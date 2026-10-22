"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createPropertyAction } from "@/server/actions/database";
import { useAction } from "@/lib/actions-client";
import { cn, initials } from "@/lib/utils";
import { tagClass, tagStyle, type TagHue } from "@/lib/design-tokens";
import { PropertyType } from "@prisma/client";
import { formatCell, normalizeOptionIds } from "@/lib/database-query";
import { formatNumberValue, type NumberFormatSpec } from "@/lib/number-format";
import { uploadFile } from "@/lib/upload-client";
import { toast } from "sonner";
import { ROLLUP_FUNCTIONS } from "@/lib/rollup";
import { t } from "@/lib/i18n";
import type { ButtonRole } from "@/lib/button-property";
import { clampWidth } from "@/lib/column-layout";
import { maxLineWidth, type CharWidths } from "@/lib/text-measure";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { validateCell } from "@/lib/cell-validation";
import { cellColorFor, type RowColorRule } from "@/lib/row-color-rules";
import {
  describeUniqueId,
  formatUniqueId,
  parseUniqueId,
  type UniqueIdConfig,
} from "@/lib/unique-id";
import { isValidEmail } from "@/lib/email-validation";
import { sanitizeFileUrl, sanitizeHref } from "@/lib/validation";
import { isValidPhone, normalizePhone } from "@/lib/phone-format";
import { classifyLink } from "@/lib/link-check";
import {
  cellDisplay,
  cellToValue,
  toggleCell,
  type CellTone,
  type LegacyVerificationCell,
} from "@/lib/verification-cell";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  avatarHue,
  optionTagHue,
  type DBProperty,
  type DBRow,
  type HeaderConfig,
} from "@/components/database/database-types";
import { ButtonCell } from "@/components/database/button-cell";
import { DateCell } from "@/components/database/date-cell";
import { IconCell } from "@/components/database/icon-cell";
import { PeopleCell } from "@/components/database/people-cell";
import { PlaceCell } from "@/components/database/place-cell";
import { RelationCell } from "@/components/database/relation-cell";
import { StatusCell } from "@/components/database/status-cell";

export { avatarHue, optionTagHue };
export {
  buttonStepUnrunnableReason,
  readRowButton,
  type RowButtonSource,
} from "@/components/database/button-cell";

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
  "PLACE",
  "BUTTON",
  "AI_AUTOFILL",
];

/** Table type size (`text-sm`) used to turn em widths into pixels. */
export const TABLE_FONT_PX = 14;
/** Cell horizontal padding (`px-3` both sides) plus slack for the sort caret. */
export const TABLE_CELL_PADDING_PX = 32;
/** Headers auto-fit against the label only; cap them well under the 800px max. */
const HEADER_AUTO_FIT_MAX = 360;

/* ---------------------------------------------------------------------------
   Cell states, tag palette and keyboard contract (design system, P4)
   --------------------------------------------------------------------------- */

/**
 * Cell types whose value is derived and therefore read-only: they render text,
 * never an editor, so the "editing" visual state never applies to them.
 */
const READ_ONLY_CELL_TYPES: ReadonlySet<string> = new Set([
  "FORMULA",
  "ROLLUP",
  "CREATED_TIME",
  "LAST_EDITED_TIME",
  "CREATED_BY",
  "LAST_EDITED_BY",
  "UNIQUE_ID",
]);

/** True when a cell type can enter the editing state. */
export function isEditableCellType(type: string): boolean {
  return !READ_ONLY_CELL_TYPES.has(type);
}

/** The independent visual states a cell shell can be in. */
export type CellVisualState = {
  hover?: boolean;
  focus?: boolean;
  editing?: boolean;
  invalid?: boolean;
  selected?: boolean;
};

/** The one state a cell shell resolves to once precedence is applied. */
export type CellVisualStateName =
  | "idle"
  | "hover"
  | "focus"
  | "editing"
  | "selected"
  | "invalid";

/**
 * Collapse the independent cell flags into a single state name. Precedence is
 * `invalid` → `editing` → `selected` → `focus` → `hover` → `idle`, so a cell can
 * never carry two competing rings and the most urgent signal always wins.
 * `editing` is ignored for read-only types (they have no editor).
 */
export function cellVisualState(
  type: string,
  state: CellVisualState = {},
): CellVisualStateName {
  if (state.invalid) return "invalid";
  if (isEditableCellType(type) && state.editing) return "editing";
  if (state.selected) return "selected";
  if (state.focus) return "focus";
  if (state.hover) return "hover";
  return "idle";
}

/** The single ring (if any) for a resolved state, always a token colour. */
function cellRingClass(name: CellVisualStateName): string {
  switch (name) {
    case "invalid":
      return "ring-2 ring-danger";
    case "editing":
      return "bg-surface ring-2 ring-accent";
    case "selected":
      return "ring-2 ring-accent";
    case "focus":
      return "ring-2 ring-ring/60";
    default:
      return "";
  }
}

/**
 * State → class mapping for a cell shell.
 *
 * Hover tint and the focus-visible ring are CSS variants, so *every* cell type
 * gets them; the editing/selected/invalid states resolve to exactly one ring
 * through {@link cellVisualState} so specificity can never pick the wrong one.
 * Read-only types ignore the editing state and are not marked `cursor-text`.
 */
export function cellStateClass(type: string, state: CellVisualState = {}): string {
  const name = cellVisualState(type, state);
  const editable = isEditableCellType(type);
  return cn(
    "group/cell relative flex min-w-0 max-w-full items-center rounded-sm u-colors",
    "hover:bg-surface-2/60 focus-within:ring-2 focus-within:ring-ring/60",
    editable && "cursor-text",
    cellRingClass(name),
  );
}

/** What a keydown should do inside a cell editor. */
export type CellKeyOutcome = "commit" | "cancel" | "move" | "none";

/**
 * The cell editor keyboard contract: `Enter` commits (blur), `Escape` cancels
 * the edit, `Tab` commits and lets focus move on, everything else (including the
 * native arrow handling of `<select>`/`<input type=number>`) is left to the
 * control. Pure so the entry/exit rules are provable without a DOM.
 */
export function cellKeyOutcome(key: string): CellKeyOutcome {
  switch (key) {
    case "Enter":
      return "commit";
    case "Escape":
      return "cancel";
    case "Tab":
      return "move";
    default:
      return "none";
  }
}

/**
 * Auto-fit a column width from real text metrics (`@/lib/text-measure`) instead
 * of a guessed average.
 *
 * The widest visible line across `samples` (a header label plus any cell texts)
 * is summed in em by the estimator, scaled by `fontPx`, padded for the cell
 * chrome, then clamped to the shared `@/lib/column-layout` bounds — so an
 * auto-fit column can never disagree with `setColumnWidth` / `autoFitWidths`.
 * Pure and deterministic: `fontPx`/`charWidths` let a caller feed a synthetic
 * font (the node test does) so the measurement → width mapping is provable.
 */
export function autoFitColumnWidth(
  samples: readonly string[],
  options: {
    /** Pixels per em; defaults to {@link TABLE_FONT_PX}. */
    fontPx?: number;
    /** Fixed chrome added to every column; defaults to {@link TABLE_CELL_PADDING_PX}. */
    paddingPx?: number;
    /** Clamp bounds, forwarded to `clampWidth`. */
    min?: number;
    max?: number;
    /** Per-class em overrides, forwarded to the estimator. */
    charWidths?: Partial<CharWidths>;
  } = {},
): number {
  const fontPx =
    typeof options.fontPx === "number" &&
    Number.isFinite(options.fontPx) &&
    options.fontPx > 0
      ? options.fontPx
      : TABLE_FONT_PX;
  const paddingPx =
    typeof options.paddingPx === "number" &&
    Number.isFinite(options.paddingPx) &&
    options.paddingPx >= 0
      ? options.paddingPx
      : TABLE_CELL_PADDING_PX;
  const measureOptions = options.charWidths
    ? { charWidths: options.charWidths }
    : {};

  let widest = 0;
  for (const sample of samples) {
    const width = maxLineWidth(sample, measureOptions);
    if (width > widest) widest = width;
  }
  return clampWidth(widest * fontPx + paddingPx, {
    min: options.min,
    max: options.max,
  });
}

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
  // configure their engine settings through the same dialog; BUTTON opens the
  // Button config editor (feat/q06) so its label/icon/action are reachable here.
  const hasOptionsEditor =
    typeCode === "SELECT" ||
    typeCode === "MULTI_SELECT" ||
    typeCode === "STATUS" ||
    typeCode === "DATE" ||
    typeCode === "UNIQUE_ID" ||
    typeCode === "PLACE" ||
    typeCode === "FORMULA" ||
    typeCode === "BUTTON";
  // With an explicit saved width: the single shared clamp so the header agrees
  // with `setColumnWidth`/`autoFitWidths`. Without one: auto-fit the header to
  // its measured label (`@/lib/text-measure`) rather than leaving it to chance.
  const widthStyle =
    width === undefined
      ? {
          minWidth: autoFitColumnWidth([property.name], { max: HEADER_AUTO_FIT_MAX }),
        }
      : { width: clampWidth(width) };
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
              className="focus-ring u-colors rounded opacity-0 group-hover/head:opacity-100"
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
 * Resolve a stored UNIQUE_ID property config the same way the allocator does
 * (`database.ts` `allocateUniqueIdValue`): a real string prefix is kept, a
 * missing one stays `""` (the engine's `"ID"` default is deliberately not
 * applied, so display and storage can never disagree), and the optional pad /
 * start / separator are carried through for the formatter to sanitise.
 */
function resolveUniqueIdConfig(
  uniqueId: Partial<UniqueIdConfig> | undefined,
): UniqueIdConfig {
  const config = uniqueId ?? {};
  return {
    prefix: typeof config.prefix === "string" ? config.prefix : "",
    ...(typeof config.padding === "number" ? { padding: config.padding } : {}),
    ...(typeof config.zeroPad === "number" ? { zeroPad: config.zeroPad } : {}),
    ...(typeof config.startAt === "number" ? { startAt: config.startAt } : {}),
    ...(typeof config.separator === "string" ? { separator: config.separator } : {}),
  };
}

/**
 * Render a stored UNIQUE_ID cell through the `@/lib/unique-id` engine. The
 * stored counter may be a number (`{ number: 42 }`) or the formatted id
 * (`{ text: "TASK-0042" }`, parsed back with `parseUniqueId`); when neither
 * yields a counter the cell has nothing the engine can format and this returns
 * `null` (the caller then falls back to the derived `computed` value).
 * `describeUniqueId` supplies the human description used as the cell's tooltip,
 * so the config/example the property editor shows and the cell agree.
 */
export function uniqueIdCellText(
  value: unknown,
  uniqueId: Partial<UniqueIdConfig> | undefined,
): { text: string; description: string } | null {
  const config = resolveUniqueIdConfig(uniqueId);
  const record = (value ?? {}) as Record<string, unknown>;
  let number: number | null = null;
  if (
    typeof record.number === "number" &&
    Number.isInteger(record.number) &&
    record.number >= 1
  ) {
    number = record.number;
  } else {
    for (const key of ["text", "value", "id"] as const) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        const parsed = parseUniqueId(candidate, config);
        if (parsed.ok) {
          number = parsed.number;
          break;
        }
      }
    }
  }
  if (number === null) return null;
  return {
    text: formatUniqueId(number, config),
    description: describeUniqueId(config),
  };
}

/** Editable draft for a PLACE cell: the three raw input strings. */
/**
 * Read the optional NUMBER `numberFormat` spec off a property config, or
 * `undefined` when the property predates the number-format engine. The shared
 * `DBProperty` config type is closed and read-only here, so the key is read
 * defensively; the formatter re-validates it, so untrusted stored JSON degrades
 * safely.
 */
function readNumberFormat(property: DBProperty): NumberFormatSpec | undefined {
  const config = property.config;
  if (!config || !("numberFormat" in config)) return undefined;
  return (config as { numberFormat?: NumberFormatSpec }).numberFormat;
}

/**
 * Engine-backed validation for the "typed text" property types, evaluated on
 * the committed value so the affordance clears itself as soon as a valid edit
 * lands. EMAIL delegates to `isValidEmail` (`@/lib/email-validation`), PHONE to
 * `isValidPhone` (`@/lib/phone-format`) and URL rejects the `"unsafe"` /
 * `"invalid"` classifications from `classifyLink` (`@/lib/link-check`); a
 * relative path or anchor stays a valid page/email/tel link. TEXT and any other
 * default-case type have no such rule and never report. Returns an English
 * message (the same convention as `@/lib/cell-validation`) or `""`.
 */
function typedValueError(type: string, value: unknown): string {
  const text =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).text
      : undefined;
  if (typeof text !== "string" || text.trim() === "") return "";
  switch (type) {
    case "EMAIL":
      return isValidEmail(text) ? "" : "Enter a valid email address.";
    case "PHONE":
      return isValidPhone(text) ? "" : "Enter a valid phone number.";
    case "URL": {
      const kind = classifyLink(text);
      return kind === "unsafe" || kind === "invalid"
        ? "Enter a safe, well-formed link."
        : "";
    }
    default:
      return "";
  }
}

/**
 * The VERIFICATION chip as the engine sees it: the `@/lib/verification-cell`
 * `cellDisplay` label + tone. A legacy `verifiedByName` alias is only a display
 * name (the engine's canonical value drops it), so it travels through the
 * `actorName` option rather than the value itself.
 */
export function verificationCellView(
  value: unknown,
  actorName?: string,
): { label: string; tone: CellTone; verified: boolean } {
  // A legacy `verifiedByName` is only a display name (the canonical value drops
  // it), so it is lifted here and passed through the engine's `actorName`.
  const legacyName =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).verifiedByName
      : undefined;
  const name =
    actorName && actorName.trim() !== ""
      ? actorName
      : typeof legacyName === "string" && legacyName !== ""
        ? legacyName
        : undefined;
  return cellDisplay(value, name ? { actorName: name } : {});
}

/**
 * Flip a stored VERIFICATION cell through the engine's `toggleCell`. The acting
 * session user is the only actor the engine ever stamps (R89.28); with no
 * session id (`actingUserId` absent/blank) verifying is refused and a stamp left
 * by someone else is kept, exactly as the engine documents — this view never
 * fabricates an actor.
 */
export function nextVerificationCell(
  value: unknown,
  options: { actingUserId?: string; now: number },
): LegacyVerificationCell {
  const userId =
    typeof options.actingUserId === "string" && options.actingUserId.trim() !== ""
      ? options.actingUserId
      : "";
  return toggleCell(value, { userId, now: options.now });
}

/**
 * The FILES value a new attachment produces: the app-owned entries the cell
 * already holds, plus the freshly uploaded asset.
 *
 * Only the app's own `/api/files/...` paths are carried over — an entry with
 * any other URL is dropped, so the write path never sees it and a stale
 * entry can never block the attach.
 */
export function composeFilesValue(
  stored: unknown,
  asset: { name: string; url: string; mimeType?: string },
): { files: { name: string; url: string; mimeType?: string }[] } {
  const entries = Array.isArray(stored)
    ? (stored as { name: string; url: string; mimeType?: string }[])
    : [];
  return {
    files: [
      ...entries.filter(
        (entry) =>
          entry &&
          typeof entry.name === "string" &&
          sanitizeFileUrl(entry.url) !== null,
      ),
      asset,
    ],
  };
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
  actingUserId,
  actingRole,
  selected,
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
  /**
   * VERIFICATION: the acting session user id, stamped by the engine's
   * `toggleCell`. Optional so existing callers are unchanged; when a caller can
   * supply the session user, the toggle finally stamps a real actor (R89.28).
   */
  actingUserId?: string;
  /**
   * BUTTON: the caller's role for the `canRun` destructive-action gate; derived
   * from `editable` when omitted, so existing callers stay valid.
   */
  actingRole?: ButtonRole;
  /**
   * Table selection: paints the accent outline on the selected cell. Optional so
   * existing callers (board cards, peeks) are unchanged; focus-within still
   * draws the accent-adjacent ring when a cell's control is focused.
   */
  selected?: boolean;
}) {
  const v = (value ?? {}) as Record<string, unknown>;
  // Formatted cells (percent/currency/friendly date) render as text and swap
  // to an editor on click; both hooks live at the top so the switch below can
  // never violate the rules of hooks.
  const [editingNumber, setEditingNumber] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  // PLACE: the display swaps to lat/lng/label inputs; the draft holds the raw
  // strings so an in-progress coordinate can be typed before it parses.
  // PEOPLE keeps a local draft so two quick picks can't overwrite each other
  // from stale server props (the echo from the server lands after both clicks).
  // RELATION: the searchable picker's typeahead text. Local-only so opening the
  // picker never touches the stored `pageIds`; `@/lib/relation-picker` owns the
  // filtering/matching rules.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const readOnly = (node: React.ReactNode, title?: string) => (
    <span
      className="min-w-0 max-w-full truncate text-muted"
      title={title ?? (typeof node === "string" ? node : undefined)}
    >
      {node}
    </span>
  );
  const numberFormat = property.config?.format;
  // Optional richer NUMBER spec (`@/lib/number-format`). Present → it supersedes
  // the legacy percent/currency pair; absent → the cell renders exactly as
  // before, so every pre-existing property is unchanged.
  const numberFormatSpec = readNumberFormat(property);
  // Percent values are stored as a fraction (0.075) but edited as the displayed
  // percentage (7.5); the spec's style, else the legacy `format`, decides.
  const percentFormat =
    numberFormatSpec !== undefined
      ? numberFormatSpec.style === "percent"
      : numberFormat === "percent";
  const dateFormatted = property.config?.format === "friendly";
  // Widened once so the switch can reach types the generated enum may not list
  // yet (PLACE) without a cast on every case.
  const typeCode: string = property.type;
  // NUMBER renders as a formatted text/button (with a click-to-edit swap) only
  // when it carries a format; otherwise it is an always-on numeric input.
  const numberFormatted =
    numberFormatSpec !== undefined ||
    numberFormat === "percent" ||
    numberFormat === "currency";
  // Whether the cell is currently showing an editor (input) rather than its
  // display node — drives the shell's editing state. Kept beside the state it
  // mirrors so the shell and the switch can never disagree.
  const editingCell = (() => {
    if (!editable) return false;
    switch (typeCode) {
      case "NUMBER":
        return numberFormatted ? editingNumber : true;
      case "DATE":
        return dateFormatted || property.config?.date ? editingDate : true;
      case "PLACE":
        return false;
      case "SELECT":
      case "STATUS":
      case "MULTI_SELECT":
      case "CHECKBOX":
      case "PEOPLE":
      case "RELATION":
      case "FILES":
      case "ICON":
      case "VERIFICATION":
      case "BUTTON":
      case "AI_AUTOFILL":
        return false;
      default:
        // TEXT / URL / EMAIL / PHONE render an always-on input.
        return true;
    }
  })();

  // Inline, non-blocking validation: any failure shows a red ring plus the
  // engine's message (as `title`), never a blocking dialog or a prevented edit.
  const validation = validateCell(property, value);
  const validationMessage = validation.ok
    ? ""
    : validation.errors.map((error) => error.message).join(" ");
  // EMAIL/PHONE/URL run their own `@/lib` engine on the committed value; an
  // invalid commit is kept (never dropped) and only flagged by this message.
  const typedMessage = typedValueError(typeCode, value);
  const errorMessage =
    validationMessage !== "" ? validationMessage : typedMessage;
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
    // The rule names a palette tint; paint it from the same tag tokens the
    // chips use rather than a raw hex + alpha (design system rule 1).
    return `var(--tag-${optionTagHue(resolved.backgroundColor)}-bg)`;
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
    onChange({ number: percentFormat ? n / 100 : n });
  };

  // Commit a default-case text edit. TEXT keeps its raw value byte-for-byte;
  // PHONE stores the engine-normalized E.164 form when one is derivable
  // (`@/lib/phone-format`), falling back to the typed text when it is not.
  // EMAIL/URL keep the typed value as-is — an unrecognized commit is never
  // dropped; `typedValueError` below is what flags it.
  const commitText = (raw: string): { text: string } | null => {
    if (raw === "") return null;
    if (typeCode === "PHONE") {
      const trimmed = raw.trim();
      return { text: normalizePhone(trimmed) || trimmed };
    }
    return { text: raw };
  };

  const attachFile = (file: File) => {
    if (!workspaceId) return;
    uploadFile(file, workspaceId)
      .then((asset) => onChange(composeFilesValue(v.files, asset)))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : t(locale, "somethingWentWrong")),
      );
  };

  const content = (() => {
  switch (typeCode) {
    case "NUMBER": {
      const raw = typeof v.number === "number" ? v.number : null;
      if (numberFormatted) {
        const text =
          numberFormatSpec !== undefined
            ? raw === null
              ? ""
              : formatNumberValue(raw, numberFormatSpec, locale)
            : formatCell(value, property);
        if (!editable) {
          return (
            <span
              aria-label={property.name}
              title={text || undefined}
              className="min-w-0 max-w-full truncate text-muted"
            >
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
              aria-invalid={errorMessage !== "" || undefined}
              // Percent shows the percentage (7.5), not the stored fraction.
              defaultValue={
                raw === null
                  ? ""
                  : String(
                      percentFormat
                        ? Math.round(raw * 1e6) / 1e6
                        : raw,
                    )
              }
              onBlur={(e) => {
                commitNumber(e.target.value);
                setEditingNumber(false);
              }}
              onKeyDown={(e) => {
                const outcome = cellKeyOutcome(e.key);
                if (outcome === "commit") (e.target as HTMLInputElement).blur();
                if (outcome === "cancel") setEditingNumber(false);
              }}
              className="focus-ring w-full bg-transparent outline-none tabular-nums"
            />
          );
        }
        return (
          <button
            type="button"
            aria-label={property.name}
            title={text || undefined}
            onClick={() => setEditingNumber(true)}
            className="focus-ring w-full min-w-0 truncate rounded px-1 py-0.5 text-left tabular-nums hover:bg-surface-2"
          >
            {text || <span className="text-muted">—</span>}
          </button>
        );
      }
      return (
        <input
          type="number"
          aria-label={property.name}
          aria-invalid={errorMessage !== "" || undefined}
          defaultValue={(v.number as number) ?? ""}
          readOnly={!editable}
          onBlur={(e) =>
            onChange(
              e.target.value === "" ? null : { number: Number(e.target.value) },
            )
          }
          onKeyDown={(e) => {
            if (cellKeyOutcome(e.key) === "commit")
              (e.target as HTMLInputElement).blur();
          }}
          className="focus-ring w-full bg-transparent outline-none tabular-nums"
        />
      );
    }
    case "CHECKBOX":
      return (
        <label className="focus-ring inline-flex cursor-pointer items-center">
          <input
            type="checkbox"
            aria-label={property.name}
            checked={Boolean(v.checked)}
            disabled={!editable}
            onChange={(e) => onChange({ checked: e.target.checked })}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className={cn(
              "u-colors flex h-4 w-4 items-center justify-center rounded-xs border border-border-strong bg-bg",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
              Boolean(v.checked) && "border-accent bg-accent text-accent-fg",
              !editable && "opacity-50",
            )}
          >
            {Boolean(v.checked) ? (
              // The 160 ms tick: the shared `animate-scale-in` token is exactly
              // `scale-in 0.16s var(--ease-smooth)`.
              <svg
                viewBox="0 0 12 12"
                className="animate-scale-in h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2 6.2 4.6 8.8 10 3.2" />
              </svg>
            ) : null}
          </span>
        </label>
      );
    case "DATE": {
      return (
        <DateCell
          property={property}
          value={value}
          editable={editable}
          errorMessage={errorMessage}
          locale={locale}
          editing={editingDate}
          onEditingChange={setEditingDate}
          onChange={onChange}
        />
      );
    }
    case "SELECT":
    case "STATUS": {
      return (
        <StatusCell
          propertyName={property.name}
          options={property.config?.options ?? []}
          value={v}
          editable={editable}
          onChange={onChange}
        />
      );
    }
    case "MULTI_SELECT": {
      const options = property.config?.options ?? [];
      // Normalised read (dedup, unknown ids dropped): a stored value can never
      // render twice or out of order, and the next toggle re-saves it clean.
      const selectedIds = normalizeOptionIds(v.optionIds, options);
      return (
        <div className="flex min-w-0 flex-wrap gap-1">
          {options.map((o) => {
            const active = selectedIds.includes(o.id);
            const hue = optionTagHue(o.color);
            return (
              <button
                key={o.id}
                type="button"
                disabled={!editable}
                aria-pressed={active}
                data-color={hue}
                title={hue}
                onClick={() =>
                  onChange({
                    optionIds: active
                      ? selectedIds.filter((id) => id !== o.id)
                      : [...selectedIds, o.id],
                  })
                }
                className={cn(
                  tagClass(hue),
                  "focus-ring min-w-0 max-w-full truncate disabled:opacity-50",
                  !active && "opacity-60",
                )}
                style={tagStyle(hue)}
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
      return (
        <PeopleCell
          propertyName={property.name}
          value={value}
          editable={editable}
          locale={locale}
          members={peopleOptions ?? []}
          onChange={onChange}
        />
      );
    }
    case "FORMULA":
      return readOnly(computed && computed.length > 0 ? computed : "—");
    case "ROLLUP":
      // Aggregate (`@/lib/rollup`, via `computed`): read-only and addressable,
      // like the other derived cells. An unconfigured rollup has no computed
      // value and stays blank, so no cell changes for a pre-config property.
      return (
        <span
          aria-label={property.name}
          title={computed && computed.length > 0 ? computed : "—"}
          className="min-w-0 max-w-full truncate text-muted"
        >
          {computed && computed.length > 0 ? computed : "—"}
        </span>
      );
    case "CREATED_TIME":
    case "LAST_EDITED_TIME":
    case "CREATED_BY":
    case "LAST_EDITED_BY":
      // Read-only, but addressable: the row UI must be assertable for
      // created/last-edited surfacing (and screen readers get the name too).
      return (
        <span
          aria-label={property.name}
          title={computed && computed.length > 0 ? computed : "—"}
          className="min-w-0 max-w-full truncate text-muted"
        >
          {computed && computed.length > 0 ? computed : "—"}
        </span>
      );
    case "UNIQUE_ID": {
      // Read-only, derived display through `@/lib/unique-id`: the stored counter
      // (`{ number }`) or the stored formatted id (`{ text }`, parsed back) is
      // formatted with the property's config, and `describeUniqueId` supplies
      // the tooltip. With nothing the engine can format it falls back to the
      // caller-computed value, so pre-engine rows render exactly as before.
      const resolved = uniqueIdCellText(value, property.config?.uniqueId);
      const text = resolved
        ? resolved.text
        : computed && computed.length > 0
          ? computed
          : "—";
      return (
        <span
          aria-label={property.name}
          title={resolved?.description ?? (text || undefined)}
          className="min-w-0 max-w-full truncate text-muted"
        >
          {text || "—"}
        </span>
      );
    }
    case "VERIFICATION": {
      // Spec R89.28, read through `@/lib/verification-cell`: the stored legacy
      // cell (`{ verified, verifiedById, verifiedAt, note? }`) becomes the
      // engine's chip label + tone; a `verifiedByName` alias is only a display
      // name and is lifted by the helper. Toggling writes the engine's legacy
      // cell back; the acting session user is stamped only when the caller
      // supplies one (`actingUserId`) — this view still never fabricates an
      // actor, so without it verifying is refused (and a foreign stamp kept).
      const display = verificationCellView(value);
      const note = cellToValue(value).note;
      // Tone → shared tag palette (no bespoke colour pairs): verified wins
      // green, a stale stamp reads yellow, an unverified cell stays neutral.
      const hue: TagHue =
        display.tone === "verified"
          ? "green"
          : display.tone === "stale"
            ? "yellow"
            : "gray";
      if (!editable) {
        return (
          <span
            aria-label={`${property.name}: ${display.label}`}
            title={note}
            data-tone={display.tone}
            className={cn(tagClass(hue), "min-w-0 max-w-full truncate")}
            style={tagStyle(hue)}
          >
            {display.label}
          </span>
        );
      }
      return (
        <button
          type="button"
          aria-label={property.name}
          aria-pressed={display.verified}
          title={note}
          data-testid="verification-cell"
          data-tone={display.tone}
          onClick={() =>
            onChange(nextVerificationCell(value, { actingUserId, now: Date.now() }))
          }
          className={cn(tagClass(hue), "focus-ring min-w-0 max-w-full truncate")}
          style={tagStyle(hue)}
        >
          {display.label}
        </button>
      );
    }
    case "PLACE": {
      return (
        <PlaceCell
          propertyName={property.name}
          value={value}
          editable={editable}
          locale={locale}
          onChange={onChange}
        />
      );
    }
    case "ICON": {
      return (
        <IconCell
          propertyName={property.name}
          value={value}
          editable={editable}
          locale={locale}
          userId={actingUserId}
          onChange={onChange}
        />
      );
    }
    case "RELATION": {
      return (
        <RelationCell
          propertyName={property.name}
          value={value}
          editable={editable}
          locale={locale}
          options={relationOptions ?? []}
          rowId={row?.id}
          onChange={onChange}
        />
      );
    }
    case "BUTTON":
      return (
        <ButtonCell
          property={property}
          value={value}
          editable={editable}
          locale={locale}
          row={row}
          onRunButton={onRunButton}
          actingRole={actingRole}
        />
      );
    case "AI_AUTOFILL":
      return editable && onRunAi ? (
        <button
          type="button"
          onClick={onRunAi}
          aria-label={t(locale, "autofillWord")}
          className="focus-ring max-w-full truncate rounded border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
        >
          {t(locale, "autofillWord")}
        </button>
      ) : (
        readOnly(formatCell(value, property) || "—")
      );
    case "FILES": {
      const stored = Array.isArray(v.files)
        ? (v.files as { name: string; url: string; mimeType?: string }[])
        : [];
      // A stored file URL is user-controlled: it must pass the shared href
      // allowlist before it may reach an anchor. A `javascript:` URL is
      // dropped instead of rendered as a clickable link.
      const files = stored
        .filter((entry) => entry && typeof entry.name === "string")
        .flatMap((entry) => {
          const href = sanitizeHref(entry.url);
          return href === null ? [] : [{ name: entry.name, href }];
        });
      return (
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="group"
          aria-label={property.name}
        >
          {files.map((entry, index) => (
            <a
              key={`${entry.href}-${index}`}
              href={entry.href}
              target="_blank"
              rel="noreferrer noopener"
              title={entry.name}
              className="focus-ring max-w-[10rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs underline-offset-2 hover:underline"
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
                className="focus-ring rounded px-1 text-xs text-muted hover:bg-surface-2"
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
          aria-invalid={errorMessage !== "" || undefined}
          defaultValue={(v.text as string) ?? ""}
          readOnly={!editable}
          placeholder="—"
          onBlur={(e) => onChange(commitText(e.target.value))}
          onKeyDown={(e) => {
            if (cellKeyOutcome(e.key) === "commit")
              (e.target as HTMLInputElement).blur();
          }}
          className="focus-ring w-full min-w-0 truncate bg-transparent outline-none placeholder:text-muted"
        />
      );
  }
  })();
  // The cell shell carries the shared states (hover tint, focus-visible ring,
  // selected accent outline, danger ring + aria-invalid) for every type; the
  // content node itself is unchanged so each case renders exactly what it did.
  const invalid = errorMessage !== "";
  const state: CellVisualState = { editing: editingCell, invalid, selected };
  return (
    <div
      data-cell-type={typeCode}
      data-state={cellVisualState(typeCode, state)}
      data-invalid={invalid ? "true" : undefined}
      aria-invalid={invalid || undefined}
      title={invalid ? errorMessage : undefined}
      style={cellBackground ? { backgroundColor: cellBackground } : undefined}
      className={cellStateClass(typeCode, state)}
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
        className="focus-ring u-interactive h-9 rounded bg-accent px-4 text-sm text-accent-fg disabled:opacity-50"
      >
        {t(locale, "add")}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t(locale, "cancel")}
        className="focus-ring u-interactive h-9 rounded px-3 text-sm text-muted hover:bg-surface-2"
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
    case "PLACE":
      return "📍";
    default:
      return "Aa";
  }
}

/* ---------------------------------------------------------------------------
   Gallery view
   --------------------------------------------------------------------------- */
