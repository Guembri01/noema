import { describe, expect, it } from "vitest";
import {
  SLACK_LIMITS,
  SlackPayloadError,
  actions,
  buildSlackMessage,
  button,
  context,
  divider,
  escapeMrkdwn,
  header,
  section,
  slackMessageForEvent,
  truncateBlocks,
  validateSlackMessage,
} from "./slack-blocks";

/**
 * Slack integration — Block Kit payload builder (pure, no network).
 *
 * A Noema event (comment/mention/ticket) turns into a Slack message: escaped
 * user text, well-formed blocks, and a strict validator that refuses any
 * payload Slack would reject (bad types, empty text, over-limit blocks).
 */

describe("escapeMrkdwn", () => {
  it("escapes the three mrkdwn control characters", () => {
    expect(escapeMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapes & first so an existing entity cannot be double-decoded", () => {
    expect(escapeMrkdwn("&amp; <b>")).toBe("&amp;amp; &lt;b&gt;");
  });

  it("neutralizes injected Slack link/mention syntax", () => {
    expect(escapeMrkdwn("<http://evil.test|pwn>")).toBe(
      "&lt;http://evil.test|pwn&gt;",
    );
    expect(escapeMrkdwn("<@U123>")).toBe("&lt;@U123&gt;");
  });

  it("rewrites a safe markdown link into Slack link syntax", () => {
    expect(escapeMrkdwn("[Roadmap](https://noema.example.com/w/p1)")).toBe(
      "<https://noema.example.com/w/p1|Roadmap>",
    );
  });

  it("escapes the label of a rewritten markdown link", () => {
    expect(escapeMrkdwn("[a & b](https://noema.example.com/w/p1)")).toBe(
      "<https://noema.example.com/w/p1|a &amp; b>",
    );
  });

  it("drops an unsafe-scheme markdown link to inert text", () => {
    const out = escapeMrkdwn("[x](javascript:alert(1))");
    expect(out).not.toContain("<");
    expect(out).toContain("javascript");
  });

  it("leaves a bare URL as text, escaping its ampersands", () => {
    expect(escapeMrkdwn("see https://x.io?a=1&b=2 now")).toBe(
      "see https://x.io?a=1&amp;b=2 now",
    );
  });
});

describe("block helpers", () => {
  it("section builds an mrkdwn section block", () => {
    expect(section("Hello")).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Hello" },
    });
  });

  it("header builds a plain_text header block", () => {
    expect(header("New comment")).toEqual({
      type: "header",
      text: { type: "plain_text", text: "New comment", emoji: true },
    });
  });

  it("context collects elements", () => {
    expect(context("one", "two")).toEqual({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "one" },
        { type: "mrkdwn", text: "two" },
      ],
    });
  });

  it("divider has no content", () => {
    expect(divider()).toEqual({ type: "divider" });
  });

  it("actions wraps buttons built from a label + url", () => {
    expect(actions(button("Open", "https://noema.example.com/w/p1"))).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open", emoji: true },
          url: "https://noema.example.com/w/p1",
        },
      ],
    });
  });

  it("rejects an empty header label", () => {
    expect(() => header("   ")).toThrow(SlackPayloadError);
  });

  it("rejects a button with a non-http url", () => {
    expect(() => button("Go", "javascript:alert(1)")).toThrow(SlackPayloadError);
  });
});

describe("buildSlackMessage + strict validation", () => {
  it("returns a text-only message with an empty block list", () => {
    expect(buildSlackMessage({ text: "hello" })).toEqual({
      text: "hello",
      blocks: [],
    });
  });

  it("accepts a blocks-only message", () => {
    const message = buildSlackMessage({ blocks: [divider()] });
    expect(message.text).toBe("");
    expect(message.blocks).toHaveLength(1);
  });

  it("passes a well-formed message", () => {
    const result = validateSlackMessage({
      text: "hi",
      blocks: [section("body"), divider()],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a message with neither text nor blocks", () => {
    const result = validateSlackMessage({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("text or blocks");
  });

  it("rejects more blocks than Slack accepts", () => {
    const blocks = Array.from({ length: SLACK_LIMITS.maxBlocks + 1 }, () =>
      divider(),
    );
    expect(validateSlackMessage({ text: "x", blocks }).ok).toBe(false);
  });

  it("rejects a section with empty text", () => {
    const blank = { type: "section", text: { type: "mrkdwn", text: " " } };
    expect(validateSlackMessage({ text: "x", blocks: [blank] }).ok).toBe(false);
  });

  it("rejects a header longer than its 150-char limit", () => {
    const tooLong = {
      type: "header",
      text: { type: "plain_text", text: "h".repeat(151), emoji: true },
    };
    expect(validateSlackMessage({ text: "x", blocks: [tooLong] }).ok).toBe(
      false,
    );
  });

  it("rejects an unknown block type", () => {
    const bogus = { type: "image", alt_text: "x" } as never;
    expect(validateSlackMessage({ text: "x", blocks: [bogus] }).ok).toBe(false);
  });

  it("rejects more context elements than Slack accepts", () => {
    const elements = Array.from({ length: 11 }, (_, i) => `e${i}`);
    expect(context(...elements).elements).toHaveLength(11);
    expect(
      validateSlackMessage({ text: "x", blocks: [context(...elements)] }).ok,
    ).toBe(false);
  });

  it("buildSlackMessage throws on an over-limit section instead of sending it", () => {
    expect(() =>
      buildSlackMessage({ text: "x", blocks: [section("s".repeat(3001))] }),
    ).toThrow(SlackPayloadError);
  });
});

describe("truncateBlocks", () => {
  it("caps section text at maxText with an ellipsis, keeping the exact length", () => {
    const [block] = truncateBlocks([section("x".repeat(10))], { maxText: 5 });
    expect(block).toEqual(section("xxxx…"));
    if (block.type === "section") expect(block.text.text).toHaveLength(5);
  });

  it("does not mutate the input blocks", () => {
    const original = section("x".repeat(10));
    truncateBlocks([original], { maxText: 5 });
    expect(original.text.text).toBe("x".repeat(10));
  });

  it("leaves non-text blocks untouched", () => {
    expect(truncateBlocks([divider()], { maxText: 1 })).toEqual([divider()]);
  });

  it("truncates context elements too", () => {
    const [block] = truncateBlocks([context("yyyyy", "zzzzz")], { maxText: 3 });
    expect(block).toEqual(context("yy…", "zz…"));
  });
});

describe("slackMessageForEvent", () => {
  it("maps a comment event to header/section/context/actions", () => {
    const message = slackMessageForEvent({
      kind: "comment",
      actor: "Ada",
      pageTitle: "Roadmap",
      pageUrl: "https://noema.example.com/w/acme/p1",
      body: "Nice <work>",
    });
    const types = message.blocks.map((block) => block.type);
    expect(types).toEqual(["header", "section", "context", "actions"]);
    expect(message.text).toBe("Ada commented on Roadmap");
    const [first] = message.blocks;
    expect(first.type === "header" && first.text.text).toBe("New comment");
    const contextBlock = message.blocks[2];
    expect(
      contextBlock.type === "context" && contextBlock.elements[0].text,
    ).toBe("Nice &lt;work&gt;");
  });

  it("maps a mention event and links the page with slack syntax", () => {
    const message = slackMessageForEvent({
      kind: "mention",
      actor: "Ada",
      pageTitle: "Roadmap",
      pageUrl: "https://noema.example.com/w/acme/p1",
    });
    const sectionBlock = message.blocks.find((block) => block.type === "section");
    expect(
      sectionBlock?.type === "section" && sectionBlock.text.text,
    ).toBe("*Ada* mentioned you on <https://noema.example.com/w/acme/p1|Roadmap>");
    expect(message.text).toBe("Ada mentioned you on Roadmap");
  });

  it("maps a ticket event with status and priority context", () => {
    const message = slackMessageForEvent({
      kind: "ticket",
      actor: "Ada",
      ticketKey: "NOE-42",
      title: "Fix <login>",
      ticketUrl: "https://noema.example.com/w/acme/tickets/42",
      status: "todo",
      priority: "high",
    });
    const headerBlock = message.blocks[0];
    expect(headerBlock.type === "header" && headerBlock.text.text).toBe(
      "New ticket: NOE-42",
    );
    const contextBlock = message.blocks.find((block) => block.type === "context");
    expect(
      contextBlock?.type === "context" &&
        contextBlock.elements.map((element) => element.text),
    ).toEqual(["Status: todo", "Priority: high"]);
    expect(message.text).toBe("Ada created NOE-42: Fix <login>");
  });

  it("produces a message the validator accepts", () => {
    const message = slackMessageForEvent({
      kind: "ticket",
      actor: "Ada",
      ticketKey: "NOE-1",
      title: "Ship it",
      ticketUrl: "https://noema.example.com/w/acme/tickets/1",
    });
    expect(validateSlackMessage(message).ok).toBe(true);
  });
});
