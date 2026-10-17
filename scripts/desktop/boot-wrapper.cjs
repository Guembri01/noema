// Boot wrapper for the packaged desktop server: get the database ready, then
// hand over to the Next standalone server.
//
// This is a real file in the repo (copied into the payload by
// `scripts/desktop/prepare.mjs`), not generated text: it is linted, reviewable,
// and can be fixed without touching the packager.
//
// Why migrate on every launch: `prisma migrate deploy` is idempotent and cheap,
// and running it at boot means an app update can never leave the schema behind
// the code. Why the db-push fallback: `P3005` means the tables exist without a
// migration history — which is exactly what `prisma db push` (this project's own
// setup path) leaves behind — and refusing to start on that would punish the
// operator for a database that is already correct.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = __dirname;

function prismaCli() {
  const cli = path.join(root, "node_modules", "prisma", "build", "index.js");
  const schema = path.join(root, "prisma", "schema.prisma");
  if (!fs.existsSync(cli) || !fs.existsSync(schema)) return null;
  return { cli, schema };
}

function runPrisma(cli, schema, args) {
  return spawnSync(process.execPath, [cli, ...args, "--schema", schema], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
  });
}

function migrate() {
  if (process.env.NOEMA_SKIP_MIGRATE === "1") return;
  const resolved = prismaCli();
  if (!resolved) {
    console.warn("[noema] prisma CLI/schema not bundled — skipping migrations");
    return;
  }
  const { cli, schema } = resolved;

  console.log("[noema] prisma migrate deploy…");
  const deployed = runPrisma(cli, schema, ["migrate", "deploy"]);
  if (deployed.status === 0) {
    if (deployed.stdout) process.stdout.write(deployed.stdout);
    return;
  }

  const output = (deployed.stdout || "") + (deployed.stderr || "");
  if (output.indexOf("P3005") !== -1) {
    console.log("[noema] existing schema without migration history — syncing with db push…");
    // Deliberately NOT `--accept-data-loss`: a boot path that can silently drop
    // a user's columns is not acceptable. `db push` without it applies additive
    // changes and refuses destructive ones, which is the right failure mode for
    // someone's real database.
    const pushed = runPrisma(cli, schema, ["db", "push", "--skip-generate"]);
    if (pushed.stdout) process.stdout.write(pushed.stdout);
    if (pushed.status === 0) return;
    console.error("[noema] db push exited with status", pushed.status, pushed.stderr || "");
    return;
  }

  // Not fatal: the server still boots, /api/health reports the problem, and the
  // app's own bootstrap page can offer the connection field.
  console.error("[noema] migrations exited with status", deployed.status);
  if (deployed.stderr) console.error(deployed.stderr);
}

function main() {
  migrate();
  require(path.join(root, "server.js"));
}

main();
