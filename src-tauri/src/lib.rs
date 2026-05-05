mod state;
mod terminal;
mod session;
mod filebrowser;
mod tunnel;
mod nettools;
mod serial;
mod config;
mod appearance;
mod vnc;

use state::AppState;
use tauri::{AppHandle, Manager};

#[tauri::command]
fn exit_app(app_handle: AppHandle) {
    app_handle.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data).ok();

            let db_path = app_data.join("newmob.db");
            let conn = rusqlite::Connection::open(&db_path)
                .expect("failed to open database");
            session::db::init_db(&conn).expect("failed to init database");

            app.manage(AppState::new(conn));

            // Auto-start any tunnels with autostart=true.
            let app_for_autostart = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tunnel::autostart_tunnels(app_for_autostart).await;
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::list_local_shells,
            terminal::open_local_shell_as_administrator,
            terminal::create_local_terminal,
            terminal::create_ssh_terminal,
            terminal::test_ssh_connection,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::send_terminal_signal,
            terminal::close_terminal,
            session::list_sessions,
            session::get_session,
            session::save_session,
            session::delete_session,
            session::mark_session_connected,
            session::list_session_groups,
            session::save_session_group,
            session::delete_session_group,
            filebrowser::sftp_attach,
            filebrowser::sftp_detach,
            filebrowser::sftp_list_remote,
            filebrowser::sftp_list_local,
            filebrowser::sftp_local_home,
            filebrowser::sftp_local_drives,
            filebrowser::sftp_mkdir,
            filebrowser::sftp_remove,
            filebrowser::sftp_rename,
            filebrowser::sftp_stat,
            filebrowser::sftp_chmod,
            filebrowser::sftp_realpath,
            filebrowser::sftp_open_path,
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
            appearance::list_system_fonts,
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
            vnc::vnc_connect,
            vnc::vnc_disconnect,
            vnc::vnc_test_connection,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
