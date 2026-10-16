"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { updateNotificationPrefs } from "@/server/actions/notifications";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import type {
  DeliveryLevel,
  DigestCadence,
  NotificationEventType,
  NotificationPrefs,
} from "@/lib/notification-prefs";
import {
  CADENCE_LABELS,
  DELIVERY_LEVELS,
  DIGEST_CADENCES,
  EVENT_DESCRIPTIONS,
  EVENT_LABELS,
  EVENT_TYPES,
  LEVEL_LABELS,
  draftsEqual,
  fromDraft,
  toDraft,
  type PrefsDraft,
} from "@/app/w/[slug]/settings/notifications/prefs-view";

/**
 * The notification-preferences form (settings → Notifications).
 *
 * The server page reads the caller's prefs through `getNotificationPrefs` and
 * hands them here; every change is persisted through `updateNotificationPrefs`
 * via `useAction`, which turns a dropped connection into a rendered error
 * instead of a silent no-op. The draft is re-normalized on save
 * (`fromDraft`), so a bad value can only fall back to its default.
 */
export function NotificationPreferencesForm({
  initialPrefs,
  locale,
}: {
  initialPrefs: NotificationPrefs;
  locale: string;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [draft, setDraft] = useState<PrefsDraft>(() => toDraft(initialPrefs));

  const dirty = !draftsEqual(draft, toDraft(initialPrefs));

  const setLevel = (type: NotificationEventType, level: DeliveryLevel) => {
    setDraft((current) => ({ ...current, events: { ...current.events, [type]: level } }));
  };

  const save = () => {
    run(() => updateNotificationPrefs(fromDraft(draft)), {
      success: t(locale, "savedWord"),
      onSuccess: (value) => {
        if (value && typeof value === "object" && "prefs" in value) {
          setDraft(toDraft(value.prefs));
          router.refresh();
        }
      },
    });
  };

  return (
    <form
      className="mt-10"
      data-testid="notification-prefs-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <BellRing className="h-4 w-4" />
        {t(locale, "notifications")}
      </h2>

      <section className="rounded-lg border border-border p-4">
        <h3 className="mb-1 text-sm font-medium">Email digest</h3>
        <p className="mb-3 text-xs text-muted">
          How accepted notifications are batched. In-app alerts are not delayed by
          the digest.
        </p>
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="notification-digest">
          Cadence
          <select
            id="notification-digest"
            data-testid="notification-digest"
            value={draft.digest}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                digest: event.target.value as DigestCadence,
              }))
            }
            className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm text-fg"
          >
            {DIGEST_CADENCES.map((cadence) => (
              <option key={cadence} value={cadence}>
                {CADENCE_LABELS[cadence]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <fieldset className="mt-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">Notify me about</legend>
        <ul className="divide-y divide-border">
          {EVENT_TYPES.map((type) => (
            <li key={type} className="flex flex-wrap items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <label
                  className="block text-sm"
                  htmlFor={`notification-event-${type}`}
                >
                  {EVENT_LABELS[type]}
                </label>
                <span className="block text-xs text-muted">{EVENT_DESCRIPTIONS[type]}</span>
              </span>
              <select
                id={`notification-event-${type}`}
                data-testid={`notification-event-${type}`}
                value={draft.events[type]}
                onChange={(event) => setLevel(type, event.target.value as DeliveryLevel)}
                className="h-9 rounded border border-border bg-bg px-2 text-sm text-fg"
              >
                {DELIVERY_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {LEVEL_LABELS[level]}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </fieldset>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-500">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !dirty}
          className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          {pending ? t(locale, "saving") : t(locale, "saveChanges")}
        </button>
      </div>
    </form>
  );
}
