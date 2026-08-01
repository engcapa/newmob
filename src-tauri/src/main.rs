// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some("--sockscap-redirector-bridge") {
        std::process::exit(taomni_lib::sockscap::redirector::bridge_process::run_from_cli());
    }
    taomni_lib::run();
}
