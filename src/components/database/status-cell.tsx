import { cn } from "@/lib/utils";
import { tagClass, tagStyle } from "@/lib/design-tokens";
import { optionTagHue } from "@/components/database/database-types";

export type StatusOption = {
  id: string;
  name: string;
  color?: string | null;
};

/**
 * The SELECT / STATUS cell.
 *
 * The visible layer is one tag; the native `<select>` is transparent over it, so
 * keyboard, mobile pickers and screen readers keep the platform control while a
 * cell no longer shows the selected label twice (chip + select text).
 */
export function StatusCell({
  propertyName,
  options,
  value,
  editable,
  onChange,
  className,
}: {
  propertyName: string;
  options: readonly StatusOption[];
  value: unknown;
  editable: boolean;
  onChange: (next: { optionId: string } | null) => void;
  className?: string;
}) {
  const record = (value ?? {}) as { optionId?: unknown };
  const selectedId = typeof record.optionId === "string" ? record.optionId : "";
  const current = options.find((option) => option.id === selectedId);
  const hue = optionTagHue(current?.color);

  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center rounded-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-bg",
        className,
      )}
    >
      {current ? (
        <span
          data-testid="option-chip"
          data-color={hue}
          title={hue}
          className={cn(tagClass(hue), "min-w-0 max-w-full truncate")}
          style={tagStyle(hue)}
        >
          {current.name}
        </span>
      ) : (
        <span className="px-1 text-xs text-muted">—</span>
      )}
      {editable ? (
        <select
          aria-label={propertyName}
          value={selectedId}
          onChange={(event) =>
            onChange(event.target.value ? { optionId: event.target.value } : null)
          }
          className="focus-ring absolute inset-0 h-full w-full cursor-pointer rounded-sm opacity-0"
        >
          <option value="">—</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
