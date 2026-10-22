import { formatCell } from "@/lib/database-query";
import { formatDateRange, parseDateValue } from "@/lib/date-range";
import { t } from "@/lib/i18n";
import type { DBProperty } from "@/components/database/database-types";

/**
 * DATE cell.
 *
 * Two modes share one surface: the legacy single-date input (no
 * `property.config.date`) and the range/all-day editor. The parent owns the
 * `editing` flag because the cell shell uses it for the editing ring; this
 * component owns the display and the commit shape.
 */
export function DateCell({
  property,
  value,
  editable,
  errorMessage,
  locale,
  editing,
  onEditingChange,
  onChange,
}: {
  property: DBProperty;
  value: unknown;
  editable: boolean;
  errorMessage: string;
  locale: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onChange: (value: unknown) => void;
}) {
  const record = (value ?? {}) as Record<string, unknown>;
  const dateConfig = property.config?.date;
  const dateFormatted = property.config?.format === "friendly";

  if (!dateConfig) {
    if (dateFormatted) {
      const text = formatCell(value, property);
      if (!editable) {
        return (
          <span
            aria-label={property.name}
            title={text || undefined}
            className="min-w-0 max-w-full truncate text-muted"
          >
            {text || "—"}
          </span>
        );
      }
      if (editing) {
        return (
          <input
            autoFocus
            type="date"
            aria-label={property.name}
            aria-invalid={errorMessage !== "" || undefined}
            defaultValue={typeof record.start === "string" ? record.start.slice(0, 10) : ""}
            onChange={(event) => {
              if (event.target.value) onChange({ start: event.target.value });
            }}
            onBlur={() => onEditingChange(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onEditingChange(false);
            }}
            className="focus-ring w-full rounded-sm border border-border-control bg-bg px-1 outline-none"
          />
        );
      }
      return (
        <button
          type="button"
          aria-label={property.name}
          title={text || undefined}
          onClick={() => onEditingChange(true)}
          className="focus-ring w-full min-w-0 truncate rounded px-1 py-0.5 text-left hover:bg-surface-2"
        >
          {text || <span className="text-muted">—</span>}
        </button>
      );
    }
    return (
      <input
        type="date"
        aria-label={property.name}
        aria-invalid={errorMessage !== "" || undefined}
        defaultValue={typeof record.start === "string" ? record.start.slice(0, 10) : ""}
        readOnly={!editable}
        onChange={(event) => onChange({ start: event.target.value })}
        className="focus-ring w-full rounded-sm border border-border-control bg-bg px-1 outline-none"
      />
    );
  }

  const parsedRange = parseDateValue(value);
  const rangeValue = parsedRange.ok ? parsedRange.value : null;
  const startText = typeof record.start === "string" ? record.start : "";
  const endText = typeof record.end === "string" ? record.end : "";
  const allDayValue =
    typeof record.allDay === "boolean" ? record.allDay : dateConfig.allDay ?? true;
  const hasRange =
    rangeValue !== null &&
    typeof rangeValue.end === "string" &&
    rangeValue.end !== rangeValue.start;
  const label =
    rangeValue && hasRange ? formatDateRange(rangeValue) : formatCell(value, property);
  const commitDate = (patch: { start?: string; end?: string; allDay?: boolean }) => {
    const nextStart = patch.start ?? startText;
    if (nextStart.trim() === "") {
      onChange(null);
      return;
    }
    const next: Record<string, unknown> = {
      start: nextStart,
      allDay: patch.allDay ?? allDayValue,
    };
    const nextEnd = patch.end ?? endText;
    if (dateConfig.allowRange && nextEnd) next.end = nextEnd;
    if (dateConfig.timeZone) next.timeZone = dateConfig.timeZone;
    onChange(next);
  };

  if (!editable) {
    return (
      <span
        aria-label={property.name}
        title={label || undefined}
        className="min-w-0 max-w-full truncate text-muted"
      >
        {label || "—"}
      </span>
    );
  }
  if (editing) {
    return (
      <div className="flex flex-col gap-1" role="group" aria-label={property.name}>
        <div className="flex items-center gap-1">
          <input
            autoFocus
            type="date"
            aria-label={property.name}
            defaultValue={startText.slice(0, 10)}
            onChange={(event) => commitDate({ start: event.target.value })}
            className="focus-ring min-w-0 rounded-sm border border-border-control bg-bg px-1 outline-none"
          />
          {dateConfig.allowRange && (
            <>
              <span className="text-muted">—</span>
              <input
                type="date"
                aria-label={`${property.name} end`}
                defaultValue={endText.slice(0, 10)}
                onChange={(event) => commitDate({ end: event.target.value })}
                className="focus-ring min-w-0 rounded-sm border border-border-control bg-bg px-1 outline-none"
              />
            </>
          )}
        </div>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input
            type="checkbox"
            aria-label={t(locale, "allDayWord")}
            checked={allDayValue}
            onChange={(event) => commitDate({ allDay: event.target.checked })}
            className="focus-ring accent-[var(--accent)]"
          />
          {t(locale, "allDayWord")}
        </label>
        <button
          type="button"
          onClick={() => onEditingChange(false)}
          className="focus-ring self-start text-xs text-accent hover:underline"
        >
          {t(locale, "close")}
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={property.name}
      title={label || undefined}
      onClick={() => onEditingChange(true)}
      className="focus-ring w-full min-w-0 truncate rounded px-1 py-0.5 text-left hover:bg-surface-2"
    >
      {label || <span className="text-muted">—</span>}
    </button>
  );
}
