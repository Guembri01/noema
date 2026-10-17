//! App-wide state and the per-user paths the desktop build owns.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

/// Preferences persisted in the app's own store (not the server database):
/// window/theme/update channel and the last known port.
pub const PREFS_FILE: &str = "preferences.json";

/// Key names inside `preferences.json`.
pub mod prefs {
    pub const THEME: &str = "theme";
    pub const UPDATE_CHANNEL: &str = "updateChannel";
    pub const AUTO_UPDATE: &str = "autoUpdate";
    pub const LAST_PORT: &str = "lastPort";
    pub const ONBOARDED: &str = "onboarded";
    pub const ZOOM: &str = "zoom";
}

/// The per-user data directory (`…/Application Support/app.noema.desktop` on
/// macOS, `%APPDATA%\app.noema.desktop` on Windows, `~/.local/share/…` on Linux).
///
/// `NOEMA_DATA_DIR` overrides it so a portable install (or CI) can point
/// somewhere else without rebuilding.
pub fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("NOEMA_DATA_DIR") {
        if !explicit.trim().is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    app.path()
        .app_data_dir()
        .ok()
        .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.data_dir().join("noema")))
}

/// `logs/` under the data directory.
pub fn log_dir(app: &AppHandle) -> Option<PathBuf> {
    data_dir(app).map(|dir| dir.join("logs"))
}

/// Read a preference, falling back to a default.
pub fn pref<T: serde::de::DeserializeOwned>(app: &AppHandle, key: &str, fallback: T) -> T {
    let Ok(store) = app.store(PREFS_FILE) else {
        return fallback;
    };
    store
        .get(key)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or(fallback)
}

/// Write a preference (best effort: a failed write must never break the app).
pub fn set_pref(app: &AppHandle, key: &str, value: serde_json::Value) {
    if let Ok(store) = app.store(PREFS_FILE) {
        store.set(key, value);
        let _ = store.save();
    }
}
