//! App-wide state and the per-user paths the desktop build owns.
//!
//! Only non-secret preferences live in the Tauri store. Password-equivalent
//! values (the Postgres connection string and the session signing secret) live
//! in the encrypted `secrets.bin` store instead — see [`crate::secrets`].

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::secrets;

/// Preferences persisted in the app's own store (not the server database):
/// window/theme/update channel and the last known port.
pub const PREFS_FILE: &str = "preferences.json";

/// Legacy file the boot wrapper used to wrote the session secret to.
///
/// It is migrated into the encrypted store on first launch after the upgrade;
/// the file is removed only after the encrypted write succeeds.
pub const AUTH_SECRET_FILE: &str = "auth-secret";

/// The minimum session secret the server will accept.
///
/// 32 characters of generated hex is 128 bits of entropy. An explicitly
/// configured shorter value is rejected by the boot wrapper as well, so this
/// constant is not the only gate.
pub const MIN_AUTH_SECRET_CHARS: usize = 32;

/// Key names inside `preferences.json`.
pub mod prefs {
    pub const THEME: &str = "theme";
    pub const UPDATE_CHANNEL: &str = "updateChannel";
    pub const AUTO_UPDATE: &str = "autoUpdate";
    pub const LAST_PORT: &str = "lastPort";
    pub const ONBOARDED: &str = "onboarded";
    pub const ZOOM: &str = "zoom";
    /// Legacy Postgres connection string. It is migrated out on launch and must
    /// never be written back: the encrypted secret store replaces it.
    pub const DATABASE_URL: &str = "databaseUrl";
}

/// Names inside the encrypted secret store.
pub mod secret_keys {
    pub const DATABASE_URL: &str = "databaseUrl";
    pub const AUTH_SECRET: &str = "authSecret";
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

/// Is this a connection string the bundled server can safely be started with?
///
/// Prisma accepts `postgres://` and `postgresql://`; everything else (a local
/// file, an HTTP URL, a shell fragment) is rejected before it is persisted or
/// handed to a child process. Control characters are rejected too: they cannot
/// be part of a valid URL and are a classic way to split a value that is later
/// written to a line-oriented file.
pub fn validate_database_url(value: &str) -> Result<(), String> {
    let value = normalise_database_url(value);
    if value.is_empty() {
        return Ok(());
    }
    if value.chars().any(char::is_control) {
        return Err("the database URL contains control characters".to_string());
    }
    let parsed =
        url::Url::parse(&value).map_err(|error| format!("invalid database URL: {error}"))?;
    match parsed.scheme() {
        "postgres" | "postgresql" => {}
        other => {
            return Err(format!(
                "the database URL must use postgres:// or postgresql://, not {other}://"
            ));
        }
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("the database URL must name a host".to_string());
    }
    Ok(())
}

/// The database the local server should use, or an **empty string** when the user
/// has not configured one.
///
/// Resolution order, first match wins:
///  1. `NOEMA_DATABASE_URL` — for CI, portable installs and support ("try this
///     connection string");
///  2. the value saved by the first-run screen / Settings, from the encrypted
///     store.
///
/// Returning empty is deliberate, and it is what makes "nothing has to be
/// installed" true: with no URL, the bundled server provisions **its own embedded
/// PostgreSQL** (PGlite — real Postgres compiled to WebAssembly, see
/// `scripts/desktop/embedded-db.cjs`). Defaulting to `localhost:5432` here is
/// exactly what used to force every user to bring their own database.
pub fn database_url(app: &AppHandle) -> Result<String, String> {
    if let Ok(explicit) = std::env::var("NOEMA_DATABASE_URL") {
        let cleaned = normalise_database_url(&explicit);
        if !cleaned.is_empty() {
            validate_database_url(&cleaned)?;
            return Ok(cleaned);
        }
    }
    let dir = data_dir(app).ok_or_else(|| "no data directory".to_string())?;
    let stored = secrets::load(&dir)?;
    let value = stored
        .get(secret_keys::DATABASE_URL)
        .cloned()
        .unwrap_or_default();
    let value = normalise_database_url(&value);
    if !value.is_empty() {
        validate_database_url(&value)?;
    }
    Ok(value)
}

/// Store (or clear) the database connection string in the encrypted store.
pub fn set_database_url(app: &AppHandle, value: &str) -> Result<(), String> {
    let value = normalise_database_url(value);
    validate_database_url(&value)?;
    let dir = data_dir(app).ok_or_else(|| "no data directory".to_string())?;
    let mut stored = secrets::load(&dir)?;
    if value.is_empty() {
        stored.remove(secret_keys::DATABASE_URL);
    } else {
        stored.insert(secret_keys::DATABASE_URL.to_string(), value);
    }
    secrets::save(&dir, &stored)
}

/// The session signing secret, generated once per install and kept encrypted.
///
/// Existing installs migrated the old plain-text `auth-secret` file here on
/// first launch. If an encrypted value is present but too short, it is replaced
/// rather than trusted: a weak signing key is a session-forgery bug, not a
/// preference.
pub fn auth_secret(app: &AppHandle) -> Result<String, String> {
    let dir = data_dir(app).ok_or_else(|| "no data directory".to_string())?;
    let mut stored = secrets::load(&dir)?;
    if let Some(existing) = stored.get(secret_keys::AUTH_SECRET) {
        if existing.len() >= MIN_AUTH_SECRET_CHARS {
            return Ok(existing.clone());
        }
    }

    let legacy_file = dir.join(AUTH_SECRET_FILE);
    if let Ok(raw) = std::fs::read_to_string(&legacy_file) {
        let legacy = raw.trim();
        if legacy.len() >= MIN_AUTH_SECRET_CHARS {
            stored.insert(secret_keys::AUTH_SECRET.to_string(), legacy.to_string());
            secrets::save(&dir, &stored)?;
            let _ = std::fs::remove_file(&legacy_file);
            return Ok(legacy.to_string());
        }
    }

    let generated = new_auth_secret();
    stored.insert(secret_keys::AUTH_SECRET.to_string(), generated.clone());
    secrets::save(&dir, &stored)?;
    let _ = std::fs::remove_file(&legacy_file);
    Ok(generated)
}

/// 32 random bytes, hex encoded. The same construction as the shell token in
/// `sidecar`; `OsRng` is the OS CSPRNG, not a userspace PRNG.
fn new_auth_secret() -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    let mut secret = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        secret.push(HEX[(byte >> 4) as usize] as char);
        secret.push(HEX[(byte & 0x0f) as usize] as char);
    }
    secret
}

/// Move password-equivalent values out of the legacy plain-text locations.
///
/// This is idempotent and runs before the server starts. The encrypted write is
/// done first; only then is the old preference key deleted (and the old
/// `auth-secret` file removed). A failure at any point leaves the old copy for
/// the next launch instead of dropping the only copy of the user's database URL.
pub fn migrate_plaintext_secrets(app: &AppHandle) -> Result<(), String> {
    let dir = data_dir(app).ok_or_else(|| "no data directory".to_string())?;
    let mut stored = secrets::load(&dir)?;
    let mut changed = false;

    let legacy_auth_file = dir.join(AUTH_SECRET_FILE);
    if !stored.contains_key(secret_keys::AUTH_SECRET) {
        if let Ok(raw) = std::fs::read_to_string(&legacy_auth_file) {
            let value = raw.trim();
            if value.len() >= MIN_AUTH_SECRET_CHARS {
                stored.insert(secret_keys::AUTH_SECRET.to_string(), value.to_string());
                changed = true;
            }
        }
    }

    let store = app
        .store(PREFS_FILE)
        .map_err(|error| format!("could not open preferences: {error}"))?;
    let legacy_url = store.get(prefs::DATABASE_URL);
    if let Some(value) = legacy_url.as_ref().and_then(|value| value.as_str()) {
        let value = normalise_database_url(value);
        if !value.is_empty() && !stored.contains_key(secret_keys::DATABASE_URL) {
            // The old key is plain text. A value that does not validate cannot
            // become the encrypted database URL, but it can still contain a
            // password, so it is dropped rather than carried forward. The
            // server then uses the embedded database, and the first-run screen
            // can ask for a corrected URL.
            match validate_database_url(&value) {
                Ok(()) => {
                    stored.insert(secret_keys::DATABASE_URL.to_string(), value);
                    changed = true;
                }
                Err(error) => {
                    eprintln!("[noema] dropping invalid legacy database URL: {error}");
                }
            }
        }
    }

    if changed {
        secrets::save(&dir, &stored)?;
    }

    // The encrypted copy is durable now; the plain-text one is safe to remove.
    if legacy_url.is_some() {
        store.delete(prefs::DATABASE_URL);
        store
            .save()
            .map_err(|error| format!("could not rewrite preferences: {error}"))?;
    }
    if stored.contains_key(secret_keys::AUTH_SECRET) {
        let _ = std::fs::remove_file(&legacy_auth_file);
    }
    Ok(())
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

/// A remembered port is only worth using if it is a real user port: `0` (never
/// set), and anything the OS reserves for privileged processes, mean "no
/// preference".
pub fn plausible_port(value: u16) -> Option<u16> {
    (value > 1024).then_some(value)
}

/// The port this install served on last time, if it is still plausible.
///
/// The shell asks for it back so the document origin (`http://127.0.0.1:<port>`)
/// is stable across launches. Everything the app keeps in the browser — the
/// theme preference, sidebar width, open tabs, recent pages, and the offline
/// cache with its pending-mutation queue — is keyed by origin, so a fresh port
/// every launch silently reset all of it. If the port is taken by the time the
/// server starts, the sidecar falls back to an ephemeral one.
pub fn preferred_port(app: &AppHandle) -> Option<u16> {
    plausible_port(pref::<u16>(app, prefs::LAST_PORT, 0))
}

/// Remember the port the server actually bound, for the next launch.
pub fn remember_port(app: &AppHandle, port: u16) {
    set_pref(app, prefs::LAST_PORT, serde_json::Value::from(port));
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

/// Preferences the JavaScript preference command may write.
///
/// The connection string is deliberately absent: it lives in the encrypted
/// secret store and is written only through `set_database_url`.
pub fn writable_pref(key: &str) -> bool {
    matches!(
        key,
        prefs::THEME
            | prefs::UPDATE_CHANNEL
            | prefs::AUTO_UPDATE
            | prefs::LAST_PORT
            | prefs::ONBOARDED
            | prefs::ZOOM
    )
}

/// Subdirectories of the data directory the shell is willing to reveal.
///
/// An allow-list, not a traversal check: the name is joined to the data
/// directory by `open_data_subdir`, so a caller-supplied `../..` must never be
/// able to turn "open the logs" into "open any folder on disk".
const SAFE_DATA_SUBDIRS: &[&str] = &["uploads", "logs", "backups"];

/// Resolve a named data subdirectory, or `None` when the name is not safe.
pub fn data_subdir(data_dir: &Path, name: &str) -> Option<PathBuf> {
    if !SAFE_DATA_SUBDIRS.contains(&name) {
        return None;
    }
    Some(data_dir.join(name))
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

    #[test]
    fn only_postgres_urls_with_a_host_are_accepted() {
        assert!(validate_database_url("postgres://u:p@h:5432/db").is_ok());
        assert!(validate_database_url("postgresql://u@h/db").is_ok());
        assert!(validate_database_url("").is_ok());
        assert!(validate_database_url("mysql://u@h/db").is_err());
        assert!(validate_database_url("file:///tmp/db").is_err());
        assert!(validate_database_url("postgresql:///db").is_err());
        assert!(validate_database_url("postgresql://u@h/db\nX=1").is_err());
        assert!(validate_database_url("not a url").is_err());
    }

    #[test]
    fn only_a_real_user_port_counts_as_a_preference() {
        // `0` is what a missing key reads as, and the privileged range is never
        // something this app picked — both mean "let the OS choose".
        assert_eq!(plausible_port(0), None);
        assert_eq!(plausible_port(80), None);
        assert_eq!(plausible_port(1024), None);
        assert_eq!(plausible_port(1025), Some(1025));
        assert_eq!(plausible_port(51800), Some(51800));
    }

    #[test]
    fn only_non_secret_preferences_are_writable_from_the_webview() {
        assert!(writable_pref(prefs::THEME));
        assert!(writable_pref(prefs::ZOOM));
        assert!(writable_pref(prefs::LAST_PORT));
        assert!(!writable_pref(prefs::DATABASE_URL));
        assert!(!writable_pref("authSecret"));
    }

    #[test]
    fn data_subdirectories_are_an_allow_list() {
        let root = Path::new("/data/noema");
        assert_eq!(data_subdir(root, "uploads"), Some(root.join("uploads")));
        assert_eq!(data_subdir(root, "logs"), Some(root.join("logs")));
        assert_eq!(data_subdir(root, "backups"), Some(root.join("backups")));
        assert_eq!(data_subdir(root, ".."), None);
        assert_eq!(data_subdir(root, "../secrets"), None);
        assert_eq!(data_subdir(root, "C:\\Windows"), None);
        assert_eq!(data_subdir(root, ""), None);
        assert_eq!(data_subdir(root, "UPLOADS"), None);
    }
}
