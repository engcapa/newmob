pub mod agent;
pub mod ai;
mod appearance;
mod asr;
pub mod backup;
mod chat;
mod config;
mod dap;
mod database;
mod dependency_index;
mod filebrowser;
mod git;
mod hbase;
mod history;
mod java_bundles;
mod java_debug_adapter;
mod java_test;
mod lanchat;
pub mod llm;
mod local_history;
mod lsp;
mod mail;
mod migrate;
pub mod models;
mod module_lock;
mod nettools;
mod notes;
mod objectstorage;
pub mod perf;
mod proxy;
mod rdp;
mod sdk;
mod serial;
mod servers;
// Public for integration tests (welcome run-batch snapshot, V-09B).
pub mod session;
pub mod sockscap;
mod state;
mod tab;
pub mod terminal;
mod test_results;
mod tunnel;
mod update;
pub mod vault;
mod vnc;
mod voice;
mod windowing;
mod workspace;
mod workspace_execution;
mod workspace_fs;
mod workspace_search;
pub mod workspace_tooling;
mod wsl;

use state::AppState;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};

const AI_PROCESS_REAPER_INTERVAL_SECS: u64 = 30;
const AI_PROCESS_IDLE_REAP_SECS: u64 = 300;

/// Resolve the app data root, honoring the debug-only QA override used by
/// native tests. Windows' `dirs::data_dir()` uses the Known Folder API and
/// ignores `APPDATA`, so the explicit override is required for isolation.
pub fn resolved_app_data_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Ok(raw) = std::env::var("NEWMOB_DATA_DIR") {
            let path = std::path::PathBuf::from(raw.trim());
            if path.is_absolute() {
                return Ok(path);
            }
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))
}

fn should_reap_ai_process(
    chat_turn_active: bool,
    process_turn_active: bool,
    idle_secs: u64,
) -> bool {
    !chat_turn_active && !process_turn_active && idle_secs >= AI_PROCESS_IDLE_REAP_SECS
}

#[tauri::command]
async fn exit_app(app_handle: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    sockscap::prepare_for_exit(&app_handle, state).await?;
    app_handle.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Auto-update: unconditional (unlike the debug-only log plugin below).
        // `process` provides relaunch() so the user can restart into the new
        // version after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = resolved_app_data_dir(app.handle())
                .expect("failed to resolve app data dir");

            // One-time migration from the legacy Taomni identity (see migrate.rs).
            // Runs before the app-data dir is created so the directory rename
            // targets a non-existent destination on every platform.
            migrate::run(&app_data);
            backup::restore::apply_pending_restore(&app_data);

            std::fs::create_dir_all(&app_data).ok();

            let db_path = app_data.join("taomni.db");
            let conn = rusqlite::Connection::open(&db_path).expect("failed to open database");
            session::db::init_db(&conn).expect("failed to init database");
            servers::db::init_server_tables(&conn).expect("init server tables");
            rdp::tls::init_trust_table(&conn).expect("init RDP certificate trust table");
            let mail_db_dir = app_data.join("mail-cache");
            std::fs::create_dir_all(&mail_db_dir).expect("failed to create mail cache directory");

            // Tao Notes lives in its own SQLite file (notes.db), deliberately
            // separate from taomni.db so its data model / backup / encryption can
            // evolve independently (see tao-notes-feature-plan.md).
            let notes_db_path = app_data.join("notes.db");
            let notes_conn =
                rusqlite::Connection::open(&notes_db_path).expect("failed to open notes database");
            notes::init_db(&notes_conn).expect("failed to init notes database");

            let vault_path = vault::default_vault_path(app.handle());
            let v = vault::Vault::open(&vault_path).expect("failed to open vault");
            let vault_arc = Arc::new(v);

            // Load AI config and build the AppAiCtx (AsrManager + LlmRouter).
            // Vault is passed so api_key fields stored as `vault:<id>` get
            // transparently resolved by the LLM router.
            let ai_config_path = ai::config::default_ai_config_path();
            let ai_config = ai::config::AiConfig::load(&ai_config_path);
            let ai_ctx =
                ai::AppAiCtx::from_config_with_proxy_db(ai_config, vault_arc.clone(), Some(&conn));

            // Decentralized LAN messenger state (separate lanchat.sqlite).
            let lanchat_state = Arc::new(lanchat::LanChatState::new(&app_data));

            app.manage(AppState::new(
                conn,
                notes_conn,
                mail_db_dir,
                vault_arc,
                ai_ctx,
                lanchat_state,
            ));
            app.state::<AppState>()
                .lsp
                .attach_app(app.handle().clone());
            app.manage(workspace_search::WorkspaceSearchState::default());
            let local_history = local_history::init_local_history(app.handle())
                .expect("failed to init local history store");
            app.manage(local_history);

            let handle_for_reaper = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        AI_PROCESS_REAPER_INTERVAL_SECS,
                    ))
                    .await;
                    let state = handle_for_reaper.state::<AppState>();
                    let active_chat_threads: HashSet<String> =
                        state.chat_runs.lock().await.keys().cloned().collect();
                    let mut registry = state.cc_processes.lock().await;
                    let now = std::time::Instant::now();
                    let mut to_remove = Vec::new();
                    for (thread_id, proc) in registry.iter() {
                        let last_active = *proc.last_active_at.lock().unwrap();
                        if should_reap_ai_process(
                            active_chat_threads.contains(thread_id),
                            proc.is_turn_active(),
                            now.duration_since(last_active).as_secs(),
                        ) {
                            to_remove.push(thread_id.clone());
                        }
                    }
                    for tid in to_remove {
                        if let Some(proc) = registry.remove(&tid) {
                            tokio::spawn(async move {
                                proc.stop().await;
                            });
                        }
                    }
                    drop(registry);

                    let mut codex_registry = state.codex_processes.lock().await;
                    let mut codex_to_remove = Vec::new();
                    for (thread_id, proc) in codex_registry.iter() {
                        let last_active = *proc.last_active_at.lock().unwrap();
                        if should_reap_ai_process(
                            active_chat_threads.contains(thread_id),
                            proc.is_turn_active(),
                            now.duration_since(last_active).as_secs(),
                        ) {
                            codex_to_remove.push(thread_id.clone());
                        }
                    }
                    for tid in codex_to_remove {
                        if let Some(proc) = codex_registry.remove(&tid) {
                            tokio::spawn(async move {
                                proc.stop().await;
                            });
                        }
                    }
                    drop(codex_registry);

                    let mut acp_registry = state.acp_processes.lock().await;
                    let mut acp_to_remove = Vec::new();
                    for (thread_id, proc) in acp_registry.iter() {
                        if should_reap_ai_process(
                            active_chat_threads.contains(thread_id),
                            proc.is_turn_active(),
                            now.saturating_duration_since(proc.last_active_at())
                                .as_secs(),
                        ) {
                            acp_to_remove.push(thread_id.clone());
                        }
                    }
                    for tid in acp_to_remove {
                        if let Some(proc) = acp_registry.remove(&tid) {
                            tokio::spawn(async move {
                                proc.stop().await;
                            });
                        }
                    }
                }
            });

            // Start the LanChat background service only if the user opted into
            // "start on launch". Otherwise it stays dark (no mDNS/beacon/listen)
            // until the user opens the chat and confirms enabling it. The state
            // (DB/identity/TLS) is always constructed above so the service can
            // be started on demand later.
            let app_for_lanchat = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let lanchat = app_for_lanchat
                    .state::<AppState>()
                    .lanchat
                    .clone();
                let start_on_launch = lanchat
                    .store
                    .get_start_on_launch()
                    .unwrap_or(false);
                if start_on_launch {
                    if let Err(error) = lanchat::start_service(app_for_lanchat).await {
                        log::warn!("lanchat: autostart skipped: {error}");
                    }
                } else {
                    log::info!("lanchat: start_on_launch disabled; service idle until enabled");
                }
            });

            // Auto-start any tunnels with autostart=true.
            let app_for_autostart = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tunnel::autostart_tunnels(app_for_autostart).await;
            });

            // SocksCap: repair residual OS capture state from a previous unclean
            // exit. Needs app state: orphaned elevated helpers can only be
            // terminated by another elevated process, so their pids are queued
            // there for the next (UAC-elevated) helper launch to reap.
            let app_for_sockscap = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_for_sockscap.state::<AppState>();
                sockscap::boot_repair(&app_for_sockscap, &state).await;
            });

            // SocksCap: resolve the bundled xray-core binary and install the
            // sidecar manager (used by core-backed upstreams: ss/trojan/vmess/
            // vless/wireguard). Non-fatal if the binary is absent.
            {
                let state = app.state::<AppState>();
                sockscap::init_xray_manager(app.handle(), &state);
            }

            // Auto-start any local servers with startOnLaunch=true.
            let app_for_servers = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                servers::autostart_servers(app_for_servers).await;
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Some(main_window_config) = app.config().app.windows.first().cloned() {
                #[allow(unused_mut)]
                let mut builder = WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?
                    // Required on Linux/Windows for navigator.clipboard.readText().
                    // Terminal right-click paste and Shift+Insert use that API.
                    .enable_clipboard_access();
                if cfg!(debug_assertions) {
                    if let Ok(raw) = std::env::var("NEWMOB_DATA_DIR") {
                        let data_dir = std::path::PathBuf::from(raw.trim());
                        if data_dir.is_absolute() {
                            let webview_dir = data_dir.join("webview");
                            std::fs::create_dir_all(&webview_dir).ok();
                            builder = builder.data_directory(webview_dir);
                        }
                    }
                }
                // On macOS use the native traffic-light controls with an overlay
                // title bar so the window feels native (the frontend reserves a
                // left inset and hides its custom min/max/close there). Windows
                // and Linux keep the borderless custom chrome from tauri.conf.json
                // (decorations = false).
                #[cfg(target_os = "macos")]
                {
                    builder = builder
                        .decorations(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true);
                }
                let main_window = builder.build()?;

                // On Linux the webview is webkit2gtk, which ships with the
                // media-stream / WebRTC settings OFF — so getUserMedia and
                // getDisplayMedia reject and LanChat calls can't be answered or
                // screen-shared (Windows/WebView2 has them on by default). Flip
                // the settings and auto-allow UserMedia permission requests for
                // the main window (where the call overlay is mounted).
                //
                // Diagnostics: keep the builder's window handle (no re-lookup),
                // surface with_webview / settings() failures via log::warn!, and
                // read the flags back after setting them so we can tell "the
                // setting never applied" apart from "this WebKitGTK build has no
                // WebRTC backend" (settings stick but RTCPeerConnection stays
                // undefined).
                #[cfg(target_os = "linux")]
                {
                    let webview_result = main_window.with_webview(|webview| {
                        use webkit2gtk::glib::object::Cast;
                        use webkit2gtk::{
                            PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
                            WebViewExt,
                        };
                        let wv = webview.inner();
                        match WebViewExt::settings(&wv) {
                            Some(settings) => {
                                settings.set_enable_media_stream(true);
                                settings.set_enable_mediasource(true);
                                settings.set_enable_webrtc(true);
                                log::info!(
                                    "lanchat: webview media settings after set — media_stream={} mediasource={} webrtc={}",
                                    settings.enables_media_stream(),
                                    settings.enables_mediasource(),
                                    settings.enables_webrtc(),
                                );
                            }
                            None => log::warn!(
                                "lanchat: WebView settings() returned None — media-stream/WebRTC left disabled"
                            ),
                        }
                        // LAN-local app: grant mic/camera/screen capture. Other
                        // permission kinds fall through to the default handler.
                        wv.connect_permission_request(|_, req| {
                            if req.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                                req.allow();
                                true
                            } else {
                                false
                            }
                        });
                    });
                    if let Err(e) = webview_result {
                        log::warn!(
                            "lanchat: with_webview failed — WebRTC/media-stream not enabled: {e}"
                        );
                    }
                }
                #[cfg(not(target_os = "linux"))]
                let _ = main_window;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::list_local_shells,
            terminal::list_common_local_directories,
            terminal::detect_x_server,
            wsl::list_wsl_distros,
            terminal::open_local_shell_as_administrator,
            terminal::create_local_terminal,
            terminal::create_command_terminal,
            terminal::create_ssh_terminal,
            terminal::submit_ssh_auth_response,
            terminal::attach_terminal_output,
            terminal::test_ssh_connection,
            terminal::test_proxy_connection,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::send_terminal_signal,
            terminal::close_terminal,
            terminal::record_local_directory_use,
            session::list_sessions,
            session::get_session,
            session::save_session,
            session::delete_session,
            session::mark_session_connected,
            session::list_session_groups,
            session::save_session_group,
            session::delete_session_group,
            session::get_welcome_run_snapshot,
            session::record_welcome_run_snapshot,
            session::update_welcome_run_context,
            session::clear_welcome_run_snapshot,
            session::import::import_putty_sessions,
            session::import::import_wsl_sessions,
            session::import::import_external_bash_sessions,
            session::import::scan_local_session_files,
            session::import::read_dbeaver_credentials_for_data_sources,
            session::import::read_plist_session_file,
            session::import_secrets::keychain::keychain_lookup_batch,
            session::import_secrets::securecrt::securecrt_decrypt_passwords,
            session::import_secrets::tabby::tabby_decrypt_vault,
            filebrowser::sftp_attach,
            filebrowser::sftp_detach,
            filebrowser::sftp_list_remote,
            filebrowser::sftp_list_local,
            filebrowser::sftp_list_local_detailed,
            filebrowser::sftp_local_home,
            filebrowser::sftp_local_drives,
            filebrowser::sftp_mkdir,
            filebrowser::sftp_remove,
            filebrowser::sftp_rename,
            filebrowser::sftp_stat,
            filebrowser::sftp_chmod,
            filebrowser::sftp_realpath,
            filebrowser::sftp_open_path,
            filebrowser::open_external_url,
            filebrowser::sftp_read_file_text,
            filebrowser::sftp_write_file_text,
            filebrowser::sftp_upload,
            filebrowser::sftp_download,
            filebrowser::sftp_upload_dir,
            filebrowser::sftp_download_dir,
            filebrowser::sftp_upload_bytes,
            filebrowser::sftp_download_bytes,
            filebrowser::sftp_cancel_transfer,
            filebrowser::sftp_pause_transfer,
            filebrowser::sftp_resume_transfer,
            filebrowser::open_sftp_window,
            git::git_probe_path,
            git::git_init_repo,
            git::git_snapshot,
            git::git_diff,
            git::git_blob_pair,
            git::git_blame_lines,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_clean_untracked,
            git::git_ignore_path,
            git::git_commit,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_checkout_branch,
            git::git_create_branch,
            git::git_delete_branch,
            git::git_merge_branch,
            git::git_rename_branch,
            git::git_set_upstream,
            git::git_create_tag,
            git::git_delete_tag,
            git::git_push_tag,
            git::git_checkout_tag,
            git::git_log,
            git::git_commit_files,
            git::git_compare,
            git::git_reset,
            git::git_revert,
            git::git_cherry_pick,
            git::git_cherry_pick_continue,
            git::git_cherry_pick_abort,
            git::git_operation_state,
            git::git_operation_continue,
            git::git_operation_abort,
            git::git_rebase,
            git::git_rebase_skip,
            git::git_resolve_conflict,
            git::git_stash_save,
            git::git_stash_list,
            git::git_stash_show,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_set_remote,
            git::git_delete_remote,
            git::git_save_settings,
            git::git_save_remote_auth,
            sdk::sdk_get_registry,
            sdk::sdk_probe_installation,
            sdk::sdk_discover_installations,
            sdk::sdk_save_installation,
            sdk::sdk_remove_installation,
            sdk::sdk_refresh_installations,
            sdk::sdk_set_default,
            sdk::sdk_save_workspace_binding,
            sdk::sdk_remove_workspace_binding,
            sdk::sdk_analyze_workspace,
            sdk::sdk_resolve_workspace,
            workspace::workspace_list_dir,
            workspace::workspace_compact_chain,
            workspace::workspace_list_files_recursive,
            workspace::workspace_detect_git_roots,
            workspace::workspace_detect_tasks,
            workspace::workspace_java_run_targets,
            workspace::workspace_java_run_target,
            workspace::workspace_task_tree,
            test_results::workspace_test_results,
            workspace_execution::workspace_execution_model,
            workspace::workspace_dependency_tree,
            workspace::workspace_read_file,
            workspace::workspace_read_loose_file,
            workspace::workspace_read_file_with_encoding,
            workspace::workspace_read_loose_file_with_encoding,
            workspace::workspace_write_file,
            workspace::workspace_write_loose_file,
            workspace::workspace_write_file_encoded,
            workspace::workspace_write_loose_file_encoded,
            workspace::workspace_create_file,
            workspace::workspace_create_dir,
            workspace::workspace_delete_path,
            workspace::workspace_rename_path,
            workspace::workspace_apply_resource_operation,
            workspace_tooling::maven::workspace_ingest_maven_project,
            workspace_tooling::gradle::workspace_ingest_gradle_project,
            local_history::history_snapshot,
            local_history::history_list,
            local_history::history_read,
            local_history::history_prune,
            dependency_index::dependency_index_status,
            dependency_index::dependency_index_search,
            dependency_index::dependency_index_versions,
            workspace_search::workspace_search_start,
            workspace_search::workspace_search_cancel,
            lsp::lsp_list_presets,
            lsp::lsp_set_java_home,
            lsp::lsp_set_java_vmargs,
            lsp::lsp_set_java_settings,
            lsp::lsp_set_java_bundles,
            lsp::lsp_detect_java_bundles,
            lsp::lsp_discover_java_bundles,
            lsp::lsp_detect_servers,
            lsp::lsp_document_status,
            lsp::lsp_execute_command,
            lsp::lsp_resolve_workspace_edit,
            lsp::lsp_resolve_show_message_request,
            lsp::lsp_cancel_work_done_progress,
            lsp::lsp_workspace_will_file_operation,
            lsp::lsp_workspace_did_file_operation,
            lsp::lsp_workspace_did_change_watched_files,
            lsp::lsp_start_workspace_watcher,
            lsp::lsp_stop_workspace_watcher,
            lsp::lsp_open_document,
            lsp::lsp_change_document,
            lsp::lsp_save_document,
            lsp::lsp_close_document,
            lsp::lsp_stop_workspace,
            lsp::lsp_get_diagnostics,
            lsp::lsp_hover,
            lsp::lsp_cancel_reference_request,
            lsp::lsp_definition,
            lsp::lsp_declaration,
            lsp::lsp_type_definition,
            lsp::lsp_implementation,
            lsp::lsp_read_uri_contents,
            lsp::lsp_download_sources,
            lsp::lsp_reload_project,
            lsp::lsp_java_modules,
            lsp::lsp_workspace_diagnostics,
            lsp::lsp_build_workspace,
            dap::dap_start_session,
            dap::dap_send_request,
            dap::dap_send,
            dap::dap_terminate,
            java_debug_adapter::java_debug_resolve_main_classes,
            java_test::java_test_discover,
            java_test::java_test_resolve_launch,
            lsp::lsp_references,
            lsp::lsp_document_symbols,
            lsp::lsp_completion,
            lsp::lsp_completion_resolve,
            lsp::lsp_formatting,
            lsp::lsp_range_formatting,
            lsp::lsp_code_actions,
            lsp::lsp_code_action_resolve,
            lsp::lsp_prepare_rename,
            lsp::lsp_rename,
            lsp::lsp_workspace_symbols,
            lsp::lsp_workspace_symbol_resolve,
            lsp::lsp_prepare_call_hierarchy,
            lsp::lsp_call_hierarchy_incoming,
            lsp::lsp_call_hierarchy_outgoing,
            lsp::lsp_prepare_type_hierarchy,
            lsp::lsp_type_hierarchy_supertypes,
            lsp::lsp_type_hierarchy_subtypes,
            lsp::lsp_document_highlights,
            lsp::lsp_inlay_hints,
            lsp::lsp_selection_ranges,
            lsp::lsp_semantic_tokens,
            lsp::lsp_signature_help,
            lsp::lsp_java_project_model,
            windowing::open_detached_window,
            windowing::close_current_detached_window,
            appearance::list_system_fonts,
            config::select_private_key_file,
            config::select_upload_file,
            config::select_save_directory,
            config::select_save_file_path,
            config::select_file_path,
            config::select_folder_path,
            config::get_home_dir,
            config::read_file_bytes,
            config::read_stream_open,
            config::read_stream_read,
            config::read_stream_close,
            config::write_stream_open,
            config::write_stream_append,
            config::write_stream_close,
            config::write_stream_abort,
            config::check_file_exists,
            config::temporary_file_path,
            config::clipboard_read_text,
            config::clipboard_write_text,
            config::clipboard_read_multi_format,
            config::clipboard_write_multi_format,
            config::clipboard_capabilities,
            config::clipboard_read_files,
            config::clipboard_parse_file_paths,
            config::clipboard_write_files,
            tunnel::list_tunnels,
            tunnel::upsert_tunnel,
            tunnel::delete_tunnel,
            tunnel::start_tunnel,
            tunnel::stop_tunnel,
            tunnel::start_all_tunnels,
            tunnel::stop_all_tunnels,
            tunnel::reorder_tunnels,
            tunnel::test_tunnel,
            tunnel::get_tunnel_status,
            tunnel::list_tunnel_statuses,
            sockscap::sockscap_capabilities,
            sockscap::sockscap_redirector_install_status,
            sockscap::sockscap_install_redirector,
            sockscap::sockscap_get_config,
            sockscap::sockscap_validate_macos_app,
            sockscap::sockscap_set_config,
            sockscap::sockscap_gfwlist_status,
            sockscap::sockscap_refresh_gfwlist,
            sockscap::sockscap_import_rules,
            sockscap::sockscap_test_target,
            sockscap::sockscap_status,
            sockscap::sockscap_diagnostics,
            sockscap::sockscap_start,
            sockscap::sockscap_launch_app,
            sockscap::sockscap_launch_terminal_app,
            sockscap::sockscap_launched_apps,
            sockscap::sockscap_stop_launched_app,
            sockscap::sockscap_stop,
            sockscap::sockscap_prepare_for_update,
            sockscap::sockscap_recover,
            sockscap::sockscap_stats_snapshot,
            sockscap::sockscap_get_domain_records,
            sockscap::sockscap_clear_domain_records,
            sockscap::sockscap_list_processes,
            sockscap::sockscap_test_upstream,
            sockscap::sockscap_parse_share_link,
            sockscap::sockscap_parse_subscription,
            sockscap::sockscap_test_core_upstream,
            sockscap::sockscap_detect_local_proxies,
            sockscap::sockscap_detect_tun_conflicts,
            sockscap::sockscap_import_subscription,
            sockscap::helper::sockscap_helper_start,
            sockscap::helper::sockscap_helper_stop,
            sockscap::helper::sockscap_helper_status,
            sockscap::helper::sockscap_helper_probe_windivert,
            servers::start_local_server,
            servers::stop_local_server,
            servers::get_server_status,
            servers::list_server_statuses,
            servers::probe_rdp_capture,
            servers::resolve_rdp_connection_request,
            servers::save_server_config,
            servers::load_server_configs,
            vnc::vnc_connect,
            vnc::vnc_disconnect,
            vnc::vnc_test_connection,
            vnc::vnc_create_detach_claim,
            vnc::vnc_consume_detach_claim,
            rdp::rdp_connect,
            rdp::rdp_disconnect,
            rdp::rdp_test_connection,
            rdp::rdp_trust_certificate,
            database::db_connect,
            database::db_ping,
            database::db_disconnect,
            database::db_list_catalogs,
            database::db_list_schemas,
            database::db_list_tables,
            database::db_search_tables,
            database::db_describe_table,
            database::db_list_foreign_keys,
            database::db_list_indexes,
            database::db_list_objects,
            database::db_object_ddl,
            database::db_table_stats,
            database::db_execute,
            database::db_execute_stream,
            database::db_cancel,
            database::sql_rewrite::db_rewrite_result_sql,
            database::db_list_bookmarks,
            database::db_save_bookmark,
            database::db_delete_bookmark,
            database::db_append_history,
            database::db_list_history,
            database::db_delete_history,
            database::db_clear_history,
            database::db_load_query_workspace,
            database::db_save_query_workspace,
            database::db_close_query_workspace_tabs,
            database::db_list_closed_query_workspace_tabs,
            database::db_reopen_query_workspace_tab,
            database::db_list_saved_queries,
            database::db_get_saved_query,
            database::db_save_saved_query,
            database::db_archive_saved_query,
            database::db_delete_saved_query,
            database::redis_list_keys,
            database::redis_get_key,
            database::redis_set_key,
            database::redis_del_key,
            database::redis_exec,
            hbase::hbase_connect,
            hbase::hbase_ping,
            hbase::hbase_disconnect,
            hbase::hbase_cancel,
            hbase::hbase_list_tables,
            hbase::hbase_describe_table,
            hbase::hbase_execute,
            hbase::hbase_parse_site_xml,
            hbase::hbase_parse_keytab_principal,
            objectstorage::storage_attach,
            objectstorage::storage_detach,
            objectstorage::storage_ping,
            objectstorage::storage_test_connection,
            objectstorage::storage_list_buckets,
            objectstorage::storage_list_objects,
            objectstorage::storage_get_object_bytes,
            objectstorage::storage_put_object_bytes,
            objectstorage::storage_delete_object,
            objectstorage::storage_create_folder,
            objectstorage::storage_create_bucket,
            objectstorage::storage_delete_bucket,
            objectstorage::storage_delete_prefix,
            objectstorage::storage_head_object,
            objectstorage::storage_copy_object,
            objectstorage::storage_move_object,
            objectstorage::storage_move_prefix,
            objectstorage::storage_share_url,
            objectstorage::storage_download,
            objectstorage::storage_upload,
            objectstorage::storage_cancel_transfer,
            objectstorage::storage_pause_transfer,
            objectstorage::storage_resume_transfer,
            mail::mail_test_connection,
            mail::mail_oauth_authorize,
            mail::mail_oauth_device_start,
            mail::mail_oauth_device_complete,
            mail::mail_sync_headers,
            mail::mail_sync_all_folders,
            mail::mail_list_cached_folders,
            mail::mail_list_cached_messages,
            mail::mail_get_message_body,
            mail::mail_download_attachment,
            mail::mail_send_message,
            mail::mail_list_drafts,
            mail::mail_save_draft,
            mail::mail_delete_draft,
            mail::mail_index_cached_contacts,
            mail::mail_search_contacts,
            mail::mail_mark_read,
            mail::mail_set_flags,
            mail::mail_move_messages,
            mail::mail_copy_messages,
            mail::mail_delete_messages,
            mail::mail_fetch_raw,
            mail::mail_save_raw,
            mail::mail_create_folder,
            mail::mail_rename_folder,
            mail::mail_delete_folder,
            mail::mail_clear_cache,
            history::history_append,
            history::history_match_prefix,
            history::history_list_recent,
            history::history_clear,
            vault::vault_status,
            vault::vault_init,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_change_master,
            vault::vault_put,
            vault::vault_update,
            vault::vault_delete,
            vault::vault_list,
            ai::commands::get_ai_config,
            ai::commands::save_ai_config,
            ai::commands::save_ai_api_key,
            ai::commands::test_llm_connection,
            ai::commands::generate_shell_command,
            ai::commands::update_shell_audit_outcome,
            ai::session_safety::is_session_ai_write_disabled,
            tab::tab_suggest_path,
            tab::tab_suggest_fim,
            tab::tab_rewrite_command,
            agent::commands::agent_explain_error,
            agent::commands::agent_plan_tool,
            agent::commands::agent_execute_tool,
            agent::commands::agent_run,
            agent::search::commands::web_search_execute,
            agent::search::commands::deep_search_execute,
            agent::search::commands::searxng_availability,
            agent::search::commands::web_fetch_execute,
            agent::search::commands::probe_searxng_instances,
            agent::search::commands::provider_caps,
            agent::search::key_storage::keyring_put,
            agent::search::key_storage::keyring_get,
            agent::search::key_storage::keyring_delete,
            agent::acp_bridge::commands::acp_probe_profile,
            agent::acp_bridge::commands::acp_resolve_permission,
            agent::acp_bridge::commands::acp_cancel_permission,
            agent::cc_bridge::commands::cc_detect,
            agent::cc_bridge::commands::cc_get_custom_settings,
            agent::cc_bridge::commands::cc_get_profile_settings,
            agent::cc_bridge::commands::cc_send_message,
            agent::cc_bridge::commands::cc_stream_message,
            agent::cc_bridge::commands::cc_stop_session,
            agent::cc_bridge::commands::cc_test_settings,
            agent::cc_bridge::commands::cc_resolve_tool_call,
            agent::cc_bridge::commands::cc_resolve_permission,
            agent::cc_bridge::commands::cc_cancel_capture,
            agent::cc_bridge::commands::cc_track_terminal,
            agent::cc_bridge::commands::cc_untrack_terminal,
            agent::codex_bridge::commands::codex_detect,
            agent::codex_bridge::commands::codex_get_custom_config,
            agent::codex_bridge::commands::codex_get_profile_config,
            agent::codex_bridge::commands::codex_stop_session,
            agent::codex_bridge::commands::codex_test_config,
            agent::codex_bridge::commands::codex_validate_config,
            chat::chat_new_thread,
            chat::chat_list_threads,
            chat::chat_list_messages,
            chat::chat_delete_thread,
            chat::chat_set_thread_provider,
            chat::chat_set_thread_cc_model,
            chat::chat_set_thread_output_format,
            chat::chat_purge_old,
            chat::chat_export_archive,
            chat::chat_stat_attachment_paths,
            chat::chat_read_clipboard_image_attachment,
            chat::chat_send,
            chat::chat_generate_media,
            chat::chat_stream,
            chat::chat_stop_stream,
            chat::inline_qq::inline_qq_stream,
            models::models_list,
            models::models_download,
            models::models_delete,
            models::models_verify,
            models::cuda_pack_status,
            models::cuda_pack_install,
            models::cuda_pack_uninstall,
            models::mirror_get_config,
            models::mirror_set_config,
            llm::llama_server::sidecar_start,
            llm::llama_server::sidecar_stop,
            llm::llama_server::sidecar_status,
            perf::perf_baseline_recent,
            voice::commands::voice_capture_supported,
            voice::commands::voice_start_capture,
            voice::commands::voice_stop_capture,
            voice::commands::voice_stop_and_transcribe,
            update::updater_platform,
            proxy::get_app_proxy_config,
            proxy::save_app_proxy_config,
            proxy::get_app_proxy_url,
            lanchat::commands::lanchat_status,
            lanchat::commands::lanchat_list_peers,
            lanchat::commands::lanchat_get_profile,
            lanchat::commands::lanchat_update_profile,
            lanchat::commands::lanchat_send_text,
            lanchat::commands::lanchat_resend_message,
            lanchat::commands::lanchat_list_conversations,
            lanchat::commands::lanchat_list_messages,
            lanchat::commands::lanchat_mark_read,
            lanchat::commands::lanchat_create_group,
            lanchat::commands::lanchat_send_group_text,
            lanchat::commands::lanchat_list_groups,
            lanchat::commands::lanchat_leave_group,
            lanchat::commands::lanchat_send_file,
            lanchat::commands::lanchat_send_group_file,
            lanchat::commands::lanchat_send_dir,
            lanchat::commands::lanchat_accept_file,
            lanchat::commands::lanchat_open_path,
            lanchat::commands::lanchat_reject_file,
            lanchat::commands::lanchat_transfer_control,
            lanchat::commands::lanchat_send_screenshot,
            lanchat::commands::lanchat_send_clipboard_image,
            lanchat::commands::lanchat_send_image_bytes,
            lanchat::commands::lanchat_send_signal,
            lanchat::commands::lanchat_signal_group,
            lanchat::commands::nmedia_start,
            lanchat::commands::nmedia_stop,
            lanchat::commands::nmedia_ws_port,
            lanchat::commands::nmedia_add_peer,
            lanchat::commands::nmedia_remove_peer,
            lanchat::commands::nmedia_peer_state,
            lanchat::commands::nmedia_toggle_mic,
            lanchat::commands::nmedia_toggle_screen,
            lanchat::commands::nmedia_toggle_cam,
            lanchat::commands::lanchat_get_retention,
            lanchat::commands::lanchat_set_retention,
            lanchat::commands::lanchat_get_service_state,
            lanchat::commands::lanchat_start_service,
            lanchat::commands::lanchat_set_start_on_launch,
            lanchat::commands::lanchat_delete_message,
            lanchat::commands::lanchat_clear_conversation,
            lanchat::commands::lanchat_clear_all_history,
            lanchat::commands::lanchat_list_pinned,
            lanchat::commands::lanchat_retrust_peer,
            notes::commands::notes_list,
            notes::commands::notes_get,
            notes::commands::notes_create,
            notes::commands::notes_update,
            notes::commands::notes_delete,
            notes::commands::notes_toggle_complete,
            notes::commands::notes_archive,
            notes::commands::notes_list_tags,
            notes::commands::notes_upsert_tags,
            notes::commands::notes_set_steps,
            notes::commands::notes_get_prefs,
            notes::commands::notes_set_prefs,
            notes::commands::notes_list_alerts,
            notes::commands::notes_ack_alert,
            backup::backup_create,
            backup::backup_inspect,
            backup::backup_stage_restore,
            backup::backup_get_policy,
            backup::backup_set_policy,
            backup::backup_list_history,
            backup::backup_delete_item,
            backup::backup_get_default_dir,
            exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // On app exit, cleanly stop the elevated SocksCap helper (and its
            // WinDivert driver) so no elevated process/driver leaks. The
            // helper's parent-death watchdog covers crash/kill paths.
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                sockscap::shutdown_on_exit(app_handle, &state);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_process_reaper_waits_for_completed_turn_idle_window() {
        assert!(!should_reap_ai_process(
            false,
            false,
            AI_PROCESS_IDLE_REAP_SECS - 1
        ));
        assert!(should_reap_ai_process(
            false,
            false,
            AI_PROCESS_IDLE_REAP_SECS
        ));
    }

    #[test]
    fn ai_process_reaper_skips_active_chat_or_process_turn() {
        assert!(!should_reap_ai_process(
            true,
            false,
            AI_PROCESS_IDLE_REAP_SECS
        ));
        assert!(!should_reap_ai_process(
            false,
            true,
            AI_PROCESS_IDLE_REAP_SECS
        ));
        assert!(!should_reap_ai_process(
            true,
            true,
            AI_PROCESS_IDLE_REAP_SECS
        ));
    }
}
