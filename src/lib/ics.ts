/**
 * Minimal iCalendar (RFC 5545) reader for calendar subscriptions.
 *
 * Only the parts needed to surface upcoming events are implemented: line
 * unfolding, VEVENT extraction, DATE/DATE-TIME values, and text unescaping.
 * Recurrence rules are intentionally not expanded (the app keeps the feed's
 * first occurrence), which keeps this dependency-free and predictable.
 */

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
        current.url = parsed.value.trim() || null;
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
