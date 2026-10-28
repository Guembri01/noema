"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  CalendarGrid,
  emptyRange,
  selectDay,
  shiftMonth,
  type RangeSelection,
} from "./calendar-grid";
import { MS_PER_DAY } from "@/lib/calendar-multiday";
import { formatDateRange } from "@/lib/date-range";
import { humanizeDuration } from "@/lib/duration";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * The date / time control the app was missing — for date properties, reminders,
 * filters and tickets.
 *
 * One control, four modes:
 *   • `date` — a single day;
 *   • `range` — start → end with a hover preview and continuous-band day cells;
 *   • `time` — hour/minute steppers plus typing;
 *   • `datetime` — a day plus a time.
 *
 * It reuses the existing engines rather than re-implementing them: the month is
 * laid out by `@/lib/calendar-multiday` (via `CalendarGrid`), labels by
 * `@/lib/date-range#formatDateRange`, and the relative phrase ("in 3 days") by
 * `@/lib/duration#humanizeDuration`. The popover enters with `animate-rise`
 * (§6) and the trigger/every control carries `.focus-ring`.
 *
 * The pure logic (preset resolution, range state machine, time stepping and
 * relative labels) is exported so `date-picker.test.ts` can pin it against a
 * fixed `now`. Nothing reads the clock during render: `today` and the relative
 * phrase appear only after mount (or when a `now` prop is supplied), so server
 * and client paint identical markup.
 */

/** A resolved preset range as inclusive `YYYY-MM-DD` bounds. */
export type DatePresetRange = { start: string; end: string };

/** The quick ranges offered above the calendar. */
export const DATE_PRESETS = [
  "today",
  "yesterday",
  "tomorrow",
  "thisWeek",
  "nextWeek",
  "thisMonth",
  "clear",
] as const;

export type DatePresetId = (typeof DATE_PRESETS)[number];

/** English defaults; override with `presetLabels` once i18n keys land. */
export const PRESET_LABELS: Readonly<Record<DatePresetId, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  tomorrow: "Tomorrow",
  thisWeek: "This week",
  nextWeek: "Next week",
  thisMonth: "This month",
  clear: "Clear",
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DD` of a UTC day index (epoch days). */
function isoFromDayIndex(dayIndex: number): string {
  const date = new Date(dayIndex * MS_PER_DAY);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Resolve a quick range against a fixed `now`, as inclusive UTC date keys.
 * `clear` resolves to `null`. Week ranges honour `weekStartsOn` (`0` = Sunday).
 * Deterministic: it never reads the clock and does all day math in UTC.
 */
export function resolvePreset(
  id: DatePresetId,
  now: Date | number,
  weekStartsOn = 0,
): DatePresetRange | null {
  const ms = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(ms)) return null;
  const today = Math.floor(ms / MS_PER_DAY);
  const iso = isoFromDayIndex;
  const weekday = (index: number) => new Date(index * MS_PER_DAY).getUTCDay();
  const weekStart = today - ((weekday(today) - weekStartsOn + 7) % 7);

  switch (id) {
    case "today":
      return { start: iso(today), end: iso(today) };
    case "yesterday":
      return { start: iso(today - 1), end: iso(today - 1) };
    case "tomorrow":
      return { start: iso(today + 1), end: iso(today + 1) };
    case "thisWeek":
      return { start: iso(weekStart), end: iso(weekStart + 6) };
    case "nextWeek":
      return { start: iso(weekStart + 7), end: iso(weekStart + 13) };
    case "thisMonth": {
      const date = new Date(today * MS_PER_DAY);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth();
      return { start: isoFromDayIndex(Date.UTC(year, month, 1) / MS_PER_DAY), end: isoFromDayIndex(Date.UTC(year, month + 1, 0) / MS_PER_DAY) };
    }
    case "clear":
      return null;
  }
}

/** A clock time in 24-hour hours/minutes. */
export type TimeParts = { hours: number; minutes: number };

/** Minutes a single minute-step moves. */
export const TIME_STEP_MINUTES = 5;

/** Clamp hours to `[0, 23]` and minutes to `[0, 59]`. */
export function clampTime(parts: TimeParts): TimeParts {
  const hours = Number.isFinite(parts.hours) ? Math.trunc(parts.hours) : 0;
  const minutes = Number.isFinite(parts.minutes) ? Math.trunc(parts.minutes) : 0;
  return {
    hours: Math.max(0, Math.min(23, hours)),
    minutes: Math.max(0, Math.min(59, minutes)),
  };
}

/** `HH:MM`, zero-padded. */
export function formatTime(parts: TimeParts): string {
  const { hours, minutes } = clampTime(parts);
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * Step a clock time by whole hours or by `stepMinutes` minutes, wrapping around
 * midnight in either direction (never going negative, never past 23:59).
 */
export function stepTime(
  parts: TimeParts,
  field: "hours" | "minutes",
  delta: number,
  stepMinutes = TIME_STEP_MINUTES,
): TimeParts {
  const { hours, minutes } = clampTime(parts);
  const perDay = 24 * 60;
  const move = field === "hours" ? delta * 60 : delta * stepMinutes;
  const next = (((hours * 60 + minutes + move) % perDay) + perDay) % perDay;
  return { hours: Math.floor(next / 60), minutes: next % 60 };
}

/** `9`, `9:5`, `09:05`, `9h30` → clamped parts; anything else → `null`. */
export function parseTimeInput(text: string): TimeParts | null {
  if (typeof text !== "string") return null;
  const match = /^\s*(\d{1,2})(?:\s*[:h.]\s*(\d{1,2}))?\s*$/i.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return clampTime({ hours, minutes });
}

/**
 * Relative phrase for an ISO date against `now` ("in 3 days" / "2 days ago"),
 * or `""` when the input is blank/unparseable. Thin wrapper over the app's
 * existing `humanizeDuration`.
 */
export function relativeToNow(iso: string | null | undefined, now: Date | number): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return humanizeDuration(ms, { now });
}

export type DatePickerMode = "date" | "range" | "time" | "datetime";

/** The value the picker emits. Fields are `null` when unset. */
export type DatePickerValue = {
  /** ISO `YYYY-MM-DD` start (or single date). */
  date?: string | null;
  /** ISO `YYYY-MM-DD` inclusive end, in `range` mode. */
  end?: string | null;
  /** `HH:MM` in `time` / `datetime` mode. */
  time?: string | null;
};

export type DatePickerProps = {
  mode?: DatePickerMode;
  /** Seeded value; the picker then tracks its own state and calls `onChange`. */
  value?: DatePickerValue;
  onChange?: (value: DatePickerValue) => void;
  locale?: string;
  /** Fixed reference instant. When omitted the picker uses the client clock. */
  now?: Date | number;
  weekStartsOn?: number;
  showPresets?: boolean;
  /** Show the relative phrase ("in 3 days") beside the value. */
  relative?: boolean;
  placeholder?: string;
  presetLabels?: Partial<Record<DatePresetId, string>>;
  className?: string;
  id?: string;
  /** Accessible name for the trigger (when it has no visible text of its own). */
  "aria-label"?: string;
  /** id(s) of external labelling element(s), forwarded to the trigger. */
  "aria-labelledby"?: string;
  /** id(s) of external description element(s), forwarded to the trigger. */
  "aria-describedby"?: string;
};

function seedRange(value: DatePickerValue | undefined): RangeSelection {
  if (!value?.date) return emptyRange();
  return { start: value.date, end: value.end ?? value.date };
}

function seedTime(value: DatePickerValue | undefined): TimeParts {
  const parsed = value?.time ? parseTimeInput(value.time) : null;
  return parsed ?? { hours: 9, minutes: 0 };
}

type Cursor = { year: number; month: number };

function seedCursor(value: DatePickerValue | undefined, clockMs: number | null): Cursor {
  const base = value?.date ? Date.parse(`${value.date}T00:00:00Z`) : clockMs;
  const date = new Date(base ?? Date.UTC(2000, 0, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

const STEPPER_CLASS =
  "focus-ring grid h-7 w-7 place-items-center rounded-control border border-border text-muted u-interactive hover:bg-surface-2 hover:text-fg";

/**
 * Date / time / range / datetime picker.
 *
 * See the module header for the mode matrix and the reused engines. The trigger
 * shows the formatted value with the ISO string in its `title`; when `relative`
 * is set it also shows the `humanizeDuration` phrase.
 */
export function DatePicker({
  mode = "date",
  value,
  onChange,
  locale = "en",
  now,
  weekStartsOn,
  showPresets = true,
  relative = false,
  placeholder = t(locale, "selectDate"),
  presetLabels,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: DatePickerProps) {
  const hasTime = mode === "time" || mode === "datetime";
  const nowMs = now === undefined ? null : typeof now === "number" ? now : now.getTime();
  const [clockMs, setClockMs] = useState<number | null>(nowMs);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<RangeSelection>(() => seedRange(value));
  const [hover, setHover] = useState<string | null>(null);
  const [time, setTime] = useState<TimeParts>(() => seedTime(value));
  const [timeDraft, setTimeDraft] = useState<string>(() => formatTime(seedTime(value)));
  const [cursor, setCursor] = useState<Cursor>(() => seedCursor(value, nowMs));
  const generatedId = useId();
  const triggerId = id ?? generatedId;

  useEffect(() => {
    if (nowMs === null) setClockMs(Date.now());
  }, [nowMs]);

  // `seedCursor` cannot read the clock during server rendering, so it starts
  // at the deterministic 2000-01 fallback. Once the mounted clock arrives,
  // move an empty picker to the current month instead of leaving it in 2000.
  useEffect(() => {
    if (clockMs === null || value?.date) return;
    const today = new Date(clockMs);
    setCursor({
      year: today.getUTCFullYear(),
      month: today.getUTCMonth(),
    });
  }, [clockMs, value?.date]);

  const todayIso = clockMs === null ? null : isoFromDayIndex(Math.floor(clockMs / MS_PER_DAY));
  const resolvedNow = clockMs ?? nowMs ?? 0;

  const emit = (next: DatePickerValue) => onChange?.(next);

  const timePayload = hasTime ? formatTime(time) : null;

  const commitTime = (next: TimeParts) => {
    setTime(next);
    setTimeDraft(formatTime(next));
    emit({ date: range.start, end: mode === "range" ? range.end : null, time: formatTime(next) });
  };

  const handleSelectDay = (day: string) => {
    if (mode === "range") {
      const next = selectDay(range, day);
      setRange(next);
      emit({ date: next.start, end: next.end, time: timePayload });
      return;
    }
    setRange({ start: day, end: day });
    setHover(null);
    emit({ date: day, end: null, time: timePayload });
    if (mode === "date") setOpen(false);
  };

  const handlePreset = (preset: DatePresetId) => {
    const resolved = resolvePreset(preset, resolvedNow, weekStartsOn ?? 0);
    if (!resolved) {
      setRange(emptyRange());
      emit({ date: null, end: null, time: timePayload });
      return;
    }
    setRange({ start: resolved.start, end: resolved.end });
    const base = new Date(`${resolved.start}T00:00:00Z`);
    setCursor({ year: base.getUTCFullYear(), month: base.getUTCMonth() });
    emit({
      date: resolved.start,
      end: mode === "range" ? resolved.end : null,
      time: timePayload,
    });
    if (mode === "date") setOpen(false);
  };

  const handleTimeDraft = (text: string) => {
    setTimeDraft(text);
    const parsed = parseTimeInput(text);
    if (parsed) {
      setTime(parsed);
      emit({ date: range.start, end: mode === "range" ? range.end : null, time: formatTime(parsed) });
    }
  };

  const label = useMemo(() => {
    if (mode === "time") return formatTime(time);
    if (mode === "range" && range.start && range.end && range.end !== range.start) {
      return formatDateRange({ start: range.start, end: range.end });
    }
    if (range.start) {
      const day = formatDateRange({ start: range.start });
      return mode === "datetime" ? `${day}, ${formatTime(time)}` : day;
    }
    return mode === "datetime" ? formatTime(time) : placeholder;
  }, [mode, range.start, range.end, time, placeholder]);

  const title = useMemo(() => {
    if (mode === "time") return formatTime(time);
    if (mode === "range" && range.start && range.end) return `${range.start}/${range.end}`;
    if (range.start) return mode === "datetime" ? `${range.start}T${formatTime(time)}` : range.start;
    return "";
  }, [mode, range.start, range.end, time]);

  const relativeText =
    relative && range.start && clockMs !== null ? relativeToNow(range.start, clockMs) : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={triggerId}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-describedby={ariaDescribedby}
          data-testid="date-picker-trigger"
          title={title || undefined}
          className={cn(
            "focus-ring inline-flex h-9 max-w-full items-center gap-2 rounded-control border-control bg-bg px-3 text-sm text-fg u-interactive hover:bg-surface-2",
            className,
          )}
        >
          <span className={cn("truncate", !range.start && mode !== "time" && "text-muted")}>
            {label}
          </span>
          {relativeText && <span className="shrink-0 text-xs text-muted">{relativeText}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-testid="date-picker"
        className="animate-rise w-auto p-3"
      >
        {showPresets && (
          <div role="group" aria-label={t(locale, "quickRanges")} className="mb-2 flex flex-wrap gap-1">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => handlePreset(preset)}
                className="focus-ring rounded-control border border-border px-2 py-0.5 text-xs text-muted u-interactive hover:bg-surface-2 hover:text-fg"
              >
                {presetLabels?.[preset] ?? PRESET_LABELS[preset]}
              </button>
            ))}
          </div>
        )}

        {mode !== "time" && (
          <CalendarGrid
            year={cursor.year}
            month={cursor.month}
            locale={locale}
            weekStartsOn={weekStartsOn}
            today={todayIso}
            value={range}
            hover={hover}
            onSelectDay={handleSelectDay}
            onHoverDay={setHover}
            onShiftMonth={(delta) =>
              setCursor((current) => shiftMonth(current.year, current.month, delta))
            }
          />
        )}

        {hasTime && (
          <div role="group" aria-label={t(locale, "timeLabel")} className="mt-2 flex items-center justify-center gap-1">
            <button
              type="button"
              aria-label={`${t(locale, "decrease")} ${t(locale, "hour")}`}
              title={t(locale, "hour")}
              onClick={() => commitTime(stepTime(time, "hours", -1))}
              className={STEPPER_CLASS}
            >
              −
            </button>
            <button
              type="button"
              aria-label={`${t(locale, "increase")} ${t(locale, "hour")}`}
              title={t(locale, "hour")}
              onClick={() => commitTime(stepTime(time, "hours", 1))}
              className={STEPPER_CLASS}
            >
              +
            </button>
            <input
              aria-label={t(locale, "timeLabel")}
              value={timeDraft}
              inputMode="numeric"
              placeholder={formatTime({ hours: 0, minutes: 0 })}
              onChange={(event) => handleTimeDraft(event.target.value)}
              onBlur={() => setTimeDraft(formatTime(time))}
              className="focus-ring h-7 w-16 rounded-control border-control bg-bg text-center text-sm tabular-nums text-fg"
            />
            <button
              type="button"
              aria-label={`${t(locale, "decrease")} ${t(locale, "minute")}`}
              title={t(locale, "minute")}
              onClick={() => commitTime(stepTime(time, "minutes", -1))}
              className={STEPPER_CLASS}
            >
              −
            </button>
            <button
              type="button"
              aria-label={`${t(locale, "increase")} ${t(locale, "minute")}`}
              title={t(locale, "minute")}
              onClick={() => commitTime(stepTime(time, "minutes", 1))}
              className={STEPPER_CLASS}
            >
              +
            </button>
          </div>
        )}

        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="focus-ring rounded-control bg-action px-3 py-1 text-xs font-medium text-action-fg u-interactive"
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
