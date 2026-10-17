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
    /// Postgres connection string for the local server (see `sidecar`).
    pub const DATABASE_URL: &str = "databaseUrl";
}

/// Tidy a connection string the way databases, `.env` files and humans actually
/// write them: `DATABASE_URL="postgresql://…"` is the conventional form, and a
/// pasted value often arrives with its quoting intact.
pub fn normalise_database_url(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

/// The database the local server should use, or an **empty string** when the user
/// has not configured one.
///
/// Resolution order, first match wins:
///  1. `NOEMA_DATABASE_URL` — for CI, portable installs and support ("try this
///     connection string");
///  2. the value saved by the first-run screen / Settings.
///
/// Returning empty is deliberate, and it is what makes "nothing has to be
/// installed" true: with no URL, the bundled server provisions **its own embedded
/// PostgreSQL** (PGlite — real Postgres compiled to WebAssembly, see
/// `scripts/desktop/embedded-db.cjs`). Defaulting to `localhost:5432` here is
/// exactly what used to force every user to bring their own database.
pub fn database_url(app: &AppHandle) -> String {
    if let Ok(explicit) = std::env::var("NOEMA_DATABASE_URL") {
        let cleaned = normalise_database_url(&explicit);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    normalise_database_url(&pref::<String>(app, prefs::DATABASE_URL, String::new()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quoted_connection_string_is_unwrapped() {
        // `DATABASE_URL="postgresql://…"` is the conventional .env form, and a
        // pasted value often keeps its quotes. Prisma rejects both.
        assert_eq!(
            normalise_database_url("\"postgresql://u:p@host:5432/db?schema=public\""),
            "postgresql://u:p@host:5432/db?schema=public"
        );
        assert_eq!(
            normalise_database_url("  'postgresql://u@h/db'  "),
            "postgresql://u@h/db"
        );
        assert_eq!(
            normalise_database_url("  postgresql://u@h/db  "),
            "postgresql://u@h/db"
        );
        assert_eq!(normalise_database_url("\"\""), "");
        assert_eq!(normalise_database_url("   "), "");
    }
}
