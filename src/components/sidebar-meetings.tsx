"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Link2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  connectCalendarFeedAction,
  createMeetingNoteAction,
  disconnectCalendarFeedAction,
  refreshCalendarFeedsAction,
} from "@/server/actions/calendar";
import { t } from "@/lib/i18n";
import { sanitizeHref } from "@/lib/validation";


export type MeetingEventView = {
  id: string;
  title: string;
  start: string | Date;
  end: string | Date | null;
  allDay: boolean;
  location: string | null;
  url: string | null;
  notesPageId: string | null;
  feed: { name: string; color: string } | null;
};

/**
 * A subscribed calendar as the sidebar shows it. The feed URL (`icsUrl`) is
 * deliberately absent: it is the private address of a personal calendar and
 * often carries a secret token in its path, so it stays on the server, which
 * reads the feed itself.
 */
export type CalendarFeedView = {
  id: string;
  name: string;
  color: string;
  _count: { events: number };
};

function dayLabel(value: string | Date, locale: string) {
  const date = new Date(value);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return t(locale, "todayWord");
  if (date.toDateString() === tomorrow.toDateString()) return t(locale, "tomorrowWord");
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function timeLabel(event: MeetingEventView, locale: string) {
  if (event.allDay) return t(locale, "allDayWord");
  return new Date(event.start).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The sidebar "Meetings" tab: subscribed ICS calendars and upcoming events. */
export function SidebarMeetings({
  workspaceId,
  slug,
  events,
  feeds,
  locale,
  role,
}: {
  workspaceId: string;
  slug: string;
  events: MeetingEventView[];
  feeds: CalendarFeedView[];
  locale: string;
  /**
   * The viewer's role in the workspace. A `GUEST` may not subscribe a
   * calendar — the server refuses the action — so the sidebar offers no door
   * to it.
   */
  role?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const canConnect = role !== "GUEST";
  const [showForm, setShowForm] = useState(canConnect && feeds.length === 0);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const grouped = useMemo(() => {
    const map = new Map<string, MeetingEventView[]>();
    for (const event of events) {
      const key = dayLabel(event.start, locale);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(event);
    }
    return [...map.entries()];
  }, [events, locale]);

  const connect = () =>
    startTransition(async () => {
      const result = await connectCalendarFeedAction({ workspaceId, name, icsUrl: url });

      if ("ok" in result) {
        const imported =
          result.imported === 1
            ? t(locale, "importedEventsOne")
            : t(locale, "importedEventsMany");
        toast.success(imported.replace("{n}", String(result.imported)));
        setName("");
        setUrl("");
        setShowForm(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "upcomingEvents")}
        </span>
        {canConnect ? (
          <button
            type="button"
            aria-label={t(locale, "connectACalendar")}
            onClick={() => setShowForm((value) => !value)}
            className="flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-surface-2"
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {showForm && canConnect && (
        <div className="space-y-1.5 rounded-lg border border-border p-2">
          <p className="text-xs text-muted">{t(locale, "pasteIcsHint")}</p>
          <input
            value={name}
            aria-label={t(locale, "calendarName")}
            placeholder={t(locale, "calendarName")}
            onChange={(event) => setName(event.target.value)}
            className="h-7 w-full rounded-control border-control bg-bg px-1.5 text-sm outline-none focus-ring"
          />
          <input
            value={url}
            aria-label={t(locale, "calendarIcsUrl")}
            placeholder={t(locale, "icsPlaceholder")}
            onChange={(event) => setUrl(event.target.value)}
            className="h-7 w-full rounded-control border-control bg-bg px-1.5 text-sm outline-none focus-ring"
          />
          <button
            type="button"
            disabled={pending || !url.trim()}
            aria-label={t(locale, "connectCalendarButton")}
            onClick={connect}
            className="focus-ring u-interactive h-7 w-full rounded-control bg-action text-xs text-action-fg disabled:opacity-50"
          >
            {pending ? t(locale, "connecting") : t(locale, "connectCalendarButton")}
          </button>
        </div>
      )}

      {grouped.length === 0 ? (
        <p className="px-1 text-sm text-muted">
          {feeds.length === 0
            ? t(locale, "noCalendarConnected")
            : t(locale, "nothingComingUp")}
        </p>
      ) : (
        grouped.map(([day, items]) => (
          <div key={day}>
            <p className="px-1 pb-0.5 text-2xs font-medium uppercase tracking-wide text-muted">
              {day}
            </p>
            <ul className="space-y-0.5">
              {items.map((event) => {
                // The event URL comes from a third-party calendar feed — and a
                // row stored before the parser was fixed can still hold a
                // hostile value. `sanitizeHref` is the last line of defence:
                // only an allowlisted scheme (`http|https|mailto|tel`) may
                // become an `href`.
                const href = sanitizeHref(event.url);
                return (
                  <li
                    key={event.id}
                    className="group flex items-start gap-2 rounded-control px-1 py-1 hover:bg-surface-2"
                  >
                    <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer noopener" className="hover:underline">
                            {event.title}
                          </a>
                        ) : (
                          event.title
                        )}
                      </p>
                      <p className="truncate text-2xs text-muted">
                        {timeLabel(event, locale)}
                        {event.feed ? ` · ${event.feed.name}` : ""}
                      </p>
                    </div>
                    {event.notesPageId ? (
                      <Link
                        href={`/w/${slug}/${event.notesPageId}`}
                        className="shrink-0 rounded-sm px-1 text-2xs text-accent hover:underline"
                      >
                        {t(locale, "eventNotes")}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        aria-label={`${t(locale, "createMeetingNotesFor")} ${event.title}`}
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const result = await createMeetingNoteAction(event.id);

                            if ("ok" in result) {
                              router.push(`/w/${result.slug}/${result.id}`);
                              router.refresh();
                            } else {
                              toast.error(result.error);
                            }
                          })
                        }
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-muted opacity-0 hover:bg-bg group-hover:opacity-100 focus:opacity-100"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      {feeds.length > 0 && (
        <div className="mt-1 space-y-1 border-t border-border pt-2">
          {feeds.map((feed) => (
            <div key={feed.id} className="flex items-center gap-1 text-2xs text-muted">
              <span className="truncate">
                {feed.name} · {feed._count.events}
              </span>
              <button
                type="button"
                aria-label={`${t(locale, "disconnectFeedFor")} ${feed.name}`}
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await disconnectCalendarFeedAction(feed.id);

                    if ("ok" in result) toast.success(t(locale, "calendarDisconnected"));
                    else toast.error(result.error);
                    router.refresh();
                  })
                }
                className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-control hover:bg-surface-2"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await refreshCalendarFeedsAction(workspaceId);

                if ("ok" in result) {
                  toast.success(
                    t(locale, "refreshedEvents").replace("{n}", String(result.refreshed)),
                  );
                } else toast.error(result.error);
                router.refresh();
              })
            }
            className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-xs text-muted hover:bg-surface-2"
          >
            <RefreshCw className="h-3 w-3" /> {t(locale, "refreshCalendars")}
          </button>
        </div>
      )}
    </div>
  );
}
