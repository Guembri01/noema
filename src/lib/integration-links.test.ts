import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITHUB_BASE_URL,
  DEFAULT_SLACK_WORKSPACE_URL,
  buildGithubLink,
  buildSlackLink,
  linkify,
  parseGithubRefs,
  parseSlackRefs,
  unfurlPayload,
  type GithubRef,
  type SlackRef,
} from "./integration-links";

/**
 * Slack + GitHub integration — linkifier (docs/FEATURE_MATRIX.md
 * "Slack integration" / "GitHub integration").
 *
 * Pure string work only: detect GitHub issue/PR/commit references and Slack
 * channel/user/permalink references in plain markdown, build deterministic
 * links from them, linkify free text while never touching fenced or inline
 * code, and pull a small unfurl summary out of a fetched payload. No network,
 * no DOM, no DB.
 */

const SHORT_SHA = "a1b2c3d";
const FULL_SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function ref(partial: Partial<GithubRef> & Pick<GithubRef, "kind" | "id">): GithubRef {
  return {
    owner: "acme",
    repo: "web",
    url: "",
    raw: "",
    ...partial,
  };
}

describe("parseGithubRefs", () => {
  it("parses an owner/repo#number shorthand as an issue", () => {
    expect(parseGithubRefs("fixes acme/web#42")).toEqual([
      {
        kind: "issue",
        owner: "acme",
        repo: "web",
        id: "42",
        url: "https://github.com/acme/web/issues/42",
        raw: "acme/web#42",
      },
    ]);
  });

  it("parses a bare #number without repository context", () => {
    expect(parseGithubRefs("closes #42")).toEqual([
      {
        kind: "issue",
        owner: "",
        repo: "",
        id: "42",
        url: "#42",
        raw: "#42",
      },
    ]);
  });

  it("resolves a bare #number against the supplied owner/repo context", () => {
    const refs = parseGithubRefs("closes #42", { owner: "acme", repo: "web" });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "issue",
      owner: "acme",
      repo: "web",
      id: "42",
      url: "https://github.com/acme/web/issues/42",
    });
  });

  it("parses a full 40-hex commit SHA as a commit", () => {
    const refs = parseGithubRefs(`pushed ${FULL_SHA}`);
    expect(refs).toEqual([
      {
        kind: "commit",
        owner: "",
        repo: "",
        id: FULL_SHA,
        url: FULL_SHA,
        raw: FULL_SHA,
      },
    ]);
  });

  it("parses a short 7-hex commit SHA as a commit", () => {
    const refs = parseGithubRefs(`see ${SHORT_SHA}`);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("commit");
    expect(refs[0].id).toBe(SHORT_SHA);
  });

  it("ignores hex runs shorter than 7 characters", () => {
    expect(parseGithubRefs("value a1b2c3 here")).toEqual([]);
  });

  it("ignores an all-digit run so #numbers stay issues", () => {
    expect(parseGithubRefs("count 1234567")).toEqual([]);
  });

  it("does not match a SHA glued to surrounding word characters", () => {
    expect(parseGithubRefs("xdeadbeefy")).toEqual([]);
  });

  it("parses owner/repo@sha as a commit", () => {
    const refs = parseGithubRefs(`acme/web@${FULL_SHA}`);
    expect(refs).toEqual([
      {
        kind: "commit",
        owner: "acme",
        repo: "web",
        id: FULL_SHA,
        url: `https://github.com/acme/web/commit/${FULL_SHA}`,
        raw: `acme/web@${FULL_SHA}`,
      },
    ]);
  });

  it("parses an issue URL", () => {
    const refs = parseGithubRefs("https://github.com/acme/web/issues/12");
    expect(refs).toEqual([
      {
        kind: "issue",
        owner: "acme",
        repo: "web",
        id: "12",
        url: "https://github.com/acme/web/issues/12",
        raw: "https://github.com/acme/web/issues/12",
      },
    ]);
  });

  it("parses a pull-request URL as a pr", () => {
    const refs = parseGithubRefs("https://github.com/acme/web/pull/7");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "pr", id: "7" });
    expect(refs[0].url).toBe("https://github.com/acme/web/pull/7");
  });

  it("parses a commit URL as a commit", () => {
    const refs = parseGithubRefs("https://github.com/acme/web/commit/deadbeef");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "commit", id: "deadbeef" });
  });

  it("normalizes a www URL onto the canonical github host", () => {
    const refs = parseGithubRefs("https://www.github.com/acme/web/issues/5");
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe("https://github.com/acme/web/issues/5");
    expect(refs[0].raw).toBe("https://www.github.com/acme/web/issues/5");
  });

  it("returns one ref for owner/repo#number instead of overlapping twice", () => {
    expect(parseGithubRefs("acme/web#123")).toHaveLength(1);
  });

  it("returns one ref for owner/repo@sha instead of also matching the SHA", () => {
    expect(parseGithubRefs(`acme/web@${FULL_SHA}`)).toHaveLength(1);
  });

  it("returns refs in the order they appear", () => {
    const refs = parseGithubRefs(`acme/web#1 and #2 and ${SHORT_SHA}`);
    expect(refs.map((r) => [r.kind, r.id])).toEqual([
      ["issue", "1"],
      ["issue", "2"],
      ["commit", SHORT_SHA],
    ]);
  });

  it("returns nothing for text without GitHub references", () => {
    expect(parseGithubRefs("no refs here")).toEqual([]);
  });

  it("does not treat Slack mentions or channels as GitHub refs", () => {
    expect(parseGithubRefs("#general @alice")).toEqual([]);
  });
});

describe("parseSlackRefs", () => {
  it("parses a #channel reference", () => {
    expect(parseSlackRefs("ping #general")).toEqual([
      {
        kind: "channel",
        id: "general",
        url: `${DEFAULT_SLACK_WORKSPACE_URL}/channels/general`,
        raw: "#general",
      },
    ]);
  });

  it("builds a channel link from the workspace URL when given", () => {
    const refs = parseSlackRefs("ping #product-updates", {
      workspaceUrl: "https://acme.slack.com",
    });
    expect(refs[0].url).toBe("https://acme.slack.com/channels/product-updates");
  });

  it("parses an @user reference", () => {
    expect(parseSlackRefs("cc @alice")).toEqual([
      {
        kind: "user",
        id: "alice",
        url: `${DEFAULT_SLACK_WORKSPACE_URL}/team/alice`,
        raw: "@alice",
      },
    ]);
  });

  it("parses a slack.com permalink, splitting the timestamp", () => {
    const raw = "https://acme.slack.com/archives/C123/p1234567890123456";
    expect(parseSlackRefs(raw)).toEqual([
      {
        kind: "permalink",
        id: "C123",
        channel: "C123",
        ts: "1234567890.123456",
        url: raw,
        raw,
      },
    ]);
  });

  it("parses a permalink without a message timestamp", () => {
    const raw = "https://acme.slack.com/archives/C123";
    const refs = parseSlackRefs(raw);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "permalink", id: "C123" });
    expect(refs[0].ts).toBeUndefined();
  });

  it("treats an all-digit #token as GitHub, not a Slack channel", () => {
    expect(parseSlackRefs("closes #123")).toEqual([]);
  });

  it("does not match an @ inside an email address", () => {
    expect(parseSlackRefs("mail a@b.com")).toEqual([]);
  });

  it("returns channel and user refs in order", () => {
    const refs = parseSlackRefs("#general @alice");
    expect(refs.map((r) => [r.kind, r.id])).toEqual([
      ["channel", "general"],
      ["user", "alice"],
    ]);
  });
});

describe("buildGithubLink", () => {
  it("builds issue, pr and commit paths", () => {
    expect(buildGithubLink(ref({ kind: "issue", id: "42" }))).toBe(
      "https://github.com/acme/web/issues/42",
    );
    expect(buildGithubLink(ref({ kind: "pr", id: "7" }))).toBe(
      "https://github.com/acme/web/pull/7",
    );
    expect(buildGithubLink(ref({ kind: "commit", id: "deadbeef" }))).toBe(
      "https://github.com/acme/web/commit/deadbeef",
    );
  });

  it("uses a custom base URL and trims a trailing slash", () => {
    expect(
      buildGithubLink(ref({ kind: "issue", id: "42" }), {
        baseUrl: "https://gh.example.test/",
      }),
    ).toBe("https://gh.example.test/acme/web/issues/42");
  });

  it("returns the raw token for a context-free reference", () => {
    expect(
      buildGithubLink({ kind: "issue", owner: "", repo: "", id: "42", url: "#42", raw: "#42" }),
    ).toBe("#42");
  });
});

describe("buildSlackLink", () => {
  it("builds channel and user links from the workspace URL", () => {
    expect(
      buildSlackLink(
        { kind: "channel", id: "general", url: "", raw: "#general" },
        { workspaceUrl: "https://acme.slack.com" },
      ),
    ).toBe("https://acme.slack.com/channels/general");
    expect(
      buildSlackLink(
        { kind: "user", id: "alice", url: "", raw: "@alice" },
        { workspaceUrl: "https://acme.slack.com/" },
      ),
    ).toBe("https://acme.slack.com/team/alice");
  });

  it("falls back to the app workspace when none is given", () => {
    expect(buildSlackLink({ kind: "channel", id: "general", url: "", raw: "#general" })).toBe(
      `${DEFAULT_SLACK_WORKSPACE_URL}/channels/general`,
    );
  });

  it("returns a permalink URL unchanged", () => {
    const raw = "https://acme.slack.com/archives/C123/p1234567890123456";
    expect(
      buildSlackLink({ kind: "permalink", id: "C123", channel: "C123", url: raw, raw }),
    ).toBe(raw);
  });

  it("rebuilds a permalink from channel and ts when the URL is missing", () => {
    expect(
      buildSlackLink(
        { kind: "permalink", id: "C123", channel: "C123", ts: "1234567890.123456", url: "", raw: "" },
        { workspaceUrl: "https://acme.slack.com" },
      ),
    ).toBe("https://acme.slack.com/archives/C123/p1234567890123456");
  });
});

describe("linkify", () => {
  it("turns a GitHub shorthand into a markdown link", () => {
    expect(linkify("fixes acme/web#42", { providers: { github: {} } })).toBe(
      "fixes [acme/web#42](https://github.com/acme/web/issues/42)",
    );
  });

  it("turns a Slack channel into a markdown link using the workspace URL", () => {
    expect(
      linkify("ping #general", {
        providers: { slack: { workspaceUrl: "https://acme.slack.com" } },
      }),
    ).toBe("ping [#general](https://acme.slack.com/channels/general)");
  });

  it("resolves a bare #number when the github provider supplies owner/repo", () => {
    expect(
      linkify("closes #12", {
        providers: { github: { owner: "acme", repo: "web" } },
      }),
    ).toBe("closes [#12](https://github.com/acme/web/issues/12)");
  });

  it("leaves a bare #number alone when there is no repository context", () => {
    expect(linkify("closes #12", { providers: { github: {} } })).toBe("closes #12");
  });

  it("never linkifies inside a fenced code block", () => {
    const input = ["see acme/web#1", "```", "acme/web#2", "```", "done acme/web#3"].join("\n");
    expect(linkify(input, { providers: { github: {} } })).toBe(
      [
        "see [acme/web#1](https://github.com/acme/web/issues/1)",
        "```",
        "acme/web#2",
        "```",
        "done [acme/web#3](https://github.com/acme/web/issues/3)",
      ].join("\n"),
    );
  });

  it("never linkifies inside a tilde-fenced code block", () => {
    const input = ["~~~", "acme/web#1", "~~~", "acme/web#2"].join("\n");
    expect(linkify(input, { providers: { github: {} } })).toBe(
      ["~~~", "acme/web#1", "~~~", "[acme/web#2](https://github.com/acme/web/issues/2)"].join(
        "\n",
      ),
    );
  });

  it("never linkifies inside an inline code span", () => {
    expect(linkify("use `acme/web#1` then acme/web#2", { providers: { github: {} } })).toBe(
      "use `acme/web#1` then [acme/web#2](https://github.com/acme/web/issues/2)",
    );
  });

  it("linkifies refs from both providers without overlapping", () => {
    expect(
      linkify("acme/web#1 and #general", { providers: { github: {}, slack: {} } }),
    ).toBe(
      "[acme/web#1](https://github.com/acme/web/issues/1) and " +
        `[#general](${DEFAULT_SLACK_WORKSPACE_URL}/channels/general)`,
    );
  });

  it("returns the text unchanged when no provider is enabled", () => {
    expect(linkify("acme/web#1", {})).toBe("acme/web#1");
  });

  it("links a full GitHub URL whose label is the URL itself", () => {
    expect(linkify("https://github.com/acme/web/issues/3", { providers: { github: {} } })).toBe(
      "[https://github.com/acme/web/issues/3](https://github.com/acme/web/issues/3)",
    );
  });
});

describe("unfurlPayload", () => {
  const issueRef: GithubRef = {
    kind: "issue",
    owner: "acme",
    repo: "web",
    id: "1",
    url: "https://github.com/acme/web/issues/1",
    raw: "acme/web#1",
  };

  it("extracts title, state and author from a GitHub issue payload", () => {
    expect(
      unfurlPayload(issueRef, {
        title: "Bug report",
        state: "open",
        user: { login: "alice" },
        html_url: "https://github.com/acme/web/issues/1",
      }),
    ).toEqual({
      title: "Bug report",
      state: "open",
      author: "alice",
      url: "https://github.com/acme/web/issues/1",
    });
  });

  it("reports a merged pull request as state merged", () => {
    const prRef: GithubRef = { ...issueRef, kind: "pr", id: "7", raw: "acme/web#7" };
    const result = unfurlPayload(prRef, {
      title: "Ship it",
      state: "closed",
      merged: true,
      user: { login: "bob" },
    });
    expect(result.state).toBe("merged");
    expect(result.author).toBe("bob");
  });

  it("uses the first line of a commit message as the title", () => {
    const commitRef: GithubRef = {
      ...issueRef,
      kind: "commit",
      id: "deadbeef",
      url: "https://github.com/acme/web/commit/deadbeef",
      raw: "acme/web@deadbeef",
    };
    const result = unfurlPayload(commitRef, {
      commit: { message: "fix: crash on save\n\nmore detail" },
      author: { login: "carol" },
    });
    expect(result.title).toBe("fix: crash on save");
    expect(result.author).toBe("carol");
    expect(result.state).toBeNull();
  });

  it("extracts title and author from a Slack payload", () => {
    const channelRef: SlackRef = {
      kind: "channel",
      id: "general",
      url: "https://acme.slack.com/channels/general",
      raw: "#general",
    };
    expect(unfurlPayload(channelRef, { text: "Deploy done", user: "dave" })).toEqual({
      title: "Deploy done",
      state: null,
      author: "dave",
      url: "https://acme.slack.com/channels/general",
    });
  });

  it("falls back to the raw token and the ref URL for an empty payload", () => {
    expect(unfurlPayload(issueRef, {})).toEqual({
      title: "acme/web#1",
      state: null,
      author: null,
      url: issueRef.url,
    });
  });

  it("tolerates a non-object payload", () => {
    expect(unfurlPayload(issueRef, null)).toEqual({
      title: "acme/web#1",
      state: null,
      author: null,
      url: issueRef.url,
    });
  });
});

describe("constants", () => {
  it("expose the default bases", () => {
    expect(DEFAULT_GITHUB_BASE_URL).toBe("https://github.com");
    expect(DEFAULT_SLACK_WORKSPACE_URL).toBe("https://app.slack.com");
  });
});
