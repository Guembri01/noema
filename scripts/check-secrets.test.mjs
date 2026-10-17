// B61 — the secret gate (scripts/check-secrets.mjs) must catch the credential
// shapes it claims to catch: a connection string that carries a password, a
// JSON Web Token, an AWS secret access key, the provider tokens, a PGP key
// block and a password value.
//
// The gate scans every tracked file — this one included. So no credential is
// written here: every secret is assembled at run time and lands only in the
// throw-away repository below. The last case keeps this file honest by
// running the gate over its own source.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GATE = new URL("./check-secrets.mjs", import.meta.url).pathname;
const THIS_FILE = new URL("./check-secrets.test.mjs", import.meta.url).pathname;

let repo;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "noema-secrets-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * Writes the files into the throw-away repository and runs the gate over it.
 * Returns the exit code and the output.
 */
function gateFor(files) {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content);
  }
  execFileSync("git", ["add", "--all"], { cwd: repo, encoding: "utf8", stdio: "pipe" });
  try {
    const output = execFileSync("node", [GATE, "--root", repo], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * Joins the parts at run time. The gate scans this file, so a credential must
 * never appear here in contiguous form — only in the throw-away repository.
 */
const joined = (...parts) => parts.join("");
const hex = (bytes) => randomBytes(bytes).toString("hex");

describe("the secret gate (B61)", () => {
  it("flags a connection string that carries a password", () => {
    const url = joined("postgresql://user:", hex(12), "@db:5432/noema");
    const { code, output } = gateFor({ "config.txt": `DATABASE_URL="${url}"\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("config.txt:1");
    expect(output).toContain("connection string with password");
  });

  it("flags a JSON Web Token", () => {
    const token = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "1234567890" })).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ].join(".");
    const { code, output } = gateFor({ "session.txt": `token = ${token}\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("session.txt:1");
    expect(output).toContain("JSON Web Token");
  });

  it("flags an AWS secret access key", () => {
    const key = randomBytes(30).toString("base64");
    const { code, output } = gateFor({
      "aws.txt": `aws_secret_access_key = "${key}"\n`,
    });
    expect(code, output).toBe(1);
    expect(output).toContain("aws.txt:1");
    expect(output).toContain("AWS secret access key");
  });

  it("flags the provider tokens", () => {
    const tokens = {
      "npm token": joined("npm_", hex(18)),
      "GitHub token": joined("ghs_", hex(18)),
      "GitLab token": joined("glpat-", hex(12)),
      "Anthropic key": joined("sk-ant-api03-", hex(24)),
      "Slack app token": joined("xapp-1-", hex(12)),
    };
    for (const [pattern, value] of Object.entries(tokens)) {
      const { code, output } = gateFor({ "token.txt": `${value}\n` });
      expect(code, output).toBe(1);
      expect(output, pattern).toContain("token.txt:1");
      expect(output, pattern).toContain(pattern);
    }
  });

  it("flags a PGP private key block", () => {
    const block = joined("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----");
    const { code, output } = gateFor({ "key.txt": `${block}\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("key.txt:1");
    expect(output).toContain("private key block");
  });

  it("flags a password value that carries no digit", () => {
    const line = joined("password=", '"supersecretpassword"');
    const { code, output } = gateFor({ "pw.txt": `${line}\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("pw.txt:1");
    expect(output).toContain("password value");
  });

  it("does not flag a connection string without a password", () => {
    const line = 'DATABASE_URL="postgresql://db:5432/app"';
    const { code, output } = gateFor({ "config.txt": `${line}\n` });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });

  it("does not flag the documented placeholder", () => {
    // The literal is **assembled** here: the gate scans every tracked file of
    // the repository, and this file is tracked — a literal that looks like a
    // secret in the **source** would be found by the gate (and by the case
    // below). The parts are therefore separate strings; the value is the same.
    const line = 'AUTH_SECRET="' + "replace-me-with-a-32-" + "byte-hex-" + 'secret"';
    const { code, output } = gateFor({ "config.txt": `${line}\n` });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });

  it("does not flag a call that produces the secret", () => {
    const line = "process.env.AUTH_SECRET = ensureAuthSecret();";
    const { code, output } = gateFor({ "config.txt": `${line}\n` });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });

  it("does not flag a certificate", () => {
    const line = "-----BEGIN CERTIFICATE-----";
    const { code, output } = gateFor({ "cert.txt": `${line}\n` });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });

  it("keeps this file free of credential-shaped literals", () => {
    const { code, output } = gateFor({
      "check-secrets.test.mjs": readFileSync(THIS_FILE, "utf8"),
    });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });
});
