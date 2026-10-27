// B85 — the authoring-window gate (scripts/check-commit-dates.mjs).
//
// The gate has two policies: the *date* policy (author and committer date
// inside a Wed–Sat 19:00–06:00 Europe/Paris window) and the *identity* policy
// (both e-mail addresses belong to a project human). A commit that GitHub
// itself created is exempt from both — as a whole, and only when its
// *committer* is GitHub's automation.
//
// The exemption is the risky part, so it is pinned here: a *human* who keeps
// their e-mail private commits as `<id>+<login>@users.noreply.github.com`, and
// that address must NOT be treated as a bot. An earlier version of the
// exemption matched the whole no-reply domain and silently switched both
// policies off for every such person — including the address registered in the
// `HUMANS` map, which made that entry unreachable.
//
// The anchor is the committer and the scope is the whole commit. GitHub's
// synthetic merge commit (`refs/pull/N/merge`, which a pull-request checkout
// makes `HEAD`) carries the *human's* address in its author field while its
// clock and its committer are GitHub's — an exemption that only covered the
// field holding the bot address left that commit failing the gate, and the CI
// runs the gate, so every pull request was red.
//
// The gate is exercised end to end in a throwaway repository: each case writes
// one commit with a crafted identity and date, then runs the script against it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-commit-dates.mjs", import.meta.url));

/** A window that is closed: Saturday 2026-10-17 19:30 Europe/Paris. */
const IN_WINDOW = "2026-10-17T17:30:00Z";
/** A Monday — no authoring window exists on a Monday. */
const OUT_OF_WINDOW = "2026-10-19T10:00:00Z";

let repo;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "noema-dates-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Tester");
  git("config", "user.email", "tester@example.com");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * Write one commit with the given identity and date, and run the gate over it.
 * Returns the exit code and the output.
 */
function gateFor({ author, committer, date }) {
  const git = (args, options = {}) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      ...options,
    });
  git(
    ["commit", "--quiet", "--allow-empty", "-m", "probe"],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_DATE: date,
      },
    },
  );
  try {
    // The gate imports a TypeScript module, so it needs Node's native type
    // stripping — the same invocation the CI uses.
    const output = execFileSync(
      "node",
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, "HEAD"],
      {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const human = (name = "Bilel Guembri", email = "bilel.guembri@outlook.fr") => ({
  name,
  email,
});

describe("the authoring-window gate (B85)", () => {
  it("accepts a project human inside a window", () => {
    const result = gateFor({
      author: human(),
      committer: human(),
      date: IN_WINDOW,
    });
    expect(result.code).toBe(0);
  });

  it("accepts every registered project human's address, like the newest one", () => {
    // Every address in the `HUMANS` map must pass the identity check; the
    // newest contributor's is pinned here so a registration gap shows up as
    // this test, not as the contributor's red pull request.
    const ugochukwu = human("Ugochukwu Chidera", "ugochukwuc762@gmail.com");
    const result = gateFor({
      author: ugochukwu,
      committer: ugochukwu,
      date: IN_WINDOW,
    });
    expect(result.code).toBe(0);
  });

  it("rejects a project human outside a window", () => {
    const result = gateFor({
      author: human(),
      committer: human(),
      date: OUT_OF_WINDOW,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("outside every window");
  });

  it("rejects a human whose e-mail address is not a project human", () => {
    const result = gateFor({
      author: human("Someone", "someone@example.com"),
      committer: human("Someone", "someone@example.com"),
      date: IN_WINDOW,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown identity");
  });

  it("does not treat a human's no-reply address as a bot", () => {
    // `<id>+<login>@users.noreply.github.com` is what a human with a private
    // e-mail commits as. It is not a bot, so both policies apply to it.
    const noReply = human("Florian", "2719454+reisi007@users.noreply.github.com");
    const result = gateFor({
      author: noReply,
      committer: noReply,
      date: OUT_OF_WINDOW,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("outside every window");
  });

  it("exempts the commit GitHub created: a human author, GitHub's committer", () => {
    // The shape of GitHub's synthetic merge commit (`refs/pull/N/merge`): the
    // author field carries the *human's* address, while the clock and the
    // committer are GitHub's. The exemption is anchored on the committer and
    // covers the whole commit — with a per-field exemption this commit fails
    // the gate, and the CI runs the gate, so every pull request that
    // carries such a merge commit is red.
    const result = gateFor({
      author: human("Florian Reisinger", "reisi007@gmail.com"),
      committer: human("GitHub", "noreply@github.com"),
      date: OUT_OF_WINDOW,
    });
    expect(result.code).toBe(0);
  });

  it("exempts a bot that commits itself, like a Dependabot branch commit", () => {
    const bot = human("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com");
    const result = gateFor({
      author: bot,
      committer: bot,
      date: OUT_OF_WINDOW,
    });
    expect(result.code).toBe(0);
  });

  it("rejects a bot author whose committer is a human", () => {
    // The reverse anchor: GitHub did not create this commit — a human
    // committed on top of a bot's work — so it is checked like any other one,
    // its author field included.
    const bot = human("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com");
    const result = gateFor({
      author: bot,
      committer: human(),
      date: OUT_OF_WINDOW,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown identity");
    expect(result.output).toContain("outside every window");
  });

  it("rejects an unknown human's no-reply address on the identity check too", () => {
    // The F1 case above uses an address that *is* in `HUMANS`, so it fails on
    // the date. This one is inside a window, so only the identity check can
    // reject it — which is exactly the half of the policy a broad bot pattern
    // would have switched off.
    const noReply = human("Someone", "999+someone@users.noreply.github.com");
    const result = gateFor({
      author: noReply,
      committer: noReply,
      date: IN_WINDOW,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown identity");
  });
});

describe("the pending path of the gate (B85)", () => {
  /** Run the gate in `--pending` mode with a crafted commit environment. */
  function pending({ committer, date }) {
    try {
      const output = execFileSync(
        "node",
        ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, "--pending"],
        {
          cwd: repo,
          encoding: "utf8",
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_COMMITTER_EMAIL: committer.email,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
          },
        },
      );
      return { code: 0, output };
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  }

  it("accepts a project human inside a window", () => {
    const result = pending({
      committer: human(),
      date: IN_WINDOW,
    });
    expect(result.code).toBe(0);
  });

  it("rejects a project human outside a window", () => {
    const result = pending({
      committer: human(),
      date: OUT_OF_WINDOW,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("outside every window");
  });

  it("exempts a commit GitHub's automation committers, like the history path", () => {
    // The pending path applies the same rule as the history path: the
    // committer decides. A commit GitHub's automation committers is exempt as
    // a whole; a commit a human committers is checked.
    const result = pending({
      committer: human("GitHub", "noreply@github.com"),
      date: OUT_OF_WINDOW,
    });
    expect(result.code).toBe(0);
  });
});
