import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/api-guard";
import { bodyReadError, readTextBody } from "@/lib/body-limit";
import { prisma } from "@/lib/db";
// B63 — the column `Webhook.secret` holds the SEALED secret (an AES-256-GCM
// envelope), not the shared secret itself.
import { decryptWebhookSecret, sealLegacyWebhookSecret } from "@/lib/webhooks";
import {
  DEFAULT_TOLERANCE_SECONDS,
  EVENT_KINDS,
  SUPPORTED_PROVIDERS,
  dedupeKey,
  isDuplicate,
  mapEventToActions,
  parseActionRules,
  parseEvent,
  verifySignature,
  type EventKind,
  type SeenDelivery,
  type WebhookProvider,
} from "@/lib/inbound-webhooks";

export const runtime = "nodejs";

/** How long a redelivery of the same event is suppressed (in ms). */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * B22 — the budget for one inbound event.
 *
 * The body is read as text because the signature is verified over the exact
 * bytes the provider sent, so it has to be buffered — but it must not be
 * unbounded. 1 MB is far above any provider event.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Request header that may carry the provider when the query string omits it. */
const PROVIDER_HEADER = "x-webhook-provider";

const isKind = (value: unknown): value is EventKind =>
  typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);

const isProvider = (value: unknown): value is WebhookProvider =>
  typeof value === "string" && (SUPPORTED_PROVIDERS as readonly string[]).includes(value);

/**
 * The provider a delivery claims to be, from `?provider=` first and the
 * `x-webhook-provider` header second. Unknown/absent values fall back to
 * `"generic"`; `verifySignature` then fails closed for any signal mismatch.
 */
function readProvider(request: Request): WebhookProvider {
  const fromQuery = new URL(request.url).searchParams.get("provider");
  const fromHeader = request.headers.get(PROVIDER_HEADER);
  const candidate = (fromQuery ?? fromHeader ?? "").trim().toLowerCase();
  return isProvider(candidate) ? candidate : "generic";
}

/** Headers as a plain, case-preserving record for `verifySignature`. */
function headerRecord(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

/**
 * POST /api/webhooks/inbound?endpoint=<id>&provider=<github|slack|generic|zapier>
 *
 * The receive side of an inbound integration. The route resolves the bound
 * `Webhook` row, verifies the provider signature against its secret over the
 * raw body, normalises the payload, plans the matching rules' actions and
 * suppresses a redelivery through a durable idempotency key stored on the
 * `WebhookDelivery` log. Fail-closed: an unknown endpoint, a disabled endpoint,
 * a missing secret or a bad signature never dispatches actions.
 *
 * `?provider=` (or `x-webhook-provider`) selects the provider. The rule list
 * `mapEventToActions` gates on belongs to the endpoint: it is read from the
 * `Webhook` row, never from the request, so a caller cannot choose which
 * actions the endpoint plans. The route is side-effect free apart from the
 * delivery row: it returns the planned actions for a worker to execute.
 *
 * B63 — the secret of the row is SEALED at rest, so the route opens the
 * envelope before it verifies anything. The value the database holds is never
 * used as the shared key: a dump of the row would then be a working credential
 * for this endpoint.
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "inbound-webhook", 60, 60_000);
  if (limited) return limited;

  const endpointId = new URL(request.url).searchParams.get("endpoint") ?? "";
  if (endpointId.trim() === "") {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  const endpoint = await prisma.webhook.findUnique({
    where: { id: endpointId },
    select: {
      id: true,
      workspaceId: true,
      secret: true,
      events: true,
      rules: true,
      active: true,
    },
  });
  if (!endpoint) return NextResponse.json({ error: "Unknown endpoint" }, { status: 404 });
  if (!endpoint.active) {
    return NextResponse.json({ error: "Endpoint disabled" }, { status: 409 });
  }
  if (typeof endpoint.secret !== "string" || endpoint.secret === "") {
    return NextResponse.json({ error: "Endpoint has no signing secret" }, { status: 401 });
  }
  // B63 — the column holds the SEALED secret, so the signature is verified
  // against the ciphertext unless the envelope is opened first. Two things
  // follow from that, and the second one is the security property:
  //
  //   1. a request the provider signed with the real secret was refused,
  //      because the MAC was compared with a MAC over the ciphertext;
  //   2. a request signed with the value a database dump yields was ACCEPTED,
  //      so the dump was a working credential for this endpoint.
  //
  // The envelope is opened here, and a secret that cannot be opened is no
  // secret at all: the route refuses it with the same message as a missing
  // one, so the answer does not tell an outsider which endpoints are broken.
  const secret = decryptWebhookSecret(endpoint.secret);
  if (!secret) {
    return NextResponse.json({ error: "Endpoint has no signing secret" }, { status: 401 });
  }

  const provider = readProvider(request);
  let body: string;
  try {
    body = await readTextBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Expected a request body.");
  }
  const now = Date.now();

  const verification = verifySignature({
    provider,
    secret,
    body,
    headers: headerRecord(request),
    now,
    toleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
  });
  if (!verification.ok) {
    return NextResponse.json(
      { error: "Invalid signature", reason: verification.reason },
      { status: 401 },
    );
  }

  // B63 — the request proved that this endpoint works, so a row that still
  // holds its secret in cleartext is sealed now: the plaintext leaves the
  // database. It happens after the verification on purpose — only the holder
  // of the secret may trigger the write.
  await sealLegacyWebhookSecret({ id: endpoint.id, secret: endpoint.secret });

  const event = parseEvent(provider, body);

  // An endpoint may narrow itself to a subset of the normalised kinds; an empty
  // or unrecognised allow-list means "every kind".
  const subscribed = endpoint.events.filter(isKind);
  if (subscribed.length > 0 && !subscribed.includes(event.kind)) {
    return NextResponse.json({ ok: true, ignored: true, kind: event.kind });
  }

  // Idempotency: the key is stored as the `event` of the delivery row, so a
  // redelivery inside the window is detected without a second Store.
  const key = dedupeKey(event);
  const since = new Date(now - DEDUPE_WINDOW_MS);
  const recent = await prisma.webhookDelivery.findMany({
    where: { webhookId: endpoint.id, event: key, createdAt: { gte: since } },
    select: { event: true, createdAt: true },
  });
  const seen: SeenDelivery[] = recent.map((row) => ({
    key: row.event,
    at: row.createdAt.getTime(),
  }));
  if (isDuplicate(seen, key, { windowMs: DEDUPE_WINDOW_MS, now })) {
    return NextResponse.json({ ok: true, duplicate: true, key });
  }

  // B18 — the rule list belongs to the endpoint, not to the caller: the
  // actions are planned from the row the request was authenticated against. A
  // rule list in the request (`?rules=` / `x-noema-rules`) is ignored.
  const actions = mapEventToActions(event, { rules: parseActionRules(endpoint.rules) });

  await prisma.webhookDelivery
    .create({
      data: {
        webhookId: endpoint.id,
        event: key,
        ok: true,
        responseStatus: 202,
        attempts: 1,
      },
    })
    .catch(() => undefined);

  return NextResponse.json({
    ok: true,
    endpoint: endpoint.id,
    workspaceId: endpoint.workspaceId,
    provider,
    kind: event.kind,
    key,
    actions,
  });
}
