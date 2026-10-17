// B55 — no workflow may start a stack with the placeholder from `.env.example`.
//
// The app refuses the placeholder (src/lib/auth-secret.ts): it is public, so
// every instance that copies `.env.example` unchanged would run with the same,
// known session-signing key — anybody could mint a valid session cookie for
// any user id.
//
// The site workflow therefore copies `.env.example` and then replaces
// `AUTH_SECRET` with a freshly generated value. This suite pins that: the
// checker below flags every step that copies `.env.example` into `.env`
// without generating a key of its own.
//
// The negative control is the workflow as it was before the fix: the checker
// must flag it, otherwise the test would pass for the wrong reason.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

/** The `AUTH_SECRET` value `.env.example` ships. */
function shippedPlaceholder() {
  const line = readFileSync(join(ROOT, ".env.example"), "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("AUTH_SECRET="));
  if (!line) throw new Error(".env.example has no AUTH_SECRET line");
  return line
    .slice("AUTH_SECRET=".length)
    .trim()
    .replace(/^["']|["']$/g, "");
}

/** Markers of a key that is generated instead of copied. */
const GENERATORS = [
  /token_hex/,
  /token_urlsafe/,
  /randomBytes/,
  /openssl rand/,
  /urandom/,
];

/**
 * The step items of a workflow (the `- ` entries of a `steps:` list). The
 * blocks are found by their list marker, so the indentation of the file does
 * not matter.
 */
function stepBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*- /.test(line)) {
      current = [line];
      blocks.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  return blocks.map((block) => block.join("\n"));
}

/**
 * A step that copies `.env.example` into a `.env` file. The copy itself is
 * fine — the shipped file is a template; what must not happen is a copy
 * without a key of its own.
 */
const COPIES_ENV_EXAMPLE = /\.env\.example[^\n]*\.env\b/;

/**
 * Every step that copies `.env.example` into `.env` without generating a
 * secret of its own. Empty list = nothing to fix.
 */
function findings(text) {
  return stepBlocks(text).filter(
    (block) =>
      COPIES_ENV_EXAMPLE.test(block) &&
      !GENERATORS.some((generator) => generator.test(block)),
  );
}

describe("no workflow ships the .env.example placeholder", () => {
  it("the premise: .env.example ships a placeholder for AUTH_SECRET", () => {
    expect(shippedPlaceholder()).toBe("replace-me-with-a-32-byte-hex-secret");
  });

  it("no workflow file contains the placeholder literally", () => {
    for (const file of readdirSync(WORKFLOW_DIR)) {
      const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
      expect(text).not.toContain(shippedPlaceholder());
    }
  });

  it("no workflow copies .env.example into .env without generating a key", () => {
    for (const file of readdirSync(WORKFLOW_DIR)) {
      const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
      expect(findings(text)).toEqual([]);
    }
  });

  it("the site workflow generates a key for the compose smoke test", () => {
    const text = readFileSync(join(WORKFLOW_DIR, "site.yml"), "utf8");
    const steps = stepBlocks(text).filter((block) => block.includes(".env.example"));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(GENERATORS.some((generator) => generator.test(step))).toBe(true);
    }
  });

  it("flags the workflow as it was before the fix (negative control)", () => {
    const beforeTheFix = [
      "      - name: Prepare environment",
      "        run: cp .env.example .env",
    ].join("\n");
    expect(findings(beforeTheFix).length).toBe(1);
  });

  it("accepts a step that generates a key (negative control)", () => {
    const afterTheFix = [
      "      - name: Prepare environment",
      "        run: |",
      "          cp .env.example .env",
      "          python3 - <<'PY'",
      "          import secrets",
      "          secrets.token_hex(32)",
      "          PY",
    ].join("\n");
    expect(findings(afterTheFix)).toEqual([]);
  });
});
