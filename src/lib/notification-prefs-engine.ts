/**
 * Notification inbox preferences engine (docs/specs/collaboration-deep.md §7
 * "Notification inbox & preferences" / "Following pages") plus the per-user
 * preference, quiet-hours, digest and follow-dispatch half of
 * docs/specs/notifications.md (R82.15-R82.18, R82.27).
 *
 * PURE module: no prisma, no `node:*` imports, no routes, no React, no ambient
 * clock. Every helper is handed its instant (`at`, `now`) and returns new
 * values, so the settings UI, the inbox route and a future digest cron share one
 * deterministic decision. Time is modelled with an explicit `tzOffsetMinutes`
 * (or the `quietHours.tz` zone) rather than the machine's local time, so a
 * server render, a client paint and a test agree byte for byte.
 *
 * The event vocabulary is the dotted `Notification.type` strings the app already
 * writes and renders - imported from `notification-prefs.ts` so there is exactly
 * one catalog and the runtime guard cannot drift from the types.
 *
 * Everything fails closed for *targeting* (unknown types never deliver) but
 * fails open for *timing* (a corrupt quiet-hours block or an unparseable instant
 * never silently swallows a notification), mirroring the direction the shipped
 * notification modules take. `DEFAULT_PREFS` is deliberately quiet: in-app only,
 * no digest, page-following opt-in - following a page is what turns
 * `page.updated` on (see `resolveRecipients`).
 *
 * Unit-pinned red-first by `src/lib/notification-prefs-engine.test.ts`.
 */

import { NOTIFICATION_EVENT_TYPES } from "./notification-prefs";
import type { NotificationEventType } from "./notification-prefs";

/** Every notification type a user can tune. One catalog, no second enum. */
export const NOTIFICATION_TYPES = NOTIFICATION_EVENT_TYPES;
export type NotificationType = NotificationEventType;

/** The transports a preference can gate. `email` is digest-timed, not instant. */
export const NOTIFICATION_CHANNELS = ["inApp", "email", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** How accepted email events are batched; `off` disables the digest entirely. */
export const DIGEST_CADENCES = ["off", "daily", "weekly"] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

/** Per-type in-app/email switches. `push` has no per-type override. */
export type ChannelSettings = {
  readonly inApp: boolean;
  readonly email: boolean;
};

/** The global channel switches; per-type settings can only narrow these. */
export type ChannelToggles = {
  readonly inApp: boolean;
  readonly email: boolean;
  readonly push: boolean;
};

/** A recurring do-not-disturb window: `HH:MM` bounds in an IANA `tz`. */
export type QuietHours = {
  /** First quiet minute, `HH:MM` (`00:00`-`23:59`). */
  readonly start: string;
  /** First deliverable minute, `HH:MM`; `start > end` wraps past midnight. */
  readonly end: string;
  readonly tz: string;
};

/** Default subscription behaviour when a page/thread is not followed explicitly. */
export type FollowDefaults = {
  readonly pages: boolean;
  readonly comments: boolean;
};

/** The persisted (JSON) preference shape. Read through `parsePrefs`. */
export type NotificationPrefs = {
  readonly userId: string;
  readonly channels: ChannelToggles;
  readonly digest: DigestCadence;
  readonly quietHours?: QuietHours;
  readonly perType: Readonly<Record<NotificationType, ChannelSettings>>;
  readonly followDefaults?: FollowDefaults;
};

/**
 * Defaults: the inbox is on, email/push are opt-in, the digest is off, and the
 * `page.updated` broadcast is off until the user follows a page. Directed events
 * (mention, reply, share, invite) are in-app on. Comment-reply following is on
 * by default; page following is not.
 */
export const DEFAULT_PREFS: NotificationPrefs = {
  userId: "",
  channels: { inApp: true, email: false, push: false },
  digest: "off",
  perType: {
    "page.mention": { inApp: true, email: false },
    "comment.reply": { inApp: true, email: false },
    "page.shared": { inApp: true, email: false },
    "page.updated": { inApp: true, email: false },
    "member.invited": { inApp: true, email: false },
  },
  followDefaults: { pages: false, comments: true },
};

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Local hour a daily/weekly digest is sent at. */
export const DIGEST_HOUR = 8;

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TZ_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const CHANNEL_LABELS: Readonly<Record<NotificationChannel, string>> = {
  inApp: "in-app",
  email: "email",
  push: "push",
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isDigestCadence(value: unknown): value is DigestCadence {
  return (
    typeof value === "string" &&
    (DIGEST_CADENCES as readonly string[]).includes(value)
  );
}

function isKnownType(value: unknown): value is NotificationType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_TYPES as readonly string[]).includes(value)
  );
}

/** `HH:MM` as minutes past midnight, or `null` when malformed. */
function parseTimeOfDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME_OF_DAY.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** A fully valid quiet window, or `null` (fail closed on any bad field). */
function readQuietHours(value: unknown): QuietHours | null {
  if (!isPlainRecord(value)) return null;
  const start = parseTimeOfDay(value.start);
  const end = parseTimeOfDay(value.end);
  if (start === null || end === null || start === end) return null;
  if (typeof value.tz !== "string" || !TZ_NAME.test(value.tz)) return null;
  return { start: String(value.start), end: String(value.end), tz: value.tz };
}

function copyPerType(
  source: Readonly<Record<NotificationType, ChannelSettings>>,
): Record<NotificationType, ChannelSettings> {
  const copy = {} as Record<NotificationType, ChannelSettings>;
  for (const type of NOTIFICATION_TYPES) {
    const settings = source[type];
    copy[type] = { inApp: settings.inApp, email: settings.email };
  }
  return copy;
}

/** A fresh copy of the defaults stamped with `userId` (never shares nested objects). */
export function defaultPrefs(userId: string): NotificationPrefs {
  return {
    userId,
    channels: { ...DEFAULT_PREFS.channels },
    digest: DEFAULT_PREFS.digest,
    perType: copyPerType(DEFAULT_PREFS.perType),
    followDefaults: DEFAULT_PREFS.followDefaults
      ? { ...DEFAULT_PREFS.followDefaults }
      : undefined,
  };
}

/**
 * Fill a possibly corrupt, possibly partial preferences value into a complete
 * `NotificationPrefs`. Every unrecognized or ill-typed field falls back to its
 * default (unknown per-type keys are dropped, a malformed quiet window is
 * removed), so callers can hand raw JSON straight off a row or a form without
 * widening delivery by accident. The input is never mutated.
 */
export function parsePrefs(raw: unknown): NotificationPrefs {
  const record = isPlainRecord(raw) ? raw : {};
  const userId = typeof record.userId === "string" ? record.userId : DEFAULT_PREFS.userId;

  const rawChannels = isPlainRecord(record.channels) ? record.channels : {};
  const channels: ChannelToggles = {
    inApp: isBoolean(rawChannels.inApp) ? rawChannels.inApp : DEFAULT_PREFS.channels.inApp,
    email: isBoolean(rawChannels.email) ? rawChannels.email : DEFAULT_PREFS.channels.email,
    push: isBoolean(rawChannels.push) ? rawChannels.push : DEFAULT_PREFS.channels.push,
  };

  const rawPerType = isPlainRecord(record.perType) ? record.perType : {};
  const perType = {} as Record<NotificationType, ChannelSettings>;
  for (const type of NOTIFICATION_TYPES) {
    const fallback = DEFAULT_PREFS.perType[type];
    const rawEntry = rawPerType[type];
    const entry = isPlainRecord(rawEntry) ? rawEntry : {};
    perType[type] = {
      inApp: isBoolean(entry.inApp) ? entry.inApp : fallback.inApp,
      email: isBoolean(entry.email) ? entry.email : fallback.email,
    };
  }

  const quietHours = readQuietHours(record.quietHours) ?? undefined;
  const digest = isDigestCadence(record.digest) ? record.digest : DEFAULT_PREFS.digest;

  const baseFollow = DEFAULT_PREFS.followDefaults ?? { pages: false, comments: false };
  const rawFollow = isPlainRecord(record.followDefaults) ? record.followDefaults : {};
  const followDefaults: FollowDefaults = {
    pages: isBoolean(rawFollow.pages) ? rawFollow.pages : baseFollow.pages,
    comments: isBoolean(rawFollow.comments) ? rawFollow.comments : baseFollow.comments,
  };

  return {
    userId,
    channels,
    digest,
    ...(quietHours ? { quietHours } : {}),
    perType,
    followDefaults,
  };
}

/** Total outcome of `validatePrefs`: the normalized value or every reason it failed. */
export type PrefsValidation =
  | { readonly ok: true; readonly value: NotificationPrefs }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Strict validation for a preferences payload (settings form, API body). Unlike
 * `parsePrefs` it does not paper over mistakes: it reports every malformed
 * digest cadence, quiet-hour bound/zone, channel switch, unknown per-type key
 * and missing type entry in one pass, and only normalizes when the whole shape
 * is sound.
 */
export function validatePrefs(prefs: unknown): PrefsValidation {
  if (!isPlainRecord(prefs)) {
    return { ok: false, errors: ["Preferences must be an object."] };
  }
  const errors: string[] = [];

  if (typeof prefs.userId !== "string" || prefs.userId.length === 0) {
    errors.push("`userId` must be a non-empty string.");
  }

  const channels = prefs.channels;
  if (!isPlainRecord(channels)) {
    errors.push("`channels` must be an object.");
  } else {
    for (const channel of NOTIFICATION_CHANNELS) {
      if (!isBoolean(channels[channel])) {
        errors.push(`\`channels.${channel}\` must be a boolean.`);
      }
    }
  }

  if (!isDigestCadence(prefs.digest)) {
    errors.push(`\`digest\` must be one of ${DIGEST_CADENCES.join(", ")}.`);
  }

  const quiet = prefs.quietHours;
  if (quiet !== undefined) {
    if (!isPlainRecord(quiet)) {
      errors.push("`quietHours` must be an object.");
    } else {
      const start = parseTimeOfDay(quiet.start);
      const end = parseTimeOfDay(quiet.end);
      if (start === null) {
        errors.push("`quietHours.start` must be HH:MM (00:00-23:59).");
      }
      if (end === null) {
        errors.push("`quietHours.end` must be HH:MM (00:00-23:59).");
      }
      if (start !== null && end !== null && start === end) {
        errors.push("`quietHours` must have a non-zero duration.");
      }
      if (typeof quiet.tz !== "string" || !TZ_NAME.test(quiet.tz)) {
        errors.push("`quietHours.tz` must be an IANA time-zone name.");
      }
    }
  }

  const perType = prefs.perType;
  if (!isPlainRecord(perType)) {
    errors.push("`perType` must be an object.");
  } else {
    for (const key of Object.keys(perType)) {
      if (!isKnownType(key)) {
        errors.push(`Unknown notification type \`${key}\` in \`perType\`.`);
      }
    }
    for (const type of NOTIFICATION_TYPES) {
      const entry = perType[type];
      if (entry === undefined) {
        errors.push(`\`perType\` is missing \`${type}\`.`);
      } else if (!isPlainRecord(entry)) {
        errors.push(`\`perType.${type}\` must be an object.`);
      } else {
        if (!isBoolean(entry.inApp)) errors.push(`\`perType.${type}.inApp\` must be a boolean.`);
        if (!isBoolean(entry.email)) errors.push(`\`perType.${type}.email\` must be a boolean.`);
      }
    }
  }

  const follow = prefs.followDefaults;
  if (follow !== undefined) {
    if (!isPlainRecord(follow)) {
      errors.push("`followDefaults` must be an object.");
    } else {
      for (const scope of ["pages", "comments"] as const) {
        if (!isBoolean(follow[scope])) {
          errors.push(`\`followDefaults.${scope}\` must be a boolean.`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsePrefs(prefs) };
}

/** One instant as a `Date`, tolerating epoch ms, `Date` or a parsable string. */
function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Minutes east of UTC for `tz` at `at`, read back through `Intl` so neither the
 * host zone nor DST leaks in. An unknown zone answers `0` (UTC) rather than
 * throwing, which keeps quiet hours fail-open.
 */
function zoneOffsetMinutes(tz: string, at: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = formatter.formatToParts(at);
    const field = (type: string): number => {
      const part = parts.find((candidate) => candidate.type === type);
      return part ? Number(part.value) : 0;
    };
    const asUtc = Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour"),
      field("minute"),
      field("second"),
    );
    return Math.round((asUtc - at.getTime()) / MS_PER_MINUTE);
  } catch {
    return 0;
  }
}

/**
 * Is `at` inside the quiet window? A same-day window (`start < end`) is quiet
 * between the two minutes; a wrapping window (`start > end`) runs from `start`
 * through (but not including) `end` the next morning. A malformed window is
 * never quiet (fail open).
 */
function isQuietAt(quiet: QuietHours, at: Date, tzOffsetMinutes?: number): boolean {
  const start = parseTimeOfDay(quiet.start);
  const end = parseTimeOfDay(quiet.end);
  if (start === null || end === null || start === end) return false;
  const offset =
    typeof tzOffsetMinutes === "number" && Number.isFinite(tzOffsetMinutes)
      ? tzOffsetMinutes
      : zoneOffsetMinutes(quiet.tz, at);
  const local = new Date(at.getTime() + offset * MS_PER_MINUTE);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/** One delivery question: is `type` deliverable on `channel` at `at`? */
export type DeliveryQuery = {
  readonly type: NotificationType;
  readonly at: Date | number | string;
  readonly channel: NotificationChannel;
  /** Overrides the zone derivation; east positive (`+120` = UTC+2). */
  readonly tzOffsetMinutes?: number;
};

/** Channel switch only: global gate then the per-type override (unknown type = off). */
function channelEnabled(
  settings: NotificationPrefs,
  type: NotificationType,
  channel: NotificationChannel,
): boolean {
  if (!isKnownType(type)) return false;
  if (channel === "push") return settings.channels.push;
  return settings.channels[channel] && settings.perType[type][channel];
}

/**
 * Should one event be delivered to one channel at one instant?
 *
 * Order: an unknown event type is suppressed (fail closed); the channel must be
 * enabled globally *and* for this type (`inApp`/`email`); then quiet hours mute
 * `inApp`/`push` (never `email`, which is re-timed by the digest). Quiet-hours
 * resolution is fail-open: a corrupt block or unparseable instant delivers.
 *
 * Digest cadence deliberately does not enter here - `off` is expressed through
 * the channel switches, and `daily`/`weekly` re-time email in `nextDigestAt` /
 * `groupDigest`.
 */
export function shouldDeliver(prefs: unknown, query: DeliveryQuery): boolean {
  const settings = parsePrefs(prefs);
  if (!channelEnabled(settings, query.type, query.channel)) return false;
  if (query.channel === "email") return true;
  const quiet = settings.quietHours;
  if (!quiet) return true;
  const at = toDate(query.at);
  if (Number.isNaN(at.getTime())) return true;
  return !isQuietAt(quiet, at, query.tzOffsetMinutes);
}

/**
 * The first instant strictly after `now` at which the next digest would send:
 * `08:00` local (`quietHours.tz` or UTC), daily or on the coming Monday for a
 * weekly cadence. Returns `null` for cadence `off` or an unparseable `now`.
 */
export function nextDigestAt(
  prefs: unknown,
  now: Date | number | string,
): Date | null {
  const settings = parsePrefs(prefs);
  if (settings.digest === "off") return null;
  const at = toDate(now);
  if (Number.isNaN(at.getTime())) return null;

  const offset = settings.quietHours ? zoneOffsetMinutes(settings.quietHours.tz, at) : 0;
  const localNowMs = at.getTime() + offset * MS_PER_MINUTE;
  const local = new Date(localNowMs);
  let targetLocalMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    DIGEST_HOUR,
    0,
    0,
    0,
  );
  if (settings.digest === "weekly") {
    const daysToMonday = (1 - local.getUTCDay() + 7) % 7; // 1 = Monday
    targetLocalMs += daysToMonday * MS_PER_DAY;
  }
  if (targetLocalMs <= localNowMs) {
    targetLocalMs += (settings.digest === "weekly" ? 7 : 1) * MS_PER_DAY;
  }
  return new Date(targetLocalMs - offset * MS_PER_MINUTE);
}

/** One event up for digesting; richer rows pass through untouched. */
export type DigestEvent = {
  readonly type: NotificationType;
  readonly at: Date | number | string;
  readonly id?: string;
};

/** Per-type totals inside a digest payload. */
export type DigestCounts = Partial<Record<NotificationType, number>>;

/** One batched digest, or `null` when nothing would send. */
export type DigestPayload<T extends DigestEvent = DigestEvent> = {
  readonly userId: string;
  readonly cadence: "daily" | "weekly";
  readonly events: readonly T[];
  readonly count: number;
  readonly counts: Readonly<DigestCounts>;
} | null;

/** `at` asc, then id asc - total and deterministic for equal instants. */
function compareDigestEvents(a: DigestEvent, b: DigestEvent): number {
  const ax = toDate(a.at).getTime();
  const bx = toDate(b.at).getTime();
  if (ax !== bx) return ax < bx ? -1 : 1;
  const aid = a.id ?? "";
  const bid = b.id ?? "";
  if (aid === bid) return 0;
  return aid < bid ? -1 : 1;
}

/**
 * Batch the events the email channel accepts into one digest payload (the
 * summary a cron sends), newest events last and totals per type. Cadence `off`,
 * a level/type that suppresses email, or an empty result all answer `null`.
 * Input order is normalized by `at`; the input array is never mutated.
 */
export function groupDigest<T extends DigestEvent>(
  events: readonly T[],
  prefs: unknown,
): DigestPayload<T> {
  const settings = parsePrefs(prefs);
  if (settings.digest === "off") return null;
  const cadence = settings.digest;
  const accepted: T[] = [];
  for (const event of events) {
    if (shouldDeliver(settings, { type: event.type, at: event.at, channel: "email" })) {
      accepted.push(event);
    }
  }
  if (accepted.length === 0) return null;
  const sorted = [...accepted].sort(compareDigestEvents);
  const counts: DigestCounts = {};
  for (const event of sorted) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return {
    userId: settings.userId,
    cadence,
    events: sorted,
    count: sorted.length,
    counts,
  };
}

/** A page follow toggle; `pageId` is echoed back for the caller to persist. */
export type FollowUpdate = {
  readonly pageId: string;
  readonly follow: boolean;
};

/** The updated preferences plus the follow target that was applied. */
export type FollowApplication = {
  readonly prefs: NotificationPrefs;
  readonly pageId: string;
  readonly follow: boolean;
};

/**
 * Apply a page follow toggle: turn `page.updated` subscription on or off by
 * updating `followDefaults.pages`, returning a new preferences value and echoing
 * the toggled `pageId`. Immutable - the input is never touched.
 */
export function applyFollow(prefs: unknown, update: FollowUpdate): FollowApplication {
  const settings = parsePrefs(prefs);
  const base = settings.followDefaults ?? { pages: false, comments: false };
  return {
    prefs: {
      ...settings,
      followDefaults: { ...base, pages: update.follow },
    },
    pageId: update.pageId,
    follow: update.follow,
  };
}

/** The event whose recipients are being resolved. */
export type RecipientEvent = {
  readonly type: NotificationType;
  readonly pageId?: string;
  /** The actor is never notified of their own action. */
  readonly actorId?: string;
  /** When present, quiet hours are honoured for in-app delivery. */
  readonly at?: Date | number | string;
};

/** Followers/watchers for the page plus each recipient's prefs (defaults if absent). */
export type RecipientOptions = {
  readonly followers?: readonly string[];
  readonly watchers?: readonly string[];
  readonly prefs?: Readonly<Record<string, NotificationPrefs | undefined>>;
};

/**
 * The missing **PageFollow dispatch**: who should receive `event` over in-app.
 *
 * `page.updated` (and its broadcast cousins) reaches the page's `followers`
 * plus its `watchers`; a directed event (`page.mention`, `page.shared`,
 * `member.invited`) reaches `watchers` only; `comment.reply` reaches watchers,
 * plus followers whose `followDefaults.comments` is on. The actor is always
 * excluded, each recipient is filtered through their own in-app settings
 * (a muted `page.updated` drops a follower), quiet hours apply when `at` is
 * given, and the result is sorted and de-duplicated.
 */
export function resolveRecipients(
  event: RecipientEvent,
  options: RecipientOptions = {},
): string[] {
  const followers = options.followers ?? [];
  const watchers = options.watchers ?? [];
  const candidates = new Set<string>();
  for (const watcher of watchers) candidates.add(watcher);
  if (event.type === "page.updated") {
    for (const follower of followers) candidates.add(follower);
  } else if (event.type === "comment.reply") {
    for (const follower of followers) {
      const prefs = options.prefs?.[follower] ?? defaultPrefs(follower);
      if (prefs.followDefaults?.comments) candidates.add(follower);
    }
  }

  const recipients: string[] = [];
  for (const userId of candidates) {
    if (userId === event.actorId) continue;
    const prefs = options.prefs?.[userId] ?? defaultPrefs(userId);
    if (!channelEnabled(prefs, event.type, "inApp")) continue;
    if (event.at !== undefined) {
      const at = toDate(event.at);
      const quiet = prefs.quietHours;
      if (quiet && !Number.isNaN(at.getTime()) && isQuietAt(quiet, at)) continue;
    }
    recipients.push(userId);
  }
  return recipients.sort();
}

/**
 * One-line, deterministic summary of a preferences value for the settings UI and
 * for logging: enabled channels, digest cadence, quiet window, follow defaults
 * and the types muted on both in-app and email.
 */
export function describePrefs(prefs: unknown): string {
  const settings = parsePrefs(prefs);
  const channels = NOTIFICATION_CHANNELS.filter((channel) => settings.channels[channel]).map(
    (channel) => CHANNEL_LABELS[channel],
  );
  const follow = settings.followDefaults
    ? [
        settings.followDefaults.pages ? "pages" : null,
        settings.followDefaults.comments ? "comments" : null,
      ].filter((scope): scope is string => scope !== null)
    : [];
  const muted = NOTIFICATION_TYPES.filter(
    (type) => !settings.perType[type].inApp && !settings.perType[type].email,
  );
  return [
    `channels ${channels.length > 0 ? channels.join(", ") : "none"}`,
    `digest ${settings.digest}`,
    settings.quietHours
      ? `quiet ${settings.quietHours.start}-${settings.quietHours.end} ${settings.quietHours.tz}`
      : "quiet off",
    `follow ${follow.length > 0 ? follow.join(", ") : "none"}`,
    `muted ${muted.length > 0 ? muted.join(", ") : "none"}`,
  ].join(" | ");
}
