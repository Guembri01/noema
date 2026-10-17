import {
  formatList,
  formatNumber,
  formatRelativeTime,
  pluralize,
} from "@/lib/i18n-format";
import { formatRemaining, type SlaStatus } from "@/lib/sla-timer";
import { statusMeta } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { LABEL_TONES } from "./ticket-types";

/** SLA grades reuse the status palette so the chip reads at a glance. */
const SLA_TONES: Record<SlaStatus, string> = {
  ok: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  overdue: "bg-danger-soft text-danger",
};

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-3xs font-medium",
        LABEL_TONES[color] ?? LABEL_TONES.gray,
      )}
    >
      {name}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-3xs font-medium uppercase",
        LABEL_TONES[meta.color] ?? LABEL_TONES.gray,
      )}
    >
      {meta.label}
    </span>
  );
}

/**
 * Compact SLA grade for one ticket: `ok` / `warning` / `overdue` tinting the
 * `formatRemaining` duration (signed once overdue). Purely presentational —
 * the caller grades the timer; a non-finite remaining renders nothing so the
 * chip never shows a misleading blank.
 */
export function SlaChip({
  status,
  remainingMs,
  className,
}: {
  status: SlaStatus;
  remainingMs: number;
  className?: string;
}) {
  const remaining = formatRemaining(remainingMs);
  if (remaining === "") return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium",
        SLA_TONES[status],
        className,
      )}
      title={`SLA ${status} · ${remaining}`}
    >
      SLA {remaining}
    </span>
  );
}

/** Shared chrome for the locale-aware value chips, matching the ticket palette. */
const VALUE_CHIP = "shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium text-muted";

/**
 * Relative date chip for a ticket's due/start instant — "in 2 days",
 * "yesterday", "3 months ago". `formatRelativeTime` buckets the delta against
 * `base` (default: now) and words it in `locale`; with no `locale` the
 * formatter keeps its English wording, so omitting the prop changes nothing
 * for existing callers. A missing or unparsable date renders nothing rather
 * than a blank chip.
 */
export function RelativeDateChip({
  date,
  base,
  locale,
  className,
  title,
}: {
  date: Date | number | string | null | undefined;
  /** Reference instant; defaults to now (pass a fixed value in tests). */
  base?: Date | number | string;
  /** BCP-47 locale for the wording; English when omitted. */
  locale?: string;
  className?: string;
  title?: string;
}) {
  if (date === null || date === undefined) return null;
  const label = formatRelativeTime(date, { base, locale });
  if (label === "") return null;
  return (
    <span className={cn(VALUE_CHIP, className)} title={title}>
      {label}
    </span>
  );
}

/**
 * Count chip, e.g. "3 open" or "1 label": the digit is rendered by
 * `formatNumber` (grouping and digits follow `locale`) and the noun chosen by
 * `pluralize` (`Intl.PluralRules`). Omitting `locale` prints the plain English
 * "N <noun>" the ticket views use today. Invariant nouns such as "open" simply
 * repeat the same form for `one` and `other`.
 */
export function CountChip({
  count,
  one,
  other,
  locale,
  className,
  title,
}: {
  count: number;
  /** Noun for a count of one; repeat `other` for invariant nouns like "open". */
  one: string;
  /** Noun for every other count. */
  other: string;
  /** BCP-47 locale for the number and noun; English when omitted. */
  locale?: string;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cn(VALUE_CHIP, className)} title={title}>
      {formatNumber(count, locale)} {pluralize(count, { one, other }, locale)}
    </span>
  );
}

/**
 * Joined ticket-key list — the blockers/dependents a row points at. With a
 * `locale`, `formatList` joins the keys with that language's conjunction
 * ("A, B and C"); without one it keeps the existing plain comma join
 * ("A, B"), so the legacy display is byte-for-byte unchanged. An empty list
 * renders nothing.
 */
export function KeyListChip({
  keys,
  locale,
  className,
  title,
}: {
  keys?: readonly string[];
  /** BCP-47 locale for the conjunction; comma join when omitted. */
  locale?: string;
  className?: string;
  title?: string;
}) {
  const list = keys ?? [];
  const label = locale
    ? formatList(list, locale)
    : Array.isArray(list)
      ? list.join(", ")
      : "";
  if (label === "") return null;
  return (
    <span className={cn(VALUE_CHIP, className)} title={title}>
      {label}
    </span>
  );
}
