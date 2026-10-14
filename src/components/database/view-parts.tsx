"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createPropertyAction } from "@/server/actions/database";
import { useAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { PropertyType } from "@prisma/client";
import { formatCell, normalizeOptionIds } from "@/lib/database-query";
import { uploadFile } from "@/lib/upload-client";
import { toast } from "sonner";
import { ROLLUP_FUNCTIONS } from "@/lib/rollup";
import { t } from "@/lib/i18n";
import { clampWidth } from "@/lib/column-layout";
import { validateCell } from "@/lib/cell-validation";
import { cellColorFor, type RowColorRule } from "@/lib/row-color-rules";
import { formatUniqueId } from "@/lib/unique-id";
import { formatDateRange, parseDateValue } from "@/lib/date-range";
import { formatGeo, parseGeo } from "@/lib/geo";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OPTION_COLORS, type DBProperty, type DBRow, type HeaderConfig } from "@/components/database/database-types";

export const PROPERTY_TYPES: PropertyType[] = [
  "TEXT",
  "NUMBER",
  "SELECT",
  "MULTI_SELECT",
  "STATUS",
  "DATE",
  "CHECKBOX",
  "URL",
  "EMAIL",
  "PHONE",
  "PEOPLE",
  "FILES",
  "FORMULA",
  "RELATION",
  "ROLLUP",
  "CREATED_TIME",
  "CREATED_BY",
  "LAST_EDITED_TIME",
  "LAST_EDITED_BY",
  "UNIQUE_ID",
  "BUTTON",
  "AI_AUTOFILL",
];

export function PropertyHeader({
  property,
  editable,
  editing,
  setEditing,
  onDelete,
  onRename,
  onDuplicate,
  onEditFormula,
  onSetFormat,
  onEditOptions,
  headerConfig,
  onConfigureButton,
  locale,
  width,
}: {
  property: DBProperty;
  editable: boolean;
  editing: boolean;
  setEditing: (id: string | null) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (p: DBProperty) => void;
  onEditFormula: (p: DBProperty) => void;
  /** NUMBER: switch between number / percent / currency display. */
  onSetFormat: (p: DBProperty, format: string, currency?: string) => void;
  /** SELECT / MULTI_SELECT / STATUS: open the option (name/colour/group) editor. */
  onEditOptions: (p: DBProperty) => void;
  headerConfig: HeaderConfig;
  onConfigureButton: (p: DBProperty) => void;
  locale: string;
  /** Optional saved column width; clamped to the layout bounds when present. */
  width?: number;
}) {
  const isPrimary = Boolean(property.config?.primary);
  const currentFormat = property.config?.format ?? "";
  // Widen to `string` once so a type the generated enum may not list yet
  // (e.g. PLACE) can still reach its editor without a cast at every check.
  const typeCode: string = property.type;
  // Selecting…/multi/status configure options; DATE / UNIQUE_ID / PLACE
  // configure their engine settings through the same dialog.
  const hasOptionsEditor =
    typeCode === "SELECT" ||
    typeCode === "MULTI_SELECT" ||
    typeCode === "STATUS" ||
    typeCode === "DATE" ||
    typeCode === "UNIQUE_ID" ||
    typeCode === "PLACE";
  // Single shared clamp so the header agrees with `setColumnWidth`/`autoFitWidths`.
  const widthStyle = width === undefined ? undefined : { width: clampWidth(width) };
  if (editing) {
    return (
      <input
        autoFocus
        aria-label={t(locale, "propertyName")}
        defaultValue={property.name}
        onBlur={(e) => onRename(property.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(null);
        }}
        style={widthStyle}
        className="w-full bg-transparent text-xs outline-none"
      />
    );
  }
  return (
    <span className="group/head inline-flex items-center gap-2" style={widthStyle}>
      <span className="text-muted">{icon(property.type)}</span>
      <span className="truncate">{property.name}</span>
      {editable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "propertyOptionsAria")}
              className="opacity-0 group-hover/head:opacity-100"
            >
              <span className="text-muted">⌄</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setEditing(property.id)}>
              {t(locale, "rename")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDuplicate(property)}>
              {t(locale, "duplicate")}
            </DropdownMenuItem>
            {(property.type === "NUMBER" || property.type === "DATE") && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="format-trigger">
                  {t(locale, "formatLabel")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {property.type === "NUMBER" ? (
                    <>
                      <DropdownMenuItem
                        data-testid="format-number"
                        onSelect={() => onSetFormat(property, "number")}
                      >
                        {t(locale, "numberWord")}
                        {currentFormat === "number" || currentFormat === "" ? " ✓" : ""}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        data-testid="format-percent"
                        onSelect={() => onSetFormat(property, "percent")}
                      >
                        {t(locale, "percentWord")}
                        {currentFormat === "percent" ? " ✓" : ""}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        data-testid="format-currency-usd"
                        onSelect={() => onSetFormat(property, "currency", "USD")}
                      >
                        {t(locale, "currencyUsd")}
                        {currentFormat === "currency" &&
                        property.config?.currency !== "EUR"
                          ? " ✓"
                          : ""}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        data-testid="format-currency-eur"
                        onSelect={() => onSetFormat(property, "currency", "EUR")}
                      >
                        {t(locale, "currencyEur")}
                        {currentFormat === "currency" &&
                        property.config?.currency === "EUR"
                          ? " ✓"
                          : ""}
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <>
                      <DropdownMenuItem
                        data-testid="format-date-iso"
                        onSelect={() => onSetFormat(property, "date")}
                      >
                        {t(locale, "dateStyleIso")}
                        {currentFormat !== "friendly" ? " ✓" : ""}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        data-testid="format-date-friendly"
                        onSelect={() => onSetFormat(property, "friendly")}
                      >
                        {t(locale, "dateStyleFriendly")}
                        {currentFormat === "friendly" ? " ✓" : ""}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {hasOptionsEditor && (
              <DropdownMenuItem
                data-testid="edit-options"
                onSelect={() => onEditOptions(property)}
              >
                {t(locale, "editOptions")}
              </DropdownMenuItem>
            )}
            {property.type === "FORMULA" && (
              <DropdownMenuItem onSelect={() => onEditFormula(property)}>
                {t(locale, "editFormula")}
              </DropdownMenuItem>
            )}
            {property.type === "RELATION" && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{t(locale, "linkToDatabase")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {headerConfig.databases.length === 0 ? (
                    <DropdownMenuItem disabled>{t(locale, "noOtherDatabases")}</DropdownMenuItem>
                  ) : (
                    headerConfig.databases.map((database) => (
                      <DropdownMenuItem
                        key={database.id}
                        onSelect={() => headerConfig.onLinkDatabase(property, database.id)}
                      >
                        {database.icon ?? "🗂️"} {database.title || t(locale, "untitled")}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {property.type === "ROLLUP" && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{t(locale, "rollupFrom")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {headerConfig.relations.length === 0 ? (
                    <DropdownMenuItem disabled>{t(locale, "addRelationFirst")}</DropdownMenuItem>
                  ) : (
                    headerConfig.relations.map((relation) => (
                      <DropdownMenuSub key={relation.id}>
                        <DropdownMenuSubTrigger>{relation.name}</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {(headerConfig.relationData[relation.id]?.properties ?? []).map(
                            (target) => (
                              <DropdownMenuSub key={target.id}>
                                <DropdownMenuSubTrigger>{target.name}</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  {ROLLUP_FUNCTIONS.map((fn) => (
                                    <DropdownMenuItem
                                      key={fn.id}
                                      onSelect={() =>
                                        headerConfig.onConfigureRollup(property, {
                                          relationPropertyId: relation.id,
                                          targetPropertyId: target.id,
                                          function: fn.id,
                                        })
                                      }
                                    >
                                      {fn.label}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                            ),
                          )}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {property.type === "BUTTON" && (
              <DropdownMenuItem onSelect={() => onConfigureButton(property)}>
                {t(locale, "configureButton")}
              </DropdownMenuItem>
            )}
            {!isPrimary && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onDelete(property.id)}>
                  <Trash2 className="h-4 w-4 text-muted" /> {t(locale, "deleteProperty")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

/**
 * The first positive integer carried by a stored UNIQUE_ID cell value, or
 * `null` when it holds no counter. Accepts a number or a digits-only string so
 * a value written as `{ number: 42 }`, `{ value: 42 }` or `{ text: "42" }`
 * all format the same way.
 */
function uniqueIdNumber(value: unknown): number | null {
  const v = (value ?? {}) as Record<string, unknown>;
  for (const candidate of [v.number, v.value, v.text, v.id]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1) {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
      const parsed = Number(candidate.trim());
      if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
    }
  }
  return null;
}

export function Cell({
  property,
  value,
  computed,
  relationOptions,
  peopleOptions,
  workspaceId,
  onRunButton,
  onRunAi,
  editable,
  onChange,
  locale,
  colorRules,
  row,
  properties,
}: {
  property: DBProperty;
  value: unknown;
  computed?: string;
  relationOptions?: { id: string; title: string; icon: string | null }[];
  /** Workspace members offered by the PEOPLE picker. */
  peopleOptions?: { id: string; name: string }[];
  /** Needed by the FILES attach flow (the upload API requires it). */
  workspaceId?: string;
  onRunButton?: () => void;
  onRunAi?: () => void;
  editable: boolean;
  onChange: (value: unknown) => void;
  locale: string;
  /**
   * Conditional-formatting rules. Only `target: "cell"` rules that paint this
   * property tint the cell; omitted by default, so nothing changes for callers
   * that do not wire rules yet.
   */
  colorRules?: RowColorRule[];
  /** Full row + schema, used to evaluate colour-rule conditions on other cells. */
  row?: DBRow;
  properties?: DBProperty[];
}) {
  const v = (value ?? {}) as Record<string, unknown>;
  // Formatted cells (percent/currency/friendly date) render as text and swap
  // to an editor on click; both hooks live at the top so the switch below can
  // never violate the rules of hooks.
  const [editingNumber, setEditingNumber] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  // PEOPLE keeps a local draft so two quick picks can't overwrite each other
  // from stale server props (the echo from the server lands after both clicks).
  const [peopleDraft, setPeopleDraft] = useState<string[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const readOnly = (node: React.ReactNode) => (
    <span className="text-muted">{node}</span>
  );
  const numberFormat = property.config?.format;
  const dateFormatted = property.config?.format === "friendly";
  // Widened once so the switch can reach types the generated enum may not list
  // yet (PLACE) without a cast on every case.
  const typeCode: string = property.type;

  // Inline, non-blocking validation: any failure shows a red ring plus the
  // engine's message (as `title`), never an alert or a prevented edit.
  const validation = validateCell(property, value);
  const errorMessage = validation.ok
    ? ""
    : validation.errors.map((error) => error.message).join(" ");
  // Cell-targeted colour rules. Without a rule set (the default) this is a
  // no-op; the caller may pass the surrounding row/schema so conditions on
  // other properties can be evaluated, else the cell validates against itself.
  const activeColorRules = colorRules ?? [];
  const cellBackground = (() => {
    if (activeColorRules.length === 0) return undefined;
    const queryRow = row ?? {
      id: "",
      title: "",
      icon: null,
      propertyValues: [{ propertyId: property.id, value }],
    };
    const resolved = cellColorFor(
      activeColorRules,
      queryRow,
      property.id,
      properties ?? [property],
    );
    if (!resolved.backgroundColor) return undefined;
    const hex = OPTION_COLORS[resolved.backgroundColor] ?? "#8a8a85";
    return `${hex}22`;
  })();

  const commitNumber = (raw: string) => {
    if (raw.trim() === "") {
      onChange(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    // Percent edits are entered as the displayed percentage (7.5) but stored
    // as the fraction (0.075), like the product.
    onChange({ number: numberFormat === "percent" ? n / 100 : n });
  };

  const attachFile = (file: File) => {
    if (!workspaceId) return;
    uploadFile(file, workspaceId)
      .then((asset) =>
        onChange({
          files: [
            ...(((v.files as { name: string; url: string; mimeType?: string }[]) ?? []).filter(
              (entry) => entry && typeof entry.name === "string",
            ) as { name: string; url: string; mimeType?: string }[]),
            { name: asset.name, url: asset.url, mimeType: asset.mimeType },
          ],
        }),
      )
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : t(locale, "somethingWentWrong")),
      );
  };

  const content = (() => {
  switch (typeCode) {
    case "NUMBER": {
      const raw = typeof v.number === "number" ? v.number : null;
      const formatted =
        numberFormat === "percent" || numberFormat === "currency";
      if (formatted) {
        const text = formatCell(value, property);
        if (!editable) {
          return (
            <span aria-label={property.name} className="text-muted">
              {text || "—"}
            </span>
          );
        }
        if (editingNumber) {
          return (
            <input
              autoFocus
              type="number"
              step="any"
              aria-label={property.name}
              // Percent shows the percentage (7.5), not the stored fraction.
              defaultValue={
                raw === null
                  ? ""
                  : String(
                      numberFormat === "percent"
                        ? Math.round(raw * 1e6) / 1e6
                        : raw,
                    )
              }
              onBlur={(e) => {
                commitNumber(e.target.value);
                setEditingNumber(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditingNumber(false);
              }}
              className="w-24 bg-transparent outline-none"
            />
          );
        }
        return (
          <button
            type="button"
            aria-label={property.name}
            onClick={() => setEditingNumber(true)}
            className="w-full rounded px-1 py-0.5 text-left hover:bg-surface-2"
          >
            {text || <span className="text-muted">—</span>}
          </button>
        );
      }
      return (
        <input
          type="number"
          aria-label={property.name}
          defaultValue={(v.number as number) ?? ""}
          readOnly={!editable}
          onBlur={(e) =>
            onChange(
              e.target.value === "" ? null : { number: Number(e.target.value) },
            )
          }
          className="w-24 bg-transparent outline-none"
        />
      );
    }
    case "CHECKBOX":
      return (
        <input
          type="checkbox"
          aria-label={property.name}
          checked={Boolean(v.checked)}
          disabled={!editable}
          onChange={(e) => onChange({ checked: e.target.checked })}
          className="accent-[var(--accent)]"
        />
      );
    case "DATE": {
      const dateConfig = property.config?.date;
      // Without a DATE config the single-date editor is byte-for-byte the
      // original: existing properties (and every other caller) are unchanged.
      if (!dateConfig) {
        if (dateFormatted) {
          const text = formatCell(value, property);
          if (!editable) {
            return (
              <span aria-label={property.name} className="text-muted">
                {text || "—"}
              </span>
            );
          }
          if (editingDate) {
            return (
              <input
                autoFocus
                type="date"
                aria-label={property.name}
                defaultValue={typeof v.start === "string" ? v.start.slice(0, 10) : ""}
                onChange={(e) => {
                  if (e.target.value) onChange({ start: e.target.value });
                }}
                onBlur={() => setEditingDate(false)}
                className="bg-transparent outline-none"
              />
            );
          }
          return (
            <button
              type="button"
              aria-label={property.name}
              onClick={() => setEditingDate(true)}
              className="w-full rounded px-1 py-0.5 text-left hover:bg-surface-2"
            >
              {text || <span className="text-muted">—</span>}
            </button>
          );
        }
        return (
          <input
            type="date"
            aria-label={property.name}
            defaultValue={typeof v.start === "string" ? v.start.slice(0, 10) : ""}
            readOnly={!editable}
            onChange={(e) => onChange({ start: e.target.value })}
            className="bg-transparent outline-none"
          />
        );
      }

      // Range/all-day aware editor driven by `@/lib/date-range`: the stored
      // value is normalised with `parseDateValue` so display agrees with the
      // engine, and `allDay`/`timeZone` defaults come from the property config.
      const parsedRange = parseDateValue(value);
      const rangeValue = parsedRange.ok ? parsedRange.value : null;
      const startText = typeof v.start === "string" ? v.start : "";
      const endText = typeof v.end === "string" ? v.end : "";
      const allDayValue =
        typeof v.allDay === "boolean" ? v.allDay : dateConfig.allDay ?? true;
      const hasRange =
        rangeValue !== null &&
        typeof rangeValue.end === "string" &&
        rangeValue.end !== rangeValue.start;
      const label =
        rangeValue && hasRange
          ? formatDateRange(rangeValue)
          : formatCell(value, property);
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
          <span aria-label={property.name} className="text-muted">
            {label || "—"}
          </span>
        );
      }
      if (editingDate) {
        return (
          <div className="flex flex-col gap-1" role="group" aria-label={property.name}>
            <div className="flex items-center gap-1">
              <input
                autoFocus
                type="date"
                aria-label={property.name}
                defaultValue={startText.slice(0, 10)}
                onChange={(e) => commitDate({ start: e.target.value })}
                className="bg-transparent outline-none"
              />
              {dateConfig.allowRange && (
                <>
                  <span className="text-muted">–</span>
                  <input
                    type="date"
                    aria-label={`${property.name} end`}
                    defaultValue={endText.slice(0, 10)}
                    onChange={(e) => commitDate({ end: e.target.value })}
                    className="bg-transparent outline-none"
                  />
                </>
              )}
            </div>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                aria-label={t(locale, "allDayWord")}
                checked={allDayValue}
                onChange={(e) => commitDate({ allDay: e.target.checked })}
                className="accent-[var(--accent)]"
              />
              {t(locale, "allDayWord")}
            </label>
            <button
              type="button"
              onClick={() => setEditingDate(false)}
              className="self-start text-xs text-accent hover:underline"
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
          onClick={() => setEditingDate(true)}
          className="w-full rounded px-1 py-0.5 text-left hover:bg-surface-2"
        >
          {label || <span className="text-muted">—</span>}
        </button>
      );
    }
    case "SELECT":
    case "STATUS": {
      const options = property.config?.options ?? [];
      const current = options.find((o) => o.id === v.optionId);
      return (
        <div className="flex items-center gap-1">
          {current && (
            <span
              data-testid="option-chip"
              className="rounded px-1.5 py-0.5 text-xs"
              style={{
                backgroundColor: `${OPTION_COLORS[current.color] ?? "#8a8a85"}22`,
                color: OPTION_COLORS[current.color] ?? "#8a8a85",
              }}
            >
              {current.name}
            </span>
          )}
          {editable && (
            <select
              aria-label={property.name}
              value={(v.optionId as string) ?? ""}
              onChange={(e) =>
                onChange(e.target.value ? { optionId: e.target.value } : null)
              }
              className="max-w-[110px] bg-transparent text-xs text-muted outline-none"
            >
              <option value="">—</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    }
    case "MULTI_SELECT": {
      const options = property.config?.options ?? [];
      // Normalised read (dedup, unknown ids dropped): a stored value can never
      // render twice or out of order, and the next toggle re-saves it clean.
      const selected = normalizeOptionIds(v.optionIds, options);
      return (
        <div className="flex flex-wrap gap-1">
          {options.map((o) => {
            const active = selected.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                disabled={!editable}
                onClick={() =>
                  onChange({
                    optionIds: active
                      ? selected.filter((id) => id !== o.id)
                      : [...selected, o.id],
                  })
                }
                className={cn(
                  "rounded px-1.5 py-0.5 text-xs",
                  active ? "text-white" : "text-muted",
                )}
                style={{
                  backgroundColor: active
                    ? OPTION_COLORS[o.color] ?? "#8a8a85"
                    : "transparent",
                  border: "1px solid var(--border)",
                }}
              >
                {o.name}
              </button>
            );
          })}
          {options.length === 0 && readOnly("—")}
        </div>
      );
    }
    case "PEOPLE": {
      const valueNames = Array.from(
        new Set(
          ((v.names as string[]) ?? []).filter(
            (entry): entry is string => typeof entry === "string" && entry !== "",
          ),
        ),
      );
      // The local draft wins until the component remounts: the server echo of
      // the first pick would otherwise be stale when the second pick is made.
      const names = peopleDraft ?? valueNames;
      const emit = (next: string[]) => {
        setPeopleDraft(next);
        onChange({ names: next });
      };
      const members = peopleOptions ?? [];
      return (
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={property.name}
        >
          {names.map((name) => (
            <span
              key={name}
              className="flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs"
            >
              {name}
              {editable && (
                <button
                  type="button"
                  aria-label={`${t(locale, "remove")}: ${name}`}
                  onClick={() => emit(names.filter((n) => n !== name))}
                  className="text-muted hover:text-fg"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t(locale, "addPersonAria")}
                  className="rounded px-1 text-xs text-muted hover:bg-surface-2"
                >
                  +
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {members.length === 0 ? (
                  <DropdownMenuItem disabled>{t(locale, "noMembersYet")}</DropdownMenuItem>
                ) : (
                  members.map((member) => {
                    const active = names.includes(member.name);
                    return (
                      <DropdownMenuItem
                        key={member.id}
                        onSelect={() =>
                          emit(
                            active
                              ? names.filter((n) => n !== member.name)
                              : [...names, member.name],
                          )
                        }
                      >
                        {active ? "✓ " : ""}
                        {member.name}
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {names.length === 0 && !editable && readOnly("—")}
        </div>
      );
    }
    case "FORMULA":
      return readOnly(computed && computed.length > 0 ? computed : "—");
    case "ROLLUP":
      return readOnly("—");
    case "CREATED_TIME":
    case "LAST_EDITED_TIME":
    case "CREATED_BY":
    case "LAST_EDITED_BY":
      // Read-only, but addressable: the row UI must be assertable for
      // created/last-edited surfacing (and screen readers get the name too).
      return (
        <span aria-label={property.name} className="text-muted">
          {computed && computed.length > 0 ? computed : "—"}
        </span>
      );
    case "UNIQUE_ID": {
      // Read-only, derived display: format the stored counter with the
      // property's Unique ID config (`@/lib/unique-id`). With no config (or no
      // numeric id) it falls back to the caller-computed value, so existing
      // rows render exactly as before.
      const number = uniqueIdNumber(value);
      const uniqueId = property.config?.uniqueId;
      if (number !== null && uniqueId) {
        let text = computed ?? "";
        try {
          text = formatUniqueId({ prefix: "", ...uniqueId }, number);
        } catch {
          text = computed ?? "";
        }
        return (
          <span aria-label={property.name} className="text-muted">
            {text || "—"}
          </span>
        );
      }
      return (
        <span aria-label={property.name} className="text-muted">
          {computed && computed.length > 0 ? computed : "—"}
        </span>
      );
    }
    case "PLACE": {
      // Guarded because PLACE may not be in the generated `PropertyType` enum
      // yet: a `{ lat, lng }` object or a `"lat, lng"` string renders
      // read-only; anything unparseable stays blank.
      const place = parseGeo(value);
      if (!place.ok) {
        return (
          <span aria-label={property.name} className="text-muted">
            —
          </span>
        );
      }
      return (
        <span aria-label={property.name} className="text-muted">
          {place.value.label ? `${place.value.label} · ` : ""}
          {formatGeo(place.value)}
        </span>
      );
    }
    case "RELATION": {
      const options = relationOptions ?? [];
      const selected = (v.pageIds as string[]) ?? [];
      return (
        <div className="flex flex-wrap items-center gap-1">
          {selected.map((id) => {
            const option = options.find((candidate) => candidate.id === id);
            return option ? (
              <span
                key={id}
                className="rounded bg-surface-2 px-1.5 py-0.5 text-xs"
              >
                {option.icon ?? "📄"} {option.title || t(locale, "untitled")}
              </span>
            ) : null;
          })}
          {editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t(locale, "addRelationAria")}
                  className="rounded px-1 text-xs text-muted hover:bg-surface-2"
                >
                  +
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {options.length === 0 ? (
                  <DropdownMenuItem disabled>{t(locale, "noRelatedRows")}</DropdownMenuItem>
                ) : (
                  options.map((option) => (
                    <DropdownMenuItem
                      key={option.id}
                      onSelect={() =>
                        onChange({
                          pageIds: selected.includes(option.id)
                            ? selected.filter((id) => id !== option.id)
                            : [...selected, option.id],
                        })
                      }
                    >
                      {selected.includes(option.id) ? "✓ " : ""}
                      {option.icon ?? "📄"} {option.title || t(locale, "untitled")}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {selected.length === 0 && !editable && readOnly("—")}
        </div>
      );
    }
    case "BUTTON":
      return editable && onRunButton ? (
        <button
          type="button"
          onClick={onRunButton}
          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
        >
          {t(locale, "runWord")}
        </button>
      ) : (
        readOnly("—")
      );
    case "AI_AUTOFILL":
      return editable && onRunAi ? (
        <button
          type="button"
          onClick={onRunAi}
          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
        >
          {t(locale, "autofillWord")}
        </button>
      ) : (
        readOnly(formatCell(value, property) || "—")
      );
    case "FILES": {
      const files = (((v.files as { name: string; url: string; mimeType?: string }[]) ??
        []) as { name: string; url: string; mimeType?: string }[]).filter(
        (entry) => entry && typeof entry.name === "string",
      );
      return (
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={property.name}
        >
          {files.map((entry, index) => (
            <a
              key={`${entry.url}-${index}`}
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              className="max-w-[10rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs underline-offset-2 hover:underline"
            >
              {entry.name}
            </a>
          ))}
          {editable && (
            <>
              <button
                type="button"
                aria-label={t(locale, "attachFile")}
                onClick={() => fileInputRef.current?.click()}
                className="rounded px-1 text-xs text-muted hover:bg-surface-2"
              >
                +
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                data-testid="property-files-input"
                aria-label={`${t(locale, "attachFile")}: ${property.name}`}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) attachFile(file);
                }}
              />
            </>
          )}
          {files.length === 0 && !editable && readOnly("—")}
        </div>
      );
    }
    default:
      return (
        <input
          aria-label={property.name}
          defaultValue={(v.text as string) ?? ""}
          readOnly={!editable}
          placeholder="—"
          onBlur={(e) =>
            onChange(e.target.value ? { text: e.target.value } : null)
          }
          className="w-full bg-transparent outline-none placeholder:text-muted"
        />
      );
  }
  })();
  // Valid + uncoloured → the exact node each case always returned. Any error or
  // resolved colour wraps it so the common path is byte-for-byte unchanged.
  if (errorMessage === "" && cellBackground === undefined) return content;
  return (
    <div
      data-invalid={errorMessage !== "" ? "true" : undefined}
      title={errorMessage !== "" ? errorMessage : undefined}
      style={cellBackground ? { backgroundColor: cellBackground } : undefined}
      className={cn("rounded", errorMessage !== "" && "ring-1 ring-red-500/70")}
    >
      {content}
    </div>
  );
}

export function AddPropertyForm({
  databasePageId,
  onClose,
  locale,
}: {
  databasePageId: string;
  onClose: () => void;
  locale: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("TEXT");
  const { pending, run } = useAction(locale);

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <label className="text-xs text-muted" htmlFor="prop-name">
          {t(locale, "propertyName")}
        </label>
        <input
          id="prop-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 w-44 rounded border border-border bg-bg px-2 text-sm outline-none"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted" htmlFor="prop-type">
          {t(locale, "typeLabel")}
        </label>
        <select
          id="prop-type"
          value={type}
          onChange={(e) => setType(e.target.value as PropertyType)}
          className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none"
        >
          {PROPERTY_TYPES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={pending || !name.trim()}
        onClick={() =>
          run(async () => createPropertyAction(databasePageId, name, type), {
            // Close only when the server accepted the property: a refused
            // action surfaces its error instead of pretending it worked.
            onSuccess: () => {
              setName("");
              onClose();
              router.refresh();
            },
          })
        }
        className="h-9 rounded bg-accent px-4 text-sm text-accent-fg disabled:opacity-50"
      >
        {t(locale, "add")}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="h-9 rounded px-3 text-sm text-muted hover:bg-surface-2"
      >
        {t(locale, "cancel")}
      </button>
    </div>
  );
}

export function icon(type: PropertyType): string {
  switch (type) {
    case "NUMBER":
      return "#";
    case "SELECT":
    case "STATUS":
      return "◉";
    case "MULTI_SELECT":
      return "≣";
    case "DATE":
      return "📅";
    case "CHECKBOX":
      return "☑";
    case "PEOPLE":
      return "👤";
    case "URL":
      return "🔗";
    case "EMAIL":
      return "@";
    case "PHONE":
      return "☎";
    case "FORMULA":
      return "ƒ";
    case "RELATION":
      return "↔";
    case "ROLLUP":
      return "Σ";
    case "FILES":
      return "📎";
    default:
      return "Aa";
  }
}

/* ---------------------------------------------------------------------------
   Gallery view
   --------------------------------------------------------------------------- */
