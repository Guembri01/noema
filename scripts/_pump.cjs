const fs = require("node:fs");
const file = "src-tauri/src/sidecar.rs";
let text = fs.readFileSync(file, "utf8");
// Replace the inline log pump inside `start` with a call to the new function.
const start = text.indexOf("    // Stream logs to file + the UI, and notice an unexpected exit.");
const end = text.indexOf("    match wait_until_ready(port, READY_TIMEOUT).await {");
if (start < 0 || end <= start) { console.log("MARKERS NOT FOUND"); process.exit(1); }
text = text.slice(0, start) +
  "    // Stream logs to file + the UI, and notice an unexpected exit.\n    spawn_log_pump(app.clone(), receiver);\n\n" +
  text.slice(end);
// The receiver binding no longer needs `mut` (the pump owns it now).
text = text.replace("let (mut receiver, child) =", "let (receiver, child) =");
// Receiver/CommandEvent need importing.
if (!/use tauri_plugin_shell::process::\{[^}]*Receiver/.test(text)) {
  text = text.replace(
    "use tauri_plugin_shell::process::{CommandChild, CommandEvent};",
    "use tauri_plugin_shell::process::{CommandChild, CommandEvent};\nuse tauri::async_runtime::Receiver;",
  );
}
fs.writeFileSync(file, text, "utf8");
console.log("log pump extracted:", text.includes("spawn_log_pump(app.clone(), receiver)"));
console.log("receiver not mut:", text.includes("let (receiver, child) ="));
