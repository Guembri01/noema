"use client";

import Link from "next/link";
import {
  chartData,
  timelineData,
  type QueryProperty,
  type QueryRow,
} from "@/lib/database-query";
import { OPTION_COLORS, type DBProperty, type DBRow } from "@/components/database/database-types";
import { stableTime } from "@/lib/time";
import { t } from "@/lib/i18n";

/**
 * Timeline and chart views for a database.
 *
 * Extracted from `database-view.tsx` (docs/FIX_PLAN.md P3) so the file that owns
 * the table/board/list renderers keeps shrinking toward a testable size.
 */

export function TimelineView({
  workspaceSlug,
  properties,
  rows,
  locale,
}: {
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  locale: string;
}) {
  const dateProperty = properties.find((p) => p.type === "DATE");
  if (!dateProperty) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        {t(locale, "timelineNeedsDate")}
      </p>
    );
  }
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 4, 0);
  const bars = timelineData(
    rows as unknown as QueryRow[],
    properties as unknown as QueryProperty[],
    dateProperty.id,
    from,
    to,
  );

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>{stableTime(from, "date")}</span>
        <span className="font-medium text-fg">{dateProperty.name}</span>
        <span>{stableTime(to, "date")}</span>
      </div>
      {bars.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noDatedRows")}</p>
      ) : (
        <div className="space-y-4">
          {bars.map((bar) => (
            <div key={bar.rowId}>
              <Link
                href={`/w/${workspaceSlug}/${bar.rowId}`}
                className="text-xs hover:underline"
              >
                {bar.title}
              </Link>
              <div className="mt-1 h-4 w-full rounded bg-surface">
                <div
                  className="h-4 rounded bg-accent/70"
                  style={{
                    marginLeft: `${bar.offsetPct}%`,
                    width: `${bar.widthPct}%`,
                  }}
                  title={`${bar.startISO.slice(0, 10)} → ${bar.endISO.slice(0, 10)}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChartView({
  properties,
  rows,
  locale,
}: {
  properties: DBProperty[];
  rows: DBRow[];
  locale: string;
}) {
  const groupProperty = properties.find(
    (p) => p.type === "STATUS" || p.type === "SELECT" || p.type === "MULTI_SELECT",
  );
  if (!groupProperty) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        {t(locale, "chartNeedsSelect")}
      </p>
    );
  }
  const data = chartData(
    rows as unknown as QueryRow[],
    properties as unknown as QueryProperty[],
    groupProperty.id,
  );
  const max = Math.max(1, ...data.map((datum) => datum.count));

  return (
    <div className="rounded-lg border border-border p-5">
      <p className="mb-4 text-sm font-medium">{t(locale, "rowsBy")} {groupProperty.name}</p>
      {data.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noDataYet")}</p>
      ) : (
        <div className="space-y-3">
          {data.map((datum) => (
            <div key={datum.id} className="flex items-center gap-3 text-sm">
              <span className="w-32 shrink-0 truncate text-muted">{datum.label}</span>
              <div className="h-4 flex-1 rounded bg-surface">
                <div
                  className="h-4 rounded"
                  style={{
                    width: `${(datum.count / max) * 100}%`,
                    backgroundColor: OPTION_COLORS[datum.color] ?? "#8a8a85",
                  }}
                />
              </div>
              <span className="w-8 shrink-0 text-right text-muted">{datum.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}