/**
 * Pure view helpers for the notification-preferences form.
 *
 * The settings form edits exactly the persisted shape of
 * `@/lib/notification-prefs` (`NotificationPrefs`: one delivery level per event
 * type plus a digest cadence). This module is the single place that maps
 * between that persisted shape and the form-friendly `PrefsDraft`, and it labels
 * every event/level/cadence the picker offers — so the client component never
 * hard-codes a vocabulary that could drift from the union.
 *
 * No React, no prisma, no clock: `toDraft`/`fromDraft` are pure and always go
 * through `normalizePrefs`, so a corrupt row renders as the defaults and a
 * malformed draft can only narrow delivery, never widen it. Unit-pinned by
 * `prefs-view.test.ts`.
 */

import {
  normalizePrefs,
  NOTIFICATION_EVENT_TYPES,
  type DeliveryLevel,
  type DigestCadence,
  type NotificationEventType,
  type NotificationPrefs,
} from "@/lib/notification-prefs";

/** The form's editable copy of the preferences: one level per type + cadence. */
export type PrefsDraft = {
  events: Record<NotificationEventType, DeliveryLevel>;
  digest: DigestCadence;
};

/** Event types the form offers, in catalogue order. */
export const EVENT_TYPES: readonly NotificationEventType[] = NOTIFICATION_EVENT_TYPES;

/** Delivery levels the per-event picker offers, in the order they are shown. */
export const DELIVERY_LEVELS: readonly DeliveryLevel[] = ["ALL", "MENTIONS", "NONE"];

/** Digest cadences the picker offers, in the order they are shown. */
export const DIGEST_CADENCES: readonly DigestCadence[] = ["INSTANT", "DAILY", "WEEKLY", "OFF"];

/** Human label for one event type. */
export const EVENT_LABELS: Readonly<Record<NotificationEventType, string>> = {
  "page.mention": "Mentions",
  "comment.reply": "Replies to my comments",
  "page.shared": "Pages shared with me",
  "page.updated": "Page edits",
  "member.invited": "Workspace invitations",
};

/** One-line explanation shown under an event type. */
export const EVENT_DESCRIPTIONS: Readonly<Record<NotificationEventType, string>> = {
  "page.mention": "When someone @mentions you in a comment or on a page.",
  "comment.reply": "When someone replies to a comment you wrote.",
  "page.shared": "When a page is shared with you.",
  "page.updated": "When a page you care about is edited.",
  "member.invited": "When you are invited to a workspace.",
};

/** Human label for one delivery level. */
export const LEVEL_LABELS: Readonly<Record<DeliveryLevel, string>> = {
  ALL: "All events",
  MENTIONS: "Mentions only",
  NONE: "Off",
};

/** Human label for one digest cadence. */
export const CADENCE_LABELS: Readonly<Record<DigestCadence, string>> = {
  INSTANT: "As they happen",
  DAILY: "Daily digest",
  WEEKLY: "Weekly digest",
  OFF: "Off",
};

/**
 * Project any stored preferences value into an editable draft. Corrupt or
 * partial input is filled with the defaults first (`normalizePrefs`), so the
 * form always renders a complete, valid set of controls.
 */
export function toDraft(prefs: unknown): PrefsDraft {
  const normalized = normalizePrefs(prefs);
  const events = {} as Record<NotificationEventType, DeliveryLevel>;
  for (const type of NOTIFICATION_EVENT_TYPES) events[type] = normalized.events[type];
  return { events, digest: normalized.digest };
}

/**
 * Turn an edited draft back into the persisted shape, normalized once more so a
 * bad level/cadence can only fall back to its default rather than reach storage.
 */
export function fromDraft(draft: PrefsDraft): NotificationPrefs {
  return normalizePrefs({ events: draft.events, digest: draft.digest });
}

/** Whether two drafts describe the same preferences (order-independent fields). */
export function draftsEqual(a: PrefsDraft, b: PrefsDraft): boolean {
  if (a.digest !== b.digest) return false;
  return NOTIFICATION_EVENT_TYPES.every((type) => a.events[type] === b.events[type]);
}
