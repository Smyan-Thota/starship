//! Starship.app: a window that shows the engine's page, and a menu bar item.

mod engine;
mod tray;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// Shows the engine's page, or the reason the engine did not start.
fn boot(app: AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    match engine::ensure(&app) {
        Ok(info) => {
            if let Ok(url) = engine::page_url(&info).parse() {
                let _ = window.navigate(url);
            }
        }
        Err(line) => {
            let detail = serde_json::to_string(&line).unwrap_or_else(|_| "\"\"".into());
            let _ = window.eval(format!("setStatus('Engine did not start', {detail})"));
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(engine::OwnEngine::default())
        .on_window_event(|window, event| {
            // Closing the window leaves the menu bar item and the engine running.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            tray::start(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || boot(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Starship could not start");

    app.run(|app, event| match event {
        // Only an engine that this app started is stopped. Agents keep running in tmux.
        RunEvent::Exit => engine::stop_own(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        _ => {}
    });
}
