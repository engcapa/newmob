mod state;
mod terminal;
mod session;
mod filebrowser;
mod tunnel;
mod nettools;
mod serial;
mod config;
mod appearance;

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
            appearance::list_system_fonts,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
