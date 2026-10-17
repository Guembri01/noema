import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CATALOG,
  type WebhookEvent,
} from "@/lib/webhook-events";
import { filterSubscribed } from "@/lib/webhook-event-catalog";
import {
  constantTimeEqualHex,
  parseSignatureHeader,
  signPayload,
  verifySignature,
} from "@/lib/webhook-signature";
// B11 — SSRF guard: a hook may not point at an internal service. The same
// gate the calendar feed path uses (`src/lib/feed-guard.ts`), re-run before
// every delivery attempt.
import {
  fetchPinnedTarget,
  resolveOutboundTarget,
} from "@/lib/feed-guard";
import {
  LEGACY_KEY_VERSION,
  createKeyring,
  decrypt,
  deriveLegacyKey,
  encrypt,
  type Keyring,
} from "@/lib/secrets";

// R24.18 — the catalog lives in the PURE module `./webhook-events` (no
// node:crypto, no prisma) so the client picker imports the same single source
// of truth. Re-exported here so every server-side import path
// (`src/server/actions/webhooks.ts`, tests, …) stays byte-stable.
export { WEBHOOK_EVENTS, WEBHOOK_EVENT_CATALOG };
export type { WebhookEvent };

/** R24.11 — delay before each delivery attempt: 0 s, 2 s, 8 s, 30 s, 2 min. */
export const WEBHOOK_BACKOFF_MS = [0, 2_000, 8_000, 30_000, 120_000] as const;

/** R24.11 — 5 attempts replaces the old `MAX_ATTEMPTS = 3`. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length;

/** Per-attempt timeout stays at 5 s (R24.11). */
const ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * B11 — one uniform error for a refused target. The delivery log must not
 * become a status oracle for internal services, so a blocked target records
 * no status code, no latency and nothing that distinguishes it from any
 * other refusal.
 */
const BLOCKED_TARGET_ERROR = "Blocked target.";

/**
 * B21 — the reason a delivery was refused because its signing secret could
 * not be opened. It names the cause and the remedy, never the secret.
 */
const UNREADABLE_SECRET_ERROR =
  "The signing secret could not be read; re-create the webhook.";

/** R24.13 — verifiers reject `|now − t|` beyond this window (300 s). */
export const SIGNATURE_TOLERANCE_MS = 300_000;

export type WebhookSleep = (ms: number) => Promise<void>;

const defaultSleep: WebhookSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cumulative due time (unix ms) of each attempt for a delivery whose dispatch
 * started at `startedAtMs`: `[start, +2 s, +10 s, +40 s, +160 s]`.
 * Pure so the schedule can be unit-tested against a fake clock (R24.11).
 */
export function deliveryDueTimes(startedAtMs: number): number[] {
  let elapsed = 0;
  return WEBHOOK_BACKOFF_MS.map((delay) => {
    elapsed += delay;
    return startedAtMs + elapsed;
  });
}

/**
 * Legacy v1 MAC: `HMAC-SHA256(secret, rawBody)`, with no timestamp bound in.
 * Retained only so already-deployed receivers keep verifying during the rollout.
 */
function legacyHmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * R24.13 — canonical form `x-noema-signature: t=<unixMs>,v1=<hex>` where
 * `v1 = HMAC-SHA256(secret, "<t>.<rawBody>")`. Delegates to the shared
 * `signPayload` (D24) so the dispatcher and `verifySignature` share ONE signing
 * implementation. The wire format is byte-for-byte unchanged, so the single
 * `x-noema-signature` header is kept — receivers need no transition.
 */
export function signWebhookV2(secret: string, body: string, timestampMs: number): string {
  return signPayload(body, secret, { timestamp: timestampMs });
}

/**
 * Verify an incoming `x-noema-signature`.
 *
 * - v2 (`t=…,v1=…`): delegated to the shared {@link verifySignature} — freshness
 *   is enforced (`|now − t| > 300 s` fails, inclusive boundary), and so does any
 *   tampering of the timestamp or the body.
 * - legacy v1 (bare hex = `HMAC-SHA256(secret, rawBody)`): still accepted so
 *   already-deployed receivers keep verifying during the rollout; it carries no
 *   timestamp, hence no freshness window.
 *
 * `timestamp` is the companion `x-noema-timestamp` header; when present it must
 * agree with the `t` inside the signature.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  body: string;
  signature: string;
  timestamp?: number | string | null;
  now?: number;
}): boolean {
  const signature = input.signature.trim();
  if (!signature) return false;

  // Legacy v1 (bare 64-hex, no `t=`): MAC over the raw body only.
  if (/^[0-9a-f]{64}$/i.test(signature)) {
    return constantTimeEqualHex(legacyHmacHex(input.secret, input.body), signature);
  }

  // The shared verifier reads `t` from the header; enforce the companion
  // `x-noema-timestamp` agrees with it when that header is present.
  const parsed = parseSignatureHeader(signature);
  if (!parsed.ok) return false;
  if (input.timestamp != null && Number(input.timestamp) !== parsed.timestamp) {
    return false;
  }

  return verifySignature(input.body, signature, input.secret, {
    now: input.now,
    toleranceSeconds: SIGNATURE_TOLERANCE_MS / 1000,
  }).ok;
}

/**
 * R28.17 / M28.3 — webhook signing secrets are sealed at rest with the versioned
 * keyring in `@/lib/secrets` (AES-256-GCM). One key is registered — the
 * env-derived key (`AUTH_SECRET`) under `LEGACY_KEY_VERSION` — so newly written
 * secrets are `v2:1:<iv>:<tag>:<payload>` envelopes and any legacy `v1:` envelope
 * (e.g. one written by `encryptSecret`) still opens under the same key. No second
 * copy of the key material is introduced.
 */
function webhookKeyring(): Keyring {
  return createKeyring(
    { [LEGACY_KEY_VERSION]: deriveLegacyKey() },
    LEGACY_KEY_VERSION,
  );
}

/** True for a `v1:`/`v2:` envelope from `@/lib/secrets`; a plaintext secret never matches. */
function isSecretEnvelope(value: string): boolean {
  return value.startsWith("v1:") || value.startsWith("v2:");
}

/** Seal a webhook signing secret for storage. */
export function encryptWebhookSecret(secret: string): string {
  return encrypt(secret, webhookKeyring());
}

/**
<<<<<<< HEAD
 * B63 — seal the secret of a hook that was created before the sealing (R28.17).
 *
 * Such a row still holds its secret in cleartext, and the secret is the shared
 * key of the webhook: a database dump of that row yields it, and with it the
 * power to sign a delivery (or to forge an inbound request). The app therefore
 * seals such a row the moment it reads it, so the cleartext leaves the database
 * without an operator step.
 *
 * The write is best-effort: a row that cannot be sealed keeps working (the
 * plaintext is still the secret it always was) — only its at-rest state stays
 * open until the next attempt. A row that already holds an envelope is never
 * touched.
 */
export async function sealLegacyWebhookSecret(hook: {
  id: string;
  secret: string | null | undefined;
}): Promise<void> {
  const stored = hook.secret;
  if (!stored || isSecretEnvelope(stored)) return;
  try {
    await prisma.webhook.update({
      where: { id: hook.id },
      data: { secret: encryptWebhookSecret(stored) },
    });
  } catch {
    /* sealing is a hardening step — it must never break the delivery */
  }
}

/**
 * Resolve a stored webhook secret to the plaintext used for signing.
=======
 * B21 — the state of a stored webhook signing secret.
 *
 * - `sealed` — an envelope that opened: `secret` is the plaintext to sign with.
 * - `legacy` — a pre-migration PLAINTEXT secret (the M28.3 transition window):
 *   it is used as-is, so already-configured hooks keep delivering signed
 *   requests, but the secret sits in the clear in the database.
 * - `unreadable` — an envelope that did NOT open: the key that opens it is
 *   gone (a rotated `AUTH_SECRET`) or the ciphertext is corrupt. There is no
 *   signing key at all, so there is nothing to sign with.
 * - `missing` — no secret is stored. The hook predates the mandatory secret
 *   (R28.17); the receiver holds no shared key either, so its delivery is
 *   unsigned by the documented wire format.
 */
type WebhookSecretState =
  | { readonly kind: "sealed"; readonly secret: string }
  | { readonly kind: "legacy"; readonly secret: string }
  | { readonly kind: "unreadable"; readonly secret: null }
  | { readonly kind: "missing"; readonly secret: null };

/**
 * Resolve a stored webhook secret to the plaintext used for signing, and say
 * WHICH state it is in.
>>>>>>> 70562cb (fix(webhooks): a delivery that cannot be signed is never sent)
 *
 * - Envelopes (`v1:` legacy or `v2:` keyring) are opened with the keyring.
 * - A pre-migration PLAINTEXT secret (M28.3 transition window) is returned
 *   as-is, with a warning, so already-configured hooks keep delivering signed
<<<<<<< HEAD
 *   requests; {@link sealLegacyWebhookSecret} seals the row at rest when the
 *   app reads it. (Follow-up: hard-fail once the migration window closes,
 *   per R28.17.)
 * - A corrupt/unreadable envelope resolves to `null` — the delivery is sent
 *   unsigned rather than signed with ciphertext — and is logged. New hooks are
 *   always sealed on write, so this cannot happen to a freshly created hook.
=======
 *   requests; re-creating the hook seals it. (Follow-up: hard-fail once the
 *   migration window closes, per R28.17.)
 * - An envelope that does not open resolves to `unreadable` and is logged.
 *   New hooks are always sealed on write, so this cannot happen to a freshly
 *   created hook — only after the key was rotated out from under the row.
 *
 * B21 — `unreadable` is kept apart from `missing` on purpose. A hook WITH a
 * secret has a receiver that verifies signatures, so a delivery that quietly
 * loses its signature is a downgrade of that channel. A hook without any
 * secret never had that guarantee, so it keeps the documented wire format.
>>>>>>> 70562cb (fix(webhooks): a delivery that cannot be signed is never sent)
 */
function resolveWebhookSecret(
  stored: string | null | undefined,
): WebhookSecretState {
  if (!stored) return { kind: "missing", secret: null };
  if (!isSecretEnvelope(stored)) {
    console.warn(
      "[webhooks] signing secret is stored in plaintext; it is sealed at rest when the app reads it.",
    );
    return { kind: "legacy", secret: stored };
  }
  try {
    return { kind: "sealed", secret: decrypt(stored, webhookKeyring()) };
  } catch {
    console.warn(
      "[webhooks] stored webhook secret could not be decrypted; the delivery is refused.",
    );
    return { kind: "unreadable", secret: null };
  }
}

/**
 * Resolve a stored webhook secret to the plaintext used for signing, or `null`
 * when there is none to sign with.
 */
export function decryptWebhookSecret(
  stored: string | null | undefined,
): string | null {
  return resolveWebhookSecret(stored).secret;
}

/**
 * Per-attempt headers; the timestamp/signature are computed at send time (R24.14 edge).
 *
 * The signature header is present whenever the hook HAS a shared secret. A
 * hook without any secret (`missing`) keeps the documented unsigned wire format;
 * a hook whose secret cannot be opened never reaches this point (B21).
 */
function signatureHeaders(
  secret: string | null,
  event: string,
  body: string,
  timestampMs: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-noema-event": event,
    "x-noema-timestamp": String(timestampMs),
  };
  if (secret) headers["x-noema-signature"] = signWebhookV2(secret, body, timestampMs);
  return headers;
}

type DeliveryRowRef = { id: string | null };

/** R24.10 — outbox write: one row persisted before any network I/O. */
async function createDeliveryRow(webhookId: string, event: string): Promise<string | null> {
  try {
    const row = await prisma.webhookDelivery.create({
      data: { webhookId, event, ok: false, attempts: 0 },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null; /* delivery logging must never throw */
  }
}

/**
 * R24.12 — one row per logical delivery: every attempt updates the SAME row's
 * `attempts` / `ok` / `responseStatus` / `error` instead of inserting a new one
 * (the old code logged up to 4 rows per failed delivery).
 */
async function recordAttempt(
  row: DeliveryRowRef,
  webhookId: string,
  event: string,
  attempt: number,
  ok: boolean,
  responseStatus: number | null,
  error: string | null,
): Promise<void> {
  try {
    if (row.id) {
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: { attempts: attempt, ok, responseStatus, error },
      });
      return;
    }
    // The outbox write failed up front — create the row here, once, and keep
    // updating that one row for the remaining attempts.
    const created = await prisma.webhookDelivery.create({
      data: { webhookId, event, attempts: attempt, ok, responseStatus, error },
      select: { id: true },
    });
    row.id = created.id;
  } catch {
    /* delivery logging must never throw */
  }
}

/**
 * Attempt delivery with the R24.11 backoff schedule (0/2/8/30/120 s), writing
 * every attempt to a single `WebhookDelivery` row. Exported for the unit tests
 * and so the durable retry sweep (T24.3) can claim-and-send through the same
 * path.
 */
export async function deliverWithRetry(
  hook: { id: string; url: string; secret: string | null },
  event: WebhookEvent,
  body: string,
  options: { deliveryId?: string | null; sleep?: WebhookSleep } = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const row: DeliveryRowRef = { id: options.deliveryId ?? null };
  // R28.17 — the secret is sealed at rest; open it once per logical delivery.
<<<<<<< HEAD
  const secret = decryptWebhookSecret(hook.secret);
  // B63 — a hook that predates the sealing still holds its secret in
  // cleartext: seal it now, so the plaintext leaves the database.
  await sealLegacyWebhookSecret(hook);
=======
  const resolved = resolveWebhookSecret(hook.secret);
  // B21 — a secret that does not OPEN leaves nothing to sign with: the row
  // holds an envelope, but the key that opens it is gone (a rotated
  // `AUTH_SECRET`) or the ciphertext is corrupt. The delivery used to go out
  // UNSIGNED and was booked as a success, so a receiver that only asks
  // whether the header is present accepted a manipulated payload. Refuse it
  // instead: no request leaves the server, and the row records the failure.
  // The condition does not change while the process runs, so the retry loop
  // is not entered — this is a policy decision, like a blocked target.
  if (resolved.kind === "unreadable") {
    await recordAttempt(
      row,
      hook.id,
      event,
      1,
      false,
      null,
      UNREADABLE_SECRET_ERROR,
    );
    return;
  }
  const secret = resolved.secret;
>>>>>>> 70562cb (fix(webhooks): a delivery that cannot be signed is never sent)

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    const delay = WEBHOOK_BACKOFF_MS[attempt - 1] ?? 0;
    if (delay > 0) await sleep(delay);

    // B11 — re-validate the target before EVERY attempt. The creation-time
    // check (`src/server/actions/webhooks.ts`) does not cover DNS rebinding
    // nor a target that changed after the hook was stored, so the guard runs
    // again here: a blocked target is never contacted at all. A refusal is a
    // policy decision, not a transient fault, so the retry loop stops instead
    // of resolving the same host five times. A resolver failure is different:
    // it is retried, because the host may become resolvable again.
    // `allowLoopbackWithOptIn` asks for the operator opt-in
    // (`NOEMA_ALLOW_LOOPBACK_TARGETS=1`): only the loopback range can be
    // opened that way, and only when the operator set the variable.
    const target = await resolveOutboundTarget(hook.url, {
      allowLoopbackInDevelopment: true,
      allowLoopbackWithOptIn: true,
    });
    if (target.blocked) {
      const transient = target.transient;
      await recordAttempt(
        row,
        hook.id,
        event,
        attempt,
        false,
        null,
        transient ? "Delivery failed." : BLOCKED_TARGET_ERROR,
      );
      if (transient) continue;
      return;
    }

    let ok = false;
    let responseStatus: number | null = null;
    let error: string | null = null;
    try {
      // Connect to the address that passed the check above, not to a fresh
      // DNS answer the hostname could have changed since.
      const response = await fetchPinnedTarget(
        hook.url,
        {
          method: "POST",
          headers: signatureHeaders(secret, event, body, Date.now()),
          body,
          // R24.11 — never follow redirects: a 3xx counts as a failed attempt.
          redirect: "manual",
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        },
        target.address,
      );
      responseStatus = response.status;
      ok = response.ok;
      if (!ok) error = `HTTP ${response.status}`;
      // The delivery log only needs the status; release the socket.
      await response.body?.cancel();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    await recordAttempt(row, hook.id, event, attempt, ok, responseStatus, error);
    if (ok) return;
  }
}

/**
 * Deliver an event to every active matching webhook for a workspace.
 * Network delivery runs in the background (with retries); this resolves once
 * the outbox rows are persisted and the deliveries scheduled, so callers never
 * block on a webhook endpoint.
 */
export async function dispatchWebhooks(
  workspaceId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  options: { sleep?: WebhookSleep } = {},
): Promise<void> {
  try {
    const hooks = await prisma.webhook.findMany({
      where: { workspaceId, active: true },
      select: { id: true, url: true, secret: true, events: true },
    });
    // B91 — subscription matching lives in the pure catalog module, so a hook's
    // filter supports the `*` wildcard and `page.*` prefixes; an empty filter
    // still means "all events" (both handled by `filterSubscribed`).
    const matching = hooks.filter(
      (hook) => filterSubscribed([event], hook.events).length > 0,
    );
    if (matching.length === 0) return;

    const sentAt = new Date().toISOString();

    // R24.10 — persist the outbox row (and its deliveryId) for EVERY receiver
    // before any network I/O starts; the payload carries `deliveryId` so
    // receivers can deduplicate.
    const scheduled: Promise<void>[] = [];
    for (const hook of matching) {
      const deliveryId = await createDeliveryRow(hook.id, event);
      const body = JSON.stringify({
        deliveryId: deliveryId ?? undefined, // omitted only when logging is down
        event,
        workspaceId,
        data,
        sentAt,
      });
      scheduled.push(
        deliverWithRetry(hook, event, body, { deliveryId, sleep: options.sleep }),
      );
    }
    for (const pending of scheduled) void pending.catch(() => {});
  } catch {
    /* never break the caller */
  }
}
