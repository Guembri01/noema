//! Native menu and system tray — the "it feels like an app" layer.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::commands;

/// Build the application menu (macOS gets the app submenu automatically).
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new_note = MenuItemBuilder::with_id("new-note", "New note")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let quick_find = MenuItemBuilder::with_id("quick-find", "Quick find…")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let search = MenuItemBuilder::with_id("search", "Search…")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // Settings lives in the app submenu on macOS (the platform convention) and in
    // File everywhere else — which also means the item is used on every platform,
    // rather than existing only for the macOS branch.
    #[cfg_attr(target_os = "macos", allow(unused_mut))]
    let mut file_builder = SubmenuBuilder::new(app, "File")
        .item(&new_note)
        .separator()
        .item(&quick_find)
        .item(&search)
        .separator();
    #[cfg(not(target_os = "macos"))]
    {
        file_builder = file_builder.item(&settings).separator();
    }
    let file = file_builder.close_window().quit().build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let data = SubmenuBuilder::new(app, "Data")
        .item(
            &MenuItemBuilder::with_id("open-data", "Open data folder")
                .accelerator("CmdOrCtrl+Shift+D")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("restart-server", "Restart local server").build(app)?)
        .item(&MenuItemBuilder::with_id("diagnostics", "Diagnostics…").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("backup", "Back up now")
                .accelerator("CmdOrCtrl+Shift+B")
                .build(app)?,
        )
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("reload", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Zoom in")
                .accelerator("CmdOrCtrl+Plus")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Zoom out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-reset", "Actual size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .separator()
        .fullscreen()
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("docs", "Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id("shortcuts", "Keyboard shortcuts").build(app)?)
        // "About" sits in Help on every platform rather than in the macOS app
        // submenu: the credits should be one click away everywhere, and a
        // second platform-specific item is how the two menus drift apart.
        .item(&MenuItemBuilder::with_id("about", "About Noema").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("check-update", "Check for updates…").build(app)?)
        .build()?;

    // macOS gets the conventional app submenu (Settings, Services, Hide, Quit).
    // Those predefined items — `services`, `hide`, `hide_others`, `show_all` —
    // are macOS-only in Tauri, and calling them on Windows/Linux fails, which
    // used to travel up through `setup()` into `.expect(...)`: an immediate,
    // message-less crash (0xC0000409) on a platform where the items make no
    // sense anyway.
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "Noema")
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let mut top: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    #[cfg(target_os = "macos")]
    top.push(&app_menu);
    top.extend([
        &file as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &edit,
        &data,
        &view,
        &help,
    ]);

    MenuBuilder::new(app).items(&top).build()
}

/// Handle a menu / tray click. Kept as one function so the two entry points
/// cannot drift.
pub fn on_shell_command(app: &AppHandle, id: &str) {
    match id {
        "new-note" => emit(app, "shell://new-note"),
        "quick-find" => emit(app, "shell://quick-find"),
        "search" => emit(app, "shell://search"),
        "settings" => emit(app, "shell://settings"),
        "diagnostics" => emit(app, "shell://diagnostics"),
        "backup" => emit(app, "shell://backup"),
        "shortcuts" => emit(app, "shell://shortcuts"),
        "about" => emit(app, "shell://about"),
        "docs" => {
            let _ = app.opener().open_url(
                "https://github.com/Guembri01/noema/tree/main/docs",
                None::<&str>,
            );
        }
        "open-data" => {
            tauri::async_runtime::spawn({
                let app = app.clone();
                async move {
                    let _ = commands::open_data_dir(app).await;
                }
            });
        }
        "restart-server" => {
            tauri::async_runtime::spawn({
                let app = app.clone();
                async move {
                    let _ = crate::sidecar::stop(&app).await;
                    let _ = crate::sidecar::start(&app).await;
                }
            });
        }
        "reload" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
        "zoom-in" => set_zoom(app, 0.1),
        "zoom-out" => set_zoom(app, -0.1),
        "zoom-reset" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("document.documentElement.style.zoom = '1'");
            }
        }
        "check-update" => emit(app, "shell://check-update"),
        "quit" => {
            tauri::async_runtime::spawn({
                let app = app.clone();
                async move { crate::commands::quit(app).await }
            });
        }
        _ => {}
    }
}

fn emit(app: &AppHandle, event: &str) {
    use tauri::Emitter;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        let _ = app.emit(event, ());
    }
}

fn set_zoom(app: &AppHandle, delta: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            "(() => {{ const z = parseFloat(document.documentElement.style.zoom || '1'); document.documentElement.style.zoom = String(Math.min(3, Math.max(0.5, z + {delta}))); }})()"
        );
        let _ = window.eval(script);
    }
}

/// The tray icon: the app's always-available entry point.
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("tray-show", "Open Noema").build(app)?)
        .item(&MenuItemBuilder::with_id("new-note", "New note").build(app)?)
        .item(&MenuItemBuilder::with_id("quick-find", "Quick find…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("restart-server", "Restart local server").build(app)?)
        .item(&MenuItemBuilder::with_id("open-data", "Open data folder").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("check-update", "Check for updates…").build(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit Noema").build(app)?)
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main")
        .icon_as_template(true)
        .tooltip("Noema")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_shell_command(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            // Left-click focuses the window (macOS/Windows convention).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
    // A tray without an icon is useless; use the app's own icon when the
    // runtime has one, and otherwise let the tray menu exist regardless.
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

use tauri_plugin_opener::OpenerExt as _;
