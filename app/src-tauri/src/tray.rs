//! The menu bar item: the needs-you count, one Halt entry per running chat, and a notification
//! when the count goes up.

use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::engine;

const POLL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Chat {
    pub id: String,
    pub title: String,
    #[serde(rename = "needsYou", default)]
    pub needs_you: u32,
    /// The engine sends the time of the halt as text ("14:02"), or null when the chat is not halted.
    #[serde(default, deserialize_with = "halted_flag")]
    pub halted: bool,
}

fn halted_flag<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Bool(b) => b,
        serde_json::Value::String(s) => !s.is_empty(),
        _ => false,
    })
}

pub fn parse_chats(text: &str) -> Option<Vec<Chat>> {
    serde_json::from_str(text).ok()
}

pub fn total_needs_you(chats: &[Chat]) -> u32 {
    chats.iter().map(|c| c.needs_you).sum()
}

/// The text beside the icon. Nothing when the count is 0.
pub fn title_for(total: u32) -> Option<String> {
    (total > 0).then(|| total.to_string())
}

/// The titles of the chats whose count went up since the last poll.
pub fn risen(before: &HashMap<String, u32>, chats: &[Chat]) -> Vec<String> {
    chats
        .iter()
        .filter(|c| c.needs_you > before.get(&c.id).copied().unwrap_or(0))
        .map(|c| c.title.clone())
        .collect()
}

/// Halt entries only for chats that are not halted already.
pub fn halt_targets(chats: &[Chat]) -> Vec<&Chat> {
    chats.iter().filter(|c| !c.halted).collect()
}

/// Keeps letters, digits, `-`, `_` and `.`; every other byte becomes `%XX`.
pub fn path_segment(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn build_menu(app: &AppHandle, chats: &[Chat]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let targets = halt_targets(chats);
    for chat in &targets {
        let item = MenuItem::with_id(app, format!("halt:{}", chat.id), format!("Halt {}", chat.title), true, None::<&str>)?;
        menu.append(&item)?;
    }
    if !targets.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "open", "Open Starship", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "open" => show_window(app),
        "quit" => app.exit(0),
        _ => {
            if let Some(chat) = id.strip_prefix("halt:") {
                let path = format!("/api/chats/{}/halt", path_segment(chat));
                thread::spawn(move || {
                    if let Some(info) = engine::read_info() {
                        let _ = engine::post(&info, &path);
                    }
                });
            }
        }
    }
}

pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let tray = TrayIconBuilder::with_id("starship")
        .icon(icon)
        .icon_as_template(true)
        .menu(&build_menu(app, &[])?)
        .on_menu_event(on_menu)
        .build(app)?;
    let _ = app.notification().request_permission();
    let app = app.clone();
    thread::spawn(move || poll(app, tray));
    Ok(())
}

fn poll(app: AppHandle, tray: TrayIcon) {
    let mut before: Option<HashMap<String, u32>> = None;
    let mut shown = String::new();
    loop {
        thread::sleep(POLL);
        let Some(chats) = engine::read_info()
            .and_then(|info| engine::get(&info, "/api/chats").ok())
            .and_then(|body| parse_chats(&body))
        else {
            continue;
        };
        let _ = tray.set_title(title_for(total_needs_you(&chats)));

        let signature: String = halt_targets(&chats).iter().map(|c| format!("{}\u{0}{}\u{1}", c.id, c.title)).collect();
        if signature != shown {
            if let Ok(menu) = build_menu(&app, &chats) {
                let _ = tray.set_menu(Some(menu));
                shown = signature;
            }
        }

        // The first poll is the baseline: what already waited when the app opened is not news.
        if let Some(before) = &before {
            let titles = risen(before, &chats);
            if !titles.is_empty() {
                let _ = app.notification().builder().title(titles.join(", ")).body("needs you").show();
            }
        }
        before = Some(chats.iter().map(|c| (c.id.clone(), c.needs_you)).collect());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, needs_you: u32, halted: bool) -> Chat {
        Chat { id: id.into(), title: format!("Chat {id}"), needs_you, halted }
    }

    #[test]
    fn parses_the_chat_list() {
        let chats = parse_chats(r#"[{"id":"a","title":"One","repo":"r","needsYou":2,"halted":false},{"id":"b","title":"Two","halted":true}]"#).unwrap();
        assert_eq!(chats, vec![Chat { id: "a".into(), title: "One".into(), needs_you: 2, halted: false }, Chat { id: "b".into(), title: "Two".into(), needs_you: 0, halted: true }]);
        assert_eq!(parse_chats("{}"), None);
    }

    #[test]
    fn parses_the_halted_field_as_the_engine_sends_it() {
        let chats = parse_chats(r#"[{"id":"a","title":"One","repo":null,"stage":"build","halted":"14:02","needsYou":1},{"id":"b","title":"Two","repo":null,"stage":null,"halted":null,"needsYou":0}]"#).unwrap();
        assert!(chats[0].halted);
        assert!(!chats[1].halted);
        assert_eq!(halt_targets(&chats).len(), 1);
    }

    #[test]
    fn sums_needs_you_over_all_chats() {
        assert_eq!(total_needs_you(&[]), 0);
        assert_eq!(total_needs_you(&[chat("a", 2, false), chat("b", 3, true)]), 5);
    }

    #[test]
    fn shows_no_number_for_zero() {
        assert_eq!(title_for(0), None);
        assert_eq!(title_for(4), Some("4".into()));
    }

    #[test]
    fn finds_the_chats_whose_count_rose() {
        let before = HashMap::from([("a".to_string(), 1), ("b".to_string(), 2)]);
        let now = [chat("a", 2, false), chat("b", 2, false), chat("c", 1, false), chat("d", 0, false)];
        assert_eq!(risen(&before, &now), vec!["Chat a".to_string(), "Chat c".to_string()]);
        assert!(risen(&before, &[chat("a", 0, false)]).is_empty());
    }

    #[test]
    fn halt_entries_skip_halted_chats() {
        let chats = [chat("a", 0, false), chat("b", 0, true)];
        let ids: Vec<&str> = halt_targets(&chats).iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
    }

    #[test]
    fn encodes_a_chat_id_for_the_path() {
        assert_eq!(path_segment("fix-login_2.1"), "fix-login_2.1");
        assert_eq!(path_segment("a/b?c"), "a%2Fb%3Fc");
    }
}
