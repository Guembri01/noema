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
import { Section } from "@/components/ui/section";
import { Field } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- *
 * Channel + quiet-hours model (pure, node-testable)
 * -------------------------------------------------------------------------- */

export type ChannelKey = "email" | "inApp";

/** The delivery channels a user can toggle, in display order. */
export const CHANNELS: readonly {
  key: ChannelKey;
  label: string;
  description: string;
}[] = [
  {
    key: "email",
    label: "Email",
    description: "Send alerts and digests to your inbox.",
  },
  {
    key: "inApp",
    label: "In-app",
    description: "Show alerts in the notification inbox.",
  },
];

export type Channels = Record<ChannelKey, boolean>;

export const DEFAULT_CHANNELS: Channels = { email: true, inApp: true };

/** The quiet-hours window: an on/off switch plus an `HH:MM` start and end. */
export type QuietHours = { enabled: boolean; start: string; end: string };

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start: "22:00",
  end: "07:00",
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse `HH:MM` into minutes past midnight, or `null` when malformed. */
export function parseTimeOfDay(value: string): number | null {
  const match = TIME_RE.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Validate a quiet-hours window. Disabled hours are always valid; once enabled
 * both ends must be well-formed `HH:MM` times and must differ. A window that
 * crosses midnight (`22:00`→`07:00`) is allowed on purpose.
 */
export function validateQuietHours(hours: QuietHours): string | null {
  if (!hours.enabled) return null;
  const start = parseTimeOfDay(hours.start);
  const end = parseTimeOfDay(hours.end);
  if (start === null || end === null) return "Enter a time as HH:MM.";
  if (start === end) return "Start and end must be different times.";
  return null;
}

function channelsEqual(a: Channels, b: Channels): boolean {
  return CHANNELS.every((channel) => a[channel.key] === b[channel.key]);
}

function quietEqual(a: QuietHours, b: QuietHours): boolean {
  return a.enabled === b.enabled && a.start === b.start && a.end === b.end;
}

const DELIVERY_OPTIONS: ReadonlyArray<SegmentedOption<DeliveryLevel>> =
  DELIVERY_LEVELS.map((level) => ({ value: level, label: LEVEL_LABELS[level] }));

const CADENCE_OPTIONS = DIGEST_CADENCES.map((cadence) => ({
  value: cadence,
  label: CADENCE_LABELS[cadence],
}));

/* -------------------------------------------------------------------------- *
 * Form
 * -------------------------------------------------------------------------- */

/**
 * The notification-preferences form (settings → Notifications).
 *
 * The server page reads the caller's prefs through `getNotificationPrefs` and
 * hands them here; every change to the persisted half (per-type levels and the
 * digest cadence) is written through `updateNotificationPrefs` via `useAction`,
 * which turns a dropped connection into a rendered error instead of a silent
 * no-op. The draft is re-normalized on save (`fromDraft`), so a bad value can
 * only fall back to its default.
 *
 * Channels and quiet hours are device-level controls kept in component state —
 * they are validated inline and included in the dirty check, but are not part of
 * the persisted payload today (see the follow-up note).
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

  const startDraft = toDraft(initialPrefs);
  const [draft, setDraft] = useState<PrefsDraft>(startDraft);
  const [channels, setChannels] = useState<Channels>(DEFAULT_CHANNELS);
  const [quiet, setQuiet] = useState<QuietHours>(DEFAULT_QUIET_HOURS);
  const [saved, setSaved] = useState(false);
  const [baseline, setBaseline] = useState(() => ({
    draft: startDraft,
    channels: DEFAULT_CHANNELS,
    quiet: DEFAULT_QUIET_HOURS,
  }));

  const quietError = validateQuietHours(quiet);
  const dirty =
    !draftsEqual(draft, baseline.draft) ||
    !channelsEqual(channels, baseline.channels) ||
    !quietEqual(quiet, baseline.quiet);
  const canSubmit = dirty && !pending && quietError === null;

  const setLevel = (type: NotificationEventType, level: DeliveryLevel) => {
    setSaved(false);
    setDraft((current) => ({ ...current, events: { ...current.events, [type]: level } }));
  };

  const save = () => {
    if (pending || quietError !== null) return;
    run(() => updateNotificationPrefs(fromDraft(draft)), {
      success: t(locale, "savedWord"),
      onSuccess: (value) => {
        const next =
          value && typeof value === "object" && "prefs" in value
            ? toDraft(value.prefs)
            : draft;
        if (value && typeof value === "object" && "prefs" in value) {
          setDraft(next);
          router.refresh();
        }
        setBaseline({ draft: next, channels, quiet });
        setSaved(true);
      },
    });
  };

  return (
    <form
      className="mt-10 flex flex-col gap-6"
      data-testid="notification-prefs-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Section
        level={2}
        title={
          <span className="flex items-center gap-2">
            <BellRing className="h-4 w-4" aria-hidden />
            {t(locale, "notifications")}
          </span>
        }
        description="Choose where we reach you, what you hear about, and when."
      >
        <div className="flex flex-col gap-3">
          {CHANNELS.map((channel) => (
            <Switch
              key={channel.key}
              label={channel.label}
              description={channel.description}
              checked={channels[channel.key]}
              onCheckedChange={(checked) => {
                setSaved(false);
                setChannels((current) => ({ ...current, [channel.key]: checked }));
              }}
            />
          ))}
        </div>
      </Section>

      <Section
        level={2}
        title="Notify me about"
        description="Set the delivery level for each kind of event."
      >
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {EVENT_TYPES.map((type) => (
            <li key={type} className="flex flex-wrap items-center gap-3 px-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-fg">{EVENT_LABELS[type]}</span>
                <span className="block text-xs text-muted">{EVENT_DESCRIPTIONS[type]}</span>
              </span>
              <Segmented<DeliveryLevel>
                options={DELIVERY_OPTIONS}
                value={draft.events[type]}
                onValueChange={(level) => setLevel(type, level)}
                ariaLabel={EVENT_LABELS[type]}
                size="sm"
                className="shrink-0"
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section
        level={2}
        title="Email digest"
        description="How accepted notifications are batched. In-app alerts are not delayed by the digest."
      >
        <div className="w-56">
          <Field id="notification-digest" label="Cadence" hint="Applies to email only.">
            <Select
              options={CADENCE_OPTIONS}
              value={draft.digest}
              onChange={(cadence) => {
                setSaved(false);
                setDraft((current) => ({ ...current, digest: cadence as DigestCadence }));
              }}
              searchable={false}
              allowClear={false}
              aria-label={t(locale, "cadenceLabel")}
            />
          </Field>
        </div>
      </Section>

      <Section
        level={2}
        title="Quiet hours"
        description="Pause notifications during a time window each day."
        action={
          <Switch
            aria-label={t(locale, "pauseNotifications")}
            checked={quiet.enabled}
            onCheckedChange={(enabled) => {
              setSaved(false);
              setQuiet((current) => ({ ...current, enabled }));
            }}
          />
        }
      >
        <div className="flex flex-wrap items-start gap-3">
          <Field id="quiet-start" label="From" error={quietError ?? undefined}>
            <input
              type="time"
              value={quiet.start}
              disabled={!quiet.enabled}
              onChange={(event) => {
                setSaved(false);
                setQuiet((current) => ({ ...current, start: event.target.value }));
              }}
              className={cn(
                "focus-ring h-9 rounded-sm border bg-bg px-2.5 text-sm text-fg disabled:cursor-not-allowed disabled:opacity-50",
                quietError ? "border-danger" : "border-border",
              )}
            />
          </Field>
          <Field id="quiet-end" label="To">
            <input
              type="time"
              value={quiet.end}
              disabled={!quiet.enabled}
              onChange={(event) => {
                setSaved(false);
                setQuiet((current) => ({ ...current, end: event.target.value }));
              }}
              className={cn(
                "focus-ring h-9 rounded-sm border bg-bg px-2.5 text-sm text-fg disabled:cursor-not-allowed disabled:opacity-50",
                quietError ? "border-danger" : "border-border",
              )}
            />
          </Field>
        </div>
      </Section>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending} disabled={!canSubmit}>
          {t(locale, "saveChanges")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!dirty || pending}
          onClick={() => {
            setSaved(false);
            setDraft(baseline.draft);
            setChannels(baseline.channels);
            setQuiet(baseline.quiet);
          }}
        >
          {t(locale, "cancel")}
        </Button>
        <p role="status" aria-live="polite" className="text-sm text-success">
          {saved ? t(locale, "savedWord") : ""}
        </p>
      </div>
    </form>
  );
}
