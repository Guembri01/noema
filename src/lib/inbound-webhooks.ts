/**
 * Inbound webhook engine — the **pure** model behind receiving events from
 * outside a workspace (docs/specs/integrations-api.md, "Inbound webhooks";
 * `docs/FEATURE_MATRIX.md` §13 Inbound webhooks). An integration POSTs a
 * provider-shaped payload at a `WebhookEndpoint`; this module decides whether
 * the request is authentic, normalises the provider vocabulary into one
 * `ParsedEvent`, plans the workspace actions a matching rule should run, and
 * offers a deterministic idempotency key so a redelivery is a no-op.
 *
 * Nothing here performs I/O, touches the clock or reads a database: the caller
 * threads `now` explicitly. The plan step reuses the **automation condition
 * shape** (`evaluateConditions` from `src/lib/automation-engine.ts`, imported
 * read-only) so a webhook rule can gate on exactly the same `all`/`any`/`none`
 * DSL a database automation uses.
 *
 * Providers:
 * - `github`  — `x-hub-signature-256: sha256=<HMAC-SHA256(secret, body)>`.
 * - `slack`   — `v0` scheme over `v0:<ts>:<body>` with
 *               `x-slack-request-timestamp`, replay-bounded by a tolerance
 *               window (Slack's documented 5 minutes by default).
 * - `generic` / `zapier` — a bare (optionally `sha256=`-prefixed) HMAC over the
 *               raw body, in `x-webhook-signature` or `x-signature`.
 */

import { createHmac } from "node:crypto";

import { type AutomationRow, type Conditions, evaluateConditions } from "@/lib/automation-engine";
import { constantTimeEqualHex } from "@/lib/webhook-signature";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The provider a webhook endpoint may be bound to. */
export const SUPPORTED_PROVIDERS = ["github", "slack", "generic", "zapier"] as const;

export type WebhookProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** The normalised event kinds every provider payload collapses into. */
export const EVENT_KINDS = ["issue", "pr", "push", "message", "custom"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** A workspace-scoped inbound webhook binding. The secret is never rendered. */
export type WebhookEndpoint = {
  id: string;
  workspaceId: string;
  provider: WebhookProvider;
  secret: string;
  events: string[];
  enabled: boolean;
};

/** The planned action kinds a webhook rule may emit. */
export const PLANNED_ACTION_TYPES = ["createRow", "updateProp", "comment"] as const;

export type PlannedActionType = (typeof PLANNED_ACTION_TYPES)[number];

/** Default replay window (seconds), matching Slack's documented 5 minutes. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Guards & small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isProvider = (value: unknown): value is WebhookProvider =>
  typeof value === "string" && (SUPPORTED_PROVIDERS as readonly string[]).includes(value);

const asEventKind = (value: unknown): EventKind | null =>
  typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value)
    ? (value as EventKind)
    : null;

function readHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!isRecord(headers)) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === "string") return value;
  }
  return undefined;
}

const hmacHex = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("hex");

/**
 * Strip a `scheme=` prefix and validate the remaining lowercase/uppercase hex.
 * Returns `null` when the value is not `<scheme>=<hex>`.
 */
function stripHexScheme(value: string, scheme: string): string | null {
  const prefix = `${scheme}=`;
  if (!value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length).trim().toLowerCase();
  return /^[0-9a-f]+$/.test(hex) ? hex : null;
}

const normalizeTolerance = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_TOLERANCE_SECONDS;

function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readId(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export type VerifyFailureReason =
  | "unknown_provider"
  | "missing_secret"
  | "missing_signature"
  | "missing_timestamp"
  | "bad_format"
  | "no_match"
  | "stale_timestamp"
  | "future_timestamp";

export type VerifyResult = { ok: true; reason: "ok" } | { ok: false; reason: VerifyFailureReason };

export type SignatureVerificationInput = {
  provider: WebhookProvider;
  secret: string;
  /** The **raw** request body, exactly as signed. */
  body: string;
  /** Request headers; lookups are case-insensitive. */
  headers: Record<string, string | undefined>;
  /** Unix **milliseconds** treated as "now". */
  now: number;
  /** Symmetric replay window in seconds. Defaults to 300. */
  toleranceSeconds?: number;
};

const ok = (): VerifyResult => ({ ok: true, reason: "ok" });
const fail = (reason: VerifyFailureReason): VerifyResult => ({ ok: false, reason });

function verifyGithub(
  secret: string,
  body: string,
  headers: Record<string, string | undefined>,
): VerifyResult {
  const raw = readHeader(headers, "x-hub-signature-256");
  if (raw === undefined || raw.trim() === "") return fail("missing_signature");
  const provided = stripHexScheme(raw.trim(), "sha256");
  if (provided === null) return fail("bad_format");
  return constantTimeEqualHex(provided, hmacHex(secret, body)) ? ok() : fail("no_match");
}

function verifySlack(
  secret: string,
  body: string,
  headers: Record<string, string | undefined>,
  now: number,
  toleranceSeconds: number | undefined,
): VerifyResult {
  const raw = readHeader(headers, "x-slack-signature");
  if (raw === undefined || raw.trim() === "") return fail("missing_signature");
  const provided = stripHexScheme(raw.trim(), "v0");
  if (provided === null) return fail("bad_format");

  const tsRaw = readHeader(headers, "x-slack-request-timestamp");
  if (tsRaw === undefined || tsRaw.trim() === "") return fail("missing_timestamp");
  if (!/^\d+$/.test(tsRaw.trim())) return fail("bad_format");

  const timestamp = Number(tsRaw.trim());
  const tolerance = normalizeTolerance(toleranceSeconds);
  const nowSeconds = Math.floor((Number.isFinite(now) ? now : 0) / 1000);
  const age = nowSeconds - timestamp;
  // Freshness is checked before the MAC, exactly like the outbound verifier:
  // a stale header never gets a signature oracle, and the boundary is inclusive.
  if (age > tolerance) return fail("stale_timestamp");
  if (age < -tolerance) return fail("future_timestamp");

  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return constantTimeEqualHex(provided, expected) ? ok() : fail("no_match");
}

function verifyGeneric(
  secret: string,
  body: string,
  headers: Record<string, string | undefined>,
): VerifyResult {
  const raw =
    readHeader(headers, "x-webhook-signature") ??
    readHeader(headers, "x-signature") ??
    readHeader(headers, "x-hub-signature-256");
  if (raw === undefined || raw.trim() === "") return fail("missing_signature");

  const trimmed = raw.trim();
  const provided = trimmed.startsWith("sha256=")
    ? stripHexScheme(trimmed, "sha256")
    : /^[0-9a-f]+$/i.test(trimmed)
      ? trimmed.toLowerCase()
      : null;
  if (provided === null) return fail("bad_format");
  return constantTimeEqualHex(provided, hmacHex(secret, body)) ? ok() : fail("no_match");
}

/**
 * Verify an inbound request signature against the endpoint's secret. Never
 * throws: an unknown provider, a missing secret/header, a malformed value, a
 * stale/future Slack timestamp or a MAC mismatch each yield a stable `reason`.
 */
export function verifySignature(input: SignatureVerificationInput): VerifyResult {
  if (!isProvider(input.provider)) return fail("unknown_provider");
  if (typeof input.secret !== "string" || input.secret === "") return fail("missing_secret");

  const body = typeof input.body === "string" ? input.body : "";
  const headers = input.headers ?? {};

  switch (input.provider) {
    case "github":
      return verifyGithub(input.secret, body, headers);
    case "slack":
      return verifySlack(input.secret, body, headers, input.now, input.toleranceSeconds);
    case "generic":
    case "zapier":
      return verifyGeneric(input.secret, body, headers);
  }
}

// ---------------------------------------------------------------------------
// Payload normalisation
// ---------------------------------------------------------------------------

/** Provider-agnostic cross-references lifted out of a raw payload. */
export type EventRefs = {
  repo?: string;
  number?: number;
  url?: string;
  branch?: string;
  sha?: string;
  channel?: string;
  user?: string;
  action?: string;
  /** The delivery's own id (comment id, Slack `ts`, generic `id`) when known. */
  id?: string;
};

export type ParsedEvent = {
  provider: WebhookProvider;
  kind: EventKind;
  refs: EventRefs;
  /** The (parsed) raw payload, preserved for rule conditions and debugging. */
  payload: unknown;
};

function coercePayload(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

function pickRefs(source: unknown): EventRefs {
  if (!isRecord(source)) return {};
  const refs: EventRefs = {};
  const repo = readString(source, "repo");
  if (repo !== undefined) refs.repo = repo;
  const number = readNumber(source, "number");
  if (number !== undefined) refs.number = number;
  const url = readString(source, "url");
  if (url !== undefined) refs.url = url;
  const branch = readString(source, "branch");
  if (branch !== undefined) refs.branch = branch;
  const sha = readString(source, "sha");
  if (sha !== undefined) refs.sha = sha;
  const channel = readString(source, "channel");
  if (channel !== undefined) refs.channel = channel;
  const user = readString(source, "user");
  if (user !== undefined) refs.user = user;
  const action = readString(source, "action");
  if (action !== undefined) refs.action = action;
  const id = readId(source, "id");
  if (id !== undefined) refs.id = id;
  return refs;
}

function parseGithub(payload: unknown): { kind: EventKind; refs: EventRefs } {
  if (!isRecord(payload)) return { kind: "custom", refs: {} };

  const repo = readString(payload.repository, "full_name");
  const action = readString(payload, "action");
  const sender = readString(payload.sender, "login");

  const pull = payload.pull_request;
  if (isRecord(pull)) {
    return {
      kind: "pr",
      refs: {
        repo,
        action,
        user: sender ?? readString(pull.user, "login"),
        number: readNumber(pull, "number"),
        url: readString(pull, "html_url"),
        branch: readString(pull.head, "ref"),
        sha: readString(pull.head, "sha"),
      },
    };
  }

  const issue = payload.issue;
  const comment = payload.comment;
  if (isRecord(issue) && isRecord(comment)) {
    return {
      kind: "message",
      refs: {
        repo,
        action,
        number: readNumber(issue, "number"),
        url: readString(comment, "html_url"),
        user: readString(comment.user, "login") ?? sender,
        id: readId(comment, "id"),
      },
    };
  }

  if (isRecord(issue)) {
    return {
      kind: "issue",
      refs: {
        repo,
        action,
        number: readNumber(issue, "number"),
        url: readString(issue, "html_url"),
        user: readString(issue.user, "login") ?? sender,
      },
    };
  }

  const ref = readString(payload, "ref");
  if (ref !== undefined && Array.isArray(payload.commits)) {
    return {
      kind: "push",
      refs: {
        repo,
        branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref,
        sha: readId(payload, "after") ?? readString(payload.head_commit, "id"),
        user: readString(payload.pusher, "name") ?? sender,
      },
    };
  }

  if (isRecord(comment)) {
    return {
      kind: "message",
      refs: { repo, action, url: readString(comment, "html_url"), user: readString(comment.user, "login") ?? sender, id: readId(comment, "id") },
    };
  }

  return { kind: "custom", refs: { repo } };
}

function parseSlack(payload: unknown): { kind: EventKind; refs: EventRefs } {
  if (!isRecord(payload)) return { kind: "custom", refs: {} };
  const event = payload.event;
  if (isRecord(event) && event.type === "message") {
    return {
      kind: "message",
      refs: {
        channel: readString(event, "channel") ?? readString(payload, "channel"),
        user: readString(event, "user"),
        id: readId(event, "ts"),
      },
    };
  }
  return { kind: "custom", refs: {} };
}

function parseGeneric(payload: unknown): { kind: EventKind; refs: EventRefs } {
  if (!isRecord(payload)) return { kind: "custom", refs: {} };
  const refs = pickRefs(payload.refs);
  const declared = asEventKind(payload.kind);
  if (declared !== null) return { kind: declared, refs };
  if (typeof payload.message === "string") return { kind: "message", refs };
  return { kind: "custom", refs };
}

/**
 * Normalise a provider payload into one `ParsedEvent`. The raw `body` may be a
 * string (JSON is parsed, invalid JSON is preserved verbatim) or an already
 * parsed value. Never throws: anything unrecognised collapses to `custom`.
 */
export function parseEvent(provider: WebhookProvider, body: unknown): ParsedEvent {
  const payload = coercePayload(body);
  switch (provider) {
    case "github": {
      const { kind, refs } = parseGithub(payload);
      return { provider, kind, refs, payload };
    }
    case "slack": {
      const { kind, refs } = parseSlack(payload);
      return { provider, kind, refs, payload };
    }
    case "generic":
    case "zapier": {
      const { kind, refs } = parseGeneric(payload);
      return { provider, kind, refs, payload };
    }
    default: {
      const { kind, refs } = parseGeneric(payload);
      return { provider, kind, refs, payload };
    }
  }
}

// ---------------------------------------------------------------------------
// Event → planned actions
// ---------------------------------------------------------------------------

export type CreateRowRuleAction = {
  type: "createRow";
  databaseId?: string;
  values?: Record<string, unknown>;
};
export type UpdatePropRuleAction = { type: "updateProp"; propertyId: string; value: unknown };
export type CommentRuleAction = { type: "comment"; body: string };

/** One action a webhook rule may declare. */
export type ActionRuleAction = CreateRowRuleAction | UpdatePropRuleAction | CommentRuleAction;

/**
 * A webhook rule: an optional event-kind allow-list and an optional automation
 * condition tree, plus the actions to plan when the event matches.
 */
export type ActionRule = {
  id: string;
  enabled?: boolean;
  /** Event kinds this rule fires for; omitted/empty means every kind. */
  kinds?: readonly EventKind[];
  /** The automation condition shape (imported read-only from the engine). */
  conditions?: Conditions;
  actions: readonly ActionRuleAction[];
};

/**
 * Validate a stored inbound-rule list.
 *
 * The list is data, not code: it is read from the endpoint's own row, and
 * every entry is shape-checked before it reaches the planner. A malformed list
 * degrades to `[]` (no actions) instead of throwing, and an entry that carries
 * no id or no action list is dropped.
 */
export function parseActionRules(value: unknown): ActionRule[] {
  if (!Array.isArray(value)) return [];

  const rules: ActionRule[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || entry.id.trim() === "") continue;
    if (!Array.isArray(entry.actions)) continue;
    const kinds = Array.isArray(entry.kinds)
      ? entry.kinds.filter((kind): kind is EventKind => asEventKind(kind) !== null)
      : undefined;
    rules.push({
      id: entry.id,
      enabled: entry.enabled !== false,
      kinds,
      conditions: entry.conditions as Conditions | undefined,
      actions: entry.actions as readonly ActionRuleAction[],
    });
  }
  return rules;
}

export type PlannedCreateRow = {
  type: "createRow";
  ruleId: string;
  databaseId: string | null;
  values: Record<string, unknown>;
};
export type PlannedUpdateProp = {
  type: "updateProp";
  ruleId: string;
  propertyId: string;
  value: unknown;
};
export type PlannedComment = { type: "comment"; ruleId: string; body: string };

/** A resolved, side-effect-free action a dispatcher may execute. */
export type PlannedAction = PlannedCreateRow | PlannedUpdateProp | PlannedComment;

export type MapEventOptions = { rules: readonly ActionRule[] };

/** The condition scope: cross-references plus the kind/provider, as one row. */
function eventRow(event: ParsedEvent): AutomationRow {
  const scope: Record<string, unknown> = {
    ...event.refs,
    kind: event.kind,
    provider: event.provider,
  };
  return { values: scope };
}

const kindsMatch = (kinds: readonly EventKind[] | undefined, kind: EventKind): boolean =>
  !Array.isArray(kinds) || kinds.length === 0 || kinds.includes(kind);

function planAction(ruleId: string, action: unknown): PlannedAction | null {
  if (!isRecord(action)) return null;
  switch (action.type) {
    case "createRow": {
      const databaseId =
        typeof action.databaseId === "string" && action.databaseId.trim() !== ""
          ? action.databaseId
          : null;
      return {
        type: "createRow",
        ruleId,
        databaseId,
        values: isRecord(action.values) ? { ...action.values } : {},
      };
    }
    case "updateProp": {
      if (typeof action.propertyId !== "string" || action.propertyId.trim() === "") return null;
      return { type: "updateProp", ruleId, propertyId: action.propertyId, value: action.value };
    }
    case "comment": {
      if (typeof action.body !== "string" || action.body === "") return null;
      return { type: "comment", ruleId, body: action.body };
    }
    default:
      return null;
  }
}

/**
 * Turn a parsed event into the ordered list of planned actions contributed by
 * every matching rule. A rule matches when it is enabled, its kind allow-list
 * covers the event (or is empty), and its automation conditions pass against
 * the event scope. Never throws and never plans a side effect.
 */
export function mapEventToActions(event: ParsedEvent, options: MapEventOptions): PlannedAction[] {
  if (!isRecord(event)) return [];
  const rules = Array.isArray(options?.rules) ? options.rules : [];
  const row = eventRow(event);
  const planned: PlannedAction[] = [];

  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    if (rule.enabled === false) continue;
    const ruleId = typeof rule.id === "string" ? rule.id : "";
    if (ruleId === "") continue;
    if (!kindsMatch(rule.kinds as readonly EventKind[] | undefined, event.kind)) continue;
    if (!evaluateConditions(rule.conditions as Conditions, row)) continue;

    const actions = rule.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const plannedAction = planAction(ruleId, action);
      if (plannedAction) planned.push(plannedAction);
    }
  }

  return planned;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** One delivery already handled, as threaded by the caller. */
export type SeenDelivery = { key: string; at: number };

export type DuplicateWindow = {
  /** Length of the dedupe window in milliseconds. */
  windowMs: number;
  /** Unix milliseconds treated as "now". */
  now: number;
};

/**
 * A deterministic idempotency key for a parsed event, e.g.
 * `github:push:acme/rocket:main:deadbeef`. Two receipts of the same delivery
 * yield the same key; a different action on the same issue does not.
 */
export function dedupeKey(event: ParsedEvent): string {
  const refs = event.refs ?? {};
  const parts = [
    event.provider,
    event.kind,
    refs.repo,
    refs.number !== undefined ? String(refs.number) : undefined,
    refs.sha,
    refs.branch,
    refs.channel,
    refs.id,
    refs.action,
  ].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.join(":");
}

/**
 * Whether a delivery with `key` already appears in `seen` inside the window.
 * The boundary is inclusive (`age === windowMs` is still a duplicate) so a
 * zero-width window degenerates to "same instant". An unknown `now` or an empty
 * key is never a duplicate.
 */
export function isDuplicate(
  seen: readonly SeenDelivery[],
  key: string,
  window: DuplicateWindow,
): boolean {
  if (typeof key !== "string" || key === "") return false;
  if (!Array.isArray(seen) || seen.length === 0) return false;
  const now = window?.now;
  if (typeof now !== "number" || !Number.isFinite(now)) return false;
  const windowMs =
    typeof window.windowMs === "number" && Number.isFinite(window.windowMs) && window.windowMs >= 0
      ? window.windowMs
      : 0;
  return seen.some(
    (entry) =>
      isRecord(entry) &&
      entry.key === key &&
      typeof entry.at === "number" &&
      Math.abs(now - entry.at) <= windowMs,
  );
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<WebhookProvider, string> = {
  github: "GitHub",
  slack: "Slack",
  generic: "Generic",
  zapier: "Zapier",
};

/**
 * A short human summary of an endpoint for a settings list, e.g.
 * `GitHub endpoint "wh_1" (enabled): issues, push`. The secret is never
 * included. Malformed input yields a stable "Invalid webhook endpoint." string.
 */
export function describeWebhookEndpoint(endpoint: unknown): string {
  if (!isRecord(endpoint)) return "Invalid webhook endpoint.";
  const id = endpoint.id;
  if (typeof id !== "string" || id.trim() === "") return "Invalid webhook endpoint.";
  if (!isProvider(endpoint.provider)) return "Invalid webhook endpoint.";

  const events = Array.isArray(endpoint.events)
    ? endpoint.events.filter((event): event is string => typeof event === "string")
    : [];
  const state = endpoint.enabled === false ? "disabled" : "enabled";
  const eventText = events.length === 0 ? "all events" : events.join(", ");
  return `${PROVIDER_LABELS[endpoint.provider]} endpoint "${id}" (${state}): ${eventText}`;
}
