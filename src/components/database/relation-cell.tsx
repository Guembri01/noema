"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { relationSummary } from "@/lib/relation-picker";
import { t } from "@/lib/i18n";

const LazyRelationPickerDialog = dynamic(
  () =>
    import("@/components/database/relation-picker-dialog").then((mod) => ({
      default: mod.RelationPickerDialog,
    })),
  { ssr: false },
);

/**
 * RELATION cell.
 *
 * The selection is a list of page ids. Chips resolve titles from the options the
 * caller already scoped to the workspace; the picker itself is a lazily loaded
 * dialog backed by the cursor-paginated `searchRelationTargetsAction`, so a
 * database with many target rows does not put the whole picker in the route
 * bundle. The pure picker engine still owns filtering, self-exclusion,
 * de-duplication and single/multi cardinality.
 */
export function RelationCell({
  propertyName,
  propertyId,
  value,
  editable,
  locale,
  options,
  rowId,
  multi = true,
  configured = true,
  onChange,
}: {
  propertyName: string;
  propertyId?: string;
  value: unknown;
  editable: boolean;
  locale: string;
  options: readonly { id: string; title: string; icon?: string | null }[];
  rowId?: string;
  multi?: boolean;
  configured?: boolean;
  onChange: (value: { pageIds: string[] }) => void;
}) {
  const record = (value ?? {}) as { pageIds?: unknown };
  const selectedIds = Array.isArray(record.pageIds)
    ? record.pageIds.filter((id): id is string => typeof id === "string")
    : [];
  const [open, setOpen] = useState(false);
  const byId = new Map(
    options.map((option): [string, { title: string }] => [
      option.id,
      { title: option.title },
    ]),
  );
  const selectionLabel = relationSummary(selectedIds, byId);

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      role="group"
      aria-label={selectionLabel || propertyName}
    >
      {selectedIds.map((id) => {
        const option = options.find((candidate) => candidate.id === id);
        const title = option?.title || t(locale, "untitled");
        return option ? (
          <span
            key={id}
            title={title}
            className="flex min-w-0 max-w-full items-center gap-1 rounded-chip bg-surface-2 px-1.5 py-0.5 text-xs"
          >
            <span aria-hidden>{option.icon ?? "📄"}</span>
            <span className="min-w-0 truncate">{title}</span>
          </span>
        ) : null;
      })}
      {editable ? (
        <button
          type="button"
          aria-label={t(locale, "addRelationAria")}
          title={configured ? undefined : t(locale, "relationNeedsTarget")}
          disabled={!configured}
          onClick={() => setOpen(true)}
          className="focus-ring rounded-control px-1 text-xs text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
      ) : null}
      {selectedIds.length === 0 && !editable ? (
        <span className="text-muted">—</span>
      ) : null}
      {open && propertyId ? (
        <LazyRelationPickerDialog
          propertyId={propertyId}
          propertyName={propertyName}
          locale={locale}
          multi={multi}
          selectedIds={selectedIds}
          rowId={rowId}
          onClose={() => setOpen(false)}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}
