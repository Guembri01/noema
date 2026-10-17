import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { declaredBodyLength } from "@/lib/body-limit";

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
 * Bodies are fingerprinted by a digest over the bytes that actually arrived
 * plus the number of bytes that arrived — never over a number the client
 * declared. The fingerprint therefore does not depend on how the request was
 * framed (chunked, or with a `Content-Length` header) and not on what the
 * client claims about the size of its body: only the bytes themselves decide
 * whether two requests are the same one.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";

/**
 * The fingerprint of a body that is over the route's budget.
 *
 * The route refuses such a body, so nothing about its content can matter — and
 * the value must not depend on how the request was framed. A request that
 * declares more than the budget is refused before a byte is read; a request
 * that lies about its length is only discovered while it is read. Both are the
 * same request, so both carry this one value: the retry then replays the
 * stored `413` instead of answering `422`.
 */
const OVER_BUDGET_FINGERPRINT = "over-budget";

/** How long a stored outcome stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Bound on memory: the oldest entry is dropped past this many. */
export const IDEMPOTENCY_MAX_ENTRIES = 500;

/** A hostile client cannot exhaust memory by sending a gigantic key. */
export const IDEMPOTENCY_MAX_KEY_LENGTH = 200;

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
 * How much of the body is *hashed* for the fingerprint (64 KiB).
 *
 * The fingerprint has two components: a digest over this many bytes and the
 * **measured** length of the body. Together they tell two requests apart at
 * least as well as the old "first 4 KB + the length" did — 64 KB of content
 * say more than 4 KB of it — while neither of them can be chosen by the
 * client.
 */
const MAX_FINGERPRINT_CONTENT_BYTES = 64 * 1024;

/**
 * Fingerprint the body **without consuming it**: the handler still gets to
 * call `request.json()` afterwards.
 *
 * B22: the body is *streamed* and only a digest of the bytes that arrived is
 * kept, so the fingerprint never depends on a number the client chose. The
 * digest covers exactly the first {@link MAX_FINGERPRINT_CONTENT_BYTES}
 * bytes, no matter how the body was chunked — a chunk that does not fit is
 * cut at the window's edge — and the length is the number of bytes that
 * actually arrived, never the `Content-Length` the client declared.
 *
 * The scan is bounded by the route's own body budget (`budget`, the limit the
 * caller reads its body under): the body is measured up to that limit and no
 * further. A body within the budget is therefore measured *exactly*, which is
 * what makes the length a reliable fingerprint component; a body beyond it is
 * refused by the route anyway, so its exact length does not matter (it is
 * marked `over-budget`).
 *
 * What this buys:
 *
 * - A **legitimate retry** is recognised: the same bytes produce the same
 *   fingerprint, whether the first attempt arrived chunked and the second one
 *   with a `Content-Length` header (or with a different chunking). A client
 *   that retries is replayed instead of being refused with `422`.
 * - A **different body** under the same key is refused with `422`. Two bodies
 *   are only indistinguishable when they share their first 64 KiB *and* their
 *   length — a strictly smaller set of collisions than the old fingerprint
 *   (which compared 4 KB of content), and one the client cannot influence.
 *
 * The cost of the clone: `request.clone()` *tees* the body. The branch read
 * here is abandoned after the scan, and everything the route reads afterwards
 * accumulates in that branch's queue — so the request is held in memory about
 * twice, once by the route and once by the queue. The amount is bounded by
 * the route's own body budget and the peak memory stays flat: the scan keeps
 * a 32-byte digest, not the body.
 *
 * The price of measuring the length: the scan reads the body up to the
 * budget, so an over-sized body is read twice — once by the scan and once by
 * the route, which refuses it. The amount is still bounded by the budget
 * (twice the budget, not the body), and the request that the route refuses
 * with `413` is one the client had to send anyway.
 *
 * The peak is a little above that: the reader holds the chunks *and* the
 * merged buffer, and the tee holds a copy for the branch the route reads
 * from — about three times the budget, never the body. Measured: a 200 MiB
 * upload against a 4 MiB budget left the resident set between ~6 and ~12 MiB.
 * That peak is transient and differs from run to run (the same upload and the
 * same code measured both); what holds is the boundary — at most three times
 * the budget, and never a share of the upload's size.
 */
async function readFingerprintBody(request: Request, budget: number): Promise<string> {
  try {
    const hash = createHash("sha256");
    const body = request.clone().body;
    if (!body) return `sha256:${hash.digest("hex")}#len:0`;

    // A body that declares more than the budget is refused by the route on the
    // declared length alone — so there is nothing to fingerprint and nothing
    // to read.
    const declared = declaredBodyLength(request);
    if (declared !== null && declared > budget) {
      // The route refuses the request on the declared length alone, so there
      // is nothing to fingerprint.
      return OVER_BUDGET_FINGERPRINT;
    }

    const reader = body.getReader();
    let content = 0;
    let length = 0;
    let overBudget = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      length += value.byteLength;
      if (content < MAX_FINGERPRINT_CONTENT_BYTES) {
        const room = MAX_FINGERPRINT_CONTENT_BYTES - content;
        hash.update(value.subarray(0, room));
        content += Math.min(room, value.byteLength);
      }
      if (length > budget) {
        // The body is larger than the route's budget: the route refuses it,
        // so the exact length cannot matter any more.
        overBudget = true;
        break;
      }
    }
    if (overBudget) return OVER_BUDGET_FINGERPRINT;
    return `sha256:${hash.digest("hex")}#len:${length}`;
  } catch {
    return "sha256:unreadable";
  }
}

/**
 * Run `handler` under idempotency protection. When the caller sends no key (or
 * uses a naturally safe method) the handler is simply invoked, so this is
 * additive: existing clients see no behaviour change.
 *
 * `scope.bodyBudget` is the byte budget the caller reads the request body
 * under — the same limit its route enforces. The fingerprint is measured over
 * exactly that budget, so it covers every body the caller is willing to
 * process (and the caller must refuse anything larger itself).
 */
export async function withIdempotency(
  request: Request,
  scope: { userId: string; bodyBudget: number },
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const key = idempotencyKey(request);
  if (!key || !RETRIABLE_METHODS.has(request.method)) return handler();

  const url = new URL(request.url);
  const fingerprint = [
    request.method,
    url.pathname,
    url.search,
    scope.userId,
    await readFingerprintBody(request, scope.bodyBudget),
  ].join("\n");
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
