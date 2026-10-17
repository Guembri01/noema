//! Supervises the local Next.js server that the desktop app wraps.
//!
//! The shell never renders the app itself: it starts the bundled Node runtime
//! (`noema-node`, a real `node` binary shipped as a Tauri sidecar) on the
//! standalone server in the app's resources, waits until `/api/health` answers,
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
//! 1. **Loopback only.** The server binds `127.0.0.1`, so nothing is exposed.
//!    The port is the one this install used last time when it is still free
//!    (which keeps the document origin stable — browser-side state such as the
//!    theme preference, open tabs and the offline cache is keyed by origin, so a
//!    fresh port every launch silently reset all of it), otherwise a fresh
//!    ephemeral one, so two installs can still run side by side.
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

/// How long the shell waits for `/api/health` before surfacing an error.
///
/// Generous on purpose: the very first run may have to start Docker Desktop, pull
/// the Postgres image and initialise a cluster before the server can listen. A
/// short budget here would show the "unhealthy" page on a perfectly healthy
/// first run, which is exactly the impression an installer must not make.
pub const READY_TIMEOUT: Duration = Duration::from_secs(300);
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
///
/// This is the boot wrapper, **not** `server.js`. The wrapper is what makes the
/// install self-contained: it resolves a database (an explicitly configured URL,
/// then the embedded PGlite engine, then a Docker-managed Postgres), migrates it,
/// generates a per-install session secret, and only then requires `server.js` in
/// the same process. Launching `server.js` directly skipped all of that, so the
/// app depended on whatever `DATABASE_URL` and `AUTH_SECRET` the payload happened
/// to carry — which is exactly what `scripts/desktop/prepare.mjs` no longer ships.
pub const SERVER_ENTRY: &str = "server/start.cjs";

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
///
/// Also sent as `STORAGE_DIR`, the name the app actually reads
/// (`src/lib/storage.ts`). It must be inside the data directory: the app falls
/// back to `<working dir>/uploads`, and a packaged install's working directory is
/// the *program* folder - an update or an uninstall would take the files with it.
pub fn uploads_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("uploads")
}

/// The app's own session store, sent as `SESSION_STORE_PATH`
/// (`src/lib/session-store.ts`). Beside the program folder by mistake once: a
/// reinstall signed everyone out and the payload shipped the builder's sessions.
pub fn sessions_file(data_dir: &Path) -> PathBuf {
    data_dir.join("sessions.json")
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
///
/// `DATABASE_URL` is included **only when one is actually configured**. Unset is
/// the signal that makes the bundled server provision its own embedded database,
/// so a fresh install needs nothing installed — not even Postgres. (An empty
/// value would work too, but an absent variable is unambiguous.)
pub fn server_env(
    port: u16,
    data_dir: &Path,
    origin: &str,
    database_url: &str,
) -> Vec<(String, String)> {
    let mut env = vec![
        ("PORT".into(), port.to_string()),
        ("HOSTNAME".into(), "127.0.0.1".into()),
        ("NODE_ENV".into(), "production".into()),
        ("NOEMA_RUNTIME".into(), "desktop".into()),
        (
            "NOEMA_DATA_DIR".into(),
            data_dir.to_string_lossy().into_owned(),
        ),
        // The names the app itself reads (`src/lib/storage.ts`,
        // `src/lib/session-store.ts`) - not `UPLOAD_DIR`, which nothing read, so
        // uploads and sessions quietly landed in the program folder instead.
        (
            "STORAGE_DIR".into(),
            uploads_dir(data_dir).to_string_lossy().into_owned(),
        ),
        (
            "SESSION_STORE_PATH".into(),
            sessions_file(data_dir).to_string_lossy().into_owned(),
        ),
        (
            "BACKUP_DIR".into(),
            backups_dir(data_dir).to_string_lossy().into_owned(),
        ),
        // The webview origin must be able to call the loopback server.
        ("APP_ORIGINS".into(), origin.into()),
        ("NEXT_TELEMETRY_DISABLED".into(), "1".into()),
    ];
    if !database_url.trim().is_empty() {
        env.push(("DATABASE_URL".into(), database_url.to_string()));
    }
    env
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

/// Can this loopback port be bound right now?
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The port to hand the server: the preferred one when it can still be bound,
/// otherwise a fresh ephemeral one.
///
/// The preference is what makes the app's origin stable across launches — see
/// `state::preferred_port` for why that matters. Both branches keep the server
/// loopback-only; a port that something else has taken is never fought over, it
/// is simply not used.
pub fn choose_port(preferred: Option<u16>) -> std::io::Result<u16> {
    match preferred {
        Some(port) if port_is_free(port) => Ok(port),
        _ => free_port(),
    }
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

    // Prefer the port this install used last time: the document origin stays the
    // same across launches, so the app's browser-side state survives a restart.
    // The port is only a preference — this machine may have given it away.
    let preferred = crate::state::preferred_port(app);
    let port = choose_port(preferred)?;
    if let Some(preferred) = preferred.filter(|preferred| *preferred != port) {
        crate::logging::line(
            app,
            "lifecycle",
            &format!("port {preferred} is in use, serving on {port} instead"),
        );
    }
    crate::state::remember_port(app, port);
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
            crate::logging::line(app, "lifecycle", &message);
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
        assert_eq!(sessions_file(root), root.join("sessions.json"));
        assert_eq!(logs_dir(root), root.join("logs"));
        assert_eq!(backups_dir(root), root.join("backups"));
    }

    #[test]
    fn loopback_urls_never_use_localhost() {
        assert_eq!(api_base(47821), "http://127.0.0.1:47821");
        assert_eq!(ready_url(47821), "http://127.0.0.1:47821/api/health");
    }

    #[test]
    fn readiness_explains_itself_to_the_user() {
        assert_eq!(Readiness::Ready.message(), "ready");
        assert!(Readiness::Unhealthy(503).message().contains("503"));
        assert!(Readiness::Unhealthy(503).message().contains("database"));
        assert!(Readiness::Silent.message().contains("did not answer"));
    }

    #[test]
    fn the_server_entry_is_inside_the_resource_dir() {
        // The boot wrapper, so a fresh install provisions its own database. See
        // SERVER_ENTRY for why `server.js` is the wrong entry.
        assert_eq!(SERVER_ENTRY, "server/start.cjs");
        assert!(SERVER_ENTRY.starts_with("server/"));
    }

    #[test]
    fn env_carries_runtime_marker_database_and_dirs() {
        let env = server_env(
            1234,
            Path::new("/data/noema"),
            "http://127.0.0.1:1234",
            "postgresql://u@h:5432/db",
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
        assert_eq!(get("DATABASE_URL"), "postgresql://u@h:5432/db");
        assert_eq!(get("NEXT_TELEMETRY_DISABLED"), "1");
        // The names the app reads, all inside the data directory. `UPLOAD_DIR`
        // was sent once and read by nobody, so uploads and the session file fell
        // back to the working directory - which for an install is the program
        // folder, where an update or an uninstall takes them.
        let data_dir = Path::new("/data/noema");
        assert_eq!(
            get("NOEMA_DATA_DIR"),
            data_dir.to_string_lossy().to_string()
        );
        assert_eq!(
            get("STORAGE_DIR"),
            uploads_dir(data_dir).to_string_lossy().to_string()
        );
        assert_eq!(
            get("SESSION_STORE_PATH"),
            sessions_file(data_dir).to_string_lossy().to_string()
        );
        assert_eq!(
            get("BACKUP_DIR"),
            backups_dir(data_dir).to_string_lossy().to_string()
        );
    }

    /// With no configured URL the variable is *absent* — that is the signal for
    /// the bundled server to provision its own embedded PostgreSQL, which is what
    /// lets a fresh install run with nothing installed.
    #[test]
    fn an_unconfigured_database_url_is_left_out_entirely() {
        let env = server_env(1234, Path::new("/data/noema"), "http://127.0.0.1:1234", "");
        assert!(
            !env.iter().any(|(key, _)| key == "DATABASE_URL"),
            "an empty DATABASE_URL must not be passed — unset is what selects the embedded database"
        );
        // The rest of the environment is unaffected.
        assert_eq!(env.len(), 10);
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
    fn the_preferred_port_comes_back_when_it_is_free() {
        // The whole point of the preference: a relaunch serves on the same
        // origin as the last one, so the app's browser-side state is still there.
        let free = free_port().expect("port available");
        assert_eq!(choose_port(Some(free)).expect("chosen"), free);
    }

    #[test]
    fn a_taken_preferred_port_falls_back_to_a_fresh_one() {
        // `listener` keeps the port for the duration, so the kernel cannot hand
        // the same one back.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let taken = listener.local_addr().expect("address").port();
        assert!(!port_is_free(taken));

        let chosen = choose_port(Some(taken)).expect("chosen");
        assert_ne!(chosen, taken);
        assert!(chosen > 1024);
    }

    #[test]
    fn no_preference_still_yields_a_usable_port() {
        assert!(choose_port(None).expect("chosen") > 1024);
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
