"use client";

import { useEffect, useState } from "react";
import { localTime, stableTime, type TimeMode } from "@/lib/time";

/**
 * A date that never breaks hydration: `stableTime` on the server and for the
 * first client render, then the user's own formatting after mount.
 *
 * See `src/lib/time.ts` for why this matters.
 */
export function LocalTime({
  value,
  mode = "datetime",
  className,
  title,
}: {
  value: string | Date;
  mode?: TimeMode;
  className?: string;
  title?: string;
}) {
  const iso = typeof value === "string" ? value : value.toISOString();
  const [text, setText] = useState(() => stableTime(iso, mode));

  useEffect(() => {
    setText(localTime(iso, mode));
  }, [iso, mode]);

  return (
    <time dateTime={iso} className={className} title={title} suppressHydrationWarning>
      {text}
    </time>
  );
}
