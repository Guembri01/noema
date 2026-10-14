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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OPTION_COLORS, type DBProperty, type HeaderConfig } from "@/components/database/database-types";

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
}) {
  const isPrimary = Boolean(property.config?.primary);
  const currentFormat = property.config?.format ?? "";
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
        className="w-full bg-transparent text-xs outline-none"
      />
    );
  }
  return (
    <span className="group/head inline-flex items-center gap-2">
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
            {(property.type === "SELECT" ||
              property.type === "MULTI_SELECT" ||
              property.type === "STATUS") && (
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

  switch (property.type) {
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
    case "UNIQUE_ID":
      // Read-only, but addressable: the row UI must be assertable for
      // created/last-edited surfacing (and screen readers get the name too).
      return (
        <span aria-label={property.name} className="text-muted">
          {computed && computed.length > 0 ? computed : "—"}
        </span>
      );
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
