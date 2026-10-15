"use client";

import { useEffect, useState } from "react";
import { localTime, stableTime, type TimeMode } from "@/lib/time";
import { formatOffset, offsetMinutes } from "@/lib/tz-offset";

/** The `localTime` display styles, pinned to an explicit IANA zone. */
const ZONED_OPTIONS: Record<TimeMode, Intl.DateTimeFormatOptions> = {
  datetime: { dateStyle: "medium", timeStyle: "short" },
  date: { dateStyle: "medium" },
  time: { timeStyle: "short" },
};

/** `iso` rendered in `timeZone`, or the user's own zone if ICU rejects it. */
function zonedTime(iso: string, mode: TimeMode, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...ZONED_OPTIONS[mode],
      timeZone,
    }).format(date);
  } catch {
    // Unknown zone: degrade to the user's own zone rather than throw on render.
    return localTime(iso, mode);
  }
}

/**
 * A date that never breaks hydration: `stableTime` on the server and for the
 * first client render, then the user's own formatting after mount.
 *
 * See `src/lib/time.ts` for why this matters.
 *
 * Pass an IANA `timeZone` to render the instant in that zone with its UTC
 * offset appended (e.g. `14:30 (UTC+05:30)`), derived from
 * `offsetMinutes`/`formatOffset`. The server and first client render stay
 * `stableTime`, so hydration is unaffected; without `timeZone` the component
 * behaves exactly as before.
 */
export function LocalTime({
  value,
  mode = "datetime",
  className,
  title,
  timeZone,
}: {
  value: string | Date;
  mode?: TimeMode;
  className?: string;
  title?: string;
  /** IANA zone to display in; its UTC offset is appended. Omit for the user's zone. */
  timeZone?: string;
}) {
  const iso = typeof value === "string" ? value : value.toISOString();
  const [text, setText] = useState(() => stableTime(iso, mode));

  useEffect(() => {
    if (!timeZone) {
      setText(localTime(iso, mode));
      return;
    }
    const offset = formatOffset(offsetMinutes(timeZone, iso));
    const zoned = zonedTime(iso, mode, timeZone);
    setText(offset ? `${zoned} (UTC${offset})` : zoned);
  }, [iso, mode, timeZone]);

  return (
    <time dateTime={iso} className={className} title={title} suppressHydrationWarning>
      {text}
    </time>
  );
}
