import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_SECONDS,
  EVENT_KINDS,
  SUPPORTED_PROVIDERS,
  dedupeKey,
  describeWebhookEndpoint,
  isDuplicate,
  mapEventToActions,
  parseActionRules,
  parseEvent,
  verifySignature,
  type ActionRule,
  type ParsedEvent,
  type WebhookProvider,
} from "@/lib/inbound-webhooks";

// Every test pins the clock via an explicit `now` — nothing here reads the wall
// clock, so signature freshness and the idempotency window are deterministic.
const NOW = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const SECRET = "whsec_inbound_1234567890";
const BODY = '{"hello":"world"}';

const hmac = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("hex");

const githubHeaders = (secret: string, body: string): Record<string, string> => ({
  "x-hub-signature-256": `sha256=${hmac(secret, body)}`,
});

const slackHeaders = (secret: string, body: string, ts: number = NOW_SECONDS): Record<string, string> => ({
  "x-slack-request-timestamp": String(ts),
  "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
});

describe("SUPPORTED_PROVIDERS", () => {
  it("lists exactly the four inbound providers", () => {
    expect(SUPPORTED_PROVIDERS).toEqual(["github", "slack", "generic", "zapier"]);
    expect(EVENT_KINDS).toEqual(["issue", "pr", "push", "message", "custom"]);
  });
});

describe("verifySignature — github", () => {
  it("accepts a valid x-hub-signature-256 HMAC", () => {
    expect(
      verifySignature({
        provider: "github",
        secret: SECRET,
        body: BODY,
        headers: githubHeaders(SECRET, BODY),
        now: NOW,
      }),
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects a mismatched signature (wrong secret)", () => {
    expect(
      verifySignature({
        provider: "github",
        secret: SECRET,
        body: BODY,
        headers: githubHeaders("other-secret", BODY),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "no_match" });
  });

  it("rejects a tampered body", () => {
    expect(
      verifySignature({
        provider: "github",
        secret: SECRET,
        body: `${BODY} `,
        headers: githubHeaders(SECRET, BODY),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "no_match" });
  });

  it("reports a missing signature header", () => {
    expect(
      verifySignature({ provider: "github", secret: SECRET, body: BODY, headers: {}, now: NOW }),
    ).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects a header without the sha256= scheme", () => {
    expect(
      verifySignature({
        provider: "github",
        secret: SECRET,
        body: BODY,
        headers: { "x-hub-signature-256": hmac(SECRET, BODY) },
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "bad_format" });
  });

  it("reads headers case-insensitively", () => {
    expect(
      verifySignature({
        provider: "github",
        secret: SECRET,
        body: BODY,
        headers: { "X-Hub-Signature-256": `sha256=${hmac(SECRET, BODY)}` },
        now: NOW,
      }),
    ).toEqual({ ok: true, reason: "ok" });
  });
});

describe("verifySignature — slack (v0 + replay window)", () => {
  it("accepts a fresh v0 signature", () => {
    expect(
      verifySignature({
        provider: "slack",
        secret: SECRET,
        body: BODY,
        headers: slackHeaders(SECRET, BODY),
        now: NOW,
      }),
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects a stale timestamp beyond the replay window", () => {
    expect(
      verifySignature({
        provider: "slack",
        secret: SECRET,
        body: BODY,
        headers: slackHeaders(SECRET, BODY, NOW_SECONDS - (DEFAULT_TOLERANCE_SECONDS + 1)),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a future timestamp beyond the replay window", () => {
    expect(
      verifySignature({
        provider: "slack",
        secret: SECRET,
        body: BODY,
        headers: slackHeaders(SECRET, BODY, NOW_SECONDS + (DEFAULT_TOLERANCE_SECONDS + 1)),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "future_timestamp" });
  });

  it("accepts a timestamp exactly at the window boundary (inclusive)", () => {
    const past = slackHeaders(SECRET, BODY, NOW_SECONDS - DEFAULT_TOLERANCE_SECONDS);
    const future = slackHeaders(SECRET, BODY, NOW_SECONDS + DEFAULT_TOLERANCE_SECONDS);
    expect(
      verifySignature({ provider: "slack", secret: SECRET, body: BODY, headers: past, now: NOW }),
    ).toEqual({ ok: true, reason: "ok" });
    expect(
      verifySignature({ provider: "slack", secret: SECRET, body: BODY, headers: future, now: NOW }),
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("honours a custom tolerance window", () => {
    const headers = slackHeaders(SECRET, BODY, NOW_SECONDS - 10);
    expect(
      verifySignature({ provider: "slack", secret: SECRET, body: BODY, headers, now: NOW, toleranceSeconds: 5 }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(
      verifySignature({ provider: "slack", secret: SECRET, body: BODY, headers, now: NOW, toleranceSeconds: 10 }),
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("requires the x-slack-request-timestamp header", () => {
    const headers = slackHeaders(SECRET, BODY);
    delete headers["x-slack-request-timestamp"];
    expect(
      verifySignature({ provider: "slack", secret: SECRET, body: BODY, headers, now: NOW }),
    ).toEqual({ ok: false, reason: "missing_timestamp" });
  });

  it("rejects a tampered slack body", () => {
    expect(
      verifySignature({
        provider: "slack",
        secret: SECRET,
        body: "{}",
        headers: slackHeaders(SECRET, BODY),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "no_match" });
  });
});

describe("verifySignature — generic + zapier", () => {
  it("accepts a bare hex HMAC in x-webhook-signature", () => {
    expect(
      verifySignature({
        provider: "generic",
        secret: SECRET,
        body: BODY,
        headers: { "x-webhook-signature": hmac(SECRET, BODY) },
        now: NOW,
      }),
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("accepts an x-signature header and a sha256= prefix", () => {
    expect(
      verifySignature({
        provider: "generic",
        secret: SECRET,
        body: BODY,
        headers: { "x-signature": hmac(SECRET, BODY) },
        now: NOW,
      }),
    ).toEqual({ ok: true, reason: "ok" });
    expect(
      verifySignature({
        provider: "generic",
        secret: SECRET,
        body: BODY,
        headers: { "x-webhook-signature": `sha256=${hmac(SECRET, BODY)}` },
        now: NOW,
      }),
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects a mismatched generic signature", () => {
    expect(
      verifySignature({
        provider: "generic",
        secret: SECRET,
        body: BODY,
        headers: { "x-webhook-signature": hmac("nope", BODY) },
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "no_match" });
  });

  it("treats zapier as a generic HMAC provider", () => {
    expect(
      verifySignature({
        provider: "zapier",
        secret: SECRET,
        body: BODY,
        headers: { "x-webhook-signature": hmac(SECRET, BODY) },
        now: NOW,
      }),
    ).toEqual({ ok: true, reason: "ok" });
  });
});

describe("verifySignature — guards", () => {
  it("rejects an unknown provider", () => {
    expect(
      verifySignature({
        provider: "gitlab" as WebhookProvider,
        secret: SECRET,
        body: BODY,
        headers: { "x-hub-signature-256": `sha256=${hmac(SECRET, BODY)}` },
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "unknown_provider" });
  });

  it("rejects an empty secret", () => {
    expect(
      verifySignature({
        provider: "github",
        secret: "",
        body: BODY,
        headers: githubHeaders(SECRET, BODY),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing_secret" });
  });
});

describe("parseEvent — github", () => {
  it("normalises an issues payload to kind=issue", () => {
    const payload = {
      action: "opened",
      repository: { full_name: "acme/rocket" },
      issue: { number: 7, html_url: "https://github.com/acme/rocket/issues/7", user: { login: "ada" } },
    };
    const event = parseEvent("github", JSON.stringify(payload));
    expect(event.kind).toBe("issue");
    expect(event.refs).toMatchObject({
      repo: "acme/rocket",
      number: 7,
      action: "opened",
      user: "ada",
      url: "https://github.com/acme/rocket/issues/7",
    });
    expect(event.payload).toEqual(payload);
  });

  it("normalises a pull_request payload to kind=pr", () => {
    const event = parseEvent(
      "github",
      JSON.stringify({
        action: "synchronize",
        repository: { full_name: "acme/rocket" },
        pull_request: {
          number: 12,
          html_url: "https://github.com/acme/rocket/pull/12",
          head: { ref: "feat/x", sha: "abc123" },
          user: { login: "ada" },
        },
      }),
    );
    expect(event.kind).toBe("pr");
    expect(event.refs).toMatchObject({ number: 12, branch: "feat/x", sha: "abc123", action: "synchronize" });
  });

  it("normalises a push payload to kind=push", () => {
    const event = parseEvent(
      "github",
      JSON.stringify({
        ref: "refs/heads/main",
        after: "deadbeef",
        commits: [{ id: "deadbeef" }],
        repository: { full_name: "acme/rocket" },
        pusher: { name: "ada" },
      }),
    );
    expect(event.kind).toBe("push");
    expect(event.refs).toMatchObject({ repo: "acme/rocket", branch: "main", sha: "deadbeef", user: "ada" });
  });

  it("normalises an issue comment to kind=message", () => {
    const event = parseEvent(
      "github",
      JSON.stringify({
        action: "created",
        repository: { full_name: "acme/rocket" },
        issue: { number: 7 },
        comment: { id: 99, html_url: "https://github.com/acme/rocket/issues/7#issuecomment-99", user: { login: "ada" } },
      }),
    );
    expect(event.kind).toBe("message");
    expect(event.refs).toMatchObject({ number: 7, id: "99", user: "ada" });
  });

  it("falls back to custom for an unknown github payload", () => {
    const event = parseEvent("github", JSON.stringify({ zen: "Non-blocking is better." }));
    expect(event.kind).toBe("custom");
  });
});

describe("parseEvent — slack", () => {
  it("normalises an event_callback message", () => {
    const event = parseEvent(
      "slack",
      JSON.stringify({
        type: "event_callback",
        event: { type: "message", channel: "C123", user: "U9", ts: "1700000000.000100" },
      }),
    );
    expect(event.kind).toBe("message");
    expect(event.refs).toMatchObject({ channel: "C123", user: "U9", id: "1700000000.000100" });
  });

  it("falls back to custom for a url_verification challenge", () => {
    const event = parseEvent(
      "slack",
      JSON.stringify({ type: "url_verification", challenge: "abc" }),
    );
    expect(event.kind).toBe("custom");
  });
});

describe("parseEvent — generic + zapier", () => {
  it("honours an explicit kind and refs", () => {
    const event = parseEvent(
      "generic",
      JSON.stringify({ kind: "pr", refs: { repo: "acme/rocket", number: 3, url: "https://x/3" } }),
    );
    expect(event.kind).toBe("pr");
    expect(event.refs).toEqual({ repo: "acme/rocket", number: 3, url: "https://x/3" });
  });

  it("maps a bare message payload to kind=message", () => {
    const event = parseEvent("zapier", JSON.stringify({ message: "hello" }));
    expect(event.kind).toBe("message");
  });

  it("never throws on invalid JSON and returns custom", () => {
    const event = parseEvent("generic", "not json {");
    expect(event.kind).toBe("custom");
    expect(event.payload).toBe("not json {");
  });
});

const issueEvent = (): ParsedEvent =>
  parseEvent(
    "github",
    JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/rocket" },
      issue: { number: 7 },
    }),
  );

describe("mapEventToActions", () => {
  it("plans createRow / updateProp / comment for a matching rule", () => {
    const rules: ActionRule[] = [
      {
        id: "r1",
        kinds: ["issue"],
        actions: [
          { type: "createRow", databaseId: "db1", values: { title: "{{repo}}" } },
          { type: "updateProp", propertyId: "status", value: "Inbox" },
          { type: "comment", body: "triage" },
        ],
      },
    ];
    expect(mapEventToActions(issueEvent(), { rules })).toEqual([
      { type: "createRow", ruleId: "r1", databaseId: "db1", values: { title: "{{repo}}" } },
      { type: "updateProp", ruleId: "r1", propertyId: "status", value: "Inbox" },
      { type: "comment", ruleId: "r1", body: "triage" },
    ]);
  });

  it("skips rules whose kinds do not include the event kind", () => {
    const rules: ActionRule[] = [
      { id: "r1", kinds: ["push"], actions: [{ type: "comment", body: "no" }] },
      { id: "r2", kinds: [], actions: [{ type: "comment", body: "yes" }] },
    ];
    expect(mapEventToActions(issueEvent(), { rules })).toEqual([
      { type: "comment", ruleId: "r2", body: "yes" },
    ]);
  });

  it("gates on the automation condition shape read from the event refs", () => {
    const rules: ActionRule[] = [
      {
        id: "r1",
        conditions: { all: [{ propertyId: "action", op: "eq", value: "opened" }] },
        actions: [{ type: "comment", body: "opened" }],
      },
      {
        id: "r2",
        conditions: { any: [{ propertyId: "action", op: "eq", value: "closed" }] },
        actions: [{ type: "comment", body: "closed" }],
      },
    ];
    expect(mapEventToActions(issueEvent(), { rules })).toEqual([
      { type: "comment", ruleId: "r1", body: "opened" },
    ]);
  });

  it("skips disabled rules and malformed rules", () => {
    const rules: ActionRule[] = [
      { id: "r1", enabled: false, actions: [{ type: "comment", body: "no" }] },
      { id: "", actions: [{ type: "comment", body: "no" }] },
      { id: "r3", actions: [{ type: "comment", body: "yes" }] },
    ];
    expect(mapEventToActions(issueEvent(), { rules })).toEqual([
      { type: "comment", ruleId: "r3", body: "yes" },
    ]);
  });

  it("ignores unknown action types without throwing", () => {
    const rules: ActionRule[] = [
      {
        id: "r1",
        actions: [
          { type: "email" } as unknown as ActionRule["actions"][number],
          { type: "updateProp", propertyId: "status", value: "Done" },
        ],
      },
    ];
    expect(mapEventToActions(issueEvent(), { rules })).toEqual([
      { type: "updateProp", ruleId: "r1", propertyId: "status", value: "Done" },
    ]);
  });

  it("returns an empty plan when no rules are supplied", () => {
    expect(mapEventToActions(issueEvent(), { rules: [] })).toEqual([]);
  });
});

describe("parseActionRules", () => {
  it("keeps a well-formed rule and normalises its defaults", () => {
    expect(
      parseActionRules([
        { id: "r1", actions: [{ type: "comment", body: "triage" }] },
      ]),
    ).toEqual([
      {
        id: "r1",
        enabled: true,
        kinds: undefined,
        conditions: undefined,
        actions: [{ type: "comment", body: "triage" }],
      },
    ]);
  });

  it("keeps a disabled rule disabled and drops an unknown event kind", () => {
    const [rule] = parseActionRules([
      { id: "r1", enabled: false, kinds: ["issue", "nope"], actions: [] },
    ]);
    expect(rule.enabled).toBe(false);
    expect(rule.kinds).toEqual(["issue"]);
  });

  it("keeps the condition tree of a rule", () => {
    const [rule] = parseActionRules([
      {
        id: "r1",
        conditions: { all: [{ propertyId: "action", op: "eq", value: "opened" }] },
        actions: [{ type: "comment", body: "opened" }],
      },
    ]);
    expect(rule.conditions).toEqual({
      all: [{ propertyId: "action", op: "eq", value: "opened" }],
    });
  });

  it("drops entries without an id or without an action list", () => {
    expect(
      parseActionRules([
        { id: "", actions: [] },
        { id: "r2" },
        "nope",
        null,
        [{ id: "r3", actions: [] }],
      ]),
    ).toEqual([]);
  });

  it("degrades a malformed list to no rules instead of throwing", () => {
    expect(parseActionRules(null)).toEqual([]);
    expect(parseActionRules(undefined)).toEqual([]);
    expect(parseActionRules({})).toEqual([]);
    expect(parseActionRules("[]")).toEqual([]);
  });
});

describe("dedupeKey", () => {
  it("is stable for the same event", () => {
    expect(dedupeKey(issueEvent())).toBe(dedupeKey(issueEvent()));
  });

  it("distinguishes two actions on the same issue", () => {
    const opened = issueEvent();
    const closed = parseEvent(
      "github",
      JSON.stringify({ action: "closed", repository: { full_name: "acme/rocket" }, issue: { number: 7 } }),
    );
    expect(dedupeKey(opened)).not.toBe(dedupeKey(closed));
  });

  it("namespaces the key by provider", () => {
    expect(dedupeKey({ provider: "slack", kind: "custom", refs: {}, payload: null })).toBe("slack:custom");
  });
});

describe("isDuplicate (idempotency window)", () => {
  it("detects a repeat inside the window", () => {
    expect(isDuplicate([{ key: "k", at: NOW - 1_000 }], "k", { windowMs: 5_000, now: NOW })).toBe(true);
  });

  it("ignores a delivery outside the window", () => {
    expect(isDuplicate([{ key: "k", at: NOW - 6_000 }], "k", { windowMs: 5_000, now: NOW })).toBe(false);
  });

  it("treats the exact window boundary as a duplicate (inclusive)", () => {
    expect(isDuplicate([{ key: "k", at: NOW - 5_000 }], "k", { windowMs: 5_000, now: NOW })).toBe(true);
  });

  it("ignores other keys and an empty history", () => {
    expect(isDuplicate([{ key: "other", at: NOW }], "k", { windowMs: 5_000, now: NOW })).toBe(false);
    expect(isDuplicate([], "k", { windowMs: 5_000, now: NOW })).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(isDuplicate([{ key: "k", at: NOW }], "", { windowMs: 5_000, now: NOW })).toBe(false);
  });
});

describe("describeWebhookEndpoint", () => {
  it("summarises an enabled endpoint without leaking the secret", () => {
    const text = describeWebhookEndpoint({
      id: "wh_1",
      workspaceId: "ws",
      provider: "github",
      secret: SECRET,
      events: ["issues", "push"],
      enabled: true,
    });
    expect(text).toBe('GitHub endpoint "wh_1" (enabled): issues, push');
    expect(text).not.toContain(SECRET);
  });

  it("reports all events and a disabled state", () => {
    expect(
      describeWebhookEndpoint({
        id: "wh_2",
        workspaceId: "ws",
        provider: "slack",
        secret: SECRET,
        events: [],
        enabled: false,
      }),
    ).toBe('Slack endpoint "wh_2" (disabled): all events');
  });

  it("marks a malformed endpoint invalid", () => {
    expect(describeWebhookEndpoint(null)).toBe("Invalid webhook endpoint.");
    expect(describeWebhookEndpoint({ id: "", provider: "github", events: [], enabled: true })).toBe(
      "Invalid webhook endpoint.",
    );
  });
});
