import { formatRemaining, type SlaStatus } from "@/lib/sla-timer";
import { statusMeta } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { LABEL_TONES } from "./ticket-types";

/** SLA grades reuse the status palette so the chip reads at a glance. */
const SLA_TONES: Record<SlaStatus, string> = {
  ok: "bg-emerald-500/10 text-emerald-600",
  warning: "bg-amber-500/10 text-amber-600",
  overdue: "bg-red-500/10 text-red-500",
};

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium",
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
        "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase",
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
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
        SLA_TONES[status],
        className,
      )}
      title={`SLA ${status} · ${remaining}`}
    >
      SLA {remaining}
    </span>
  );
}
