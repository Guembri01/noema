import { NextResponse } from "next/server";

/**
 * Idempotency keys for retriable mutations (spec §20).
 *
 * A client that retries a `POST` — because a request timed out, a network hop
 * dropped, or a queue redelivered — must not create the same page twice. The
 * caller sends `Idempotency-Key: <opaque>`; the first request performs the
 * mutation and its outcome is remembered, and any repeat of the same
 * method + path + user + key + body replays that stored outcome instead of
 * running the handler again.
 *
 * Behaviour (modelled on the widely used Stripe/RFC-draft semantics):
 *
 * | situation                                   | result                                  |
 * |--------------------------------------------|-----------------------------------------|
 * | no `Idempotency-Key`, or a safe method      | handler runs, nothing stored            |
 * | first request                               | handler runs, outcome stored for 24 h   |
 * | repeat, identical request                   | stored status + body, `Idempotency-Replayed: true` |
 * | repeat while the first is still running     | `409 idempotency_in_progress` (retry)   |
 * | same key, different body/path               | `422 idempotency_key_reuse`             |
 * | the handler threw, or answered 5xx / 429    | nothing stored — the retry may run      |
 *
 * Storage is **process-local** (a bounded FIFO map with a 24 h TTL). That is the
 * right call for the standalone desktop build and the single-process server,
 * where one Node process owns the workspace, and it is deliberately honest about
 * the limitation: behind multiple instances you would need a shared store
 * (Postgres table or Redis) keyed the same way. Nothing else in the pipeline
 * depends on the location of that map, so moving it later is a one-file change.
 *
 * Bodies are remembered verbatim for fingerprint comparison (bounded to 4 KB).
 * No hashing: the fingerprint is only ever compared for equality against our own
 * stored copy, so a collision-free digest would buy nothing.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";

/** How long a stored outcome stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Bound on memory: the oldest entry is dropped past this many. */
export const IDEMPOTENCY_MAX_ENTRIES = 500;

/** A hostile client cannot exhaust memory by sending a gigantic key. */
export const IDEMPOTENCY_MAX_KEY_LENGTH = 200;

/** Bodies longer than this are fingerprinted by prefix + length. */
const MAX_FINGERPRINT_BODY = 4096;

/** Only methods whose repetition could duplicate work are scoped. */
const RETRIABLE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

type Entry = {
  /** Method + path + query + user + body. A different fingerprint means a different request. */
  fingerprint: string;
  /** False while the handler is still running, so a concurrent retry can be told to wait. */
  settled: boolean;
  status: number;
  body: string;
  contentType: string | null;
  expiresAt: number;
};

const store = new Map<string, Entry>();

/** Test seam: the store is process-wide, so tests need a way to start clean. */
export function resetIdempotencyStore(): void {
  store.clear();
}

/** Only for diagnostics and tests — never used to decide anything. */
export function idempotencyStoreSize(): number {
  return store.size;
}

function sweep(now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

/** FIFO eviction: `Map` iterates in insertion order, so the first key is the oldest. */
function trim(): void {
  while (store.size > IDEMPOTENCY_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) return;
    store.delete(oldest);
  }
}

/** The client's key, trimmed and bounded, or `null` when the caller sent none. */
export function idempotencyKey(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_HEADER)?.trim() ?? "";
  if (!raw) return null;
  return raw.slice(0, IDEMPOTENCY_MAX_KEY_LENGTH);
}

/**
 * Read the body for fingerprinting **without consuming it**: the handler still
 * gets to call `request.json()` afterwards.
 */
async function readFingerprintBody(request: Request): Promise<string> {
  try {
    const text = await request.clone().text();
    return text.length > MAX_FINGERPRINT_BODY
      ? `${text.slice(0, MAX_FINGERPRINT_BODY)}#truncated:${text.length}`
      : text;
  } catch {
    return "";
  }
}

/**
 * Run `handler` under idempotency protection. When the caller sends no key (or
 * uses a naturally safe method) the handler is simply invoked, so this is
 * additive: existing clients see no behaviour change.
 */
export async function withIdempotency(
  request: Request,
  scope: { userId: string },
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const key = idempotencyKey(request);
  if (!key || !RETRIABLE_METHODS.has(request.method)) return handler();

  const url = new URL(request.url);
  const fingerprint = [request.method, url.pathname, url.search, scope.userId, await readFingerprintBody(request)].join(
    "\n",
  );
  // The key is scoped to the principal and the endpoint, so two users may pick
  // the same key without colliding, and a key cannot be replayed across routes.
  const storageKey = `${scope.userId}\u0000${request.method}\u0000${url.pathname}\u0000${key}`;

  const now = Date.now();
  sweep(now);

  const existing = store.get(storageKey);
  if (existing && existing.expiresAt > now) {
    if (existing.fingerprint !== fingerprint) {
      return NextResponse.json(
        {
          error: "idempotency_key_reuse",
          detail: "This Idempotency-Key was already used for a different request.",
        },
        { status: 422 },
      );
    }
    if (!existing.settled) {
      return NextResponse.json(
        { error: "idempotency_in_progress", detail: "A request with this key is still running." },
        { status: 409, headers: { "Retry-After": "1" } },
      );
    }
    const headers = new Headers();
    if (existing.contentType) headers.set("Content-Type", existing.contentType);
    headers.set(IDEMPOTENCY_REPLAYED_HEADER, "true");
    return new NextResponse(existing.body, { status: existing.status, headers });
  }

  store.set(storageKey, {
    fingerprint,
    settled: false,
    status: 0,
    body: "",
    contentType: null,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  });
  trim();

  let response: NextResponse;
  try {
    response = await handler();
  } catch (error) {
    // A crash is not an outcome: drop the claim so the retry can genuinely run.
    store.delete(storageKey);
    throw error;
  }

  // Cache the outcome — except 5xx (the mutation may not have happened, so a
  // retry must be allowed to try again) and 429 (rate limiting belongs to the
  // attempt, not to the mutation).
  if (response.status < 500 && response.status !== 429) {
    const cloned = response.clone();
    const body = await cloned.text();
    store.set(storageKey, {
      fingerprint,
      settled: true,
      status: response.status,
      body,
      contentType: response.headers.get("content-type"),
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
  } else {
    store.delete(storageKey);
  }
  return response;
}
