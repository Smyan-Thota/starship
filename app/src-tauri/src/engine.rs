//! The engine process: find a live one, or start the sidecar and wait for `/health`.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// What the engine writes to `engine.json`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct EngineInfo {
    pub pid: u32,
    pub port: u16,
    pub token: String,
}

/// The engine this app started itself. Only this one is stopped when the app quits.
#[derive(Default)]
pub struct OwnEngine(pub Mutex<Option<CommandChild>>);

/// Edge A12 and I5: an engine that answers `/health` within this time is used as it is.
const REUSE_LIMIT: Duration = Duration::from_secs(1);
/// Edge I7: a new engine answers `/health` within this time, or it is stopped.
const START_LIMIT: Duration = Duration::from_secs(5);

pub fn parse_info(text: &str) -> Option<EngineInfo> {
    serde_json::from_str(text).ok()
}

pub fn page_url(info: &EngineInfo) -> String {
    format!("http://127.0.0.1:{}/?token={}", info.port, info.token)
}

pub fn api_url(info: &EngineInfo, path: &str) -> String {
    format!("http://127.0.0.1:{}{}", info.port, path)
}

fn home() -> Option<PathBuf> {
    match std::env::var_os("STARSHIP_HOME") {
        Some(h) if !h.is_empty() => Some(PathBuf::from(h)),
        _ => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".starship")),
    }
}

pub fn read_info() -> Option<EngineInfo> {
    parse_info(&fs::read_to_string(home()?.join("engine.json")).ok()?)
}

fn agent(limit: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(limit).build()
}

pub fn healthy(info: &EngineInfo, limit: Duration) -> bool {
    agent(limit).get(&api_url(info, "/health")).call().is_ok()
}

/// A GET with the token. Returns the body.
pub fn get(info: &EngineInfo, path: &str) -> Result<String, String> {
    let res = agent(Duration::from_secs(3))
        .get(&api_url(info, path))
        .set("Authorization", &format!("Bearer {}", info.token))
        .call()
        .map_err(|e| e.to_string())?;
    res.into_string().map_err(|e| e.to_string())
}

pub fn post(info: &EngineInfo, path: &str) -> Result<(), String> {
    agent(Duration::from_secs(3))
        .post(&api_url(info, path))
        .set("Authorization", &format!("Bearer {}", info.token))
        .call()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The engine to show: a live one, or a new one. The error is the engine's last output line.
pub fn ensure(app: &AppHandle) -> Result<EngineInfo, String> {
    if let Some(info) = read_info() {
        if healthy(&info, REUSE_LIMIT) {
            return Ok(info);
        }
    }

    let dist = app.path().resource_dir().map_err(|e| e.to_string())?.join("dist");
    // The app's own folder, never a folder under Desktop, Documents or Downloads (edge I7).
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;

    let (mut events, child) = app
        .shell()
        .sidecar("starship-engine")
        .map_err(|e| e.to_string())?
        .args(["daemon", "--static", &dist.to_string_lossy()])
        .env("PATH", engine_path(std::env::var("PATH").ok(), std::env::var("HOME").ok()))
        .current_dir(data)
        .spawn()
        .map_err(|e| e.to_string())?;

    let last_line = Arc::new(Mutex::new(String::new()));
    let failed = Arc::new(Mutex::new(false));
    {
        let (last_line, failed) = (last_line.clone(), failed.clone());
        thread::spawn(move || {
            while let Some(event) = events.blocking_recv() {
                match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        if let Some(line) = last_nonempty_line(&String::from_utf8_lossy(&bytes)) {
                            *last_line.lock().unwrap() = line;
                        }
                    }
                    CommandEvent::Error(text) => *last_line.lock().unwrap() = text,
                    CommandEvent::Terminated(end) => {
                        if end.code != Some(0) {
                            *failed.lock().unwrap() = true;
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    let start = Instant::now();
    while start.elapsed() < START_LIMIT && !*failed.lock().unwrap() {
        if let Some(info) = read_info() {
            if healthy(&info, Duration::from_millis(300)) {
                *app.state::<OwnEngine>().0.lock().unwrap() = Some(child);
                return Ok(info);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = child.kill();
    let line = last_line.lock().unwrap().clone();
    Err(if line.is_empty() { "no output".to_string() } else { line })
}

/// Stops the engine this app started. An engine that was already running is left alone.
pub fn stop_own(app: &AppHandle) {
    if let Some(child) = app.state::<OwnEngine>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// A Mac app starts with a short PATH. The engine needs tmux and the agents' tools, so the usual
/// install folders come first.
fn engine_path(current: Option<String>, home: Option<String>) -> String {
    let mut parts: Vec<String> = vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Some(home) = home {
        parts.push(format!("{home}/.local/bin"));
        parts.push(format!("{home}/.bun/bin"));
    }
    parts.extend(current.unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into()).split(':').map(String::from));
    parts.join(":")
}

fn last_nonempty_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_engine_json() {
        let info = parse_info(r#"{ "pid": 41, "port": 4317, "token": "abc" }"#).unwrap();
        assert_eq!(info, EngineInfo { pid: 41, port: 4317, token: "abc".into() });
    }

    #[test]
    fn rejects_engine_json_that_is_broken_or_incomplete() {
        assert_eq!(parse_info("not json"), None);
        assert_eq!(parse_info(r#"{ "pid": 41, "port": 4317 }"#), None);
        assert_eq!(parse_info(r#"{ "pid": 41, "port": 99999, "token": "t" }"#), None);
    }

    #[test]
    fn builds_the_page_address() {
        let info = EngineInfo { pid: 1, port: 4317, token: "t0k".into() };
        assert_eq!(page_url(&info), "http://127.0.0.1:4317/?token=t0k");
        assert_eq!(api_url(&info, "/health"), "http://127.0.0.1:4317/health");
    }

    #[test]
    fn puts_the_install_folders_before_the_short_path() {
        assert_eq!(
            engine_path(Some("/usr/bin:/bin".into()), Some("/home/me".into())),
            "/opt/homebrew/bin:/usr/local/bin:/home/me/.local/bin:/home/me/.bun/bin:/usr/bin:/bin"
        );
    }

    #[test]
    fn keeps_the_last_line_of_the_output() {
        assert_eq!(last_nonempty_line("a\nboom\n\n"), Some("boom".into()));
        assert_eq!(last_nonempty_line("  \n"), None);
    }
}
