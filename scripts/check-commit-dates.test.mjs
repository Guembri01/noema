// The commit gate enforces project-human identities, never dates. GitHub
// automation remains exempt as a whole when it is the committer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-commit-dates.mjs", import.meta.url));

let repo;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "noema-identities-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Tester");
  git("config", "user.email", "tester@example.com");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function gateFor({ author, committer, date }) {
  const git = (args, options = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", ...options });
  git(["commit", "--quiet", "--allow-empty", "-m", "probe"], {
    env: { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: date },
  });
  try {
    const output = execFileSync("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, "HEAD"], { cwd: repo, encoding: "utf8", stdio: "pipe" });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}
const human = (name = "Bilel Guembri", email = "bilel.guembri@outlook.fr") => ({ name, email });

describe("the commit identity gate", () => {
  it("accepts a project human at any date, including an ordinary weekday", () => {
    const result = gateFor({ author: human(), committer: human(), date: "2001-01-01T12:00:00Z" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("project human identities");
  });
  it("rejects an unregistered author or committer", () => {
    const unknown = human("Someone", "someone@example.com");
    const result = gateFor({ author: unknown, committer: unknown, date: "2026-10-19T10:00:00Z" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown identity");
  });
  it("does not treat a human no-reply address as a bot", () => {
    const privateEmail = human("Florian", "2719454+reisi007@users.noreply.github.com");
    expect(gateFor({ author: privateEmail, committer: privateEmail, date: "2026-10-19T10:00:00Z" }).code).toBe(0);
    const unknown = human("Someone", "999+someone@users.noreply.github.com");
    const result = gateFor({ author: unknown, committer: unknown, date: "2026-10-19T10:00:00Z" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown identity");
  });
  it("exempts a GitHub-created commit as a whole", () => {
    expect(gateFor({ author: human("Someone", "someone@example.com"), committer: human("GitHub", "noreply@github.com"), date: "2026-10-19T10:00:00Z" }).code).toBe(0);
  });
  it("does not exempt a bot author committed by a human", () => {
    const bot = human("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com");
    const result = gateFor({ author: bot, committer: human(), date: "2026-10-19T10:00:00Z" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown identity");
  });
});

describe("the pending identity gate", () => {
  function pending({ author = human(), committer, date }) {
    try {
      const output = execFileSync("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, "--pending"], {
        cwd: repo, encoding: "utf8", stdio: "pipe", env: { ...process.env,
          GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_EMAIL: committer.email,
          GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
      return { code: 0, output };
    } catch (error) { return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` }; }
  }
  it("accepts a registered identity regardless of date", () => {
    expect(pending({ committer: human(), date: "2001-01-01T12:00:00Z" }).code).toBe(0);
  });
  it("rejects an unregistered author even when the committer is registered", () => {
    const result = pending({ author: human("Someone", "someone@example.com"), committer: human(), date: "2001-01-01T12:00:00Z" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("author e-mail <someone@example.com> is not a project human");
    expect(result.output).not.toContain("committer e-mail");
  });
  it("rejects an unknown human identity", () => {
    expect(pending({ committer: human("Someone", "someone@example.com"), date: "2001-01-01T12:00:00Z" }).code).toBe(1);
  });
  it("exempts GitHub automation", () => {
    expect(pending({ committer: human("GitHub", "noreply@github.com"), date: "2001-01-01T12:00:00Z" }).code).toBe(0);
  });
});
