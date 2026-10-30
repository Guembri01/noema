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
//! 5. **Authenticated.** The readiness handshake carries a random token that
//!    only this run's server knows, so a program that grabbed the port before
//!    the server did is never mistaken for it — see `shell_token`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rand::RngCore;
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

/// The environment variable that carries the handshake token to the server.
///
/// The server reads it out of its own environment and echoes it in the
/// `SHELL_TOKEN_HEADER` response header; the supervisor only trusts a server
/// that does. A plain web deployment sets nothing, and then the header is
/// absent — an empty value would look like a token to a caller.
pub const SHELL_TOKEN_ENV: &str = "NOEMA_SHELL_TOKEN";

/// The response header the server echoes the handshake token in.
///
/// A header and not the body: `/api/health`'s JSON body is a frozen contract
/// (`{ ok, db }`, see B62) that probes and load balancers parse.
pub const SHELL_TOKEN_HEADER: &str = "x-noema-shell-token";

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
    #[error("could not read or create a shell secret: {0}")]
    Secret(String),
    #[error("the bundled server is missing: {0} (reinstall the app)")]
    MissingEntry(PathBuf),
    #[error("server did not become ready within {0:?}: {1}")]
    NotReady(Duration, String),
    #[error("failed to spawn the server: {0}")]
    Spawn(String),
    #[error("the system random number generator failed")]
    NoToken,
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
    /// Monotonic id of the child that is *currently* supervised.
    ///
    /// Exit events are delivered asynchronously, so an old child's `Terminated`
    /// can still be in flight while its replacement is already running (a manual
    /// restart) or while the app is quitting. Without an identity check the log
    /// pump would treat that stale event as a crash and start a *third* server —
    /// the orphaned `noema-node` that outlives the window. See `should_restart`.
    pub epoch: Arc<Mutex<u64>>,
}

/// Should a `Terminated` event from child `epoch` trigger an automatic restart?
///
/// Both conditions are necessary:
///  * `!stopping` — the stop was not deliberate, and
///  * `epoch == current` — the event belongs to the child still being supervised.
///
/// Kept as a free function so the rule is unit-testable without a running app.
pub fn should_restart(stopping: bool, epoch: u64, current: u64) -> bool {
    !stopping && epoch == current
}

/// How many *consecutive* failed starts the supervisor tolerates.
pub const MAX_RESTART_ATTEMPTS: u32 = 8;

/// Will the supervisor try again after `attempt` consecutive failed starts?
///
/// `attempt` counts failures since the last successful start, *not* lifetime
/// starts — see `attempt_after_start`. Free function so the budget arithmetic
/// is unit-testable without a running app, like `should_restart`.
pub fn will_attempt_restart(attempt: u32) -> bool {
    attempt < MAX_RESTART_ATTEMPTS
}

/// The counter value a start leaves behind, given how it ended.
///
/// A start that reached [`Readiness::Ready`] erases the count: the budget
/// governs crashes *in a row*, and a server that came up proves every failure
/// before it obsolete. Without this reset, eight ordinary starts over the
/// install's lifetime — manual restarts, database-URL fixes — would read as a
/// crash loop and silently disable auto-restart forever. A start that never
/// became ready keeps the count standing, so back-to-back failures accumulate.
pub fn attempt_after_start(attempt: u32, ready: bool) -> u32 {
    if ready {
        0
    } else {
        attempt
    }
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
    /// Something else answered on the port: it is not our server.
    Foreign,
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
            Readiness::Foreign => {
                "Another program is serving on this port — it is not the Noema server. \
                 Quit that program and try again."
                    .to_string()
            }
            Readiness::Silent => {
                "The local server did not answer at all. See the log for details.".to_string()
            }
        }
    }
}

/// A fresh handshake token for this run.
///
/// 32 bytes from the operating system's CSPRNG (`OsRng` — the kernel's
/// `getrandom`), hex encoded so it is a plain header value.
///
/// One token per start: a token from an earlier run is worthless. A program
/// that squats the port *before* the server starts never learns this one — the
/// server never runs to echo it, and the squatter cannot read the environment
/// of a process that belongs to another user. A caller that can query the
/// running server, or read its environment, can read the token; that caller is
/// already in the same trust domain as the server, and a restart issues a new
/// token before the shell trusts anything again.
///
/// Without a token the shell cannot tell its own server apart from an
/// impostor, so a generator that fails is a reason not to start at all.
pub fn shell_token() -> Result<String, SidecarError> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0u8; 32];
    let mut rng = rand::rngs::OsRng;
    rng.try_fill_bytes(&mut bytes)
        .map_err(|_| SidecarError::NoToken)?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(token)
}

/// Compare two secrets without leaking how much of them matched.
///
/// The length is not secret — the token is always the same length — but the
/// content is: a comparison that returns as soon as it finds a difference
/// tells whoever can measure the answer how much of the token was right.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// Is this health response from *our* server?
///
/// The response must carry the token of this run in the `SHELL_TOKEN_HEADER`
/// header, and the header must match it exactly.
///
/// A missing header is not a match. The server always sends it, so a response
/// without one comes from something else — most likely the program that
/// grabbed the port before the server did. That program answers `200` to
/// everything, and the window would load *its* page on an origin the Tauri
/// capability covers, with the app's IPC rights. So it must never be
/// mistaken for the server.
pub fn health_response_is_ours(received: Option<&str>, token: &str) -> bool {
    match received {
        Some(value) => constant_time_eq(value.as_bytes(), token.as_bytes()),
        None => false,
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
///
/// `shell_token` is the handshake token of this run: the server echoes it in
/// the `SHELL_TOKEN_HEADER` header, and the supervisor believes a server only
/// when it does. `auth_secret` is the session signing secret, kept in the
/// encrypted store and passed through the child's environment rather than left
/// on disk.
pub fn server_env(
    port: u16,
    data_dir: &Path,
    origin: &str,
    database_url: &str,
    shell_token: &str,
    auth_secret: &str,
) -> Vec<(String, String)> {
    let mut env = vec![
        ("PORT".into(), port.to_string()),
        ("HOSTNAME".into(), "127.0.0.1".into()),
        ("NODE_ENV".into(), "production".into()),
        ("NOEMA_RUNTIME".into(), "desktop".into()),
        ("AUTH_SECRET".into(), auth_secret.into()),
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
        // The handshake token. It never leaves this machine: only the server
        // process reads it, out of its own environment.
        (SHELL_TOKEN_ENV.into(), shell_token.into()),
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

/// Poll the health endpoint until it answers 200 **with our token**, or the
/// timeout elapses.
///
/// Returns *why* it gave up, so the shell can tell "the database is unreachable"
/// (the user can fix that on the bootstrap page) apart from "nothing is
/// listening" (a real bug worth a bug report).
///
/// A `200` alone is not enough: the port was picked by binding `127.0.0.1:0`,
/// reading the port and closing the socket again, so another program on this
/// machine can take it before the server does — and it only has to answer `200`
/// to be believed. The token in `SHELL_TOKEN_HEADER` is what tells our own
/// server apart from that impostor.
pub async fn wait_until_ready(port: u16, timeout: Duration, token: &str) -> Readiness {
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
    let mut foreign = false;
    while tokio::time::Instant::now() < deadline {
        if let Ok(response) = client.get(&url).send().await {
            let status = response.status().as_u16();
            let echoed = response
                .headers()
                .get(SHELL_TOKEN_HEADER)
                .and_then(|value| value.to_str().ok());
            if health_response_is_ours(echoed, token) {
                if response.status().is_success() {
                    return Readiness::Ready;
                }
                last_status = Some(status);
            } else {
                // Something else is answering on this port. Keep waiting: the
                // server may still win the port and answer with the token
                // afterwards. Remember it, so the failure can say what
                // happened instead of "nothing answered".
                foreign = true;
            }
        }
        tokio::time::sleep(READY_POLL).await;
    }
    match last_status {
        Some(status) => Readiness::Unhealthy(status),
        None if foreign => Readiness::Foreign,
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
///
/// `epoch` is the identity of the child this pump is draining, so an exit event
/// from a superseded child is ignored rather than restarted.
fn spawn_log_pump(app: AppHandle, mut receiver: Receiver<CommandEvent>, epoch: u64) {
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
                    let (stopping, current) = {
                        let state = app.state::<SidecarState>();
                        let stopping = *state.stopping.lock().await;
                        let current = *state.epoch.lock().await;
                        (stopping, current)
                    };
                    crate::logging::sidecar_line(
                        &app,
                        "lifecycle",
                        &format!(
                            "terminated code={:?} stopping={stopping} epoch={epoch} current={current}",
                            payload.code
                        ),
                    );
                    if should_restart(stopping, epoch, current) {
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
    let database_url = crate::state::database_url(app).map_err(SidecarError::Secret)?;
    let auth_secret = crate::state::auth_secret(app).map_err(SidecarError::Secret)?;

    let (attempt, epoch) = {
        let state = app.state::<SidecarState>();
        let mut attempt = state.attempt.lock().await;
        *attempt += 1;
        // A new child gets a new identity; see `SidecarState::epoch`.
        let mut epoch = state.epoch.lock().await;
        *epoch += 1;
        (*attempt, *epoch)
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
    // The handshake token of this run. The server reads it out of its own
    // environment and echoes it in the health response; the supervisor only
    // trusts a server that does, so a program that grabbed the port before the
    // server did is never mistaken for it.
    let token = shell_token()?;
    let env = server_env(
        port,
        &data_dir,
        &origin,
        &database_url,
        &token,
        &auth_secret,
    );

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
        // This child is the one being supervised, so clear the flag a deliberate
        // stop left set: a later genuine crash must still restart. A stale exit
        // event from the previous child is rejected by the epoch check instead,
        // which is what keeps a manual restart from leaving two servers running.
        *state.stopping.lock().await = false;
    }

    // Stream logs to file + the UI, and notice an unexpected exit.
    spawn_log_pump(app.clone(), receiver, epoch);

    match wait_until_ready(port, READY_TIMEOUT, &token).await {
        Readiness::Ready => {
            let info = SidecarInfo {
                api_base: origin,
                port,
                pid,
                data_dir: data_dir.to_string_lossy().into_owned(),
            };
            // Must be true before `Ready` reaches the page: the bootstrap page
            // navigates to `info.api_base` as soon as it sees the event.
            crate::navigation::set_server_origin(app, Some(&info.api_base));
            {
                let state = app.state::<SidecarState>();
                *state.info.lock().await = Some(info.clone());
                // A start that came up erases the failure count so the restart
                // budget counts crashes in a row, not lifetime starts. This
                // runs on the same task that observed `Readiness::Ready`, and
                // the write is complete before `Ok` is returned: any later
                // `Terminated` event is judged against the re-set counter, so
                // a background task cannot race a stale count.
                *state.attempt.lock().await = attempt_after_start(attempt, true);
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
    let will_restart = will_attempt_restart(attempt);
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
///
/// The `stopping` flag stays set: an intentional stop must never be mistaken for
/// a crash by the log pump. `start` clears it when it spawns a replacement, so
/// both a crash and a manual restart get supervision back.
pub async fn stop(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    *state.stopping.lock().await = true;
    let child = state.child.lock().await.take();
    if let Some(child) = child {
        crate::logging::sidecar_line(app, "lifecycle", "stopping server");
        let _ = child.kill();
    }
    *state.info.lock().await = None;
    crate::navigation::set_server_origin(app, None);
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
        // The impostor case has to say what happened, or the user is sent to
        // the database field for a port that somebody else is holding.
        assert!(Readiness::Foreign.message().contains("Another program"));
        assert!(Readiness::Foreign.message().contains("port"));
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
            "token-of-this-run",
            "auth-secret-of-this-install-123456",
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
        // The handshake token goes to the server with the environment, and
        // nowhere else.
        assert_eq!(get(SHELL_TOKEN_ENV), "token-of-this-run");
        // The session secret comes from the encrypted store and is only ever
        // handed to the child process.
        assert_eq!(get("AUTH_SECRET"), "auth-secret-of-this-install-123456");
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
        let env = server_env(
            1234,
            Path::new("/data/noema"),
            "http://127.0.0.1:1234",
            "",
            "token-of-this-run",
            "auth-secret-of-this-install-123456",
        );
        assert!(
            !env.iter().any(|(key, _)| key == "DATABASE_URL"),
            "an empty DATABASE_URL must not be passed — unset is what selects the embedded database"
        );
        // The rest of the environment is unaffected.
        assert_eq!(env.len(), 12);
    }

    /// The handshake. A program that grabbed the port before the server did
    /// answers `200` to everything, and the window would load its page with the
    /// app's IPC rights — so only a server that proves it knows this run's
    /// token counts as ready.
    #[test]
    fn only_a_response_carrying_our_token_is_ours() {
        let token = shell_token().expect("token");
        // Our own server echoes the token of this run.
        assert!(health_response_is_ours(Some(token.as_str()), &token));
        // No header at all: not ours, whatever the status code was.
        assert!(!health_response_is_ours(None, &token));
        // A wrong token: not ours.
        assert!(!health_response_is_ours(Some("not-the-token"), &token));
        // An empty header is not a match either.
        assert!(!health_response_is_ours(Some(""), &token));
        // And the token of another run is not this run's token.
        let other = shell_token().expect("token");
        assert!(!health_response_is_ours(Some(other.as_str()), &token));
    }

    #[test]
    fn the_handshake_token_is_fresh_and_unpredictable() {
        let token = shell_token().expect("token");
        assert_eq!(token.len(), 64, "32 bytes, hex encoded");
        assert!(
            token.chars().all(|character| character.is_ascii_hexdigit()),
            "the token is plain hex: {token}"
        );
        assert_ne!(
            token,
            shell_token().expect("token"),
            "every start gets its own token"
        );
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
    fn free_port_avoids_a_held_port_and_stays_usable() {
        // Hold the first port for the whole test. Asking the kernel for port 0
        // twice in a row can legitimately return the same port again after the
        // first listener is dropped — Windows does exactly that — so comparing
        // two sequential calls tests the kernel, not `free_port`. Keeping the
        // listener alive is what makes the uniqueness check deterministic.
        let held = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let a = held.local_addr().expect("address").port();
        let b = free_port().expect("port available");
        assert!(a > 1024, "ephemeral ports are > 1024, got {a}");
        assert!(b > 1024);
        assert_ne!(a, b, "free_port must not hand back a port that is held");
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

    /// The rule that keeps a stopped server stopped.
    ///
    /// A `Terminated` event arrives asynchronously, so at the moment one lands the
    /// world may already have moved on. Restarting is only correct for the child
    /// that is still the current one *and* was not stopped on purpose.
    #[test]
    fn only_a_current_child_that_was_not_stopped_restarts() {
        // The ordinary crash: current child, no deliberate stop.
        assert!(should_restart(false, 3, 3));
        // A deliberate stop (quit, "stop server"): never restart.
        assert!(!should_restart(true, 3, 3));
        // A stale event from a superseded child: never restart, or a manual
        // restart would end up with two servers.
        assert!(!should_restart(false, 2, 3));
        assert!(!should_restart(true, 2, 3));
    }

    /// A successful start erases the failure count so auto-restart never
    /// depends on how many times the server has ever been started.
    #[test]
    fn attempt_after_ready_mean_reverts_the_budget() {
        assert_eq!(attempt_after_start(0, false), 0);
        assert_eq!(
            attempt_after_start(7, true),
            0,
            "a ready start erases every failure before it"
        );
        assert_eq!(
            attempt_after_start(7, false),
            7,
            "a failed start keeps the count standing, so crashes accumulate"
        );
    }

    /// The budget counts crashes *in a row*: eight healthy runs, then a crash,
    /// must read as the first failure — not the ninth, which is what the
    /// lifetime count produced before the reset existed (auto-restart died
    /// after eight ordinary starts over the install's life).
    #[test]
    fn eight_healthy_starts_and_a_crash_still_auto_restart() {
        // Replays the exact transitions `start` and `restart` make: entry
        // increments, the `Ready` branch mean-reverts via
        // `attempt_after_start(…, true)`, a crash is left for `restart` to
        // judge through `will_attempt_restart`.
        let mut attempt = 0;
        for _ in 0..8 {
            attempt += 1; // `start` entry
            attempt = attempt_after_start(attempt, true); // server came up
        }
        assert_eq!(attempt, 0, "eight ready starts leave no failure behind");
        attempt += 1; // one crash
        assert!(
            will_attempt_restart(attempt),
            "a crash after eight healthy runs is the first failure, not the ninth"
        );
    }

    #[test]
    fn eight_consecutive_failures_still_give_up() {
        // The crash-loop protection has to survive the reset: eight starts
        // that never became ready must exhaust the budget.
        let mut attempt = 0;
        for _ in 0..8 {
            attempt += 1; // `start` entry, never reaches Ready
            attempt = attempt_after_start(attempt, false);
        }
        assert!(
            !will_attempt_restart(attempt),
            "sustained failure must still stop the restarts"
        );
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
        assert_send(wait_until_ready(1, READY_TIMEOUT, "token-of-this-run"));
    }

    #[test]
    fn state_locks_are_send() {
        let state = SidecarState::default();
        assert_send(async move {
            let _ = state.child.lock().await;
            let _ = state.info.lock().await;
            let _ = state.attempt.lock().await;
            let _ = state.stopping.lock().await;
            let _ = state.epoch.lock().await;
        });
    }

    #[test]
    fn the_supervisor_state_is_shareable() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SidecarState>();
        assert_send_sync::<SidecarInfo>();
    }
}
