//! Tauri commands the webview calls (via `@tauri-apps/api`, the JS API).
//!
//! Everything here is a thin, well-typed wrapper over the shell. The webview
//! never touches the filesystem or the process table directly except through
//! these commands, so the "allow everything" capability set stays auditable.

use serde::Serialize;
use std::path::Path;
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
        database_url: {
            // No configured URL means the bundled server is running its own
            // embedded database; say so rather than printing an empty field.
            let resolved = state::database_url(&app);
            if resolved.trim().is_empty() {
                "embedded (in-app PostgreSQL)".to_string()
            } else {
                redact(&resolved)
            }
        },
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
///
/// The database connection string is **not** among them: the store holds it
/// unredacted (`set_database_url` writes it there), and this command reads
/// *any* key — so it would hand the password straight past the redaction
/// `desktop_info` does. `database_url` is the redacted way to ask for it.
#[tauri::command]
pub fn get_pref(app: AppHandle, key: String) -> Option<serde_json::Value> {
    read_pref(
        |key| {
            app.store(state::PREFS_FILE)
                .ok()
                .and_then(|store| store.get(key))
        },
        &key,
    )
}

/// Read a preference, refusing the one that holds a secret.
///
/// The lookup is injected so the rule can be proven without a running app:
/// `get_pref` needs an `AppHandle`, and a unit test has none.
fn read_pref<F>(lookup: F, key: &str) -> Option<serde_json::Value>
where
    F: Fn(&str) -> Option<serde_json::Value>,
{
    if key == state::prefs::DATABASE_URL {
        return None;
    }
    lookup(key)
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
    let trimmed = state::normalise_database_url(&url);
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
///
/// **Redacted**: the password must not leave the shell, not even to the
/// shell's own page. `desktop_info` hands out the same redacted form.
#[tauri::command]
pub fn database_url(app: AppHandle) -> String {
    redacted_connection_string(&state::database_url(&app))
}

/// The connection string as the shell hands it out: **redacted**, or empty
/// when the user has configured none.
fn redacted_connection_string(resolved: &str) -> String {
    if resolved.trim().is_empty() {
        String::new()
    } else {
        redact(resolved)
    }
}

/// Toggle the native window decorations (for a "focus mode").
#[tauri::command]
pub fn set_decorations(app: AppHandle, decorated: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window.set_decorations(decorated).map_err(|e| e.to_string())
}

/// The window theme a stored preference asks for.
///
/// `"system"` — and anything unrecognised, which is treated the same way rather
/// than pinning a wrong look — is `None`: hand the window back to the OS, which
/// keeps following the desktop setting live.
pub fn theme_from_name(name: &str) -> Option<tauri::Theme> {
    match name {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// Paint the window chrome in the workspace's theme.
///
/// The title bar, menus and scrollbars are drawn by the OS; the page's
/// `class="dark"` cannot reach them. Without this, a light workspace inside a
/// dark-skinned desktop showed a dark title bar above a light page.
pub fn apply_theme(app: &AppHandle, name: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window
        .set_theme(theme_from_name(name))
        .map_err(|error| error.to_string())
}

/// Set the workspace theme: apply it now *and* remember it for the next launch.
#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    state::set_pref(
        &app,
        state::prefs::THEME,
        serde_json::Value::String(theme.clone()),
    );
    // On disk as well as on screen: when the window chrome and the page
    // disagree, this line is what says which of the two the shell believes.
    logging::line(
        &app,
        "lifecycle",
        &format!("window theme set to \"{theme}\" by the app"),
    );
    apply_theme(&app, &theme)
}

/// Quit the app cleanly (stops the server first).
#[tauri::command]
pub async fn quit(app: AppHandle) {
    sidecar::stop(&app).await;
    app.exit(0);
}

/// The parts of the data directory a backup keeps.
///
/// The database (`pgdata/`), the uploaded files and the session file are the
/// irreplaceable content. Logs are deliberately left out (disposable), and
/// `backups/` must not be included or every backup would contain all the
/// previous ones.
const BACKUP_UNITS: &[&str] = &["pgdata", "uploads", "sessions.json"];

/// Days since 1970-01-01 → `(year, month, day)` in the proleptic Gregorian
/// calendar (Howard Hinnant's `civil_from_days`).
///
/// Hand-rolled rather than pulling in a date crate: this exists to name one
/// directory, and `Cargo.toml`'s dependency policy is explicit that every crate
/// is compiled on three platforms, so it has to earn its place.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// A `YYYYMMDD-HHMMSS` stamp in UTC.
///
/// Sorts chronologically as a string, and avoids the colon Windows forbids in a
/// file name — which is exactly why the local-time ISO form is not used.
fn utc_stamp(epoch_seconds: u64) -> String {
    let days = (epoch_seconds / 86_400) as i64;
    let rest = epoch_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Recursively copy a directory tree.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Copy every backup unit that exists into `backups/<name>/`.
///
/// A missing unit is not an error — a fresh install has no uploads yet — but
/// nothing at all to copy is, because reporting a backup that captured no data
/// would be worse than failing.
fn copy_backup_units(data_dir: &Path, name: &str) -> Result<(), String> {
    let destination = sidecar::backups_dir(data_dir).join(name);
    let mut copied = 0usize;
    for unit in BACKUP_UNITS {
        let from = data_dir.join(unit);
        if !from.exists() {
            continue;
        }
        let to = destination.join(unit);
        if from.is_dir() {
            copy_tree(&from, &to).map_err(|error| format!("{unit}: {error}"))?;
        } else {
            std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            std::fs::copy(&from, &to).map_err(|error| format!("{unit}: {error}"))?;
        }
        copied += 1;
    }
    if copied == 0 {
        return Err("there is nothing to back up yet".to_string());
    }
    Ok(())
}

/// Back up the user's data. Returns the name of the new backup directory.
///
/// The backup unit is the data directory, not a `pg_dump`: the embedded database
/// is a WebAssembly PostgreSQL with no binaries beside it, so its files *are* the
/// database (see `docs/DESKTOP.md` §3).
///
/// The server is stopped for the copy and started again afterwards. That is not
/// politeness — PGlite writes continuously, so copying it live can capture a torn
/// state — and it is why this is async and visibly slow. The restart happens on
/// every path, including a failed copy: the app must never be left without a
/// database because a backup went wrong.
#[tauri::command]
pub async fn backup_now(app: AppHandle) -> Result<String, String> {
    let dir = state::data_dir(&app).ok_or_else(|| "no data directory".to_string())?;
    let name = format!("noema-{}", utc_stamp(now_seconds()));
    logging::line(&app, "lifecycle", "backup: stopping the server to copy");
    sidecar::stop(&app).await;
    let result = copy_backup_units(&dir, &name);
    let _ = sidecar::start(&app).await;
    match &result {
        Ok(()) => logging::line(&app, "lifecycle", &format!("backup: wrote {name}")),
        Err(error) => logging::line(&app, "lifecycle", &format!("backup: failed ({error})")),
    }
    result.map(|()| name)
}

/// Seconds since the Unix epoch, or 0 if the clock is before 1970 (which cannot
/// happen on a real machine and must not panic if it somehow does).
fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
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

    /// The store holds the connection string unredacted, and `get_pref` reads
    /// *any* key — so this is the one key that must not come back out of the
    /// shell.
    #[test]
    fn get_pref_refuses_the_unredacted_connection_string() {
        let secret = serde_json::json!(
            "postgresql://noema:sup3r-secret@db.example.com:5432/noema?schema=public"
        );
        let lookup = |key: &str| {
            if key == crate::state::prefs::DATABASE_URL {
                Some(secret.clone())
            } else {
                None
            }
        };
        assert_eq!(
            read_pref(lookup, crate::state::prefs::DATABASE_URL),
            None,
            "the password must not leave the shell through get_pref"
        );
    }

    #[test]
    fn get_pref_still_returns_an_ordinary_preference() {
        let lookup = |key: &str| {
            if key == crate::state::prefs::THEME {
                Some(serde_json::json!("dark"))
            } else {
                None
            }
        };
        assert_eq!(
            read_pref(lookup, crate::state::prefs::THEME),
            Some(serde_json::json!("dark"))
        );
    }

    /// The connection string the shell hands out is for display only.
    #[test]
    fn the_connection_string_the_shell_hands_out_is_redacted() {
        let shown = redacted_connection_string(
            "postgresql://noema:sup3r-secret@db.example.com:5432/noema?schema=public",
        );
        assert!(!shown.contains("sup3r-secret"), "password leaked: {shown}");
        assert!(shown.contains("db.example.com:5432"), "host lost: {shown}");
        // No connection string configured: the shell says so with an empty
        // field, not with a placeholder that looks like one.
        assert_eq!(redacted_connection_string(""), "");
        assert_eq!(redacted_connection_string("   "), "");
    }

    #[test]
    fn theme_names_map_to_window_themes() {
        assert_eq!(theme_from_name("light"), Some(tauri::Theme::Light));
        assert_eq!(theme_from_name("dark"), Some(tauri::Theme::Dark));
    }

    #[test]
    fn an_unset_or_unknown_theme_leaves_the_window_to_the_os() {
        // "system" is a real preference the app offers, and a stale/garbled
        // store value falls the same way: follow the desktop rather than pin a
        // look the user did not ask for.
        assert_eq!(theme_from_name("system"), None);
        assert_eq!(theme_from_name(""), None);
        assert_eq!(theme_from_name("DARK"), None);
        assert_eq!(theme_from_name("solarized"), None);
    }

    /// The stamp is a directory name a user has to read in their file manager,
    /// so it must be the real date — and it must sort chronologically as a
    /// string, which is why the components are zero-padded and ordered
    /// biggest-first.
    #[test]
    fn the_backup_stamp_is_a_real_utc_date() {
        // 2026-10-16T15:50:12Z
        assert_eq!(utc_stamp(1_792_165_812), "20261016-155012");
        // The epoch, a leap day, and a year boundary: the three cases where
        // hand-rolled date arithmetic goes wrong.
        assert_eq!(utc_stamp(0), "19700101-000000");
        assert_eq!(utc_stamp(1_709_164_800), "20240229-000000");
        assert_eq!(utc_stamp(1_735_689_599), "20241231-235959");
        assert_eq!(utc_stamp(1_735_689_600), "20250101-000000");
    }

    #[test]
    fn stamps_sort_in_chronological_order() {
        let mut stamps = [
            utc_stamp(1_792_165_812),
            utc_stamp(0),
            utc_stamp(1_735_689_600),
            utc_stamp(1_709_164_800),
        ];
        stamps.sort();
        assert_eq!(
            stamps,
            [
                "19700101-000000",
                "20240229-000000",
                "20250101-000000",
                "20261016-155012",
            ]
        );
    }

    /// A backup is only worth anything if the data is actually in it, and it must
    /// never contain the backups folder — that would double in size on every run.
    #[test]
    fn a_backup_copies_the_content_and_never_the_previous_backups() {
        let root = std::env::temp_dir().join(format!("noema-backup-{}", rand::random::<u32>()));
        let pgdata = root.join("pgdata");
        std::fs::create_dir_all(pgdata.join("base")).expect("pgdata");
        std::fs::write(pgdata.join("PG_VERSION"), "17").expect("version file");
        std::fs::write(pgdata.join("base").join("chunk"), "rows").expect("nested file");
        std::fs::create_dir_all(root.join("uploads").join("nested")).expect("uploads");
        std::fs::write(root.join("uploads").join("nested").join("a.png"), "png").expect("upload");
        std::fs::write(root.join("sessions.json"), "[]").expect("sessions");
        // Noise that must not travel.
        std::fs::create_dir_all(root.join("logs")).expect("logs");
        std::fs::write(root.join("logs").join("noema.log"), "noise").expect("log");
        std::fs::create_dir_all(root.join("backups").join("noema-19700101-000000")).expect("old");
        std::fs::write(
            root.join("backups")
                .join("noema-19700101-000000")
                .join("pgdata"),
            "old backup",
        )
        .expect("old backup file");

        copy_backup_units(&root, "noema-20261016-143012").expect("copied");

        let out = root.join("backups").join("noema-20261016-143012");
        assert_eq!(
            std::fs::read_to_string(out.join("pgdata").join("PG_VERSION")).expect("copied file"),
            "17"
        );
        assert_eq!(
            std::fs::read_to_string(out.join("pgdata").join("base").join("chunk"))
                .expect("nested copy"),
            "rows"
        );
        assert_eq!(
            std::fs::read_to_string(out.join("uploads").join("nested").join("a.png"))
                .expect("upload copy"),
            "png"
        );
        assert_eq!(
            std::fs::read_to_string(out.join("sessions.json")).expect("session copy"),
            "[]"
        );
        assert!(!out.join("logs").exists(), "logs are disposable");
        // The old backup inside `backups/` is not re-copied: only the three
        // declared units are, and `backups` is not one of them.
        assert!(!out.join("backups").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    /// Reporting success on an empty copy would be worse than failing.
    #[test]
    fn an_empty_data_directory_is_not_reported_as_a_backup() {
        let root = std::env::temp_dir().join(format!("noema-empty-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&root).expect("root");
        let error = copy_backup_units(&root, "noema-20261016-143012").expect_err("must fail");
        assert!(error.contains("nothing to back up"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn every_command_is_declared_for_the_acl() {
        // `build.rs` declares this list to Tauri so an `allow-<command>`
        // permission exists for each one; a capability can only hand out
        // permissions that exist, and a command with no permission is
        // unreachable from the served app (that is how `set_theme` first came
        // back as "Command set_theme not allowed by ACL"). A command missing
        // from the list would fail at runtime, in the installed app, where no
        // test runs — so the two are checked against each other here.
        let source = include_str!("commands.rs");
        let build_script = include_str!("../build.rs");

        // Match the attribute as a *whole line*: every real one is on its own
        // line, while the marker also appears inside this test's own text.
        let lines: Vec<&str> = source.lines().collect();
        let mut declared = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            let signature = lines[index + 1..]
                .iter()
                .take(4)
                .find(|next| next.contains("fn "))
                .expect("a #[tauri::command] with no fn after it");
            let after_fn = &signature[signature.find("fn ").unwrap() + "fn ".len()..];
            let name: String = after_fn
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            assert!(!name.is_empty(), "could not read the command name");
            declared.push(name);
        }

        assert!(
            declared.len() >= 15,
            "only found {} commands — is the attribute still spelled `#[tauri::command]`?",
            declared.len()
        );
        for name in &declared {
            assert!(
                build_script.contains(&format!("\"{name}\"")),
                "`{name}` has no entry in build.rs APP_COMMANDS, so no `allow-{}` \
                 permission exists for it",
                name.replace('_', "-")
            );
        }
    }
}
