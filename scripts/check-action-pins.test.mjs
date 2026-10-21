// Regression test for the action pins (B66).
//
// The hole: every action the workflows ran was named by a tag
// (`actions/checkout@v4`, `tauri-apps/tauri-action@v0`, …). A tag is a
// movable pointer — its owner can move it, and whoever moves it executes their
// code inside this repository's jobs. One of those actions runs in the
// release job, the one that holds `GITHUB_TOKEN` and the Apple and Windows
// signing secrets. The tool the desktop workflow installs
// (`cargo install tauri-cli --version "^2"`) floated the same way: a range
// resolves to a different release over time.
//
// The gate: `scripts/check-action-pins.mjs` reads the workflows line by line
// and fails on a reference that is not a commit SHA, on a SHA without the
// version behind it, on a tool installed with anything but an exact version,
// and on a cache key that would restore a tool of another version. This file
// pins the gate against the workflows as they were (red) and as they are
// (green).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditWorkflow, scanWorkflow, workflowFiles } from "./check-action-pins.mjs";

/** The workflow source of a repository workflow. */
const sourceOf = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/**
 * The desktop workflow as it was before the fix, cut to the parts the rules
 * read: actions named by a tag, a tool installed with a range, and a cache
 * key that does not carry the tool's version.
 */
const VULNERABLE_WORKFLOW = `name: desktop

on:
  push:
    tags: ["v*"]

jobs:
  release:
    if: \${{ startsWith(github.ref, 'refs/tags/') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4

      - name: Cache the Tauri CLI
        uses: actions/cache@v4
        with:
          path: ~/.cargo/bin/cargo-tauri*
          key: tauri-cli-\${{ runner.os }}-\${{ hashFiles('src-tauri/Cargo.toml') }}

      - name: Install the Tauri CLI
        shell: bash
        run: |
          cargo install tauri-cli --version "^2" --locked

      - name: Build the app and open the draft release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

describe("the pre-fix desktop workflow", () => {
  const violations = auditWorkflow(VULNERABLE_WORKFLOW, { file: "desktop.yml" });
  const rules = violations.map((violation) => violation.rule);

  it("is flagged for every action that floats on a tag", () => {
    expect(rules.filter((rule) => rule === "action-not-pinned-by-sha")).toHaveLength(4);
  });

  it("is flagged for the tool that is installed with a range", () => {
    expect(rules).toContain("tool-version-not-exact");
  });

  it("names the reference and the line it found it on", () => {
    expect(violations[0]).toMatchObject({ file: "desktop.yml", line: 12 });
    expect(violations[0].message).toContain("actions/checkout@v4");
  });
});

describe("the workflows", () => {
  it("pins every action to a commit SHA", () => {
    for (const file of workflowFiles()) {
      expect(auditWorkflow(sourceOf(file), { file })).toEqual([]);
    }
  });

  it("names every action with its version behind the SHA", () => {
    for (const file of workflowFiles()) {
      for (const { reference, comment } of scanWorkflow(sourceOf(file)).references) {
        expect(reference).toMatch(/@[0-9a-f]{40}$/);
        expect(comment).not.toBe("");
      }
    }
  });

  it("pins the Tauri CLI to an exact version", () => {
    const tools = scanWorkflow(sourceOf(".github/workflows/desktop.yml")).tools;
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.crate).toBe("tauri-cli");
      expect(tool.exact).toBe(true);
      expect(tool.version).toBe("2.12.3");
    }
  });

  it("caches the Tauri CLI under a key that carries its version", () => {
    // Otherwise the cache restores the *old* binary, the install step skips
    // itself and the pin names a version nobody runs.
    const { tools, keys } = scanWorkflow(sourceOf(".github/workflows/desktop.yml"));
    for (const tool of tools) {
      const key = keys.find((candidate) => candidate.value.includes(tool.crate));
      expect(key).toBeDefined();
      expect(key.value).toContain(tool.version);
    }
  });

  it("pins every reference of every workflow", () => {
    // The gate is what fails on an unpinned reference; this test says the
    // same thing about the tree in the repository, so the property holds even
    // when the gate is not run.
    //
    // The exact *numbers* are deliberately not fixed here: every round adds a
    // job somewhere, and a test that cries wolf over that would be turned off
    // — which is exactly what would let the next unpinned reference in.
    for (const file of workflowFiles()) {
      const references = scanWorkflow(sourceOf(file)).references;
      expect(references.length, `${file} has no action reference at all`).toBeGreaterThan(0);
      for (const { reference } of references) {
        expect(reference, `${file}: \`${reference}\` is not pinned by SHA`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

describe("the scanner", () => {
  it("accepts a SHA-pinned reference with its version behind it", () => {
    const rules = auditWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toEqual([]);
  });

  it("flags a reference without a SHA", () => {
    const violations = auditWorkflow(
      ["jobs:", "  build:", "    steps:", "      - uses: actions/checkout@v4", ""].join("\n"),
      { file: "other.yml" },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("action-not-pinned-by-sha");
    expect(violations[0].message).toContain("actions/checkout@v4");
  });

  it("flags a branch as well as a tag", () => {
    const rules = auditWorkflow(
      ["jobs:", "  build:", "    steps:", "      - uses: actions/checkout@main", ""].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toEqual(["action-not-pinned-by-sha"]);
  });

  it("flags a SHA that carries no version", () => {
    const violations = auditWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "",
      ].join("\n"),
      { file: "other.yml" },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("action-version-comment-missing");
  });

  it("accepts a local action and a container action", () => {
    // A local action is part of this repository; a container action is an
    // image reference, pinned by digest — neither is a git ref to pin.
    const rules = auditWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: ./.github/actions/build",
        "      - uses: docker://alpine:3.8",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toEqual([]);
  });

  it("ignores a commented-out step", () => {
    const rules = auditWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      # - uses: actions/checkout@v4",
        "      - run: echo hi",
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toEqual([]);
  });

  it("reads the body of a block scalar as text, not as keys", () => {
    const { references } = scanWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          echo 'uses: actions/checkout@v4'",
        "",
      ].join("\n"),
    );
    expect(references).toEqual([]);
  });

  it("flags a tool installed with a range", () => {
    const violations = auditWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        '          cargo install tauri-cli --version "^2" --locked',
        "",
      ].join("\n"),
      { file: "other.yml" },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("tool-version-not-exact");
  });

  it("flags a tool installed without a version", () => {
    const violations = auditWorkflow(
      ["jobs:", "  build:", "    steps:", "      - run: cargo install tauri-cli --locked", ""].join(
        "\n",
      ),
      { file: "other.yml" },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("tool-version-not-exact");
  });

  it("accepts a tool installed with an exact version", () => {
    const rules = auditWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        '          cargo install tauri-cli --version "2.12.3" --locked',
        "",
      ].join("\n"),
      { file: "other.yml" },
    ).map((violation) => violation.rule);
    expect(rules).toEqual([]);
  });

  it("flags a cache key that drops the tool's version", () => {
    const violations = auditWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0",
        "        with:",
        "          path: ~/.cargo/bin/cargo-tauri*",
        "          key: tauri-cli-${{ runner.os }}-${{ hashFiles('src-tauri/Cargo.toml') }}",
        "      - run: |",
        '          cargo install tauri-cli --version "2.12.3" --locked',
        "",
      ].join("\n"),
      { file: "other.yml" },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("tool-cache-key-misses-version");
  });
});
