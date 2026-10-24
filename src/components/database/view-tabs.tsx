"use client";

import { Copy, Ellipsis, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { DBView } from "@/components/database/database-types";

export type ViewTypeName =
  | "TABLE"
  | "BOARD"
  | "LIST"
  | "GALLERY"
  | "CALENDAR"
  | "TIMELINE"
  | "CHART"
  | "FORM";

export const VIEW_TYPES: { type: ViewTypeName; label: string }[] = [
  { type: "TABLE", label: "Table" },
  { type: "BOARD", label: "Board" },
  { type: "LIST", label: "List" },
  { type: "GALLERY", label: "Gallery" },
  { type: "CALENDAR", label: "Calendar" },
  { type: "TIMELINE", label: "Timeline" },
  { type: "CHART", label: "Chart" },
  { type: "FORM", label: "Form" },
];

export function ViewIcon({ type }: { type: string }) {
  const map: Record<string, string> = {
    TABLE: "▦",
    BOARD: "▤",
    LIST: "≣",
    GALLERY: "▧",
    CALENDAR: "▦",
    TIMELINE: "↔",
    CHART: "▥",
    FORM: "▤",
  };
  return <span className="text-xs text-muted">{map[type] ?? "▦"}</span>;
}

/**
 * The database's view strip. Tabs persist per view; the active tab exposes the
 * rename/duplicate/type menu, and the trailing + creates a view. Moved out of
 * the 2.6k-line screen so the screen keeps orchestration and data flow.
 */
export function DatabaseViewTabs({
  views,
  activeView,
  editable,
  locale,
  rowCount,
  onSelect,
  onRename,
  onDuplicate,
  onChangeType,
  onAdd,
}: {
  views: readonly DBView[];
  activeView: DBView;
  editable: boolean;
  locale: string;
  rowCount: number;
  onSelect: (id: string) => void;
  onRename: (view: DBView) => void;
  onDuplicate: (view: DBView) => void;
  onChangeType: (view: DBView, type: ViewTypeName) => void;
  onAdd: (type: ViewTypeName) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-border">
      {views.map((view) => (
        <div key={view.id} className="flex items-center">
          <button
            type="button"
            aria-current={view.id === activeView.id ? "true" : undefined}
            onClick={() => onSelect(view.id)}
            className={cn(
              "focus-ring u-colors flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              view.id === activeView.id
                ? "-mb-px border-fg font-medium text-fg"
                : "border-transparent text-muted hover:text-fg",
            )}
          >
            <ViewIcon type={view.type} />
            {view.name}
          </button>
          {editable && view.id === activeView.id && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t(locale, "dbViewMenu")}
                  title={t(locale, "dbViewMenu")}
                  className="-mb-px flex items-center justify-center rounded-control px-1.5 py-1.5 text-muted hover:bg-surface-2 focus-ring u-colors"
                >
                  <Ellipsis className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => onRename(view)}>
                  {t(locale, "rename")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onDuplicate(view)}>
                  <Copy className="h-4 w-4 text-muted" /> {t(locale, "duplicate")}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{t(locale, "typeLabel")}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {VIEW_TYPES.map((candidate) => (
                      <DropdownMenuItem
                        key={candidate.type}
                        onSelect={() => onChangeType(view, candidate.type)}
                      >
                        <ViewIcon type={candidate.type} />
                        {candidate.label}
                        {view.type === candidate.type ? " ✓" : ""}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}
      {editable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "addViewAria")}
              className="-mb-px ml-1 flex items-center justify-center rounded-control px-2 py-1.5 text-muted hover:bg-surface-2 focus-ring u-colors"
            >
              <Plus className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {VIEW_TYPES.map((type) => (
              <DropdownMenuItem key={type.type} onSelect={() => onAdd(type.type)}>
                <ViewIcon type={type.type} />
                {type.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <span className="ml-auto pr-1 text-xs text-muted">
        {rowCount} {t(locale, "rowsUnit")}
      </span>
    </div>
  );
}
