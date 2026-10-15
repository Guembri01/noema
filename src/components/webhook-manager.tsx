"use client";

import { useState, useTransition } from "react";
import { guarded } from "@/lib/actions-client";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { toast } from "sonner";
import {
  createWebhookAction as createWebhookActionRaw,
  deleteWebhookAction as deleteWebhookActionRaw,
} from "@/server/actions/webhooks";
import { t } from "@/lib/i18n";
import { WEBHOOK_EVENT_CATALOG } from "@/lib/webhook-events";
import {
  WEBHOOK_EVENTS,
  isWebhookEventType,
  validateEventPayload,
} from "@/lib/webhook-event-catalog";
import {
  canAttempt,
  createBreaker,
  onFailure,
  onSuccess,
  stateName,
  type BreakerName,
} from "@/lib/circuit-breaker";

/** Transport-safe wrappers (F-09): a failed request now returns `{ error }`. */
const createWebhookAction = guarded(createWebhookActionRaw);
const deleteWebhookAction = guarded(deleteWebhookActionRaw);

export type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  hasSecret: boolean;
};

export type DeliveryRow = {
  id: string;
  event: string;
  ok: boolean;
  status: number | null;
  attempts: number;
  error: string | null;
  url: string;
  createdAt: string;
};

/** Stored subscriptions are raw wire ids; render them through the identity catalog. */
const EVENT_LABELS = new Map<string, string>(
  WEBHOOK_EVENT_CATALOG.map((event) => [event.id, event.label]),
);

/** Join stored event ids into picker labels, falling back to the raw id. */
function subscriptionLabels(ids: readonly string[]): string {
  return ids.map((id) => EVENT_LABELS.get(id) ?? id).join(", ");
}

/**
 * Validate a picked event set against the B91 catalog before creating the hook,
 * mirroring the server's `WEBHOOK_EVENTS` filter in `createWebhookAction`.
 * Returns the first problem message, or `null` when every id is a known event.
 */
function validateEventSelection(selected: readonly string[]): string | null {
  for (const type of selected) {
    if (isWebhookEventType(type)) continue;
    return validateEventPayload(type, {})[0].message;
  }
  return null;
}

/** Per-webhook delivery health folded from its recent `WebhookDelivery` rows. */
type DeliveryHealth = {
  /** Effective circuit at the newest delivery instant: `closed`, `open`, or `half-open`. */
  circuit: BreakerName;
  /** Whether the circuit would let another attempt through right now. */
  attemptable: boolean;
  /** Retry attempts recorded by the webhook's newest delivery. */
  attempts: number;
};

/**
 * Replay a webhook's deliveries (any order) through the shared breaker so the
 * manager can surface an open/closed delivery circuit per webhook alongside the
 * newest retry count. Older rows are applied first; `now` is pinned to the
 * newest row's timestamp instead of `Date.now()`, so the reading is
 * deterministic and server/client renders agree.
 */
function deliveryHealth(rows: readonly DeliveryRow[]): DeliveryHealth | null {
  if (rows.length === 0) return null;
  const chronological = [...rows].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  let state = createBreaker();
  for (const row of chronological) {
    const at = Date.parse(row.createdAt);
    state = row.ok ? onSuccess(state, at) : onFailure(state, at);
  }
  const newest = chronological[chronological.length - 1];
  const now = Date.parse(newest.createdAt);
  return {
    circuit: stateName(state, now),
    attemptable: canAttempt(state, now),
    attempts: newest.attempts,
  };
}

export function WebhookManager({
  workspaceId,
  webhooks,
  deliveries,
  locale,
}: {
  workspaceId: string;
  webhooks: WebhookRow[];
  deliveries: DeliveryRow[];
  locale: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const toggleEvent = (event: string) =>
    setEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );

  const create = () =>
    startTransition(async () => {
      const problem = validateEventSelection(events);
      if (problem) {
        toast.error(problem);
        return;
      }
      const result = await createWebhookAction({ workspaceId, url, events, secret });
      if ("ok" in result) {
        setUrl("");
        setSecret("");
        setEvents([]);
        toast.success(t(locale, "webhookAdded"));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  // Group the recent delivery log by webhook URL so each row can show its own
  // circuit and newest retry count. The RSC payload only carries the URL, so it
  // is the join key available to the manager.
  const deliveriesByUrl = new Map<string, DeliveryRow[]>();
  for (const delivery of deliveries) {
    const rows = deliveriesByUrl.get(delivery.url);
    if (rows) rows.push(delivery);
    else deliveriesByUrl.set(delivery.url, [delivery]);
  }

  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <WebhookIcon className="h-4 w-4" />
        {t(locale, "webhooks")}
      </h2>
      <p className="mb-3 text-sm text-muted">
        {t(locale, "webhookIntroA")}{" "}
        <code className="rounded bg-surface px-1">x-noema-signature</code> {t(locale, "webhookIntroB")}
      </p>

      <div className="mb-4 space-y-2 rounded-lg border border-border p-3">
        <input
          aria-label={t(locale, "webhookUrlLabel")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/hooks/noema"
          className="h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <input
          aria-label={t(locale, "signingSecretLabel")}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={t(locale, "signingSecretLabel")}
          aria-required="true"
          className="h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <div className="flex flex-wrap gap-3 text-sm">
          {WEBHOOK_EVENTS.map((event) => (
            <label key={event.type} className="flex items-center gap-1.5" title={event.description}>
              <input
                type="checkbox"
                checked={events.includes(event.type)}
                onChange={() => toggleEvent(event.type)}
              />
              {event.label}
              <code className="rounded bg-surface px-1 font-mono text-[10px] text-muted">
                {event.requiredFields.join(", ")}
              </code>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          {t(locale, "webhookNoEventsHint")}
        </p>
        <button
          type="button"
          disabled={pending || !url.trim() || !secret.trim()}
          onClick={create}
          className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> {t(locale, "addWebhook")}
        </button>
      </div>

      {webhooks.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noWebhooks")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {webhooks.map((webhook) => {
            const health = deliveryHealth(deliveriesByUrl.get(webhook.url) ?? []);
            return (
              <li key={webhook.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="flex-1 truncate font-mono text-xs">{webhook.url}</span>
                <span className="text-xs text-muted">
                  {webhook.events.length === 0 ? t(locale, "allEvents") : subscriptionLabels(webhook.events)}
                </span>
                {health && (
                  <span
                    title={
                      health.attemptable
                        ? "Delivery circuit closed"
                        : "Delivery circuit open"
                    }
                    className={`rounded px-1 text-[10px] font-medium ${
                      health.attemptable
                        ? "bg-emerald-500/15 text-emerald-600"
                        : "bg-red-500/15 text-red-600"
                    }`}
                  >
                    {health.circuit} · {health.attempts} {t(locale, "attemptUnit")}
                  </span>
                )}
                {webhook.hasSecret && (
                  <span className="rounded bg-surface px-1 text-[10px] text-muted">{t(locale, "signedBadge")}</span>
                )}
                <button
                  type="button"
                  aria-label={t(locale, "deleteWebhook")}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await deleteWebhookAction(webhook.id);
                      if ("ok" in result) {
                        toast.success(t(locale, "webhookRemoved"));
                        router.refresh();
                      } else {
                        toast.error(result.error);
                      }
                    })
                  }
                  className="text-muted hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {deliveries.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-muted">
            {t(locale, "recentDeliveries")}
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="flex items-center gap-3 px-4 py-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    delivery.ok ? "bg-emerald-500" : "bg-red-500"
                  }`}
                  aria-hidden
                />
                <span className="w-32 shrink-0 font-mono text-xs">{delivery.event}</span>
                <span className="flex-1 truncate text-xs text-muted">{delivery.url}</span>
                <span className="text-xs text-muted">
                  {delivery.ok
                    ? `${delivery.status ?? 200} · ${delivery.attempts} ${t(locale, "attemptUnit")}`
                    : `${delivery.error ?? t(locale, "failedWord")} · ${delivery.attempts} ${t(locale, "attemptUnit")}`}
                </span>
                <span className="text-xs text-muted">
                  {new Date(delivery.createdAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
