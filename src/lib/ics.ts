/**
 * Minimal iCalendar (RFC 5545) reader for calendar subscriptions.
 *
 * Only the parts needed to surface upcoming events are implemented: line
 * unfolding, VEVENT extraction, DATE/DATE-TIME values, and text unescaping.
 * Recurrence rules are intentionally not expanded (the app keeps the feed's
 * first occurrence), which keeps this predictable and free of any parsing
 * library. The one import is the shared href allowlist (`sanitizeHref`): a
 * feed is third-party input, so a `javascript:` URL is dropped before it can
 * be stored.
 */

import { sanitizeHref } from "@/lib/validation";

export type IcsEvent = {
  uid: string;
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  location: string | null;
  url: string | null;
};

/** Unfold RFC 5545 continuation lines (leading space or tab). */
function unfold(input: string): string[] {
  const raw = input.replace(/\r\n?/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Split `NAME;PARAM=VALUE:value` into its parts. */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** Parse a DTSTART/DTEND value into a Date plus an all-day flag. */
export function parseIcsDate(
  value: string,
  params: Record<string, string>,
): { date: Date; allDay: boolean } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (params.VALUE === "DATE" || /^\d{8}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    if (!year || !month || !day) return null;
    return { date: new Date(Date.UTC(year, month - 1, day)), allDay: true };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zulu] = match;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
  // A trailing Z or an explicit UTC TZID is absolute; otherwise treat the
  // wall-clock time as UTC so stored instants stay stable across servers.
  const date = new Date(Date.UTC(...parts));
  if (zulu) return { date, allDay: false };
  return { date, allDay: false };
}

/** Extract the events contained in an ICS payload. */
export function parseIcsEvents(input: string): IcsEvent[] {
  const lines = unfold(input);
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (parsed.name === "BEGIN" && parsed.value.trim().toUpperCase() === "VEVENT") {
      current = {};
      continue;
    }
    if (parsed.name === "END" && parsed.value.trim().toUpperCase() === "VEVENT") {
      if (current?.start && current.uid) {
        events.push({
          uid: current.uid,
          title: current.title ?? "Untitled event",
          start: current.start,
          end: current.end ?? null,
          allDay: current.allDay ?? false,
          location: current.location ?? null,
          url: current.url ?? null,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    switch (parsed.name) {
      case "UID":
        current.uid = parsed.value.trim();
        break;
      case "SUMMARY":
        current.title = unescapeText(parsed.value).slice(0, 300);
        break;
      case "LOCATION":
        current.location = unescapeText(parsed.value).slice(0, 300) || null;
        break;
      case "URL":
        // A calendar feed is third-party input, and this value ends up in an
        // anchor `href` in the meetings sidebar. Only an allowlisted scheme
        // (`http|https|mailto|tel`) may be stored — a `javascript:` URL is
        // dropped here, before it ever reaches the database.
        current.url = sanitizeHref(parsed.value.trim());
        break;
      case "DTSTART": {
        const parsedDate = parseIcsDate(parsed.value, parsed.params);
        if (parsedDate) {
          current.start = parsedDate.date;
          current.allDay = parsedDate.allDay;
        }
        break;
      }
      case "DTEND": {
        const parsedDate = parseIcsDate(parsed.value, parsed.params);
        if (parsedDate) current.end = parsedDate.date;
        break;
      }
      default:
        break;
    }
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Accept only http(s) feed URLs. */
export function isAllowedFeedUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Rewrite a plain webcal:// URL to https:// so it can be fetched. */
export function normalizeFeedUrl(value: string): string {
  const trimmed = value.trim();
  return /^webcal:\/\//i.test(trimmed) ? trimmed.replace(/^webcal:\/\//i, "https://") : trimmed;
}

// ---------------------------------------------------------------------------
// ICS export — the outbound half of calendar subscriptions. A pure, RFC 5545
// builder: no prisma, no network, and no clock reads (the caller passes `now`),
// so the same input always produces byte-identical output. Pinned by the
// export block in src/lib/ics.test.ts.
// ---------------------------------------------------------------------------

/** One event to serialise into a VEVENT. */
export interface CalendarEventInput {
  /** Stable iCalendar UID, e.g. `"evt-1@noema"`. */
  uid: string;
  /** ISO 8601 instant, or `YYYY-MM-DD` for an all-day event. */
  start: string;
  /** Exclusive end (RFC 5545); omitted when unknown. */
  end?: string;
  /** Serialise dates with `VALUE=DATE` (no time component). */
  allDay?: boolean;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
}

/** Envelope metadata for {@link buildCalendar}. */
export interface CalendarBuildOptions {
  /** `PRODID`, e.g. `"-//Noema//Calendar//EN"`. */
  prodId: string;
  /** Optional `X-WR-CALNAME` display name. */
  name?: string;
  /** `DTSTAMP` source — injected so the builder never reads the clock. */
  now: string | Date;
}

const CRLF = "\r\n";
const OCTET_LIMIT = 75;
const UTF8 = new TextEncoder();

const pad = (value: number): string => String(value).padStart(2, "0");

const toDate = (value: string | Date): Date =>
  typeof value === "string" ? new Date(value) : value;

/** `YYYYMMDD` from the value's UTC calendar date. */
function formatDate(value: string | Date): string {
  const date = toDate(value);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/** `YYYYMMDDTHHMMSSZ`, pinned to UTC. */
function formatDateTime(value: string | Date): string {
  const date = toDate(value);
  return (
    formatDate(date) +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Escape an RFC 5545 TEXT value: `\` → `\\`, `;` → `\;`, `,` → `\,`, and any
 * newline (LF, CR or CRLF) → the two-character sequence `\n`. Backslash is
 * escaped first so the characters introduced by the later passes are not
 * re-escaped (no double escaping).
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold one content line to at most 75 octets, joining continuations with CRLF
 * and a single leading space. Folding is **octet**-counted (UTF-8), so a
 * multi-byte character is never split across a fold; the leading space of a
 * continuation counts toward its 75-octet budget.
 */
export function foldLine(line: string): string {
  if (UTF8.encode(line).length <= OCTET_LIMIT) return line;

  const pieces: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = UTF8.encode(char).length;
    if (octets + size > OCTET_LIMIT) {
      pieces.push(current);
      current = ` ${char}`;
      octets = 1 + size;
    } else {
      current += char;
      octets += size;
    }
  }
  pieces.push(current);
  return pieces.join(CRLF);
}

/**
 * Serialise events into an RFC 5545 VCALENDAR. Each event becomes a VEVENT
 * with `UID`, `DTSTAMP`, `DTSTART`, an optional `DTEND`, `SUMMARY` and the
 * optional `DESCRIPTION`/`LOCATION`/`URL`; TEXT fields are escaped and every
 * physical line is folded to 75 octets. All-day events use `VALUE=DATE`; timed
 * events use UTC `YYYYMMDDTHHMMSSZ`. Lines are CRLF-terminated (including the
 * final one). Event order is preserved.
 */
export function buildCalendar(
  events: CalendarEventInput[],
  options: CalendarBuildOptions,
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options.prodId}`,
    "CALSCALE:GREGORIAN",
  ];
  if (options.name) lines.push(`X-WR-CALNAME:${escapeText(options.name)}`);

  const stamp = formatDateTime(options.now);
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${event.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatDate(event.start)}`);
      if (event.end) lines.push(`DTEND;VALUE=DATE:${formatDate(event.end)}`);
    } else {
      lines.push(`DTSTART:${formatDateTime(event.start)}`);
      if (event.end) lines.push(`DTEND:${formatDateTime(event.end)}`);
    }
    lines.push(`SUMMARY:${escapeText(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join(CRLF) + CRLF;
}
