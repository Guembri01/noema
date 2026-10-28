//! Keep the desktop webview on the two origins that are allowed to hold IPC
//! rights: the shell's own page and the exact local server this run started.
//!
//! Tauri's capability system can bind a remote capability to a *pattern*
//! (`http://127.0.0.1:*`), not to the port the supervisor just chose. Without a
//! navigation guard, any page that can get the webview to navigate to another
//! loopback port inherits `desktop-remote` — the same narrow but real IPC surface
//! the app has (read diagnostics, set theme, start a backup, restart the server).
//! A redirect from user content, a link with `target="_top"`, or a future
//! mistake in the app would be enough.
//!
//! The guard allows:
//!  * the shell's own origin (`http://tauri.localhost` on Windows,
//!    `tauri://localhost` elsewhere), where `dist/index.html` lives;
//!  * exactly the active server origin, including its port;
//!  * `about:blank`, the initial empty document;
//!  * the Vite dev server in debug builds.
//!
//! Anything else is denied. HTTP(S) links are handed to the user's browser
//! instead, which is what a documentation link should do anyway; everything
//! else (`javascript:`, `data:`, `file:`) is simply blocked.

use std::sync::Mutex;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// The origin of the currently running local server, if it is ready.
#[derive(Default)]
pub struct NavigationState {
    server_origin: Mutex<Option<Url>>,
}

/// Set (or clear) the exact origin the webview may navigate to.
pub fn set_server_origin<R: Runtime>(app: &tauri::AppHandle<R>, origin: Option<&str>) {
    let parsed = origin.and_then(|origin| Url::parse(origin).ok());
    if let Ok(mut current) = app.state::<NavigationState>().server_origin.lock() {
        *current = parsed;
    }
}

/// Is this URL allowed to become the webview's top-level document?
///
/// `debug_build` is a parameter rather than a global so the rule can be tested
/// on a release build.
pub fn is_allowed_navigation(url: &Url, server_origin: Option<&Url>, debug_build: bool) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if is_shell_origin(url) {
        return true;
    }
    if let Some(server) = server_origin {
        if url.origin() == server.origin() {
            return true;
        }
    }
    if debug_build {
        if let Ok(dev) = Url::parse("http://localhost:3200") {
            if url.origin() == dev.origin() {
                return true;
            }
        }
    }
    false
}

fn is_shell_origin(url: &Url) -> bool {
    match url.scheme() {
        // Tauri's custom protocol on Linux and macOS.
        "tauri" => url.host_str() == Some("localhost"),
        // Tauri's localhost mapping on Windows and Android.
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// The navigation-guard plugin.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let server = webview
                .state::<NavigationState>()
                .server_origin
                .lock()
                .ok()
                .and_then(|current| current.clone());
            if is_allowed_navigation(url, server.as_ref(), cfg!(debug_assertions)) {
                return true;
            }

            // A link in a note is a link, not a new application document. Send
            // it to the default browser; the app stays on its own origin.
            if matches!(url.scheme(), "http" | "https") {
                let _ = webview
                    .app_handle()
                    .opener()
                    .open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Url {
        Url::parse("http://127.0.0.1:47821").expect("server URL")
    }

    #[test]
    fn the_shell_page_is_allowed_on_every_desktop_platform() {
        for origin in [
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "tauri://localhost/index.html",
        ] {
            let url = Url::parse(origin).expect("shell URL");
            assert!(
                is_allowed_navigation(&url, Some(&server()), false),
                "{origin} should be allowed"
            );
        }
    }

    #[test]
    fn only_the_exact_active_server_origin_is_allowed() {
        assert!(is_allowed_navigation(
            &Url::parse("http://127.0.0.1:47821/login?next=/").expect("URL"),
            Some(&server()),
            false
        ));
        for other in [
            "http://127.0.0.1:47822/",
            "http://localhost:47821/",
            "http://127.0.0.1/",
            "https://127.0.0.1:47821/",
            "http://127.0.0.1.evil.example:47821/",
        ] {
            let url = Url::parse(other).expect("URL");
            assert!(
                !is_allowed_navigation(&url, Some(&server()), false),
                "{other} must not inherit the app's IPC rights"
            );
        }
    }

    #[test]
    fn external_and_dangerous_schemes_are_denied() {
        for other in [
            "https://example.com/",
            "http://192.168.1.10:47821/",
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///C:/Windows/System32/calc.exe",
        ] {
            let url = Url::parse(other).expect("URL");
            assert!(
                !is_allowed_navigation(&url, Some(&server()), false),
                "{other} must be blocked"
            );
        }
    }

    #[test]
    fn about_blank_is_allowed_before_the_page_loads() {
        assert!(is_allowed_navigation(
            &Url::parse("about:blank").expect("URL"),
            None,
            false
        ));
    }

    #[test]
    fn the_dev_server_is_only_allowed_in_a_debug_build() {
        let dev = Url::parse("http://localhost:3200/").expect("URL");
        assert!(is_allowed_navigation(&dev, None, true));
        assert!(!is_allowed_navigation(&dev, None, false));
    }

    #[test]
    fn an_origin_with_userinfo_cannot_spoof_the_host() {
        let url = Url::parse("http://127.0.0.1:47821@evil.example/").expect("URL");
        assert!(!is_allowed_navigation(&url, Some(&server()), false));
    }
}
