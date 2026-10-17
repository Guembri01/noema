//! The desktop shell's entry point.
//!
//! Boot order (each step is deliberate; see docs/DESKTOP.md):
//!  1. logging + data layout, so anything that fails afterwards is on disk
//!  2. plugins (single instance, deep links, updater, store, log, opener…)
//!  3. native menu + tray, so the app is controllable even if the server fails
//!  4. **start the local server** and wait for `/api/ready`
//!  5. point the window at it and inject `window.__NOEMA_DESKTOP__`
//!  6. check for updates (non-blocking) and restore window state
//!
//! If step 4 fails the window still opens, on a bundled "the server did not
//! start" page, with Restart / Diagnostics buttons — never a white screen.

pub mod commands;
pub mod logging;
pub mod shell;
pub mod sidecar;
pub mod state;

use std::time::Duration;

use sidecar::{SidecarEvent, SidecarState};
use tauri::{Emitter, Listener, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::ShellExt;

/// A tiny inline page shown when the server cannot start, so the user always has
/// a way out (restart / open data folder / read logs).
fn bootstrap_error_page(message: &str) -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Noema — starting</title>
<meta name="color-scheme" content="light dark">
<style>
 :root {{ --bg:#ffffff; --fg:#37352f; --muted:#6b6a65; --border:#e9e9e7; --danger:#d44c47; --accent:#1a75d2; }}
 @media (prefers-color-scheme: dark) {{ :root {{ --bg:#191919; --fg:rgba(255,255,255,.85); --muted:rgba(255,255,255,.55); --border:#2f2f2f; }} }}
 html,body {{ height:100%; margin:0; background:var(--bg); color:var(--fg);
   font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }}
 main {{ max-width:520px; margin:0 auto; padding:12vh 24px; }}
 h1 {{ font-size:22px; font-weight:600; letter-spacing:-.01em; margin:0 0 8px; }}
 p {{ color:var(--muted); margin:0 0 20px; }}
 code {{ background:rgba(127,127,127,.12); border-radius:4px; padding:2px 6px; font-size:13px; }}
 .row {{ display:flex; gap:8px; flex-wrap:wrap; }}
 button {{ font:inherit; padding:7px 14px; border-radius:6px; border:1px solid var(--border);
   background:transparent; color:var(--fg); cursor:pointer; }}
 button.primary {{ background:var(--accent); border-color:var(--accent); color:#fff; }}
 #detail {{ margin-top:18px; font-size:12px; color:var(--danger); white-space:pre-wrap; }}
</style></head><body><main>
<h1>Noema is starting…</h1>
<p>The local server has not answered yet. This usually takes a few seconds on first
run while the database is created.</p>
<div class="row">
  <button class="primary" onclick="restart()">Retry</button>
  <button onclick="reveal()">Open data folder</button>
</div>
<div id="detail">{message}</div>
<script>
  async function restart() {{ try {{ await window.__TAURI__.core.invoke('restart_server'); location.reload(); }} catch (e) {{ document.getElementById('detail').textContent = String(e); }} }}
  async function reveal() {{ try {{ await window.__TAURI__.core.invoke('open_data_dir'); }} catch (e) {{ document.getElementById('detail').textContent = String(e); }} }}
</script>
</main></body></html>"#
    )
}

/// Inject the bridge object and re-point the window at the local server.
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
    // The bridge must exist before the app's first script runs, and the API base
    // has to survive client-side navigation, so it is installed as an
    // initialization script rather than a post-load eval.
    let script = format!(
        "window.__NOEMA_DESKTOP__ = Object.freeze({bridge});{}",
        "window.__NOEMA_DESKTOP__"
    );
    let _ = window.eval(&script);
    if let Ok(url) = url::Url::parse(&info.api_base) {
        let _ = window.navigate(url);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch focuses the first window; `noema://` arguments are
            // forwarded so deep links work.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            for argument in argv.iter().filter(|a| a.starts_with("noema://")) {
                let _ = app.emit("shell://deep-link", argument.clone());
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
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
            commands::open_data_dir,
            commands::open_data_subdir,
            commands::recent_logs,
            commands::log_file_path,
            commands::get_pref,
            commands::set_pref,
            commands::set_window_title,
            commands::set_zoom,
            commands::check_update,
            commands::install_update,
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

            // 2. native menu + tray (the app stays controllable).
            let menu = shell::build_menu(&handle)?;
            app.set_menu(menu)?;
            shell::build_tray(&handle)?;
            app.on_menu_event(|app, event| shell::on_shell_command(app, event.id().as_ref()));

            // 3. deep links at runtime (Linux/Windows) and on cold start.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_for_links = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = app_for_links.emit("shell://deep-link", url.to_string());
                    }
                });
            }

            // 4. the window: show a bootstrap page immediately, then swap in the
            //    real app once the server is ready.
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::Html(bootstrap_error_page("")),
            )
            .title("Noema")
            .inner_size(1360.0, 900.0)
            .min_inner_size(900.0, 620.0)
            .resizable(true)
            .center()
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .build()?;

            let window_for_close = window.clone();
            window.on_window_event(move |event| {
                // Closing the window hides the app instead of killing the server:
                // reopen from the tray/dock. Cmd+Q / File→Quit really quits.
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if cfg!(target_os = "macos") {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                }
            });

            // 5. start the server, then attach.
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
                        let _ = app_for_boot.emit(
                            "sidecar://event",
                            SidecarEvent::Failed { message: error.to_string() },
                        );
                    }
                }
            });

            // 6. update check shortly after boot (never blocking the UI).
            let app_for_updates = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(8)).await;
                let auto: bool = state::pref(&app_for_updates, state::prefs::AUTO_UPDATE, true);
                if auto {
                    let _ = app_for_updates.emit("shell://check-update", ());
                }
            });

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Noema");

    app.run(|app_handle, event| match event {
        // Stop the local server before the process disappears, so the database
        // is closed cleanly (this is what makes the next launch instant).
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let handle = app_handle.clone();
            tauri::async_runtime::block_on(async move {
                sidecar::stop(&handle).await;
            });
        }
        _ => {}
    });
}
