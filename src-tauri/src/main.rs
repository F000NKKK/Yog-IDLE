// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--designer-host") {
        return yog_idle_tauri_lib::designer_host();
    }
    yog_idle_tauri_lib::run()
}
