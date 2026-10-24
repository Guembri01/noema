"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Ban, X } from "lucide-react";
import { setRowDependencyAction } from "@/server/actions/database";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

/**
 * Direct blocker / blocked lists for one row (R89.31).
 *
 * The arrows on the timeline and the virtual table column read the same
 * `RowDependency` edges, but a graph is hard to edit: this panel gives the open
 * row a concrete "blocked by" and "blocks" list with one picker per direction.
 * The search space is the whole database (not just the filtered view) so a row
 * can depend on a row that is currently hidden by a filter. The server owns the
 * invariants — same database, live rows, edit rights, no self-edge, no cycle,
 * edge cap — and a refusal is surfaced verbatim instead of silently rolling
 * back.
 */
export function RowDependencies({
  locale,
  databasePageId,
  currentRowId,
  rows,
  edges,
}: {
  locale: string;
  databasePageId: string;
  currentRowId: string;
  rows: { id: string; title: string }[];
  /** All direct blocking edges in the database (`from` blocks `to`). */
  edges: readonly { from: string; to: string }[];
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);

  const titleById = useMemo(
    () => new Map(rows.map((row) => [row.id, row.title || t(locale, "untitled")])),
    [rows, locale],
  );
  const blockedBy = useMemo(
    () => edges.filter((edge) => edge.to === currentRowId).map((edge) => edge.from),
    [edges, currentRowId],
  );
  const blocks = useMemo(
    () => edges.filter((edge) => edge.from === currentRowId).map((edge) => edge.to),
    [edges, currentRowId],
  );

  const candidates = (exclude: readonly string[]) =>
    rows.filter((row) => row.id !== currentRowId && !exclude.includes(row.id));

  const write = (blockerId: string, blockedId: string, linked: boolean) => {
    if (pending) return;
    run(
      () => setRowDependencyAction(databasePageId, blockerId, blockedId, linked),
      { onSuccess: () => router.refresh() },
    );
  };

  const group = (
    label: string,
    ids: readonly string[],
    direction: "blockedBy" | "blocks",
  ) => (
    <div>
      <p className="mb-1 text-3xs font-medium tracking-wide text-muted uppercase">
        {label}
      </p>
      {ids.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <li
              key={id}
              className="flex max-w-full items-center gap-1 rounded-control border border-border bg-surface-2 px-1.5 py-0.5 text-xs"
            >
              <span className="truncate">{titleById.get(id) ?? id}</span>
              <button
                type="button"
                aria-label={`${t(locale, "remove")}: ${titleById.get(id) ?? id}`}
                title={t(locale, "remove")}
                disabled={pending}
                onClick={() =>
                  direction === "blockedBy"
                    ? write(id, currentRowId, false)
                    : write(currentRowId, id, false)
                }
                className="focus-ring rounded-sm p-0.5 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-50"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <select
        aria-label={label}
        value=""
        disabled={pending}
        onChange={(event) => {
          const id = event.currentTarget.value;
          if (!id) return;
          if (direction === "blockedBy") write(id, currentRowId, true);
          else write(currentRowId, id, true);
        }}
        className="focus-ring h-7 w-full rounded-control border border-border bg-transparent px-1.5 text-xs disabled:opacity-50"
      >
        <option value="">
          {direction === "blockedBy"
            ? t(locale, "addBlocker")
            : t(locale, "addBlockedRow")}
        </option>
        {candidates(ids).map((row) => (
          <option key={row.id} value={row.id}>
            {row.title || t(locale, "untitled")}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section
      data-testid="row-dependencies"
      aria-busy={pending}
      className="mb-3 space-y-2 rounded-lg border border-border bg-surface-2/40 p-3"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Ban className="h-3.5 w-3.5" aria-hidden />
        {t(locale, "dependencies")}
      </p>
      {group(t(locale, "relationBlockedBy"), blockedBy, "blockedBy")}
      {group(t(locale, "relationBlocks"), blocks, "blocks")}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
