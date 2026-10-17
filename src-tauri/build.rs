// Build script: generates the Tauri context (icons, capabilities, permissions)
// and makes the sidecar path available to the Rust code at compile time.
//
// The shell's own commands are declared here so the ACL can name them
// (`allow-set-theme`, …) and a capability can hand them out. It has to be the
// app manifest that declares them: the installed app displays the *served* web
// app, which is a different, remote origin, and Tauri refuses an app command
// from a remote origin unless a capability grants it — the call comes back as
// `Command set_theme not allowed by ACL`. Declaring the manifest also puts
// local origins under the ACL, so `permissions/default.toml` re-grants the
// shell's own page the whole surface it used to reach implicitly.
//
// `commands::tests::every_command_is_declared_for_the_acl` fails if this list
// and the `#[tauri::command]`s drift apart.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to generate the Tauri context");

    // Rebuild when the sidecar changes, so `tauri dev` picks up a new server
    // binary without a manual `cargo clean`.
    println!("cargo:rerun-if-changed=binaries");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
}

/// Every command the shell exposes — the `#[tauri::command]`s in `src/`, in the
/// order `generate_handler!` registers them.
const APP_COMMANDS: &[&str] = &[
    "desktop_info",
    "restart_server",
    "stop_server",
    "open_data_dir",
    "open_data_subdir",
    "recent_logs",
    "log_file_path",
    "get_pref",
    "set_pref",
    "set_window_title",
    "set_zoom",
    "check_update",
    "set_database_url",
    "database_url",
    "set_decorations",
    "set_theme",
    "backup_now",
    "quit",
];
