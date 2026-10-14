import { statusMeta } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { LABEL_TONES } from "./ticket-types";

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
