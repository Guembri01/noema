"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Ban,
  CalendarClock,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  History,
  LayoutTemplate,
  Lock,
  Plus,
  Trash2,
  Unlock,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { deleteTemplateAction } from "@/server/actions/database";
import { cn } from "@/lib/utils";
import { formatTemplateNextRun, isTemplateRecurrence } from "@/lib/template-schedule";
import {
  TemplateScheduleDialog,
} from "@/components/database/template-schedule-dialog";

import { t } from "@/lib/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The template shape the action row needs; the screen's richer type fits. */
export type ActionTemplate = {
  id: string;
  name: string;
  icon: string | null;
  recurrence?: string | null;
  nextRunAt?: string | Date | null;
  lastRunAt?: string | Date | null;
  paused?: boolean;
  isDefault?: boolean;
};

/**
 * The schedule chip rendered in the template submenu (R89.17): the next run
 * when active, "Paused" when a schedule is paused, and nothing for a manual
 * template. Exported so the UI wiring is unit-testable without a DOM.
 */
export function templateScheduleMenuStatus(
  template: Pick<ActionTemplate, "recurrence" | "nextRunAt" | "paused">,
  locale: string,
): string | null {
  if (!isTemplateRecurrence(template.recurrence)) return null;
  if (template.paused) return t(locale, "templatePaused");
  return formatTemplateNextRun(template.nextRunAt, locale) ?? template.recurrence;
}

/**
 * The database's row/schema action row.
 *
 * It owns the controls that act on the whole view — sub-item nesting, lock,
 * new row, templates, deleted rows, schema actions, CSV import/export — while
 * the screen owns the mutations themselves. The template submenu's recurrence
 * and delete calls refresh the server component directly, so the screen only
 * passes the template list and its row-creation callback.
 */
export function DatabaseActions({
  locale,
  editable,
  nestSubItems,
  onToggleNest,
  blockedRowCount,
  canToggleLock,
  lockLabel,
  schemaLockedState,
  showReadOnlyLock,
  onToggleLock,
  onAddRow,
  defaultTemplateName,
  templates,
  onAddRowFromTemplate,
  onToggleDeletedRows,
  onNewProperty,
  onDuplicateDatabase,
  databasePageId,
  onImportCsv,
}: {
  locale: string;
  editable: boolean;
  nestSubItems: boolean;
  onToggleNest: () => void;
  blockedRowCount: number;
  canToggleLock: boolean;
  lockLabel: string;
  schemaLockedState: boolean;
  showReadOnlyLock: boolean;
  onToggleLock: () => void;
  onAddRow: () => void;
  defaultTemplateName: string | null;
  templates: ActionTemplate[];
  onAddRowFromTemplate: (template: ActionTemplate) => void;
  onToggleDeletedRows: () => void;
  onNewProperty: () => void;
  onDuplicateDatabase: () => void;
  databasePageId: string;
  onImportCsv: (text: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const csvInputRef = useRef<HTMLInputElement | null>(null);
  /** The template whose schedule editor is open (R89.17/R31.22). */
  const [scheduleTemplateId, setScheduleTemplateId] = useState<string | null>(null);
  const scheduleTemplate =
    templates.find((template) => template.id === scheduleTemplateId) ?? null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {/* R89.30 — sub-items nesting toggle. A pure view preference, so it
          is offered to every viewer, not just editors. */}
      <button
        type="button"
        aria-pressed={nestSubItems}
        aria-label={t(locale, "subticketsHeading")}
        title={t(locale, "breadcrumbHint")}
        onClick={onToggleNest}
        className={cn(
          "focus-ring u-colors flex items-center gap-1 rounded-control px-2 py-1 text-sm text-muted hover:bg-surface-2",
          nestSubItems && "bg-surface-2 text-fg",
        )}
      >
        <ChevronRight
          className={cn("h-4 w-4 transition-transform", nestSubItems && "rotate-90")}
        />
        {t(locale, "subticketsHeading")}
      </button>
      {/* R89.31 — how many rows this view has blocked. Only shown once the
          caller supplies dependency edges. */}
      {blockedRowCount > 0 && (
        <span
          className="flex items-center gap-1 rounded-chip px-2 py-1 text-sm text-muted"
          title={t(locale, "relationBlockedBy")}
        >
          <Ban className="h-4 w-4" />
          {blockedRowCount} {t(locale, "relationBlockedBy")}
        </span>
      )}
      {/* R89.24 — database lock. An `editSchema` holder gets the interactive
          toggle wired to `toggleSchemaLockAction` (unlock stays reachable
          because it is the same control); everyone else keeps the engine's
          canonical read-only summary, which also covers the per-property
          lock (`describeLock` renders both). */}
      {canToggleLock ? (
        <button
          type="button"
          aria-pressed={schemaLockedState}
          aria-label={lockLabel}
          title={lockLabel}
          onClick={onToggleLock}
          className={cn(
            "focus-ring u-colors flex items-center gap-1 rounded-control px-2 py-1 text-sm text-muted hover:bg-surface-2",
            schemaLockedState && "bg-surface-2 text-fg",
          )}
        >
          {schemaLockedState ? (
            <Unlock className="h-4 w-4" />
          ) : (
            <Lock className="h-4 w-4" />
          )}
          {lockLabel}
        </button>
      ) : (
        showReadOnlyLock && (
          <span
            className="flex items-center gap-1 rounded-chip px-2 py-1 text-sm text-muted"
            title={lockLabel}
            aria-label={lockLabel}
          >
            <Lock className="h-4 w-4" />
            {lockLabel}
          </span>
        )
      )}
      {editable && (
        <button
          type="button"
          onClick={onAddRow}
          aria-label={t(locale, "newRow")}
          title={
            defaultTemplateName ? `${t(locale, "newRow")} — ${defaultTemplateName}` : undefined
          }
          className="focus-ring u-colors flex items-center gap-1 rounded-control bg-action px-2.5 py-1 text-sm text-action-fg hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t(locale, "newRow")}
        </button>
      )}
      {editable && templates.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "chooseTemplate")}
              className="focus-ring u-colors flex items-center gap-1 rounded-control px-2 py-1 text-sm text-muted hover:bg-surface-2"
            >
              <LayoutTemplate className="h-4 w-4" />
              {t(locale, "templates")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {templates.map((template) => {
              const scheduled = isTemplateRecurrence(template.recurrence);
              const scheduleStatus = templateScheduleMenuStatus(template, locale);
              return (
                <DropdownMenuSub key={template.id}>
                  <DropdownMenuSubTrigger>
                    <span>{template.icon ?? "📄"}</span>
                    <span className="flex-1 truncate">{template.name}</span>
                    {template.isDefault && (
                      <span aria-hidden title={t(locale, "templates")}>
                        ★
                      </span>
                    )}
                    {scheduled && (
                      <span
                        className="text-3xs text-muted"
                        data-testid={`template-schedule-status-${template.id}`}
                      >
                        {scheduleStatus}
                      </span>
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onSelect={() => onAddRowFromTemplate(template)}>
                      {t(locale, "newRow")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={`template-schedule-open-${template.id}`}
                      onSelect={() => setScheduleTemplateId(template.id)}
                    >
                      <CalendarClock className="h-4 w-4 text-muted" />
                      {t(locale, "templateSchedule")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-danger"
                      onSelect={() =>
                        startTransition(async () => {
                          const result = await deleteTemplateAction(template.id);

                          if ("error" in result) toast.error(result.error);
                          else toast.success(`${t(locale, "deletedPrefix")} “${template.name}”`);
                          router.refresh();
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4 text-muted" /> {t(locale, "deleteTemplate")}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t(locale, "moreActions")}
            title={t(locale, "moreActions")}
            className="focus-ring u-colors flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-surface-2"
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {editable && (
            <DropdownMenuItem onSelect={onToggleDeletedRows}>
              <History className="h-4 w-4 text-muted" />
              {t(locale, "dbDeletedRows")}
            </DropdownMenuItem>
          )}
          {editable && (
            <DropdownMenuItem onSelect={onNewProperty}>
              <Plus className="h-4 w-4 text-muted" />
              {t(locale, "newProperty")}
            </DropdownMenuItem>
          )}
          {editable && (
            <DropdownMenuItem onSelect={onDuplicateDatabase}>
              <Copy className="h-4 w-4 text-muted" />
              {t(locale, "duplicate")}
            </DropdownMenuItem>
          )}
          {editable && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onSelect={() => {
              const anchor = document.createElement("a");
              anchor.href = `/api/export/database/${databasePageId}`;
              anchor.download = "";
              anchor.click();
            }}
          >
            <Download className="h-4 w-4 text-muted" />
            {t(locale, "exportCsv")}
          </DropdownMenuItem>
          {editable && (
            <DropdownMenuItem onSelect={() => csvInputRef.current?.click()}>
              <Upload className="h-4 w-4 text-muted" />
              {t(locale, "importCsv")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {editable && (
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            file.text().then(onImportCsv);
          }}
        />
      )}
      <TemplateScheduleDialog
        locale={locale}
        template={scheduleTemplate}
        open={scheduleTemplate !== null}
        onOpenChange={(next) => {
          if (!next) setScheduleTemplateId(null);
        }}
      />
    </div>
  );
}
