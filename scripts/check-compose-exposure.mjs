#!/usr/bin/env node
/**
 * Compose exposure gate (B09).
 *
 * The hole it closes: the compose stack published its database on **every**
 * interface of the machine (`ports: - "5433:5432"` binds 0.0.0.0) and started
 * it with a password that was written down in the file (`POSTGRES_PASSWORD:
 * noema`). Both halves are published in the repository, so the pair was a
 * complete, ready-to-use credential for anyone who could reach the host — and
 * the database holds every workspace's content, password hashes and token
 * hashes.
 *
 * The rules:
 *  · a **database** service must not publish a port without naming a loopback
 *    host address. A published port without a host part binds every interface
 *    of the machine, so the database is reachable from the network.
 *  · the database password must not be a fixed value. It has to be a
 *    *mandatory* interpolation (`${POSTGRES_PASSWORD:?…}`), so Compose refuses
 *    to start without it. A default (`${…:-noema}`) is a fixed value with a
 *    warning attached, and a warning does not keep a database off the network.
 *  · a postgres URL in the compose file must not carry a fixed password.
 *  · `.env.example` must not ship a fixed database password — an empty value
 *    or a `<…>` placeholder is what a template may carry, and the compose
 *    stack refuses to start until the operator fills it in.
 *
 * Scope: the **database** of the compose stack. The `app` service publishes
 * `3202:3000` on purpose — it is the web app, it is meant to be reached — so
 * only a service that runs a database is held to the loopback rule.
 *
 * There is no YAML parser in the dependency tree, so this reads the subset of
 * YAML a compose file uses: block mappings, block sequences and flow
 * sequences. A shape it cannot read is an error, never a silent pass.
 *
 *   npm run check:compose
 *   node scripts/check-compose-exposure.mjs            # the two files below
 *   node scripts/check-compose-exposure.mjs <file…>   # the given files
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The files the gate owns, relative to the repository root. */
export const OWNED_FILES = ["docker-compose.yml", ".env.example"];

// --- the YAML subset a compose file uses ------------------------------------

/** A mapping key with an optional value: `key: value`. */
const KEY_VALUE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

/** A block scalar: `>`, `>-`, `|`, `|-`, … */
const BLOCK_SCALAR = /^[>|][-+]?$/;

/** A `#` starts a comment when it is outside quotes and follows a space. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** The value of a scalar, without its quotes. */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The rows of a file: the non-empty, non-comment lines with their indent. */
function rows(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const stripped = stripComment(raw);
    const content = stripped.trim();
    if (content === "") return;
    out.push({
      indent: stripped.length - stripped.trimStart().length,
      content,
      line: index + 1,
    });
  });
  return mergeFlowRows(out);
}

/** How many flow collections a piece of text opens but does not close. */
function flowDepth(content) {
  let depth = 0;
  let quote = null;
  for (const ch of content) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
  }
  return depth;
}

/**
 * Merge a flow sequence that spans several lines into one row — the compose
 * file writes the healthcheck command that way.
 */
function mergeFlowRows(all) {
  const out = [];
  for (let i = 0; i < all.length; i += 1) {
    const row = all[i];
    if (!row.content.startsWith("[")) {
      out.push(row);
      continue;
    }
    let content = row.content;
    let j = i;
    while (flowDepth(content) > 0 && j + 1 < all.length) {
      j += 1;
      content += ` ${all[j].content}`;
    }
    out.push({ indent: row.indent, content, line: row.line });
    i = j;
  }
  return out;
}

/**
 * Read the rows of a block sequence or a block mapping, starting at `start`
 * and indented by `indent`.
 *
 * Returns the node and the index of the first row that belongs to the next
 * block. A row the reader cannot make sense of throws — a gate that cannot
 * read the file has to say so instead of passing it.
 */
function parseRows(all, start, indent) {
  const first = all[start];
  if (!first) return { node: null, next: start };
  if (first.content.startsWith("[")) {
    // A flow sequence that stands on its own lines.
    return { node: scalarNode(first.content, first.line), next: start + 1 };
  }
  if (first.content === "-" || first.content.startsWith("- ")) {
    return parseSequence(all, start, indent);
  }
  return parseMapping(all, start, indent);
}

/** A block sequence: `- item`. */
function parseSequence(all, start, indent) {
  const items = [];
  let i = start;
  while (i < all.length) {
    const row = all[i];
    if (row.indent !== indent) break;
    if (row.content !== "-" && !row.content.startsWith("- ")) break;
    const rest = row.content === "-" ? "" : row.content.slice(2).trim();
    if (rest === "") {
      const child =
        i + 1 < all.length && all[i + 1].indent > indent
          ? parseRows(all, i + 1, all[i + 1].indent)
          : { node: null, next: i + 1 };
      items.push({ line: row.line, node: child.node });
      i = child.next;
      continue;
    }
    if (KEY_VALUE.test(rest) && !rest.startsWith("[")) {
      // A mapping that starts on the item line (`- target: 5432`): the rest of
      // the mapping is indented under it.
      const rewritten = [{ indent: indent + 2, content: rest, line: row.line }, ...all.slice(i + 1)];
      const child = parseMapping(rewritten, 0, indent + 2);
      items.push({ line: row.line, node: child.node });
      i += child.next;
      continue;
    }
    items.push({ line: row.line, node: scalarNode(rest, row.line) });
    i += 1;
  }
  return { node: { type: "seq", items }, next: i };
}

/** A block mapping: `key: value` or `key:` followed by a nested block. */
function parseMapping(all, start, indent) {
  const entries = [];
  let i = start;
  while (i < all.length) {
    const row = all[i];
    if (row.indent < indent) break;
    if (row.indent > indent) {
      throw new Error(`line ${row.line}: unexpected indentation`);
    }
    const match = KEY_VALUE.exec(row.content);
    if (!match) throw new Error(`line ${row.line}: cannot read "${row.content}"`);
    const key = match[1];
    const rest = (match[2] ?? "").trim();
    if (rest === "") {
      const child =
        i + 1 < all.length && all[i + 1].indent > indent
          ? parseRows(all, i + 1, all[i + 1].indent)
          : { node: null, next: i + 1 };
      entries.push({ key, line: row.line, node: child.node });
      i = child.next;
      continue;
    }
    if (BLOCK_SCALAR.test(rest)) {
      // A block scalar: the indented lines below belong to it.
      const block = [];
      let j = i + 1;
      while (j < all.length && all[j].indent > indent) {
        block.push(all[j].content);
        j += 1;
      }
      entries.push({ key, line: row.line, node: { type: "scalar", value: block.join("\n"), line: row.line } });
      i = j;
      continue;
    }
    entries.push({ key, line: row.line, node: scalarNode(rest, row.line) });
    i += 1;
  }
  return { node: { type: "map", entries }, next: i };
}

/** A scalar, or a flow sequence (`[a, b]`) read as a list of scalars. */
function scalarNode(raw, line) {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    const items = body === "" ? [] : body.split(",").map((item) => unquote(item));
    return { type: "flow-seq", items, line };
  }
  return { type: "scalar", value: unquote(value), line };
}

/** The entry of a mapping node under `key`, or `null`. */
function mapEntry(node, key) {
  if (!node || node.type !== "map") return null;
  return node.entries.find((entry) => entry.key === key) ?? null;
}

/** The value of a mapping node under `key`, or `null`. */
function mapValue(node, key) {
  const entry = mapEntry(node, key);
  if (!entry || !entry.node) return null;
  return entry.node.type === "scalar" ? entry.node.value : null;
}

/** Every scalar of the tree, with the line it stands on. */
function scalars(node, out = []) {
  if (!node) return out;
  if (node.type === "scalar") {
    out.push({ value: node.value, line: node.line ?? node.value?.line });
    return out;
  }
  if (node.type === "map") {
    for (const entry of node.entries) scalars(entry.node, out);
    return out;
  }
  if (node.type === "seq") {
    for (const item of node.items) scalars(item.node, out);
    return out;
  }
  return out;
}

// --- the rules --------------------------------------------------------------

/** A mandatory interpolation: `${NAME:?message}`. */
const MANDATORY_INTERPOLATION = /^\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*\}$/;

/** An interpolation of any shape. */
const INTERPOLATION = /\$\{[^}]*\}/;

/** A placeholder value: `<something>`. */
const PLACEHOLDER = /^<.+>$/;

/** The address a published port binds, or `null` for "every interface". */
export function publishedHost(entry) {
  const value = entry.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    // `[::1]:5433:5432` — a host address and at least one port.
    return rest.startsWith(":") && rest.split(":").length >= 3 ? value.slice(1, end) : null;
  }
  const parts = value.split(":");
  // `host:published:target` names a host; anything shorter binds every
  // interface of the machine.
  return parts.length >= 3 ? parts[0] : null;
}

/** Whether an address is a loopback address. */
export function isLoopback(host) {
  const value = host.trim().toLowerCase();
  if (value === "localhost" || value === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/** Whether a service runs a database. */
export function isDatabaseService(name, image) {
  if (typeof image === "string" && /postgres/i.test(image)) return true;
  return /^(db|database|postgres)$/i.test(name);
}

/** The password of a connection string, or `null` when it carries none. */
export function urlPassword(url) {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/@]*)@/.exec(url);
  if (!match) return null;
  const userinfo = match[1];
  const colon = userinfo.indexOf(":");
  return colon < 0 ? "" : userinfo.slice(colon + 1);
}

/** The published ports of a service, with the address each one binds. */
function publishedPorts(node) {
  const out = [];
  const push = (raw, line, host) => out.push({ raw, line, host });
  if (!node) return out;
  if (node.type === "flow-seq") {
    for (const item of node.items) push(item, node.line, publishedHost(item));
    return out;
  }
  if (node.type !== "seq") return out;
  for (const item of node.items) {
    if (item.node?.type === "scalar") {
      push(item.node.value, item.line, publishedHost(item.node.value));
      continue;
    }
    if (item.node?.type === "map") {
      const hostIp = mapValue(item.node, "host_ip");
      push(hostIp ?? "<no host_ip>", item.line, hostIp);
      continue;
    }
    push("<unreadable>", item.line, null);
  }
  return out;
}

/** One finding of the gate. */
export function finding(file, line, rule, message) {
  return { file, line, rule, message };
}

/**
 * The findings of one compose file: a database published on every interface,
 * a fixed database password, and a connection string with a fixed password.
 */
export function auditCompose(text, file) {
  const findings = [];
  const root = parseRows(rows(text), 0, rows(text)[0]?.indent ?? 0).node;
  if (!root) return findings;
  const services = mapEntry(root, "services");
  if (!services || services.node?.type !== "map") {
    throw new Error(`${file}: no "services" mapping`);
  }

  for (const service of services.node.entries) {
    const image = mapValue(service.node, "image");
    const database = isDatabaseService(service.key, image);

    if (database) {
      const ports = publishedPorts(mapEntry(service.node, "ports")?.node);
      for (const port of ports) {
        if (port.host === null || !isLoopback(port.host)) {
          findings.push(
            finding(
              file,
              port.line,
              "interface",
              `the database port "${port.raw}" is published on every interface of the machine — bind it to the loopback address, e.g. "127.0.0.1:5433:5432"`,
            ),
          );
        }
      }
    }

    const environment = mapEntry(service.node, "environment");
    if (environment?.node?.type === "map") {
      for (const entry of environment.node.entries) {
        if (entry.key !== "POSTGRES_PASSWORD") continue;
        const value = entry.node?.type === "scalar" ? entry.node.value : "";
        if (!MANDATORY_INTERPOLATION.test(value)) {
          findings.push(
            finding(
              file,
              entry.line,
              "password",
              `POSTGRES_PASSWORD is a fixed value ("${value}") — read it from .env with a mandatory interpolation, e.g. "\${POSTGRES_PASSWORD:?…}"`,
            ),
          );
        }
      }
    }
  }

  for (const scalar of scalars(root)) {
    if (!/postgres(ql)?:\/\//i.test(scalar.value)) continue;
    const password = urlPassword(scalar.value);
    if (password === null || password === "") continue;
    if (INTERPOLATION.test(password)) continue;
    findings.push(
      finding(
        file,
        scalar.line,
        "password",
        `the connection string carries a fixed password ("${password}") — interpolate it from .env instead`,
      ),
    );
  }

  return findings;
}

/**
 * The findings of one `.env` template: a database password that ships with a
 * value. A template may carry an empty value or a `<…>` placeholder — never a
 * password that works.
 */
export function auditEnvExample(text, file) {
  const findings = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const content = stripComment(raw).trim();
    if (content === "" || content.startsWith("#")) return;
    const equals = content.indexOf("=");
    if (equals < 0) return;
    const key = content.slice(0, equals).trim();
    const value = unquote(content.slice(equals + 1));

    if (key === "POSTGRES_PASSWORD") {
      if (value !== "" && !PLACEHOLDER.test(value)) {
        findings.push(
          finding(
            file,
            line,
            "password",
            `the template ships a fixed database password ("${value}") — ship an empty value or a placeholder instead`,
          ),
        );
      }
      return;
    }

    if (!/postgres(ql)?:\/\//i.test(value)) return;
    const password = urlPassword(value);
    if (password === null || password === "") return;
    if (PLACEHOLDER.test(password)) return;
    findings.push(
      finding(
        file,
        line,
        "password",
        `the template ships a fixed database password ("${password}") — ship a placeholder instead`,
      ),
    );
  });
  return findings;
}

/** The findings of a file, by the kind of file it is. */
export function auditFile(path, text) {
  if (path.endsWith(".env.example") || path.endsWith("/.env.example")) {
    return auditEnvExample(text, path);
  }
  return auditCompose(text, path);
}

/** The findings of every given file. */
export function auditFiles(files) {
  const findings = [];
  for (const file of files) {
    findings.push(...auditFile(file, readFileSync(file, "utf8")));
  }
  return findings;
}

/** The files the gate reads when it is called without arguments. */
export function defaultFiles() {
  return OWNED_FILES.map((file) => join(ROOT, file));
}

/** Run the gate and report. Returns the process exit code. */
export function main(argv) {
  const files = argv.length > 0 ? argv.map((file) => resolve(file)) : defaultFiles();
  let findings;
  try {
    findings = auditFiles(files);
  } catch (error) {
    console.error(`compose exposure gate — ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  console.log(
    `compose exposure gate — ${files.length} file(s) scanned · 4 rule(s)\n`,
  );
  for (const item of findings) {
    console.log(`  ${item.rule.toUpperCase().padEnd(9)} ${item.file}:${item.line} — ${item.message}`);
  }
  if (findings.length === 0) {
    console.log("  ok       the database is bound to the loopback and its password comes from .env");
    console.log("\n0 finding(s).");
    return 0;
  }
  console.error(
    [
      "",
      `${findings.length} finding(s).`,
      "",
      "Bind the database port to 127.0.0.1 and read the password from .env:",
      "the compose stack refuses to start without POSTGRES_PASSWORD, so a",
      "database with a publicly known password can never come up.",
    ].join("\n"),
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
