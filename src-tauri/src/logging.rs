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
        if buffer.len() == RING_CAPACITY {
            buffer.pop_front();
        }
        buffer.push_back(entry.to_string());
    }
    if let Ok(guard) = log_file().lock() {
        if let Some(path) = guard.as_ref() {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{entry}");
            }
        }
    }
}

/// The most recent lines, oldest first.
pub fn recent(limit: usize) -> Vec<String> {
    ring()
        .lock()
        .map(|buffer| {
            let take = limit.min(buffer.len());
            buffer.iter().skip(buffer.len() - take).cloned().collect()
        })
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
    fn ring_keeps_the_newest_lines_and_caps_memory() {
        for index in 0..(RING_CAPACITY + 25) {
            push(&format!("line-{index}"));
        }
        let recent_lines = recent(RING_CAPACITY);
        assert_eq!(recent_lines.len(), RING_CAPACITY);
        assert!(recent_lines.last().unwrap().ends_with("line-224"));
    }

    #[test]
    fn recent_honours_a_smaller_limit() {
        push("a");
        push("b");
        push("c");
        assert_eq!(recent(2), vec!["b".to_string(), "c".to_string()]);
    }
}
