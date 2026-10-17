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
    if let Ok(url) = url::Url::parse(&info.api_base) {
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
