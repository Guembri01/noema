//! The desktop shell's entry point.
//!
//! Boot order (each step is deliberate; see docs/DESKTOP.md):
//!  1. logging + data layout, so anything that fails afterwards is on disk
//!  2. plugins (single instance, store, log, opener, window state, shell…)
//!  3. native menu + tray, so the app is controllable even if the server fails
//!  4. **start the local server** and wait for `/api/ready`
//!  5. point the window at it and inject `window.__NOEMA_DESKTOP__`
//!
//! If step 4 fails the window still opens, on a bundled "not ready" page. That
//! page is also the first-run surface: the desktop build talks to a Postgres, so
//! if the default `localhost:5432` is not the user's database, they can paste a
//! connection string there and the shell restarts the server with it — no white
//! screen, no terminal, no reinstall.

pub mod commands;
pub mod logging;
pub mod shell;
pub mod sidecar;
pub mod state;

use std::path::PathBuf;

use sidecar::{SidecarEvent, SidecarState};
use tauri::{Emitter, Manager, RunEvent};

/// Record panics somewhere a user (or a support engineer) can find them.
///
/// The release profile aborts on panic, so without this a shipped app that dies
/// during boot leaves no trace whatsoever: the user sees a window that never
/// opens, and there is nothing in `logs/` because logging had not started yet.
/// That is precisely what happened the first time this app was installed.
///
/// The report goes to the OS temp directory — always writable, and it exists
/// before any of the app's own directories do — and additionally next to the
/// app's logs when the data directory is known.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let report = format!(
            "Noema {} — panic\nepoch: {seconds}\nversion: {}\nplatform: {}-{}\nthread: {:?}\n{info}\n\n",
            env!("CARGO_PKG_VERSION"),
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::thread::current().name().unwrap_or("unnamed"),
        );

        let mut targets = vec![std::env::temp_dir().join("noema-panic.log")];
        if let Ok(dir) = std::env::var("NOEMA_DATA_DIR") {
            if !dir.trim().is_empty() {
                let logs = PathBuf::from(dir).join("logs");
                let _ = std::fs::create_dir_all(&logs);
                targets.push(logs.join("panic.log"));
            }
        }
        for target in targets {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&target)
            {
                use std::io::Write as _;
                let _ = file.write_all(report.as_bytes());
            }
        }

        previous(info);
    }));
}

/// The theme value to hand to the served app.
///
/// Only the two concrete themes are passed through; `"system"` and anything
/// unrecognised become `"system"`, so a corrupt preference leaves the page
/// following the OS rather than pinned to a wrong look. Mirrors
/// `commands::theme_from_name`, which makes the same call for the window chrome.
fn theme_query(stored: &str) -> String {
    match stored {
        "light" | "dark" => stored.to_string(),
        _ => "system".to_string(),
    }
}

/// Inject the bridge object and point the window at the local server.
async fn attach_server(app: &tauri::AppHandle, info: &sidecar::SidecarInfo) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let bridge = serde_json::json!({
        "mode": "desktop",
        "apiBase": info.api_base,
        "dataDir": info.data_dir,
        "appVersion": app.package_info().version.to_string(),
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
    });
    let script = format!("window.__NOEMA_DESKTOP__ = Object.freeze({bridge});");
    let _ = window.eval(&script);
    if let Ok(mut url) = url::Url::parse(&info.api_base) {
        // Hand the stored theme over as a query parameter: the page's own store
        // (`localStorage`) is keyed by origin, and the port is only *preferred*
        // to be stable, so on a launch after a port change the page would
        // otherwise start on its default theme while the window chrome is
        // already painted in this one. The middleware turns the parameter into a
        // cookie and the server renders the theme into the first document, so
        // the first paint is right — see `src/lib/theme-preference.ts`.
        let stored_theme = state::pref::<String>(app, state::prefs::THEME, "system".to_string());
        url.query_pairs_mut()
            .append_pair("theme", &theme_query(&stored_theme));
        let _ = window.navigate(url);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing: a shipped app that dies during boot must leave a trace.
    install_panic_hook();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the first window instead of starting a
            // second server against the same data directory.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            commands::desktop_info,
            commands::restart_server,
            commands::stop_server,
            commands::set_database_url,
            commands::database_url,
            commands::open_data_dir,
            commands::open_data_subdir,
            commands::recent_logs,
            commands::log_file_path,
            commands::get_pref,
            commands::set_pref,
            commands::set_window_title,
            commands::set_zoom,
            commands::check_update,
            commands::set_decorations,
            commands::set_theme,
            commands::backup_now,
            commands::quit,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 1. data layout + file logging before anything else can fail.
            if let Some(dir) = state::data_dir(&handle) {
                if let Some(logs) = state::log_dir(&handle) {
                    logging::init_file_sink(logs);
                }
                let _ = sidecar::ensure_layout(&dir);
            }
            logging::line(
                &handle,
                "lifecycle",
                &format!(
                    "Noema {} starting on {}-{}",
                    handle.package_info().version,
                    std::env::consts::OS,
                    std::env::consts::ARCH
                ),
            );

            // 2. native menu + tray (the app stays controllable).
            let menu = shell::build_menu(&handle)?;
            app.set_menu(menu)?;
            shell::build_tray(&handle)?;
            app.on_menu_event(|app, event| shell::on_shell_command(app, event.id().as_ref()));

            // 3. the window is declared in `tauri.conf.json` (label "main") and
            //    loads the shell's own page (`frontendDist` = dist/index.html),
            //    which shows progress and, on failure, the database + retry
            //    controls. Declaring it in config and *not* rebuilding it here is
            //    deliberate: building a second window with the same label fails
            //    with "a webview with label `main` already exists".
            let window = app
                .get_webview_window("main")
                .ok_or("the main window is missing from tauri.conf.json")?;

            // Closing the window hides the app on macOS and quits elsewhere; the
            // server is stopped by the exit hook below either way.
            let window_for_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if cfg!(target_os = "macos") {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                }
            });

            // Paint the window chrome in the theme the workspace was last left
            // in — before the page loads, so the title bar never flashes the
            // desktop's theme over an app that disagrees with it. The webview
            // keeps the shell updated afterwards (`set_theme`).
            let stored_theme =
                state::pref::<String>(&handle, state::prefs::THEME, "system".to_string());
            if let Err(error) = commands::apply_theme(&handle, &stored_theme) {
                logging::line(
                    &handle,
                    "lifecycle",
                    &format!("could not apply the stored theme: {error}"),
                );
            }

            // 4. start the server, then attach the window to it.
            let app_for_boot = handle.clone();
            tauri::async_runtime::spawn(async move {
                match sidecar::start(&app_for_boot).await {
                    Ok(info) => attach_server(&app_for_boot, &info).await,
                    Err(error) => {
                        logging::line(
                            &app_for_boot,
                            "lifecycle",
                            &format!("server failed to start: {error}"),
                        );
                        // Keep the user in the app: the bootstrap page (already
                        // showing) can retry or fix the connection string.
                        let _ = app_for_boot.emit(
                            "sidecar://event",
                            SidecarEvent::Failed {
                                message: error.to_string(),
                            },
                        );
                    }
                }
            });

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Noema");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            // Stop the server before the process disappears so database handles
            // are released cleanly (this is what makes the next launch instant).
            let handle = app_handle.clone();
            tauri::async_runtime::block_on(async move {
                sidecar::stop(&handle).await;
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the two concrete themes travel to the page. `"system"` — and any
    /// value this build does not know, such as one written by a newer release —
    /// leaves the page following the OS instead of pinning a look the shell
    /// never asked for.
    #[test]
    fn only_a_concrete_theme_is_handed_to_the_page() {
        assert_eq!(theme_query("light"), "light");
        assert_eq!(theme_query("dark"), "dark");
        assert_eq!(theme_query("system"), "system");
        assert_eq!(theme_query(""), "system");
        assert_eq!(theme_query("solarized"), "system");
        assert_eq!(theme_query("DARK"), "system");
    }

    /// The value is read by the page from a query parameter, so it has to survive
    /// URL encoding intact and must never carry a character that could split the
    /// query string.
    #[test]
    fn the_handed_theme_is_url_safe() {
        for stored in ["light", "dark", "system", "nonsense"] {
            let value = theme_query(stored);
            let mut url = url::Url::parse("http://127.0.0.1:47821").expect("parse");
            url.query_pairs_mut().append_pair("theme", &value);
            let round_tripped = url
                .query_pairs()
                .find(|(key, _)| key == "theme")
                .map(|(_, value)| value.into_owned());
            assert_eq!(round_tripped.as_deref(), Some(value.as_str()));
            assert!(!value.contains('&') && !value.contains('=') && !value.contains('#'));
        }
    }
}
