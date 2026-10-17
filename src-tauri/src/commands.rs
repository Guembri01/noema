//! Tauri commands the webview calls (via `window.__TAURI__` or the JS API).
//!
//! Everything here is a thin, well-typed wrapper over the shell. The webview
//! never touches the filesystem or the process table directly except through
//! these commands, so the "allow everything" capability set stays auditable.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

use crate::logging;
use crate::sidecar::{self, SidecarInfo, SidecarState};
use crate::state;

/// Metadata the app reads on boot to switch into "app" mode.
#[derive(Debug, Clone, Serialize)]
pub struct DesktopInfo {
    pub mode: &'static str,
    pub api_base: String,
    pub data_dir: String,
    pub app_version: String,
    pub platform: String,
    pub arch: &'static str,
    pub ready: bool,
    pub port: Option<u16>,
    pub log_file: Option<String>,
    /// Redacted (credentials stripped) so diagnostics can be pasted safely.
    pub database_url: String,
}

/// Strip the password from a connection string before it leaves the shell.
pub fn redact(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            if parsed.password().is_some() {
                let _ = parsed.set_password(Some("***"));
            }
            parsed.to_string()
        }
        Err(_) => "<unparseable connection string>".to_string(),
    }
}

fn platform_triple() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[tauri::command]
pub async fn desktop_info(app: AppHandle) -> Result<DesktopInfo, String> {
    let info = app.state::<SidecarState>().info.lock().await.clone();
    let dir = state::data_dir(&app).ok_or_else(|| "no data directory".to_string())?;
    Ok(DesktopInfo {
        mode: "desktop",
        api_base: info
            .as_ref()
            .map(|i| i.api_base.clone())
            .unwrap_or_default(),
        data_dir: dir.to_string_lossy().into_owned(),
        app_version: app.package_info().version.to_string(),
        platform: platform_triple(),
        arch: std::env::consts::ARCH,
        ready: info.is_some(),
        port: info.map(|i| i.port),
        log_file: logging::current_file().map(|p| p.to_string_lossy().into_owned()),
        database_url: redact(&state::database_url(&app)),
    })
}

/// Restart the local server (used by the diagnostics panel).
#[tauri::command]
pub async fn restart_server(app: AppHandle) -> Result<SidecarInfo, String> {
    sidecar::stop(&app).await;
    sidecar::start(&app)
        .await
        .map_err(|error| error.to_string())
}

/// Stop the server without quitting the shell.
#[tauri::command]
pub async fn stop_server(app: AppHandle) -> Result<(), String> {
    sidecar::stop(&app).await;
    Ok(())
}

/// Reveal the data directory in the OS file manager.
#[tauri::command]
pub async fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = state::data_dir(&app).ok_or_else(|| "no data directory".to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Reveal a subfolder of the data directory (`uploads`, `logs`, `backups`).
#[tauri::command]
pub async fn open_data_subdir(app: AppHandle, name: String) -> Result<(), String> {
    let dir = state::data_dir(&app)
        .ok_or_else(|| "no data directory".to_string())?
        .join(name);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// The last N shell/server log lines for the diagnostics panel.
#[tauri::command]
pub fn recent_logs(limit: Option<usize>) -> Vec<String> {
    logging::recent(limit.unwrap_or(200))
}

/// Where the log file is (so the UI can offer "Reveal log").
#[tauri::command]
pub fn log_file_path() -> Option<String> {
    logging::current_file().map(|path| path.to_string_lossy().into_owned())
}

/// Read a preference from the shell's own store.
#[tauri::command]
pub fn get_pref(app: AppHandle, key: String) -> Option<serde_json::Value> {
    app.store(state::PREFS_FILE)
        .ok()
        .and_then(|store| store.get(key))
}

/// Write a preference.
#[tauri::command]
pub fn set_pref(app: AppHandle, key: String, value: serde_json::Value) {
    state::set_pref(&app, &key, value);
}

/// Update the window title (the page title changes as you navigate).
#[tauri::command]
pub fn set_window_title(app: AppHandle, title: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("{title} — Noema"));
    }
}

/// Zoom the webview (Ctrl/Cmd +/- are also bound natively).
#[tauri::command]
pub fn set_zoom(app: AppHandle, factor: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window
        .eval(format!(
            "document.documentElement.style.zoom = '{}'",
            factor.clamp(0.5, 3.0)
        ))
        .map_err(|error| error.to_string())
}

/// Check for an update and return its version, if any (no install).
///
/// Deliberately absent right now: the updater needs a signing key pair and a
/// release endpoint, and shipping an updater that cannot verify a signature is
/// worse than shipping none. See docs/DESKTOP.md §"Deferred".
#[tauri::command]
pub async fn check_update() -> Result<Option<String>, String> {
    Ok(None)
}

/// Save the database connection string and restart the server with it.
#[tauri::command]
pub async fn set_database_url(app: AppHandle, url: String) -> Result<SidecarInfo, String> {
    let trimmed = url.trim().to_string();
    state::set_pref(
        &app,
        state::prefs::DATABASE_URL,
        serde_json::Value::String(trimmed),
    );
    sidecar::stop(&app).await;
    sidecar::start(&app)
        .await
        .map_err(|error| error.to_string())
}

/// The connection string currently in use (for the diagnostics panel).
#[tauri::command]
pub fn database_url(app: AppHandle) -> String {
    state::database_url(&app)
}

/// Toggle the native window decorations (for a "focus mode").
#[tauri::command]
pub fn set_decorations(app: AppHandle, decorated: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window.set_decorations(decorated).map_err(|e| e.to_string())
}

/// Quit the app cleanly (stops the server first).
#[tauri::command]
pub async fn quit(app: AppHandle) {
    sidecar::stop(&app).await;
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_hides_the_password_but_keeps_the_rest() {
        let redacted =
            redact("postgresql://noema:sup3r-secret@db.example.com:5432/noema?schema=public");
        assert!(
            !redacted.contains("sup3r-secret"),
            "password leaked: {redacted}"
        );
        assert!(
            redacted.contains("db.example.com:5432"),
            "host lost: {redacted}"
        );
        assert!(redacted.contains("noema"), "database name lost: {redacted}");
    }

    #[test]
    fn redact_leaves_a_passwordless_url_alone() {
        let url = "postgresql://postgres@127.0.0.1:5432/noema";
        assert!(redact(url).contains("127.0.0.1:5432"));
        assert!(!redact(url).contains("***"));
    }

    #[test]
    fn redact_never_echoes_garbage_back() {
        assert_eq!(redact("not a url"), "<unparseable connection string>");
    }
}
