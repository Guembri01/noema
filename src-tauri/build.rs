// Build script: generates the Tauri context (icons, capabilities, permissions)
// and makes the sidecar path available to the Rust code at compile time.
fn main() {
    tauri_build::build();

    // Rebuild when the sidecar changes, so `tauri dev` picks up a new server
    // binary without a manual `cargo clean`.
    println!("cargo:rerun-if-changed=binaries");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
}
