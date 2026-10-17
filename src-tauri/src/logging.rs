//! Logging for the shell and the supervised server.
//!
//! Two sinks, both local (a local-first app never ships logs anywhere):
//!  * a rotating file `logs/noema.log` for support/diagnostics,
//!  * a bounded in-memory ring buffer the app can display, so a user can paste
//!    the last 200 lines into a bug report without finding the file.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

/// How many lines the diagnostics panel can read.
pub const RING_CAPACITY: usize = 200;

fn ring() -> &'static Mutex<VecDeque<String>> {
    static RING: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(RING_CAPACITY)))
}

fn log_file() -> &'static Mutex<Option<PathBuf>> {
    static FILE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    FILE.get_or_init(|| Mutex::new(None))
}

/// Point the file sink at `dir/noema.log` (called once during setup).
pub fn init_file_sink(dir: PathBuf) {
    std::fs::create_dir_all(&dir).ok();
    let mut guard = log_file().lock().expect("log file lock");
    *guard = Some(dir.join("noema.log"));
}

/// Append one line to both sinks and notify the UI.
pub fn line(app: &AppHandle, source: &str, message: &str) {
    let entry = format!("[{source}] {}", message.trim_end());
    push(&entry);
    let _ = app.emit("sidecar://log", &entry);
}

/// Convenience for the sidecar's stdout/stderr.
pub fn sidecar_line(app: &AppHandle, stream: &str, message: &str) {
    line(app, &format!("server:{stream}"), message);
}

fn push(entry: &str) {
    if let Ok(mut buffer) = ring().lock() {
        push_into(&mut buffer, entry);
    }
    if let Ok(guard) = log_file().lock() {
        if let Some(path) = guard.as_ref() {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(file, "{entry}");
            }
        }
    }
}

/// Append one line to a bounded buffer, dropping the oldest when full.
///
/// Split out from [`push`] so the ring's behaviour can be tested without
/// touching the process-global buffer (parallel tests sharing one buffer made
/// the old assertions order-dependent, which is a flaky test, not a bug).
fn push_into(buffer: &mut VecDeque<String>, entry: &str) {
    if buffer.len() == RING_CAPACITY {
        buffer.pop_front();
    }
    buffer.push_back(entry.to_string());
}

/// The last `limit` entries, oldest first.
fn tail(buffer: &VecDeque<String>, limit: usize) -> Vec<String> {
    let take = limit.min(buffer.len());
    buffer.iter().skip(buffer.len() - take).cloned().collect()
}

/// The most recent lines, oldest first.
pub fn recent(limit: usize) -> Vec<String> {
    ring()
        .lock()
        .map(|buffer| tail(&buffer, limit))
        .unwrap_or_default()
}

/// Where the log file lives (for "Reveal in folder").
pub fn current_file() -> Option<PathBuf> {
    log_file().lock().ok().and_then(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_keeps_the_newest_lines_and_caps_memory() {
        let mut buffer = VecDeque::new();
        for index in 0..(RING_CAPACITY + 25) {
            push_into(&mut buffer, &format!("line-{index}"));
        }
        assert_eq!(buffer.len(), RING_CAPACITY);
        assert!(buffer.back().unwrap().ends_with("line-224"));
        assert!(
            buffer.front().unwrap().ends_with("line-25"),
            "oldest was dropped"
        );
    }

    #[test]
    fn tail_honours_a_smaller_limit_and_keeps_order() {
        let mut buffer = VecDeque::new();
        for entry in ["a", "b", "c"] {
            push_into(&mut buffer, entry);
        }
        assert_eq!(tail(&buffer, 2), vec!["b".to_string(), "c".to_string()]);
        assert_eq!(tail(&buffer, 0), Vec::<String>::new());
        assert_eq!(
            tail(&buffer, 99).len(),
            3,
            "a limit above the length returns everything"
        );
    }

    #[test]
    fn the_global_ring_never_exceeds_capacity() {
        // Deliberately only asserts the invariant, not exact contents: the ring
        // is process-global, so any test running in parallel also pushes to it.
        for index in 0..(RING_CAPACITY * 2) {
            push(&format!("global-{index}"));
        }
        let lines = recent(RING_CAPACITY * 4);
        assert!(lines.len() <= RING_CAPACITY);
        assert!(!lines.is_empty());
    }
}
