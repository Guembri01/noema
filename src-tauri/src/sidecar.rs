//! Supervises the local Next.js server that the desktop app wraps.
//!
//! The shell never renders the app itself: it starts the bundled Node runtime
//! (`noema-node`, a real `node` binary shipped as a Tauri sidecar) on the
//! standalone server in the app's resources, waits until `/api/ready` answers,
//! then points the window at it.
//!
//! Why a real Node runtime instead of a Node SEA single executable: `next build
//! --output standalone` keeps its dependency graph in `node_modules` and loads
//! it with dynamic `require`, and Prisma loads a native query engine. Neither
//! survives being folded into one SEA blob, so a "single executable server"
//! would have shipped broken. Bundling the runtime is the honest option that
//! still requires nothing of the user (no Node install, no PATH surgery).
//!
//! Design rules (see docs/DESKTOP.md):
//! 1. **Loopback only.** The server binds `127.0.0.1` on an ephemeral port that
//!    the OS picks, so two installs can run side by side and nothing is exposed.
//! 2. **Supervised.** If the process exits unexpectedly it is restarted with
//!    exponential backoff, and the UI is told (so it can show an offline state
//!    instead of a dead window).
//! 3. **Graceful.** On quit the child gets a kill signal, so database handles
//!    are released cleanly.
//! 4. **Observable.** stdout/stderr are streamed to the rotating log file, and
//!    the last N lines are exposed to the app for a "Diagnostics" panel.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// How long the shell waits for `/api/ready` before surfacing an error.
pub const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// How often readiness is polled.
pub const READY_POLL: Duration = Duration::from_millis(300);
/// Backoff between automatic restarts.
pub const RESTART_BACKOFF: [Duration; 4] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(10),
];

/// Where the server entry point lives inside the installed app.
pub const SERVER_ENTRY: &str = "server/server.js";

/// The connection string used when the user has not configured one.
///
/// The desktop build talks to a Postgres like the site build does (the schema
/// uses Postgres full-text search). `NOEMA_DATABASE_URL` or the first-run screen
/// overrides it, which is what makes the installed app usable against a local
/// container, a remote server, or a managed database.
pub const DEFAULT_DATABASE_URL: &str =
    "postgresql://postgres:postgres@127.0.0.1:5432/noema?schema=public";

/// What the webview is told about the running server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidecarInfo {
    /// e.g. `http://127.0.0.1:47821`
    pub api_base: String,
    pub port: u16,
    pub pid: u32,
    /// `data` directory the server writes to (logs, uploads, backups).
    pub data_dir: String,
}

/// Lifecycle events emitted to the webview.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarEvent {
    Starting {
        attempt: u32,
    },
    Ready {
        info: SidecarInfo,
    },
    /// The process exited; the UI should show an offline banner.
    Crashed {
        code: Option<i32>,
        will_restart: bool,
        attempt: u32,
    },
    Failed {
        message: String,
    },
    Stopped,
}

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("could not resolve the application data directory")]
    NoDataDir,
    #[error("the bundled server is missing: {0} (reinstall the app)")]
    MissingEntry(PathBuf),
    #[error("server did not become ready within {0:?}: {1}")]
    NotReady(Duration, String),
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
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("noema.db")
}

/// Where uploaded files live (served by `/api/files/...`).
pub fn uploads_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("uploads")
}

/// Where logs live.
pub fn logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// Where automatic backups are written.
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
///
/// This is `/api/health`, not `/api/ready`: the latter is a secret-gated ops
/// endpoint that fails closed (401/503) for an unauthenticated caller, so a
/// supervisor polling it would never see the app come up. `/api/health` is the
/// documented unauthenticated liveness+readiness probe (`{ ok, db }`, 503 when
/// the database is unreachable).
pub fn ready_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/health")
}

/// What the readiness probe learned.
#[derive(Debug, PartialEq, Eq)]
pub enum Readiness {
    /// 200 from `/api/health`: the server and its dependencies are up.
    Ready,
    /// The server answered, but not with 200 — almost always the database.
    Unhealthy(u16),
    /// Nothing answered within the budget.
    Silent,
}

impl Readiness {
    /// A user-facing explanation, so the bootstrap page can say what to fix.
    pub fn message(&self) -> String {
        match self {
            Readiness::Ready => "ready".to_string(),
            Readiness::Unhealthy(status) => format!(
                "The local server is running but reports unhealthy (HTTP {status}) — \
                 usually the database connection. Check the connection string below."
            ),
            Readiness::Silent => {
                "The local server did not answer at all. See the log for details.".to_string()
            }
        }
    }
}

/// The API base the webview should use.
pub fn api_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Environment handed to the server. Kept in one place so the site build and the
/// desktop build cannot drift.
pub fn server_env(
    port: u16,
    data_dir: &Path,
    origin: &str,
    database_url: &str,
) -> Vec<(String, String)> {
    vec![
        ("PORT".into(), port.to_string()),
        ("HOSTNAME".into(), "127.0.0.1".into()),
        ("NODE_ENV".into(), "production".into()),
        ("NOEMA_RUNTIME".into(), "desktop".into()),
        (
            "NOEMA_DATA_DIR".into(),
            data_dir.to_string_lossy().into_owned(),
        ),
        ("DATABASE_URL".into(), database_url.into()),
        (
            "UPLOAD_DIR".into(),
            uploads_dir(data_dir).to_string_lossy().into_owned(),
        ),
        (
            "BACKUP_DIR".into(),
            backups_dir(data_dir).to_string_lossy().into_owned(),
        ),
        // The webview origin must be able to call the loopback server.
        ("APP_ORIGINS".into(), origin.into()),
        ("NEXT_TELEMETRY_DISABLED".into(), "1".into()),
    ]
}

/// Ask the OS for a free loopback port.
///
/// Binding to port 0 lets the kernel choose; the socket is closed immediately
/// and the port is handed to the server. A tiny race window exists, which is why
/// the supervisor retries with a fresh port if the bind fails.
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

/// Poll the health endpoint until it answers 200, or the timeout elapses.
///
/// Returns *why* it gave up, so the shell can tell "the database is unreachable"
/// (the user can fix that on the bootstrap page) apart from "nothing is
/// listening" (a real bug worth a bug report).
pub async fn wait_until_ready(port: u16, timeout: Duration) -> Readiness {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return Readiness::Silent,
    };
    let url = ready_url(port);
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_status: Option<u16> = None;
    while tokio::time::Instant::now() < deadline {
        if let Ok(response) = client.get(&url).send().await {
            let status = response.status().as_u16();
            if response.status().is_success() {
                return Readiness::Ready;
            }
            last_status = Some(status);
        }
        tokio::time::sleep(READY_POLL).await;
    }
    match last_status {
        Some(status) => Readiness::Unhealthy(status),
        None => Readiness::Silent,
    }
}

/// The bundled server entry point, inside the app's resources.
pub fn server_entry(app: &AppHandle) -> Result<PathBuf, SidecarError> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|_| SidecarError::NoDataDir)?;
    let entry = dir.join(SERVER_ENTRY);
    if entry.exists() {
        Ok(entry)
    } else {
        Err(SidecarError::MissingEntry(entry))
    }
}

/// Stream the server's stdout/stderr to the log and the UI, and notice an exit.
///
/// Kept out of `start` so the supervisor's own future stays simple: it must be
/// `Send` (the shell spawns it), and an inline `async move` block that captures
/// the start-up locals makes that harder to prove than it needs to be.
fn spawn_log_pump(app: AppHandle, mut receiver: Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    crate::logging::sidecar_line(&app, "stdout", &String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    crate::logging::sidecar_line(&app, "stderr", &String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    let stopping = { *app.state::<SidecarState>().stopping.lock().await };
                    crate::logging::sidecar_line(
                        &app,
                        "lifecycle",
                        &format!("terminated code={:?} stopping={stopping}", payload.code),
                    );
                    if !stopping {
                        // Restart on its own task: the log stream must keep
                        // draining while the backoff sleeps, and awaiting the
                        // restart here would tie this task's future to `start`,
                        // which spawns this very task.
                        let app_for_restart = app.clone();
                        tauri::async_runtime::spawn(async move {
                            crate::sidecar::restart(&app_for_restart, payload.code).await;
                        });
                    }
                }
                _ => {}
            }
        }
    });
}

/// Start the server, wait for readiness, and remember how to reach it.
pub async fn start(app: &AppHandle) -> Result<SidecarInfo, SidecarError> {
    let data_dir = crate::state::data_dir(app).ok_or(SidecarError::NoDataDir)?;
    ensure_layout(&data_dir)?;
    let entry = server_entry(app)?;
    let database_url = crate::state::database_url(app);

    let attempt = {
        let state = app.state::<SidecarState>();
        let mut attempt = state.attempt.lock().await;
        *attempt += 1;
        *attempt
    };
    let _ = app.emit("sidecar://event", SidecarEvent::Starting { attempt });

    let port = free_port()?;
    let origin = api_base(port);
    let env = server_env(port, &data_dir, &origin, &database_url);

    let command = app
        .shell()
        .sidecar("noema-node")
        .map_err(|error| SidecarError::Spawn(error.to_string()))?
        .args([entry.to_string_lossy().into_owned()])
        .current_dir(entry.parent().unwrap_or(Path::new(".")))
        .envs(env);

    let (receiver, child) = command
        .spawn()
        .map_err(|error| SidecarError::Spawn(error.to_string()))?;

    let pid = child.pid();
    {
        let state = app.state::<SidecarState>();
        *state.child.lock().await = Some(child);
    }

    // Stream logs to file + the UI, and notice an unexpected exit.
    spawn_log_pump(app.clone(), receiver);

    match wait_until_ready(port, READY_TIMEOUT).await {
        Readiness::Ready => {
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
            let _ = app.emit(
                "sidecar://event",
                SidecarEvent::Ready { info: info.clone() },
            );
            Ok(info)
        }
        readiness => {
            // Stay on the bootstrap page: it is the surface that can actually fix
            // this (the database connection string), so navigating would hide the
            // remedy behind a broken app.
            let message = readiness.message();
            logging::line(app, "lifecycle", &message);
            let _ = app.emit(
                "sidecar://event",
                SidecarEvent::Failed {
                    message: message.clone(),
                },
            );
            Err(SidecarError::NotReady(READY_TIMEOUT, message))
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
    let will_restart = attempt < 8;
    let _ = app.emit(
        "sidecar://event",
        SidecarEvent::Crashed {
            code,
            will_restart,
            attempt,
        },
    );
    if !will_restart {
        crate::logging::sidecar_line(app, "lifecycle", "giving up after repeated crashes");
        return;
    }
    tokio::time::sleep(backoff_for(attempt)).await;
    let _ = start(app).await;
}

/// Stop the server.
pub async fn stop(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    *state.stopping.lock().await = true;
    let child = state.child.lock().await.take();
    if let Some(child) = child {
        crate::logging::sidecar_line(app, "lifecycle", "stopping server");
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
    fn the_server_entry_is_inside_the_resource_dir() {
        assert_eq!(SERVER_ENTRY, "server/server.js");
    }

    #[test]
    fn env_carries_runtime_marker_database_and_dirs() {
        let env = server_env(
            1234,
            Path::new("/data/noema"),
            "http://127.0.0.1:1234",
            DEFAULT_DATABASE_URL,
        );
        let get = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(get("PORT"), "1234");
        assert_eq!(get("HOSTNAME"), "127.0.0.1");
        assert_eq!(get("NODE_ENV"), "production");
        assert_eq!(get("NOEMA_RUNTIME"), "desktop");
        assert_eq!(get("APP_ORIGINS"), "http://127.0.0.1:1234");
        assert_eq!(get("DATABASE_URL"), DEFAULT_DATABASE_URL);
        assert!(get("DATABASE_URL").starts_with("postgresql://"));
        assert_eq!(get("NEXT_TELEMETRY_DISABLED"), "1");
    }

    #[test]
    fn every_restart_backoff_is_positive_and_bounded() {
        assert_eq!(backoff_for(1), Duration::from_millis(500));
        assert_eq!(backoff_for(4), Duration::from_secs(10));
        assert_eq!(backoff_for(99), Duration::from_secs(10));
        assert_eq!(backoff_for(0), Duration::from_millis(500));
        assert!(READY_TIMEOUT > READY_POLL);
    }

    #[test]
    fn free_port_is_usable_and_unique_enough() {
        let a = free_port().expect("port available");
        let b = free_port().expect("port available");
        assert!(a > 1024, "ephemeral ports are > 1024, got {a}");
        assert!(b > 1024);
        assert_ne!(a, b);
    }

    #[test]
    fn ensure_layout_creates_every_directory() {
        let dir = std::env::temp_dir().join(format!("noema-layout-{}", rand::random::<u32>()));
        ensure_layout(&dir).expect("layout created");
        for path in [
            dir.clone(),
            uploads_dir(&dir),
            logs_dir(&dir),
            backups_dir(&dir),
        ] {
            assert!(path.is_dir(), "{path:?} should exist");
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod send_guards {
    //! The shell spawns the supervisor, so its futures must be `Send`. These
    //! assertions pin that: a stray non-`Send` local held across an await
    //! (which is exactly what broke this before) fails here instead of at the
    //! call site, with a clearer message.
    use super::*;

    fn assert_send<T: Send>(_: T) {}

    #[test]
    fn readiness_probe_future_is_send() {
        assert_send(wait_until_ready(1, READY_TIMEOUT));
    }

    #[test]
    fn state_locks_are_send() {
        let state = SidecarState::default();
        assert_send(async move {
            let _ = state.child.lock().await;
            let _ = state.info.lock().await;
            let _ = state.attempt.lock().await;
            let _ = state.stopping.lock().await;
        });
    }

    #[test]
    fn the_supervisor_state_is_shareable() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SidecarState>();
        assert_send_sync::<SidecarInfo>();
    }
}
