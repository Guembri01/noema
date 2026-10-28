"use client";

import { useMemo, useState } from "react";
import {
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
} from "lucide-react";
import {
  CALENDAR_WEEKDAYS,
  addCalendarEvent,
  currentMonth,
  eventsForDay,
  monthGrid,
  moveMonth,
  newCalendarEvent,
  parseCalendarEvents,
  removeCalendarEvent,
  type CalendarEvent,
} from "@/lib/calendar-block";
import { cn } from "@/lib/utils";

/**
 * Lazy-loaded node view for the inline calendar. Keeping the grid, icons and
 * event editor in a separate chunk means a page without a calendar does not pay
 * for them in its initial bundle.
 */
export function CalendarBlockView({
  node,
  updateAttributes,
  deleteNode,
  editor,
  selected,
  locale = "en",
}: NodeViewProps & { locale?: string }) {
  const month = String(node.attrs.month ?? currentMonth());
  const events = useMemo(
    () => parseCalendarEvents(node.attrs.events),
    [node.attrs.events],
  );
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editable = editor.isEditable;
  const cells = useMemo(() => monthGrid(month), [month]);
  const dayEvents = selectedDate ? eventsForDay(events, selectedDate) : [];
  const monthLabel = useMemo(() => {
    const [year, monthNumber] = month.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  }, [locale, month]);

  const commitEvents = (next: readonly CalendarEvent[]) => {
    updateAttributes({ events: JSON.stringify(next) });
  };

  const addEvent = () => {
    if (!selectedDate || draft.trim() === "") return;
    commitEvents(addCalendarEvent(events, newCalendarEvent(selectedDate, draft)));
    setDraft("");
  };

  return (
    <NodeViewWrapper
      data-calendar-block=""
      data-calendar-month={month}
      className={cn(
        "noema-calendar my-3 rounded-lg border border-border bg-bg p-3",
        selected && "border-border-strong shadow-1",
      )}
    >
      <div className="mb-2 flex items-center gap-2" contentEditable={false}>
        <CalendarDays className="h-4 w-4 text-muted" aria-hidden />
        <span className="text-sm font-semibold capitalize">{monthLabel}</span>
        <div className="ms-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            title="Previous month"
            onClick={() => updateAttributes({ month: moveMonth(month, -1) })}
            className="focus-ring u-interactive rounded-control p-1 text-muted hover:bg-surface-2"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            title="Next month"
            onClick={() => updateAttributes({ month: moveMonth(month, 1) })}
            className="focus-ring u-interactive rounded-control p-1 text-muted hover:bg-surface-2"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="This month"
            title="This month"
            onClick={() => updateAttributes({ month: currentMonth() })}
            className="focus-ring u-interactive rounded-control px-2 py-0.5 text-xs text-muted hover:bg-surface-2"
          >
            Today
          </button>
          {editable && (
            <button
              type="button"
              aria-label="Remove calendar"
              title="Remove calendar"
              onClick={() => deleteNode()}
              className="focus-ring u-interactive rounded-control p-1 text-muted hover:bg-surface-2 hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div
        className="grid grid-cols-7 gap-1 text-center text-2xs text-muted"
        contentEditable={false}
        aria-hidden
      >
        {CALENDAR_WEEKDAYS.map((day) => (
          <span key={day} className="py-1 font-medium">
            {day}
          </span>
        ))}
      </div>
      <div
        className="grid grid-cols-7 gap-1"
        contentEditable={false}
        role="grid"
        aria-label={`${monthLabel} calendar`}
      >
        {cells.map((cell) => {
          const count = eventsForDay(events, cell.date).length;
          return (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              aria-selected={selectedDate === cell.date}
              aria-label={`${cell.date}${count > 0 ? `, ${count} event${count === 1 ? "" : "s"}` : ""}`}
              onClick={() => {
                setSelectedDate(cell.date);
                setDraft("");
              }}
              className={cn(
                "focus-ring relative flex min-h-10 flex-col rounded-control border border-transparent p-1 text-left text-xs u-colors hover:bg-surface-2",
                !cell.inMonth && "text-muted/50",
                cell.isToday && "border-action font-semibold text-action",
                selectedDate === cell.date && "bg-surface-2",
              )}
            >
              <span className="tabular-nums">{cell.day}</span>
              {count > 0 && (
                <span className="mt-0.5 flex gap-0.5">
                  {Array.from({ length: Math.min(count, 3) }, (_, index) => (
                    <span
                      key={index}
                      className="h-1 w-1 rounded-full bg-action"
                      aria-hidden
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <div className="mt-2 border-t border-border pt-2" contentEditable={false}>
          <p className="mb-1 text-xs font-medium">{selectedDate}</p>
          {dayEvents.length > 0 ? (
            <ul className="mb-2 space-y-1">
              {dayEvents.map((event) => (
                <li key={event.id} className="flex items-center gap-2 text-xs">
                  <span className="h-1.5 w-1.5 rounded-full bg-action" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{event.title}</span>
                  {editable && (
                    <button
                      type="button"
                      aria-label={`Remove ${event.title}`}
                      onClick={() =>
                        commitEvents(removeCalendarEvent(events, event.id))
                      }
                      className="focus-ring rounded-control p-0.5 text-muted hover:bg-surface-2 hover:text-danger"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-xs text-muted">No events on this day.</p>
          )}
          {editable && (
            <div className="flex items-center gap-1">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addEvent();
                  }
                }}
                placeholder="Add an event"
                aria-label="Event title"
                className="focus-ring h-8 min-w-0 flex-1 rounded-control border border-border bg-bg px-2 text-xs"
              />
              <button
                type="button"
                onClick={addEvent}
                disabled={draft.trim() === ""}
                className="focus-ring u-interactive flex h-8 items-center gap-1 rounded-control border border-border px-2 text-xs hover:bg-surface-2 disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}
