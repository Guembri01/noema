"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  queryRelationCandidates,
  relationSummary,
  toggleRelation,
} from "@/lib/relation-picker";
import { t } from "@/lib/i18n";

/**
 * RELATION cell.
 *
 * The selection is a list of page ids; the visible chips and the picker resolve
 * titles from the options the caller already scoped to the workspace. The pure
 * picker engine owns filtering, self-exclusion, de-duplication and the cap.
 */
export function RelationCell({
  propertyName,
  value,
  editable,
  locale,
  options,
  rowId,
  onChange,
}: {
  propertyName: string;
  value: unknown;
  editable: boolean;
  locale: string;
  options: readonly { id: string; title: string; icon?: string | null }[];
  rowId?: string;
  onChange: (value: { pageIds: string[] }) => void;
}) {
  const record = (value ?? {}) as { pageIds?: unknown };
  const selectedIds = Array.isArray(record.pageIds)
    ? record.pageIds.filter((id): id is string => typeof id === "string")
    : [];
  const [query, setQuery] = useState("");
  const byId = new Map(
    options.map((option): [string, { title: string }] => [
      option.id,
      { title: option.title },
    ]),
  );
  const candidates = queryRelationCandidates(
    options.map((option) => ({ id: option.id, title: option.title })),
    {
      query,
      excludeIds: selectedIds,
      allowMultiple: true,
      selfId: rowId,
    },
  );
  const selectionLabel = relationSummary(selectedIds, byId);
  const pick = (id: string) =>
    onChange({
      pageIds: toggleRelation(selectedIds, id, { allowMultiple: true }),
    });

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "addRelationAria")}
              className="focus-ring rounded-control px-1 text-xs text-muted hover:bg-surface-2"
            >
              +
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <div className="p-1">
              <input
                autoFocus
                value={query}
                aria-label={t(locale, "search")}
                placeholder={t(locale, "search")}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                className="focus-ring w-full rounded-control border border-border-control bg-bg px-1.5 py-0.5 text-xs outline-none"
              />
            </div>
            {candidates.length === 0 ? (
              <DropdownMenuItem disabled>
                {t(locale, "noRelatedRows")}
              </DropdownMenuItem>
            ) : (
              candidates.map((option) => {
                const meta = options.find((candidate) => candidate.id === option.id);
                return (
                  <DropdownMenuItem
                    key={option.id}
                    onSelect={() => {
                      pick(option.id);
                      setQuery("");
                    }}
                  >
                    {meta?.icon ?? "📄"}{" "}
                    {option.title || t(locale, "untitled")}
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {selectedIds.length === 0 && !editable ? (
        <span className="text-muted">—</span>
      ) : null}
    </div>
  );
}
