//! The icon in the notification area (ADR 0001): "All notes", "New note", "Show all notes",
//! "Quit"; a left click opens "All notes". "Quit" lets every open note save first
//! (`windows::quit`).
//!
//! The texts come from the windows, which own all translations (`set_tray_labels`). Until the
//! first window has loaded, the menu shows the English defaults. Where the platform has no
//! working tray (some Linux desktops), building it fails, closing "All notes" closes it, and
//! closing the last window quits.

use std::sync::Arc;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager as _, Runtime};

use crate::settings::SettingsStore;
use crate::store::Store;
use crate::windows;

pub const TRAY_ID: &str = "main";
const HUB_ITEM: &str = "hub";
const NEW_ITEM: &str = "new";
const SHOW_ALL_ITEM: &str = "show-all";
const QUIT_ITEM: &str = "quit";
/// Menu texts and tooltip are UI texts; a longer one is a mistake, not a translation.
const MAX_LABEL_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayLabels {
    pub all_notes: String,
    pub new_note: String,
    pub show_all: String,
    pub quit: String,
    pub tooltip: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            all_notes: "All notes".into(),
            new_note: "New note".into(),
            show_all: "Show all notes".into(),
            quit: "Quit".into(),
            tooltip: "Hangar Note".into(),
        }
    }
}

impl TrayLabels {
    /// One line each, without control characters, at most [`MAX_LABEL_CHARS`]; empty texts fall
    /// back to English so the menu never shows blank items.
    pub fn cleaned(&self) -> Self {
        let fallback = Self::default();
        let clean = |text: &str, fallback: String| {
            let text: String = text
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .take(MAX_LABEL_CHARS)
                .collect();
            let text = text.trim();
            if text.is_empty() {
                fallback
            } else {
                text.to_owned()
            }
        };
        Self {
            all_notes: clean(&self.all_notes, fallback.all_notes),
            new_note: clean(&self.new_note, fallback.new_note),
            show_all: clean(&self.show_all, fallback.show_all),
            quit: clean(&self.quit, fallback.quit),
            tooltip: clean(&self.tooltip, fallback.tooltip),
        }
    }
}

pub fn present<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

fn menu<R: Runtime>(app: &AppHandle<R>, labels: &TrayLabels) -> tauri::Result<Menu<R>> {
    let hub = MenuItem::with_id(app, HUB_ITEM, &labels.all_notes, true, None::<&str>)?;
    let new = MenuItem::with_id(app, NEW_ITEM, &labels.new_note, true, None::<&str>)?;
    let show_all = MenuItem::with_id(app, SHOW_ALL_ITEM, &labels.show_all, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ITEM, &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&hub, &new, &show_all, &separator, &quit])
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, item: &str) {
    let store = app.state::<Arc<Store>>();
    let result = match item {
        HUB_ITEM => windows::open_hub(app),
        NEW_ITEM => {
            windows::create_note(app, &store, &app.state::<SettingsStore>(), None).map(|_| ())
        }
        SHOW_ALL_ITEM => {
            windows::show_all_notes(app, &store);
            Ok(())
        }
        QUIT_ITEM => {
            windows::quit(app);
            Ok(())
        }
        _ => Ok(()),
    };
    if let Err(error) = result {
        eprintln!("hangar-note: tray action failed: {error}");
    }
}

/// Builds the icon with the English defaults. An error means no tray on this desktop.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let labels = TrayLabels::default();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu(app, &labels)?)
        .tooltip(&labels.tooltip)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = windows::open_hub(tray.app_handle()) {
                    eprintln!("hangar-note: All notes not opened: {error}");
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Replaces the menu and the tooltip with translated texts. Harmless to call again.
pub fn set_labels<R: Runtime>(app: &AppHandle<R>, labels: &TrayLabels) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let labels = labels.cleaned();
    tray.set_menu(Some(menu(app, &labels)?))?;
    tray.set_tooltip(Some(&labels.tooltip))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_one_short_line_with_english_fallbacks() {
        let labels = TrayLabels {
            all_notes: "Alle Notizen".into(),
            new_note: "Neue Notiz\r\n".into(),
            show_all: "x".repeat(200),
            quit: " ".into(),
            tooltip: String::new(),
        }
        .cleaned();
        assert_eq!(labels.all_notes, "Alle Notizen");
        assert_eq!(labels.new_note, "Neue Notiz");
        assert_eq!(labels.show_all.chars().count(), MAX_LABEL_CHARS);
        assert_eq!(labels.quit, "Quit");
        assert_eq!(labels.tooltip, "Hangar Note");
    }

    #[test]
    fn labels_arrive_as_in_the_contract() {
        let labels: TrayLabels = serde_json::from_value(serde_json::json!({
            "allNotes": "a", "newNote": "b", "showAll": "c", "quit": "d", "tooltip": "e"
        }))
        .unwrap();
        assert_eq!(labels.show_all, "c");
        assert!(
            serde_json::from_value::<TrayLabels>(serde_json::json!({ "allNotes": "x" })).is_err()
        );
    }
}
