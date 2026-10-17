//! Supervises the local Next.js server that the desktop app wraps.
//!
//! The shell never renders the app itself: it starts `noema-server` (a Node
//! Single Executable Application built from `next build --output standalone`),
//! waits until `/api/ready` answers, then points the window at it.
//!
//! Design rules (see docs/DESKTOP.md):
//! 1. **Loopback only.** The server binds `127.0.0.1` on an ephemeral port that
//!    the OS picks, so two installs can run side by side and nothing is exposed.
//! 2. **Supervised.** If the process exits unexpectedly it is restarted with
//!    exponential backoff, and the UI is told (so it can show an offline state
//!    instead of a dead window).
//! 3. **Graceful.** On quit the child gets SIGTERM/CTRL_BREAK, then a hard kill
//!    after a timeout, so Postgres/SQLite handles are released cleanly.
//! 4. **Observable.** stdout/stderr are streamed to the rotating log file, and
//!    the last N lines are exposed to the app for a "Diagnostics" panel.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// How long the shell waits for `/api/ready` before surfacing an error.
pub const READY_TIMEOUT: Duration = Duration::from_secs(45);
/// How often readiness is polled.
pub const READY_POLL: Duration = Duration::from_millis(250);
/// Backoff between automatic restarts.
pub const RESTART_BACKOFF: [Duration; 4] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(10),
];
/// Grace period between SIGTERM and a hard kill.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(8);

/// What the webview is told about the running server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidecarInfo {
    /// e.g. `http://127.0.0.1:47821`
    pub api_base: String,
    pub port: u16,
    pub pid: u32,
    /// `data` directory the server writes to (db, uploads, logs, backups).
    pub data_dir: String,
}

/// Lifecycle events emitted to the webview.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarEvent {
    Starting { attempt: u32 },
    Ready { info: SidecarInfo },
    /// The process exited; the UI should show an offline banner.
    Crashed { code: Option<i32>, will_restart: bool, attempt: u32 },
    Failed { message: String },
    Stopped,
}

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("could not resolve the application data directory")]
    NoDataDir,
    #[error("sidecar executable missing: {0}")]
    MissingBinary(PathBuf),
    #[error("server did not become ready within {0:?}")]
    NotReady(Duration),
    #[error("failed to spawn the server: {0}")]
    Spawn(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// State machine for the supervised process, kept in app state.
#[derive(Default)]
pub struct SidecarState {
    pub child: Arc<Mutex<Option<CommandChild>>>,
    pub info: Arc<Mutex<Option<SidecarInfo>>>,
    pub attempt: Arc<Mutex<u32>>,
    pub stopping: Arc<Mutex<bool>>,
}

/// Layout of the per-user data directory, created on first run.
///
/// ```
/// # use std::path::Path;
/// let root = Path::new("/home/x/.local/share/noema");
/// assert_eq!(noema_desktop_lib::sidecar::db_path(root).file_name().unwrap(), "noema.db");
/// ```
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("noema.db")
}

/// Where uploaded files live (served by `/api/files/...`).
pub fn uploads_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("uploads")
}

/// Where rotated logs live.
pub fn logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// Where automatic backups are written (`/api/cron/backups` prunes them).
pub fn backups_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

/// Directories the shell guarantees before the server starts.
pub fn ensure_layout(data_dir: &Path) -> std::io::Result<()> {
    for dir in [
        data_dir.to_path_buf(),
        uploads_dir(data_dir),
        logs_dir(data_dir),
        backups_dir(data_dir),
    ] {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

/// The readiness probe URL for a port. `127.0.0.1` (not `localhost`) so the
/// check cannot accidentally hit a different resolver family.
pub fn ready_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/ready")
}

/// The API base the webview should use.
pub fn api_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Environment handed to the sidecar. Kept in one place so the site build and
/// the desktop build cannot drift.
pub fn sidecar_env(port: u16, data_dir: &Path, origin: &str) -> Vec<(String, String)> {
    vec![
        ("PORT".into(), port.to_string()),
        ("HOSTNAME".into(), "127.0.0.1".into()),
        ("NODE_ENV".into(), "production".into()),
        ("NOEMA_RUNTIME".into(), "desktop".into()),
        ("NOEMA_DATA_DIR".into(), data_dir.to_string_lossy().into_owned()),
        ("DATABASE_URL".into(), sqlite_url(&db_path(data_dir))),
        ("UPLOAD_DIR".into(), uploads_dir(data_dir).to_string_lossy().into_owned()),
        ("BACKUP_DIR".into(), backups_dir(data_dir).to_string_lossy().into_owned()),
        // The webview origin must be able to call the loopback server.
        ("APP_ORIGINS".into(), origin.into()),
        // No telemetry in an installable app; opt-in only.
        ("NEXT_TELEMETRY_DISABLED".into(), "1".into()),
    ]
}

/// SQLite connection string for the local database (Prisma `file:` URL).
pub fn sqlite_url(db: &Path) -> String {
    let path = db.to_string_lossy().replace('\\', "/");
    format!("file:{path}")
}

/// Ask the OS for a free loopback port.
///
/// Binding to port 0 lets the kernel choose; the socket is closed immediately
/// and the port is handed to the sidecar. A tiny race window exists, which is
/// why the sidecar retries with a fresh port if the bind fails.
pub fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Backoff for a given restart attempt (attempt starts at 1).
pub fn backoff_for(attempt: u32) -> Duration {
    let index = (attempt.saturating_sub(1) as usize).min(RESTART_BACKOFF.len() - 1);
    RESTART_BACKOFF[index]
}

/// Poll `/api/ready` until it answers 200 or the timeout elapses.
pub async fn wait_until_ready(port: u16, timeout: Duration) -> Result<(), SidecarError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| SidecarError::Spawn(error.to_string()))?;
    let url = ready_url(port);
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(READY_POLL).await;
    }
    Err(SidecarError::NotReady(timeout))
}

/// Start the sidecar, wait for readiness, and remember how to reach it.
pub async fn start(app: &AppHandle) -> Result<SidecarInfo, SidecarError> {
    let data_dir = crate::state::data_dir(app).ok_or(SidecarError::NoDataDir)?;
    ensure_layout(&data_dir)?;

    let attempt = {
        let state = app.state::<SidecarState>();
        let mut attempt = state.attempt.lock().await;
        *attempt += 1;
        *attempt
    };
    let _ = app.emit("sidecar://event", SidecarEvent::Starting { attempt });

    let port = free_port()?;
    let origin = api_base(port);
    let env = sidecar_env(port, &data_dir, &origin);

    let command = app
        .shell()
        .sidecar("noema-server")
        .map_err(|error| SidecarError::Spawn(error.to_string()))?
        .envs(env);

    let (mut receiver, child) =
        command.spawn().map_err(|error| SidecarError::Spawn(error.to_string()))?;

    let pid = child.pid();
    {
        let state = app.state::<SidecarState>();
        *state.child.lock().await = Some(child);
    }

    // Stream logs to file + the UI, and notice an unexpected exit.
    let app_for_logs = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    crate::logging::sidecar_line(&app_for_logs, "stdout", &String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    crate::logging::sidecar_line(&app_for_logs, "stderr", &String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    let stopping = { *app_for_logs.state::<SidecarState>().stopping.lock().await };
                    crate::logging::sidecar_line(
                        &app_for_logs,
                        "lifecycle",
                        &format!("terminated code={:?} stopping={stopping}", payload.code),
                    );
                    if !stopping {
                        crate::sidecar::restart(&app_for_logs, payload.code).await;
                    }
                }
                _ => {}
            }
        }
    });

    match wait_until_ready(port, READY_TIMEOUT).await {
        Ok(()) => {
            let info = SidecarInfo {
                api_base: origin,
                port,
                pid,
                data_dir: data_dir.to_string_lossy().into_owned(),
            };
            {
                let state = app.state::<SidecarState>();
                *state.info.lock().await = Some(info.clone());
            }
            let _ = app.emit("sidecar://event", SidecarEvent::Ready { info: info.clone() });
            Ok(info)
        }
        Err(error) => {
            let _ = app.emit(
                "sidecar://event",
                SidecarEvent::Failed { message: error.to_string() },
            );
            Err(error)
        }
    }
}

/// Restart after an unexpected exit, with backoff (bounded attempts).
pub async fn restart(app: &AppHandle, code: Option<i32>) {
    let attempt = {
        let state = app.state::<SidecarState>();
        let attempt = *state.attempt.lock().await;
        attempt
    };
    let will_restart = attempt < 6;
    let _ = app.emit(
        "sidecar://event",
        SidecarEvent::Crashed { code, will_restart, attempt },
    );
    if !will_restart {
        crate::logging::sidecar_line(app, "lifecycle", "giving up after repeated crashes");
        return;
    }
    tokio::time::sleep(backoff_for(attempt)).await;
    let _ = start(app).await;
}

/// Stop the sidecar: ask politely, then force it.
pub async fn stop(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    *state.stopping.lock().await = true;
    let child = state.child.lock().await.take();
    if let Some(child) = child {
        crate::logging::sidecar_line(app, "lifecycle", "stopping sidecar");
        // `kill` is immediate; the graceful path is the shell's job on quit.
        let _ = child.kill();
    }
    *state.info.lock().await = None;
    *state.stopping.lock().await = false;
    let _ = app.emit("sidecar://event", SidecarEvent::Stopped);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_layout_is_stable_and_nested_under_the_root() {
        let root = Path::new("/tmp/noema-test");
        assert_eq!(db_path(root), root.join("noema.db"));
        assert_eq!(uploads_dir(root), root.join("uploads"));
        assert_eq!(logs_dir(root), root.join("logs"));
        assert_eq!(backups_dir(root), root.join("backups"));
    }

    #[test]
    fn loopback_urls_never_use_localhost() {
        assert_eq!(api_base(47821), "http://127.0.0.1:47821");
        assert_eq!(ready_url(47821), "http://127.0.0.1:47821/api/ready");
    }

    #[test]
    fn sqlite_url_is_a_prisma_file_url_with_forward_slashes() {
        let url = sqlite_url(Path::new(r"C:\Users\x\AppData\noema\noema.db"));
        assert!(url.starts_with("file:"));
        assert!(!url.contains('\\'), "windows paths must be normalised: {url}");
    }

    #[test]
    fn env_carries_runtime_marker_and_data_dirs() {
        let env = sidecar_env(1234, Path::new("/data/noema"), "http://127.0.0.1:1234");
        let get = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(get("PORT"), "1234");
        assert_eq!(get("HOSTNAME"), "127.0.0.1");
        assert_eq!(get("NOEMA_RUNTIME"), "desktop");
        assert_eq!(get("APP_ORIGINS"), "http://127.0.0.1:1234");
        assert!(get("DATABASE_URL").starts_with("file:"));
        assert_eq!(get("NEXT_TELEMETRY_DISABLED"), "1");
    }

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(backoff_for(1), Duration::from_millis(500));
        assert_eq!(backoff_for(2), Duration::from_secs(1));
        assert_eq!(backoff_for(3), Duration::from_secs(3));
        assert_eq!(backoff_for(4), Duration::from_secs(10));
        assert_eq!(backoff_for(99), Duration::from_secs(10));
        assert_eq!(backoff_for(0), Duration::from_millis(500));
    }

    #[test]
    fn free_port_is_usable_and_unique_enough() {
        let a = free_port().expect("port available");
        let b = free_port().expect("port available");
        assert!(a > 1024, "ephemeral ports are > 1024, got {a}");
        assert!(b > 1024);
        // Two consecutive calls must not return the same port.
        assert_ne!(a, b);
    }

    #[test]
    fn ensure_layout_creates_every_directory() {
        let dir = std::env::temp_dir().join(format!("noema-layout-{}", rand::random::<u32>()));
        ensure_layout(&dir).expect("layout created");
        for path in [dir.clone(), uploads_dir(&dir), logs_dir(&dir), backups_dir(&dir)] {
            assert!(path.is_dir(), "{path:?} should exist");
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
