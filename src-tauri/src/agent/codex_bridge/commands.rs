use crate::agent::codex_bridge::process::{CodexAppServer, CodexThreadOptions, CodexTurnOptions};
use crate::agent::codex_bridge::protocol::CodexEvent;
use crate::agent::codex_bridge::{CodexStatusResult, detect};
use crate::ai::config::{AiConfig, default_ai_config_path};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub type CodexProcessRegistry = Mutex<HashMap<String, Arc<CodexAppServer>>>;

#[tauri::command]
pub async fn codex_detect(state: State<'_, AppState>) -> Result<CodexStatusResult, String> {
    let ai_ctx = state.ai_ctx.read().await;
    if ai_ctx.config.full_local_mode || ai_ctx.config.fully_disabled {
        return Ok(CodexStatusResult {
            status: crate::agent::codex_bridge::CodexStatus::NotFound,
            message: "Codex is hidden in full-local / fully-disabled mode.".into(),
            binary_path: None,
        });
    }
    let codex = ai_ctx.config.codex_bridge.clone();
    let binary = if codex.binary == "auto" {
        None
    } else {
        Some(codex.binary.clone())
    };
    drop(ai_ctx);
    let proxy = crate::agent::codex_bridge::config::resolve_global_proxy_url(&state, &codex)?;
    Ok(detect(binary.as_deref(), proxy.as_deref()).await)
}

#[tauri::command]
pub async fn codex_get_custom_config(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let config = AiConfig::load(&default_ai_config_path());
    crate::agent::codex_bridge::config::resolve_custom_config(&config.codex_bridge, &state.vault)
}

#[tauri::command]
pub async fn codex_get_profile_config(
    vault_ref: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if !vault_ref.starts_with("vault:") {
        return Err("Invalid vault reference".into());
    }
    match state.vault.resolve(&vault_ref) {
        Ok(Some(plaintext)) => Ok(Some(plaintext.to_string())),
        Ok(None) => Ok(None),
        Err(e) if e.contains(crate::vault::ERR_VAULT_LOCKED) => Err(format!(
            "{}: unlock the credential vault to read Codex config.",
            crate::vault::ERR_VAULT_LOCKED
        )),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn codex_stop_session(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let process = { state.codex_processes.lock().await.remove(&thread_id) };
    if let Some(process) = process {
        process.stop().await;
    }
    Ok(())
}

pub(crate) async fn recycle_thread_process(state: &AppState, thread_id: &str) {
    let process = { state.codex_processes.lock().await.remove(thread_id) };
    if let Some(process) = process {
        process.stop().await;
    }
    state.captures.purge_thread(thread_id);
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexTestConfigRequest {
    pub config_toml: String,
}

#[tauri::command]
pub fn codex_validate_config(config_toml: String) -> Result<(), String> {
    crate::agent::codex_bridge::config::parse_profile_config(Some(&config_toml)).map(|_| ())
}

#[tauri::command]
pub async fn codex_test_config(
    config_toml: String,
    proxy_mode: Option<String>,
    proxy_session_id: Option<String>,
    proxy_url: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = AiConfig::load(&default_ai_config_path());
    let binary = if config.codex_bridge.binary == "auto" {
        crate::agent::codex_bridge::find_codex_binary().ok_or("Codex CLI not found")?
    } else {
        config.codex_bridge.binary.clone()
    };
    let effective_proxy =
        crate::agent::codex_bridge::config::resolve_effective_proxy_url_with_profile_override(
            &state,
            &config.codex_bridge,
            proxy_mode.as_deref(),
            proxy_session_id.as_deref(),
            proxy_url.as_deref(),
        )?;

    let thread_id = "codex_test_config_thread".to_string();
    let event_name = "codex-test-config-stream".to_string();
    let emit = |evt: crate::chat::StreamEventOut| {
        let _ = app.emit(&event_name, evt);
    };

    {
        let old = { state.codex_processes.lock().await.remove(&thread_id) };
        if let Some(old) = old {
            old.stop().await;
        }
    }

    let flavor = crate::agent::cc_bridge::mcp_http::Flavor::Shell;
    let (server_url, token) =
        crate::agent::cc_bridge::mcp_http::provision_for_thread_with_inline_permission(
            &app,
            &thread_id,
            None,
            None,
            flavor,
            config.codex_bridge.confirm_readonly,
            true,
        )
        .await?;
    let control_server_url = crate::agent::cc_bridge::mcp_http::control_server_url()?;

    let mut runtime = crate::agent::codex_bridge::config::parse_profile_config(Some(&config_toml))
        .map_err(|e| {
            crate::agent::cc_bridge::mcp_http::revoke_token(&token);
            e
        })?;
    runtime.isolated_home = true;
    let thread_config = crate::agent::codex_bridge::config::build_thread_config_from_config(
        runtime.config.clone(),
        flavor.server_name(),
        &server_url,
        &token,
        &control_server_url,
    );

    let temp_dir = std::env::temp_dir().join(format!(".{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| {
        crate::agent::cc_bridge::mcp_http::revoke_token(&token);
        format!("Failed to create Codex temp dir: {e}")
    })?;

    let process = Arc::new(
        CodexAppServer::spawn(
            &binary,
            effective_proxy,
            Some(temp_dir.clone()),
            Some(token.clone()),
            Some(runtime.env.clone()),
            runtime.isolated_home,
        )
        .await
        .map_err(|e| {
            crate::agent::cc_bridge::mcp_http::revoke_token(&token);
            let _ = std::fs::remove_dir_all(&temp_dir);
            e
        })?,
    );

    let model = if runtime.config.contains_key("model") {
        None
    } else {
        Some(config.codex_bridge.default_model.trim().to_string())
    };
    if let Err(e) = process
        .start_or_resume_thread(CodexThreadOptions {
            resume_thread_id: None,
            model,
            cwd: std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string()),
            approval_policy: config.codex_bridge.approval_policy.clone(),
            sandbox: config.codex_bridge.sandbox.clone(),
            network_access: config.codex_bridge.network_access,
            config: thread_config,
            base_instructions: Some(
                "You are a short Codex settings test. Reply in one concise sentence.".into(),
            ),
            developer_instructions: None,
            ephemeral: true,
        })
        .await
    {
        process.stop().await;
        return Err(e);
    }

    {
        state
            .codex_processes
            .lock()
            .await
            .insert(thread_id.clone(), process.clone());
    }

    let app_clone = app.clone();
    let event_name_clone = event_name.clone();
    let events_result = process
        .send_turn_with_callback(
            "Hello, My name is Taomni, Can you help me?",
            CodexTurnOptions {
                cwd: std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string()),
                approval_policy: config.codex_bridge.approval_policy.clone(),
                sandbox: config.codex_bridge.sandbox.clone(),
                network_access: config.codex_bridge.network_access,
                model: if runtime.config.contains_key("model") {
                    None
                } else {
                    Some(config.codex_bridge.default_model.clone())
                },
            },
            move |evt| {
                if let CodexEvent::Partial { content } = evt {
                    let _ = app_clone.emit(
                        &event_name_clone,
                        crate::chat::StreamEventOut::Token {
                            id: "test".to_string(),
                            content: content.clone(),
                        },
                    );
                }
            },
        )
        .await;

    let stderr = process.get_stderr().await.trim().to_string();
    {
        let old = { state.codex_processes.lock().await.remove(&thread_id) };
        if let Some(old) = old {
            old.stop().await;
        }
    }

    match events_result {
        Ok(events) => {
            let final_content = crate::agent::codex_bridge::protocol::extract_answer(&events);
            emit(crate::chat::StreamEventOut::End {
                id: "test".to_string(),
                thread_id,
                content: final_content,
                redacted_count: 0,
            });
            Ok(())
        }
        Err(e) => {
            let msg = if stderr.is_empty() {
                e
            } else {
                format!("{e}\n\nCodex stderr:\n{stderr}")
            };
            emit(crate::chat::StreamEventOut::Error {
                id: "test".to_string(),
                message: msg.clone(),
            });
            Err(msg)
        }
    }
}
