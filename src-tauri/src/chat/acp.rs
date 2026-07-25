use super::*;
use crate::agent::acp_bridge::{
    AcpPermissionPrompt, AcpResourceLink, AcpRuntimeEvent, AcpStopReason, AcpThreadProcess,
    GROK_PROFILE_ID, profile_id_from_provider_id,
};
use crate::agent::local::LocalAgentEvent;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(super) async fn recycle_if_profile_changed(
    state: &AppState,
    thread_id: &str,
    provider_id: &str,
) {
    let selected_profile = profile_id_from_provider_id(provider_id);
    let process = {
        let mut registry = state.acp_processes.lock().await;
        let should_remove = registry
            .get(thread_id)
            .is_some_and(|process| Some(process.profile_id()) != selected_profile);
        should_remove.then(|| registry.remove(thread_id)).flatten()
    };
    if let Some(process) = process {
        process.stop().await;
    }
}

/// Stop an in-flight short-lived Grok media ACP process when its thread is
/// deleted or rebound to another provider. Unlike normal ACP chat processes,
/// media processes are not reusable and must never survive their owner.
pub(super) async fn recycle_media_process(state: &AppState, app: &AppHandle, thread_id: &str) {
    let process = { state.acp_media_processes.lock().await.remove(thread_id) };
    if let Some(process) = process {
        let permission_owner_id = process.permission_owner_id().to_string();
        process.stop().await;
        // `stop` normally emits a Closed event, but remove a visible card here
        // as well so a deleted/rebound thread cannot retain an actionable gate.
        // Scope this to the retired media process: a reusable ACP chat process
        // for the same thread may still have its own independent card.
        dismiss_acp_permission(app, thread_id, Some(&permission_owner_id), None);
    }
}

pub(super) async fn stream(
    req: &ChatSendRequest,
    app: &AppHandle,
    state: &AppState,
    event_name: &str,
    thread: &store::ChatThread,
    history: &[store::ChatMessage],
    attachments: &[store::ChatAttachment],
    clean_content: &str,
    redacted_count: usize,
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Result<(), String> {
    let assistant_id = Uuid::new_v4().to_string();
    let assistant_ts = now() + 1;
    emit(
        app,
        event_name,
        StreamEventOut::AssistantStart {
            id: assistant_id.clone(),
            thread_id: req.thread_id.clone(),
            created_at: assistant_ts,
        },
    );

    let profile_id = profile_id_from_provider_id(&thread.provider_id)
        .ok_or_else(|| "invalid ACP provider id".to_string())?;
    let ai_config = AiConfig::load(&default_ai_config_path());
    let bridge = &ai_config.acp_bridge;
    let Some(profile) = bridge.profile(profile_id).cloned() else {
        emit_error(
            app,
            event_name,
            &assistant_id,
            format!("ACP profile `{profile_id}` is not configured."),
        );
        return Ok(());
    };
    if !bridge.enabled || !profile.enabled || ai_config.fully_disabled || ai_config.full_local_mode
    {
        recycle_thread_process(state, &req.thread_id).await;
        emit_error(
            app,
            event_name,
            &assistant_id,
            "ACP is unavailable in full-local / fully-disabled mode or the bridge/profile is disabled."
                .into(),
        );
        return Ok(());
    }

    recycle_if_profile_changed(state, &req.thread_id, &thread.provider_id).await;
    let cwd = resolve_process_cwd(req, agent_ctx)?;
    let (process, session_id) = match existing_process(state, &req.thread_id, profile_id).await {
        Some(process) => {
            let session_id = match process
                .ensure_session(
                    thread.acp_session_id.as_deref(),
                    &cwd.to_string_lossy(),
                    Vec::new(),
                )
                .await
            {
                Ok(session_id) => session_id,
                Err(error) => {
                    recycle_thread_process(state, &req.thread_id).await;
                    emit_error(app, event_name, &assistant_id, error.to_string());
                    return Ok(());
                }
            };
            (process, session_id)
        }
        None => {
            let (process, session_id) = match spawn_thread_process(
                req,
                app,
                state,
                agent_ctx,
                bridge,
                &profile,
                &cwd,
                thread.acp_session_id.as_deref(),
            )
            .await
            {
                Ok(result) => result,
                Err(message) => {
                    emit_error(app, event_name, &assistant_id, message);
                    return Ok(());
                }
            };
            state
                .acp_processes
                .lock()
                .await
                .insert(req.thread_id.clone(), process.clone());
            (process, session_id)
        }
    };
    if let Ok(db) = state.db.lock() {
        let _ = store::set_acp_session_id(&db, &req.thread_id, &session_id);
    }

    agent_ctx.refresh_runtime_bindings(state).await;
    state.chat_runs.lock().await.insert(
        req.thread_id.clone(),
        run::ChatRunHandle::bridge_process(thread.provider_id.clone(), process.clone()),
    );

    let prompt = build_prompt(
        thread,
        history,
        attachments,
        clean_content,
        req.terminal_context.as_deref(),
        agent_ctx,
        &ai_config,
    );
    // Grok currently negotiates `promptCapabilities.image = false`, so never
    // send it an inline ACP image block. Its CLI can nevertheless read local
    // image `resource_link`s, which preserve the attachment as a local file
    // instead of embedding image bytes in the ACP stream.
    let resource_links = grok_image_resource_links(profile_id, attachments);
    let permission_owner_id = process.permission_owner_id().to_string();
    let mut updates = process.subscribe();
    let mut prompt_future = Box::pin(async {
        if resource_links.is_empty() {
            process.prompt(&prompt).await
        } else {
            process
                .prompt_with_resource_links(&prompt, &resource_links)
                .await
        }
    });
    let mut accumulator = AcpEventAccumulator::default();
    let prompt_result = loop {
        tokio::select! {
            result = &mut prompt_future => break result,
            update = updates.recv() => {
                match update {
                    Ok(update) => accumulator.handle(
                        app,
                        event_name,
                        &assistant_id,
                        &req.thread_id,
                        &permission_owner_id,
                        &profile.name,
                        update,
                    ),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break prompt_future.await;
                    }
                }
            }
        }
    };
    while let Ok(update) = updates.try_recv() {
        accumulator.handle(
            app,
            event_name,
            &assistant_id,
            &req.thread_id,
            &permission_owner_id,
            &profile.name,
            update,
        );
    }
    state.chat_runs.lock().await.remove(&req.thread_id);

    let result = match prompt_result {
        Ok(result) => result,
        Err(error) => {
            let stopped = process.is_stopped();
            recycle_thread_process(state, &req.thread_id).await;
            emit_error(
                app,
                event_name,
                &assistant_id,
                if stopped {
                    "Stream stopped by user".into()
                } else {
                    error.to_string()
                },
            );
            return Ok(());
        }
    };

    if result.stop_reason == AcpStopReason::Cancelled {
        emit_error(
            app,
            event_name,
            &assistant_id,
            "ACP turn was cancelled.".into(),
        );
        return Ok(());
    }
    if let Some(usage) = result.usage {
        emit(
            app,
            event_name,
            StreamEventOut::Usage {
                id: assistant_id.clone(),
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cost_usd: usage.total_cost_usd,
                duration_ms: usage.duration_ms,
            },
        );
    }

    let final_content = accumulator.content;
    let assistant_msg = store::ChatMessage {
        id: assistant_id.clone(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: final_content.clone(),
        created_at: assistant_ts,
        redacted: false,
        attachments: Vec::new(),
    };
    {
        let db = state.db.lock().map_err(|error| error.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|error| error.to_string())?;
        if history.is_empty() {
            let title = clean_content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title)
                .map_err(|error| error.to_string())?;
        }
    }

    emit(
        app,
        event_name,
        StreamEventOut::End {
            id: assistant_id,
            thread_id: req.thread_id.clone(),
            content: final_content,
            redacted_count,
        },
    );
    Ok(())
}

async fn spawn_thread_process(
    req: &ChatSendRequest,
    app: &AppHandle,
    state: &AppState,
    agent_ctx: &crate::agent::context::AgentThreadContext,
    bridge: &crate::agent::acp_bridge::AcpBridgeConfig,
    profile: &crate::agent::acp_bridge::AcpProfileConfig,
    cwd: &Path,
    resume_session_id: Option<&str>,
) -> Result<(Arc<AcpThreadProcess>, String), String> {
    let proxy_url = crate::agent::acp_bridge::resolve_effective_proxy_url(state, bridge, profile)?;
    let process_config = crate::agent::acp_bridge::process_config(
        profile,
        Some(cwd),
        proxy_url.as_deref(),
        bridge.request_timeout(),
    )?;
    let (server_url, token) = crate::agent::mcp_bridge::provision_for_thread(
        app,
        &req.thread_id,
        agent_ctx.linked_session_id.clone(),
        agent_ctx.bound_session_id.clone(),
        agent_ctx.flavor,
        false,
    )
    .await?;
    let control_url = match crate::agent::mcp_bridge::control_server_url() {
        Ok(url) => url,
        Err(error) => {
            crate::agent::mcp_bridge::revoke_token(&token);
            return Err(error);
        }
    };
    let mcp_servers = crate::agent::mcp_bridge::acp_http_servers(
        agent_ctx.flavor,
        &server_url,
        &control_url,
        &token,
    );
    let process = Arc::new(
        AcpThreadProcess::spawn(
            profile.id.clone(),
            process_config,
            profile.auth_method_id.as_deref(),
            token,
        )
        .await
        .map_err(|error| error.to_string())?,
    );
    let mcp_servers = process
        .agent_info()
        .supports_mcp_http
        .then_some(mcp_servers)
        .unwrap_or_default();
    let session_id = match process
        .ensure_session(resume_session_id, &cwd.to_string_lossy(), mcp_servers)
        .await
    {
        Ok(session_id) => session_id,
        Err(error) => {
            process.stop().await;
            return Err(error.to_string());
        }
    };
    Ok((process, session_id))
}

async fn existing_process(
    state: &AppState,
    thread_id: &str,
    profile_id: &str,
) -> Option<Arc<AcpThreadProcess>> {
    state
        .acp_processes
        .lock()
        .await
        .get(thread_id)
        .filter(|process| process.profile_id() == profile_id && !process.is_stopped())
        .cloned()
}

async fn recycle_thread_process(state: &AppState, thread_id: &str) {
    let process = state.acp_processes.lock().await.remove(thread_id);
    if let Some(process) = process {
        process.stop().await;
    }
}

fn resolve_process_cwd(
    req: &ChatSendRequest,
    agent_ctx: &crate::agent::context::AgentThreadContext,
) -> Result<PathBuf, String> {
    let base = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut candidates = Vec::new();
    if let Some(cwd) = req.cwd.as_deref() {
        candidates.push(cwd);
    }
    if let Some(workspace) = agent_ctx.code_workspace.as_ref() {
        if !workspace.repo_root.trim().is_empty() {
            candidates.push(&workspace.repo_root);
        }
        candidates.extend(workspace.roots.iter().map(|root| root.path.as_str()));
    }
    for candidate in candidates {
        let candidate = candidate.trim();
        if candidate.is_empty() {
            continue;
        }
        let path = PathBuf::from(candidate);
        let absolute = if path.is_absolute() {
            path
        } else {
            base.join(path)
        };
        if absolute.is_dir() {
            return Ok(absolute);
        }
    }
    Ok(base)
}

fn build_prompt(
    thread: &store::ChatThread,
    history: &[store::ChatMessage],
    attachments: &[store::ChatAttachment],
    clean_content: &str,
    terminal_context: Option<&str>,
    agent_ctx: &crate::agent::context::AgentThreadContext,
    ai_config: &AiConfig,
) -> String {
    let output_format = resolve_output_format(thread, ai_config);
    let mut prompt =
        append_agent_context_to_system_prompt(build_system_prompt(&output_format), agent_ctx);
    prompt.push_str(
        "\n\nYou are connected through ACP inside Taomni. Use the scoped Taomni MCP tools for the bound terminal/database session and taomni_control for saved-session or tab actions.",
    );
    if thread.acp_session_id.is_none() && !history.is_empty() {
        prompt.push_str("\n\n[Prior Taomni chat context]\n");
        let mut used = 0_usize;
        for message in history.iter().rev().take(8).rev() {
            let remaining = 12_000_usize.saturating_sub(used);
            if remaining == 0 {
                break;
            }
            let content = message.content.chars().take(remaining).collect::<String>();
            used += content.chars().count();
            prompt.push_str(&format!("{}: {}\n", message.role, content));
        }
    }
    if let Some(context) = terminal_context.filter(|context| !context.trim().is_empty()) {
        let (context, _) = redact::redact(context);
        prompt.push_str(&format!("\n\n[Terminal context]\n```\n{context}\n```"));
    }
    prompt.push_str("\n\n");
    prompt.push_str(&render_agent_attachment_prefix(attachments));
    prompt.push_str(clean_content);
    prompt
}

fn grok_image_resource_links(
    profile_id: &str,
    attachments: &[store::ChatAttachment],
) -> Vec<AcpResourceLink> {
    if profile_id != GROK_PROFILE_ID {
        return Vec::new();
    }
    attachments
        .iter()
        .filter(|attachment| attachment.kind == "image")
        .filter_map(|attachment| {
            let path = std::fs::canonicalize(&attachment.path).ok()?;
            if !path.is_file() {
                return None;
            }
            let uri = url::Url::from_file_path(path).ok()?.to_string();
            let mime_type = attachment
                .mime
                .as_deref()
                .map(str::trim)
                .filter(|mime| !mime.is_empty())
                .map(str::to_string);
            Some(AcpResourceLink::new(
                uri,
                attachment.name.clone(),
                mime_type,
            ))
        })
        .collect()
}

/// Run Grok's native media tools through its ACP server. This is intentionally
/// separate from API-key based LLM providers: the installed `grok` CLI owns
/// authentication and emits a local artifact path when its image/video tool
/// completes.
pub(super) async fn generate_grok_media(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    bridge: &crate::agent::acp_bridge::AcpBridgeConfig,
    profile: &crate::agent::acp_bridge::AcpProfileConfig,
    kind: MediaGenerationKind,
    prompt: &str,
    attachments: &[store::ChatAttachment],
) -> Result<GeneratedMediaFile, String> {
    if profile.id != GROK_PROFILE_ID {
        return Err("Only the built-in Grok ACP profile can generate local media.".into());
    }

    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let proxy_url = crate::agent::acp_bridge::resolve_effective_proxy_url(state, bridge, profile)?;
    let process_config = crate::agent::acp_bridge::process_config(
        profile,
        Some(&cwd),
        proxy_url.as_deref(),
        bridge.request_timeout(),
    )?;
    let process = Arc::new(
        crate::agent::acp_bridge::AcpProcess::spawn(process_config)
            .await
            .map_err(|error| error.to_string())?,
    );
    let permission_owner_id = process.permission_owner_id().to_string();
    let already_running = {
        let mut registry = state.acp_media_processes.lock().await;
        if registry.contains_key(thread_id) {
            true
        } else {
            registry.insert(thread_id.to_string(), process.clone());
            false
        }
    };
    if already_running {
        process.stop().await;
        return Err("Grok media generation is already active for this chat thread.".into());
    }

    let result = async {
        let agent_info = process
            .initialize()
            .await
            .map_err(|error| error.to_string())?;
        if let Some(method_id) = profile
            .auth_method_id
            .as_deref()
            .map(str::trim)
            .filter(|method_id| !method_id.is_empty())
        {
            if !agent_info
                .auth_methods
                .iter()
                .any(|method| method.id == method_id)
            {
                return Err("Configured Grok ACP authentication method was not advertised.".into());
            }
            process
                .authenticate(method_id)
                .await
                .map_err(|error| error.to_string())?;
        }

        let session_id = process
            .new_session(&cwd.to_string_lossy(), Vec::new())
            .await
            .map_err(|error| error.to_string())?;
        let resource_links = grok_image_resource_links(&profile.id, attachments);
        let media_prompt = grok_media_prompt(kind, prompt, !resource_links.is_empty());
        let candidates = collect_grok_media_candidates(
            app,
            thread_id,
            &permission_owner_id,
            &profile.name,
            process.as_ref(),
            &session_id,
            &media_prompt,
            &resource_links,
        )
        .await?;
        copy_grok_generated_media(app, kind, &candidates, &profile.name).await
    }
    .await;

    let was_registered = {
        let mut registry = state.acp_media_processes.lock().await;
        if registry
            .get(thread_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &process))
        {
            registry.remove(thread_id).is_some()
        } else {
            false
        }
    };
    process.stop().await;
    if was_registered {
        dismiss_acp_permission(app, thread_id, Some(&permission_owner_id), None);
    }
    result
}

fn grok_media_prompt(kind: MediaGenerationKind, prompt: &str, has_reference_image: bool) -> String {
    let instruction = match kind {
        MediaGenerationKind::Image if has_reference_image => {
            "Generate exactly one image now. Use Grok's native image_edit tool immediately, with the attached local image as the reference. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
        MediaGenerationKind::Image => {
            "Generate exactly one new image now. Use Grok's native image_gen tool immediately. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
        MediaGenerationKind::Video if has_reference_image => {
            "Generate exactly one video now. Use Grok's native image_to_video tool immediately with the attached local image as its first frame. Use a 6-second clip unless the user explicitly requests 10 seconds. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
        MediaGenerationKind::Video => {
            "Generate exactly one video now. First use Grok's native image_gen tool once to create an appropriate first frame, then use image_to_video. Use a 6-second clip unless the user explicitly requests 10 seconds. Do not modify or read workspace files, and do not use any other tool. Apply this user prompt verbatim:"
        }
    };
    format!("{instruction}\n\n{prompt}")
}

async fn collect_grok_media_candidates(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: &str,
    source_label: &str,
    process: &crate::agent::acp_bridge::AcpProcess,
    session_id: &str,
    prompt: &str,
    resource_links: &[AcpResourceLink],
) -> Result<Vec<String>, String> {
    let mut updates = process.subscribe();
    let mut prompt_future = Box::pin(async {
        if resource_links.is_empty() {
            process.prompt(session_id, prompt).await
        } else {
            process
                .prompt_with_resource_links(session_id, prompt, resource_links)
                .await
        }
    });
    let mut candidates = Vec::new();
    let prompt_result = loop {
        tokio::select! {
            result = &mut prompt_future => break result,
            update = updates.recv() => {
                match update {
                    Ok(update) => collect_grok_media_event(
                        app,
                        thread_id,
                        permission_owner_id,
                        source_label,
                        update,
                        &mut candidates,
                    ),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break prompt_future.await,
                }
            }
        }
    };
    while let Ok(update) = updates.try_recv() {
        collect_grok_media_event(
            app,
            thread_id,
            permission_owner_id,
            source_label,
            update,
            &mut candidates,
        );
    }

    let result = prompt_result.map_err(|error| error.to_string())?;
    if result.stop_reason == AcpStopReason::Cancelled {
        return Err("Grok media generation was cancelled.".into());
    }
    Ok(candidates)
}

fn collect_grok_media_event(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: &str,
    source_label: &str,
    event: AcpRuntimeEvent,
    candidates: &mut Vec<String>,
) {
    match event {
        AcpRuntimeEvent::SessionUpdate(update) => {
            let Some(media) = update.generated_media else {
                return;
            };
            if !candidates.iter().any(|candidate| candidate == &media.path) {
                candidates.push(media.path);
            }
        }
        AcpRuntimeEvent::PermissionRequest(permission) => {
            emit_acp_permission(
                app,
                thread_id,
                permission_owner_id,
                source_label,
                permission,
            );
        }
        AcpRuntimeEvent::PermissionResolved { call_id } => {
            dismiss_acp_permission(app, thread_id, Some(permission_owner_id), Some(&call_id));
        }
        AcpRuntimeEvent::Closed => {
            dismiss_acp_permission(app, thread_id, Some(permission_owner_id), None)
        }
        AcpRuntimeEvent::ProtocolWarning { message } => {
            tracing::warn!("ACP protocol warning during Grok media generation: {message}");
        }
    }
}

const GROK_GENERATED_MEDIA_MAX_BYTES: u64 = 512 * 1024 * 1024;

async fn copy_grok_generated_media(
    app: &AppHandle,
    kind: MediaGenerationKind,
    candidates: &[String],
    model: &str,
) -> Result<GeneratedMediaFile, String> {
    // Video creation can first emit its generated still frame, so examine the
    // newest artifacts first and select by actual file type rather than a
    // Grok-private rawOutput type label.
    for candidate in candidates.iter().rev() {
        if let Some(file) = copy_grok_generated_media_candidate(app, kind, candidate, model).await?
        {
            return Ok(file);
        }
    }
    Err(format!(
        "Grok CLI completed without providing a readable generated {}.",
        kind.as_str()
    ))
}

async fn copy_grok_generated_media_candidate(
    app: &AppHandle,
    kind: MediaGenerationKind,
    candidate: &str,
    model: &str,
) -> Result<Option<GeneratedMediaFile>, String> {
    let candidate_path = Path::new(candidate);
    // Grok's native tools return an absolute artifact path. Rejecting relative
    // values prevents an unexpected ACP payload from making Taomni copy a
    // workspace file merely because its name happens to match a media type.
    if !candidate_path.is_absolute() {
        return Ok(None);
    }
    let Ok(source) = std::fs::canonicalize(candidate_path) else {
        return Ok(None);
    };
    let Ok(metadata) = tokio::fs::metadata(&source).await else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > GROK_GENERATED_MEDIA_MAX_BYTES
    {
        return Ok(None);
    }
    let Some(mime) = grok_generated_media_mime(&source, kind).await else {
        return Ok(None);
    };
    let target =
        generation_output_path(app, kind.as_str(), extension_for_mime(&mime, kind.as_str()))?;
    tokio::fs::copy(&source, &target)
        .await
        .map_err(|_| "Could not copy Grok-generated media into Taomni storage.".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_else(|| {
            if kind == MediaGenerationKind::Image {
                "generated-image.png"
            } else {
                "generated-video.mp4"
            }
        })
        .to_string();
    Ok(Some(GeneratedMediaFile {
        path: target,
        name,
        size: metadata.len(),
        mime,
        remote_url: None,
        video_id: None,
        model: model.to_string(),
    }))
}

async fn grok_generated_media_mime(path: &Path, kind: MediaGenerationKind) -> Option<String> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut header = [0_u8; 16];
    let bytes_read = file.read(&mut header).await.ok()?;
    let header = &header[..bytes_read];
    match kind {
        MediaGenerationKind::Image => infer_image_mime(header),
        MediaGenerationKind::Video if header.get(4..8) == Some(b"ftyp") => Some("video/mp4".into()),
        MediaGenerationKind::Video if header.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) => {
            Some("video/webm".into())
        }
        MediaGenerationKind::Video => match path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref()
        {
            Some("mp4") => Some("video/mp4".into()),
            Some("webm") => Some("video/webm".into()),
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_media_prompts_select_the_native_tools_for_each_flow() {
        let image = grok_media_prompt(MediaGenerationKind::Image, "a red kite", false);
        assert!(image.contains("image_gen"));
        assert!(image.ends_with("a red kite"));

        let edited_image = grok_media_prompt(MediaGenerationKind::Image, "make it blue", true);
        assert!(edited_image.contains("image_edit"));

        let video = grok_media_prompt(MediaGenerationKind::Video, "waves moving", false);
        assert!(video.contains("image_gen"));
        assert!(video.contains("image_to_video"));
        assert!(video.contains("6-second"));

        let referenced_video = grok_media_prompt(MediaGenerationKind::Video, "slow zoom", true);
        assert!(referenced_video.contains("image_to_video"));
        assert!(!referenced_video.contains("First use Grok's native image_gen"));
    }

    #[test]
    fn grok_image_attachments_become_local_file_resource_links() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("reference image.png");
        std::fs::write(&image, [137, 80, 78, 71]).unwrap();
        let attachment = store::ChatAttachment {
            id: "image-1".into(),
            kind: "image".into(),
            path: image.to_string_lossy().into_owned(),
            name: "reference image.png".into(),
            size: 4,
            mime: Some("image/png".into()),
            preview_url: None,
        };

        let links = grok_image_resource_links(GROK_PROFILE_ID, &[attachment]);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].name, "reference image.png");
        assert_eq!(links[0].mime_type.as_deref(), Some("image/png"));
        let uri = url::Url::parse(&links[0].uri).unwrap();
        assert_eq!(uri.scheme(), "file");
        // Compare against a URL built the same way production builds it
        // (`canonicalize` → `from_file_path`). On Windows `canonicalize`
        // yields a `\\?\` verbatim path that `Url::to_file_path` normalizes
        // away, so asserting `to_file_path() == canonicalize()` fails on the
        // prefix alone. Round-tripping both through `from_file_path` keeps the
        // comparison symmetric across platforms.
        let expected = url::Url::from_file_path(std::fs::canonicalize(&image).unwrap()).unwrap();
        assert_eq!(uri, expected);
        assert!(grok_image_resource_links("another-agent", &[]).is_empty());
    }
}

#[derive(Default)]
struct AcpEventAccumulator {
    content: String,
    tool_names: HashMap<String, String>,
}

/// Forward only the data required to render and resolve a standard ACP
/// permission gate. In particular, raw tool input, ACP session ids,
/// tool-call ids, and agent-authored option labels stay in the backend.
fn emit_acp_permission(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: &str,
    source_label: &str,
    permission: AcpPermissionPrompt,
) {
    let options = permission
        .options
        .into_iter()
        .map(|option| {
            json!({
                "optionId": option.option_id,
                "kind": option.kind,
            })
        })
        .collect::<Vec<_>>();
    let _ = app.emit(
        "agent-acp-permission",
        json!({
            "callId": permission.call_id,
            "threadId": thread_id,
            "permissionOwnerId": permission_owner_id,
            "sourceLabel": source_label,
            "title": permission.title,
            "kind": permission.kind,
            "options": options,
        }),
    );
}

fn dismiss_acp_permission(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: Option<&str>,
    call_id: Option<&str>,
) {
    let _ = app.emit(
        "agent-acp-permission-dismissed",
        json!({
            "threadId": thread_id,
            "permissionOwnerId": permission_owner_id,
            "callId": call_id,
        }),
    );
}

impl AcpEventAccumulator {
    fn handle(
        &mut self,
        app: &AppHandle,
        event_name: &str,
        assistant_id: &str,
        thread_id: &str,
        permission_owner_id: &str,
        source_label: &str,
        event: AcpRuntimeEvent,
    ) {
        match event {
            AcpRuntimeEvent::SessionUpdate(update) if !update.is_replay => {
                if let Some(event) = update.event {
                    self.handle_local_event(app, event_name, assistant_id, event);
                }
            }
            AcpRuntimeEvent::PermissionRequest(permission) => {
                emit_acp_permission(
                    app,
                    thread_id,
                    permission_owner_id,
                    source_label,
                    permission,
                );
            }
            AcpRuntimeEvent::PermissionResolved { call_id } => {
                dismiss_acp_permission(app, thread_id, Some(permission_owner_id), Some(&call_id));
            }
            AcpRuntimeEvent::ProtocolWarning { message } => {
                tracing::warn!("ACP protocol warning: {message}");
            }
            AcpRuntimeEvent::Closed => {
                dismiss_acp_permission(app, thread_id, Some(permission_owner_id), None)
            }
            AcpRuntimeEvent::SessionUpdate(_) => {}
        }
    }

    fn handle_local_event(
        &mut self,
        app: &AppHandle,
        event_name: &str,
        assistant_id: &str,
        event: LocalAgentEvent,
    ) {
        match event {
            LocalAgentEvent::AssistantDelta { content }
            | LocalAgentEvent::AssistantMessage { content } => {
                self.content.push_str(&content);
                emit(
                    app,
                    event_name,
                    StreamEventOut::Token {
                        id: assistant_id.into(),
                        content,
                    },
                );
            }
            LocalAgentEvent::ToolStarted {
                id, name, input, ..
            } => {
                self.tool_names.insert(id.clone(), name.clone());
                self.content.push_str(&format_cc_tool_use(&name, &input));
                emit(
                    app,
                    event_name,
                    StreamEventOut::CcToolActivity {
                        id: assistant_id.into(),
                        call_id: id,
                        phase: "use".into(),
                        tool: name,
                        detail: cc_tool_arg_summary(&input).unwrap_or_default(),
                    },
                );
            }
            LocalAgentEvent::ToolCompleted { id, output } => {
                let preview = cc_tool_result_preview(&output);
                if !preview.is_empty() {
                    self.content.push_str(&format!("> ↳ {preview}\n"));
                }
                emit(
                    app,
                    event_name,
                    StreamEventOut::CcToolActivity {
                        id: assistant_id.into(),
                        call_id: id.clone(),
                        phase: "result".into(),
                        tool: self.tool_names.remove(&id).unwrap_or_default(),
                        detail: preview,
                    },
                );
            }
            LocalAgentEvent::Error { message } => {
                tracing::warn!("ACP agent event error: {message}");
            }
            LocalAgentEvent::SessionStarted { .. } | LocalAgentEvent::Done { .. } => {}
        }
    }
}

fn emit(app: &AppHandle, event_name: &str, event: StreamEventOut) {
    let _ = app.emit(event_name, event);
}

fn emit_error(app: &AppHandle, event_name: &str, assistant_id: &str, message: String) {
    emit(
        app,
        event_name,
        StreamEventOut::Error {
            id: assistant_id.into(),
            message,
        },
    );
}
