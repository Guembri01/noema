"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COLOR_CHOICES,
  type DBProperty,
  type PropertyConfig,
} from "@/components/database/database-types";
import { updatePropertyAction } from "@/server/actions/database";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { formatUniqueId, isValidPrefix, type UniqueIdConfig } from "@/lib/unique-id";
import { formatGeo, normalizeGeo, parseGeo } from "@/lib/geo";
import { formatDateRange, isValidTimeZone, type DateValue } from "@/lib/date-range";
import {
  computeReminderTimes,
  describeOffset,
  parseReminderOffset,
  type ReminderDirection,
  type ReminderOffset,
  type ReminderUnit,
} from "@/lib/date-reminder";
import {
  describeFormat,
  formatNumberValue,
  validateFormatSpec,
  type NumberFormatSpec,
} from "@/lib/number-format";
import { CURRENCIES, isCurrencyCode } from "@/lib/currency";
import {
  defaultValueFor,
  isComputedType,
  type StoredPropertyValue,
} from "@/lib/property-defaults";
import {
  BUTTON_ACTION_CATALOG,
  BUTTON_NOTIFY_LEVELS,
  validateButton,
  type ButtonAction,
  type ButtonActionKind,
  type ButtonConfig,
  type ButtonNotifyLevel,
} from "@/lib/row-buttons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { Tooltip } from "@/components/ui/tooltip";
import { FormulaEditor } from "@/components/editor/formula-editor";
import { Plus, X } from "lucide-react";

type OptionDraft = { id: string; name: string; color: string; group?: string };

/**
 * A property's option colour, authored as a row of `Tag` hue chips (the Tag
 * primitive). Selecting a chip persists the same `color` string a `<select>`
 * used to, so the stored option shape is unchanged.
 */
function OptionColorPicker({
  locale,
  value,
  name,
  disabled,
  onSelect,
}: {
  locale: string;
  value: string;
  name: string;
  disabled?: boolean;
  onSelect: (color: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${t(locale, "optionColorLabel")}: ${name}`}
      className="flex flex-wrap items-center gap-1"
    >
      {COLOR_CHOICES.map((color) => (
        <Tag
          key={color}
          hue={color}
          size="sm"
          dot
          selected={value === color}
          disabled={disabled}
          aria-label={color}
          onSelectedChange={() => onSelect(color)}
        >
          {color}
        </Tag>
      ))}
    </div>
  );
}

const DEFAULT_ZERO_PAD = 4;
const DEFAULT_START_AT = 1;
const DEFAULT_SEPARATOR = "-";

/** Mapbox-style zoom bounds for the Place default-zoom control. */
const MIN_ZOOM = 0;
const MAX_ZOOM = 22;

/** Reminder unit/direction choices offered by the DATE reminder editor. */
const REMINDER_UNITS: readonly ReminderUnit[] = ["minutes", "hours", "days"];
const REMINDER_DIRECTIONS: readonly ReminderDirection[] = ["before", "after"];
/** A freshly-added reminder: one day before the due instant. */
const DEFAULT_REMINDER: ReminderOffset = {
  amount: 1,
  unit: "days",
  direction: "before",
};

/** Fixed sample bounds so the DATE preview never depends on the wall clock. */
const PREVIEW_START = "2026-03-03";
const PREVIEW_END = "2026-03-05";

/** Fixed sample so the NUMBER preview never depends on the wall clock. */
const NUMBER_PREVIEW_VALUE = 1234.56;

/** Fraction-digit choices offered by the NUMBER format picker (0–8). */
const NUMBER_DECIMAL_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * Read the optional NUMBER `numberFormat` spec off a property config. The
 * shared `PropertyConfig` type is closed, so the key is read defensively (like
 * `view-parts.ts`); `validateFormatSpec` repairs anything untrusted.
 */
function readNumberFormat(config: PropertyConfig): unknown {
  if (!config || !("numberFormat" in config)) return undefined;
  return (config as { numberFormat?: NumberFormatSpec }).numberFormat;
}

/** Read the optional `default` authored for a property (config is closed-typed). */
function readDefault(config: PropertyConfig): unknown {
  if (!config || !("default" in config)) return undefined;
  return (config as { default?: unknown }).default;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the optional BUTTON `config.button` (a `ButtonConfig`-shaped value). The
 * shared `PropertyConfig` type is closed, so the key is read defensively, like
 * `readNumberFormat`; `normalizeButtonDraft` re-checks every field.
 */
function readButton(config: PropertyConfig): unknown {
  if (!config || !("button" in config)) return undefined;
  return (config as { button?: unknown }).button;
}

/**
 * Read the optional FORMULA `expression` off a property config. The shared
 * `PropertyConfig` type is closed, so the key is read defensively (like
 * `readNumberFormat`); only a string is accepted, and anything else reads as an
 * empty formula.
 */
function readExpression(config: PropertyConfig): string {
  if (!config || !("expression" in config)) return "";
  const value = (config as { expression?: unknown }).expression;
  return typeof value === "string" ? value : "";
}

/**
 * Read the optional top-level `reminders` list off a property config. The shared
 * `PropertyConfig` type is closed, so the key is read defensively (like
 * `readNumberFormat`); every entry is re-checked by the engine's
 * `parseReminderOffset`, so an untrusted stored list can only drop an offset,
 * never poison the editor.
 */
function readReminders(config: PropertyConfig): ReminderOffset[] {
  const container = config as Record<string, unknown> | null;
  if (!container) return [];
  const raw = container.reminders;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => parseReminderOffset(entry))
    .filter((entry): entry is ReminderOffset => entry !== null);
}

/** Editable draft of a BUTTON property's `config.button`. */
type ButtonDraft = {
  id: string;
  label: string;
  icon: string;
  kind: ButtonActionKind;
  url: string;
  openInNewTab: boolean;
  propertyId: string;
  value: string;
  templateId: string;
  message: string;
  level: ButtonNotifyLevel;
};

function emptyButtonDraft(property: DBProperty): ButtonDraft {
  return {
    id: property.id,
    label: property.name,
    icon: "",
    kind: "open_url",
    url: "",
    openInNewTab: true,
    propertyId: "",
    value: "",
    templateId: "",
    message: "",
    level: "info",
  };
}

/**
 * Coerce an untrusted stored `config.button` into a draft, defaulting every
 * absent/ill-typed field so a half-written config still opens the editor.
 * Unknown action kinds fall back to `open_url` but are never silently written.
 */
function normalizeButtonDraft(raw: unknown, property: DBProperty): ButtonDraft {
  const base = emptyButtonDraft(property);
  if (!isRecord(raw)) return base;
  const action = isRecord(raw.action) ? raw.action : {};
  const kindSpec = BUTTON_ACTION_CATALOG.find((spec) => spec.kind === action.kind);
  return {
    id:
      typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : base.id,
    label: typeof raw.label === "string" ? raw.label : base.label,
    icon: typeof raw.icon === "string" ? raw.icon : base.icon,
    kind: kindSpec ? kindSpec.kind : base.kind,
    url: typeof action.url === "string" ? action.url : base.url,
    openInNewTab:
      typeof action.openInNewTab === "boolean"
        ? action.openInNewTab
        : base.openInNewTab,
    propertyId:
      typeof action.propertyId === "string" ? action.propertyId : base.propertyId,
    value: typeof action.value === "string" ? action.value : base.value,
    templateId:
      typeof action.templateId === "string" ? action.templateId : base.templateId,
    message: typeof action.message === "string" ? action.message : base.message,
    level:
      typeof action.level === "string" &&
      (BUTTON_NOTIFY_LEVELS as readonly unknown[]).includes(action.level)
        ? (action.level as ButtonNotifyLevel)
        : base.level,
  };
}

/** Build the `ButtonConfig` to store from an editor draft. */
function draftToButtonConfig(draft: ButtonDraft): ButtonConfig {
  const action: ButtonAction = (() => {
    switch (draft.kind) {
      case "open_url":
        return {
          kind: "open_url",
          url: draft.url,
          openInNewTab: draft.openInNewTab,
        };
      case "set_property":
        return {
          kind: "set_property",
          propertyId: draft.propertyId,
          value: draft.value,
        };
      case "insert_template":
        return { kind: "insert_template", templateId: draft.templateId };
      case "notify":
        return { kind: "notify", message: draft.message, level: draft.level };
    }
  })();
  const icon = draft.icon.trim();
  return {
    id: draft.id,
    label: draft.label,
    ...(icon !== "" ? { icon } : {}),
    action,
  };
}

/**
 * The canonical `config.default` to store for a resolved default value, or
 * `undefined` when the property should carry no default at all (an empty cell).
 * Derived from `defaultValueFor`'s validated output, so what is stored is
 * exactly what a brand-new row would start with.
 */
function canonicalDefault(
  type: string,
  resolved: StoredPropertyValue | null,
): unknown | undefined {
  if (resolved === null) return undefined;
  switch (type) {
    case "CHECKBOX":
      return "checked" in resolved ? resolved.checked : undefined;
    case "MULTI_SELECT":
      return "optionIds" in resolved && resolved.optionIds.length > 0
        ? resolved.optionIds
        : undefined;
    case "SELECT":
    case "STATUS":
      return "optionId" in resolved ? resolved.optionId : undefined;
    case "DATE":
      return "start" in resolved ? resolved.start : undefined;
    case "NUMBER":
      return "number" in resolved ? resolved.number : undefined;
    case "PEOPLE":
      return "names" in resolved && resolved.names.length > 0
        ? resolved.names
        : undefined;
    case "TEXT":
    case "URL":
    case "EMAIL":
    case "PHONE":
      return "text" in resolved ? resolved.text : undefined;
    default:
      return undefined;
  }
}

/** Human-readable preview of a resolved default cell, with option names. */
function describeDefault(
  value: StoredPropertyValue | null,
  options: readonly { id: string; name: string }[],
): string {
  if (value === null) return "—";
  const optionName = (id: string) =>
    options.find((option) => option.id === id)?.name ?? id;
  if ("text" in value) return value.text;
  if ("number" in value) return String(value.number);
  if ("checked" in value) return value.checked ? "Checked" : "Unchecked";
  if ("start" in value) return value.start;
  if ("optionId" in value) return optionName(value.optionId);
  if ("optionIds" in value) return value.optionIds.map(optionName).join(", ") || "—";
  if ("names" in value) return value.names.join(", ") || "—";
  return "—";
}

/**
 * Property types that can carry a configured default. Excludes every computed
 * type (see `isComputedType`) as well as PLACE/FILES, whose cells have no
 * stored default shape in `property-defaults`.
 */
const DEFAULTABLE_TYPES: ReadonlySet<string> = new Set([
  "TEXT",
  "URL",
  "EMAIL",
  "PHONE",
  "NUMBER",
  "CHECKBOX",
  "DATE",
  "SELECT",
  "STATUS",
  "MULTI_SELECT",
  "PEOPLE",
]);

/** Parse a positive integer, falling back to the engine default when invalid. */
function parsePositiveInt(text: string, fallback: number): number {
  const value = Number.parseInt(text, 10);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * Editor for a database property's configuration. SELECT / MULTI_SELECT /
 * STATUS get the option (name/colour/group) editor; UNIQUE_ID, PLACE and DATE
 * get the config editors for their newly-merged engines. Every change persists
 * the full config through `updatePropertyAction`, and the latest draft is what
 * gets written, so two quick edits can never revert each other.
 */
export function PropertyOptionsEditor({
  locale,
  property,
  onClose,
}: {
  locale: string;
  property: DBProperty;
  onClose: () => void;
}) {
  const router = useRouter();
  const initial = (property.config?.options ?? []) as OptionDraft[];
  const [draft, setDraft] = useState<OptionDraft[]>(initial);
  // Latest intended option list while a save is still in flight.
  const pending = useRef<OptionDraft[]>(initial);
  // Latest intended config, so consecutive edits to different fields merge.
  const configRef = useRef<PropertyConfig>(property.config ?? null);
  const { run } = useAction(locale);

  // The generated PropertyType enum predates PLACE; widen to string so the
  // check stays valid whether or not the enum has caught up.
  const typeCode: string = property.type;
  const isOptions =
    typeCode === "SELECT" || typeCode === "MULTI_SELECT" || typeCode === "STATUS";
  const isUniqueId = typeCode === "UNIQUE_ID";
  const isPlace = typeCode === "PLACE";
  const isDate = typeCode === "DATE";
  const isNumber = typeCode === "NUMBER";
  const isButton = typeCode === "BUTTON";
  const isFormula = typeCode === "FORMULA";

  // --- Default value (config.default) --------------------------------------
  // Live option list (SELECT/MULTI_SELECT/STATUS edits are already reflected in
  // `draft`), used both to author a default and to resolve it back for display.
  const options: readonly { id: string; name: string }[] = isOptions
    ? draft
    : property.config?.options ?? [];
  // Computed/derived types never take a default; neither do PLACE/FILES.
  const showDefault = DEFAULTABLE_TYPES.has(typeCode) && !isComputedType(typeCode);
  const isTextLike =
    typeCode === "TEXT" ||
    typeCode === "URL" ||
    typeCode === "EMAIL" ||
    typeCode === "PHONE";
  const isDefaultCheckbox = typeCode === "CHECKBOX";
  const isDefaultSelect = typeCode === "SELECT" || typeCode === "STATUS";
  const isDefaultMulti = typeCode === "MULTI_SELECT";
  const isDefaultPeople = typeCode === "PEOPLE";

  const persist = (config: PropertyConfig) => {
    configRef.current = config;
    run(() => updatePropertyAction(property.id, { config }), {
      // The table behind the dialog re-renders from storage, so closing the
      // editor never shows a stale value.
      onSuccess: () => router.refresh(),
    });
  };

  const saveOptions = (next: OptionDraft[]) => {
    pending.current = next;
    setDraft(next);
    persist({ ...(configRef.current ?? {}), options: next });
  };

  const commitName = (index: number, name: string) => {
    const trimmed = name.trim();
    const current = pending.current;
    if (!trimmed || (current[index] && current[index].name === trimmed)) return;
    saveOptions(
      current.map((option, i) =>
        i === index ? { ...option, name: trimmed.slice(0, 60) } : option,
      ),
    );
  };

  // --- UNIQUE_ID: prefix / zero-pad / start-at / separator ------------------
  const [prefix, setPrefix] = useState(property.config?.uniqueId?.prefix ?? "");
  const [zeroPadText, setZeroPadText] = useState(
    property.config?.uniqueId?.zeroPad !== undefined
      ? String(property.config.uniqueId.zeroPad)
      : String(DEFAULT_ZERO_PAD),
  );
  const [startAtText, setStartAtText] = useState(
    property.config?.uniqueId?.startAt !== undefined
      ? String(property.config.uniqueId.startAt)
      : String(DEFAULT_START_AT),
  );
  const [separator, setSeparator] = useState(
    property.config?.uniqueId?.separator ?? DEFAULT_SEPARATOR,
  );

  const commitUniqueId = (patch: {
    prefix?: string;
    zeroPad?: string;
    startAt?: string;
    separator?: string;
  }) => {
    const next: UniqueIdConfig = {
      prefix: patch.prefix ?? prefix,
      zeroPad: parsePositiveInt(patch.zeroPad ?? zeroPadText, DEFAULT_ZERO_PAD),
      startAt: parsePositiveInt(patch.startAt ?? startAtText, DEFAULT_START_AT),
      separator: patch.separator ?? separator,
    };
    persist({ ...(configRef.current ?? {}), uniqueId: next });
  };

  const zeroPadValue = parsePositiveInt(zeroPadText, DEFAULT_ZERO_PAD);
  const startAtValue = parsePositiveInt(startAtText, DEFAULT_START_AT);
  // `startAtValue` is always a positive integer, so `formatUniqueId` never
  // throws here; an unusable prefix just hides the preview.
  const uniqueIdPreview = isValidPrefix(prefix)
    ? formatUniqueId(
        { prefix, zeroPad: zeroPadValue, startAt: startAtValue, separator },
        startAtValue,
      )
    : null;

  // --- PLACE: default centre + zoom ----------------------------------------
  const [latText, setLatText] = useState(
    property.config?.place?.lat !== undefined ? String(property.config.place.lat) : "",
  );
  const [lngText, setLngText] = useState(
    property.config?.place?.lng !== undefined ? String(property.config.place.lng) : "",
  );
  const [zoomText, setZoomText] = useState(
    property.config?.place?.zoom !== undefined ? String(property.config.place.zoom) : "",
  );
  const [labelText, setLabelText] = useState(property.config?.place?.label ?? "");

  const placeParse = parseGeo(`${latText},${lngText}`);
  const placeCenter = placeParse.ok ? normalizeGeo(placeParse.value) : null;
  const placeLabel = labelText.trim();
  const placePreview = placeCenter
    ? `${placeLabel !== "" ? `${placeLabel} · ` : ""}${formatGeo(placeCenter)}`
    : null;
  const placeError =
    latText.trim() !== "" && lngText.trim() !== "" && !placeParse.ok
      ? placeParse.error
      : null;

  const commitPlace = (patch: {
    lat?: string;
    lng?: string;
    zoom?: string;
    label?: string;
  }) => {
    const lat = patch.lat ?? latText;
    const lng = patch.lng ?? lngText;
    const zoomRaw = patch.zoom ?? zoomText;
    const zoomValue = Number.parseInt(zoomRaw, 10);
    const zoom =
      Number.isInteger(zoomValue) && zoomValue >= MIN_ZOOM && zoomValue <= MAX_ZOOM
        ? zoomValue
        : undefined;
    const parsed = parseGeo(`${lat},${lng}`);
    const center = parsed.ok ? normalizeGeo(parsed.value) : null;
    const label = (patch.label ?? labelText).trim();
    persist({
      ...(configRef.current ?? {}),
      place: {
        ...(center ? { lat: center.lat, lng: center.lng } : {}),
        ...(zoom !== undefined ? { zoom } : {}),
        ...(label !== "" ? { label } : {}),
      },
    });
  };

  // --- DATE: range / all-day / time zone -----------------------------------
  const [allowRange, setAllowRange] = useState(Boolean(property.config?.date?.allowRange));
  const [allDay, setAllDay] = useState(property.config?.date?.allDay ?? true);
  const [timeZoneText, setTimeZoneText] = useState(
    property.config?.date?.timeZone ?? "",
  );
  // Reminder offsets around the due date (`@/lib/date-reminder`); every write is
  // re-validated by `parseReminderOffset` so only well-formed offsets persist.
  const [reminders, setReminders] = useState<ReminderOffset[]>(() =>
    readReminders(property.config),
  );

  const timeZoneTrimmed = timeZoneText.trim();
  const timeZoneValid = timeZoneTrimmed === "" || isValidTimeZone(timeZoneTrimmed);
  const previewRange: DateValue = {
    start: PREVIEW_START,
    end: allowRange ? PREVIEW_END : PREVIEW_START,
    allDay,
    ...(isValidTimeZone(timeZoneTrimmed) ? { timeZone: timeZoneTrimmed } : {}),
  };
  const datePreview = formatDateRange(previewRange);

  // Engine-computed reminder instants for a fixed sample due date, so the
  // preview never depends on the wall clock.
  const reminderPreview =
    reminders.length > 0
      ? computeReminderTimes(PREVIEW_START, reminders).join(", ")
      : null;

  const commitDate = (patch: {
    allowRange?: boolean;
    allDay?: boolean;
    timeZone?: string;
  }) => {
    const rawZone = (patch.timeZone ?? timeZoneText).trim();
    const valid = rawZone === "" || isValidTimeZone(rawZone);
    // Keep the last good zone while the user is mid-typing an invalid one.
    const storedZone = valid ? rawZone || undefined : configRef.current?.date?.timeZone;
    persist({
      ...(configRef.current ?? {}),
      date: {
        allowRange: patch.allowRange ?? allowRange,
        allDay: patch.allDay ?? allDay,
        timeZone: storedZone,
      },
    });
  };

  /**
   * Replace the reminder list. Candidates pass through the engine's
   * `parseReminderOffset`, so a malformed offset is dropped rather than stored.
   */
  const commitReminders = (next: ReminderOffset[]) => {
    const validated = next
      .map((entry) => parseReminderOffset(entry))
      .filter((entry): entry is ReminderOffset => entry !== null);
    setReminders(validated);
    persist({
      ...(configRef.current ?? {}),
      reminders: validated,
    } as unknown as PropertyConfig);
  };

  const addReminder = () => commitReminders([...reminders, DEFAULT_REMINDER]);

  const updateReminder = (index: number, patch: Partial<ReminderOffset>) =>
    commitReminders(
      reminders.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  const removeReminder = (index: number) =>
    commitReminders(reminders.filter((_, i) => i !== index));

  // --- NUMBER: display style / decimals / currency -------------------------
  // The spec is normalized on read and every write, so an untrusted stored
  // value (or an out-of-range pick) can never reach `Intl` unchecked.
  const [numberFormat, setNumberFormat] = useState<NumberFormatSpec>(() =>
    validateFormatSpec(readNumberFormat(property.config)),
  );
  const numberPreview = formatNumberValue(NUMBER_PREVIEW_VALUE, numberFormat, locale);

  const commitNumberFormat = (patch: Record<string, unknown>) => {
    const next = validateFormatSpec({ ...numberFormat, ...patch });
    setNumberFormat(next);
    persist({
      ...(configRef.current ?? {}),
      numberFormat: next,
    } as PropertyConfig);
  };

  // --- BUTTON: label / icon / action (`@/lib/row-buttons`) ------------------
  // The draft is validated through the engine's own `validateButton` before it
  // reaches storage, so `config.button` only ever holds a runnable config (the
  // Button cell then resolves it with no `invalid` plan).
  const [buttonDraft, setButtonDraft] = useState<ButtonDraft>(() =>
    normalizeButtonDraft(readButton(property.config), property),
  );
  const buttonCandidate = draftToButtonConfig(buttonDraft);
  const buttonIssues = isButton ? validateButton(buttonCandidate) : [];
  const buttonSpec = BUTTON_ACTION_CATALOG.find(
    (spec) => spec.kind === buttonDraft.kind,
  );

  const commitButton = (patch: Partial<ButtonDraft>) => {
    const next: ButtonDraft = { ...buttonDraft, ...patch };
    setButtonDraft(next);
    const candidate = draftToButtonConfig(next);
    // Persist only a config the engine accepts, so the cell can always run it.
    if (validateButton(candidate).length > 0) return;
    persist({
      ...(configRef.current ?? {}),
      button: candidate,
    } as PropertyConfig);
  };

  // --- FORMULA: expression (`@/lib/formula` + `@/lib/formula-editor`) ------
  // The editor keeps a live draft so autocomplete/diagnostics run on every
  // keystroke; only blur/Format persists, so storage is not written per char.
  const [expression, setExpression] = useState(() => readExpression(property.config));

  const commitFormula = (next: string) => {
    setExpression(next);
    persist({ ...(configRef.current ?? {}), expression: next } as PropertyConfig);
  };

  // --- Default value: validated through `defaultValueFor` ------------------
  const [defaultDraft, setDefaultDraft] = useState<unknown>(() => readDefault(property.config));

  // Keep the raw draft for display, but persist the engine-validated canonical
  // form (or drop `default` entirely when nothing resolves, i.e. an empty cell).
  const commitDefault = (raw: unknown) => {
    setDefaultDraft(raw);
    const resolved = defaultValueFor(typeCode, { options, default: raw });
    const value = canonicalDefault(typeCode, resolved);
    const next: Record<string, unknown> = { ...(configRef.current ?? {}) };
    if (value === undefined) delete next.default;
    else next.default = value;
    persist(next as unknown as PropertyConfig);
  };

  const defaultPreview = showDefault
    ? defaultValueFor(typeCode, { options, default: defaultDraft })
    : null;
  const defaultString = typeof defaultDraft === "string" ? defaultDraft : "";
  const defaultChecked = defaultDraft === true;
  const defaultOptionIds = Array.isArray(defaultDraft)
    ? defaultDraft.filter((entry): entry is string => typeof entry === "string")
    : [];
  const defaultNamesText = defaultOptionIds.join(", ");

  return (
    <DialogContent
      className="w-full max-w-md rounded-xl border border-border bg-bg p-4 shadow-2xl"
      aria-label={`${t(locale, "editOptions")} — ${property.name}`}
      aria-describedby={undefined}
      data-testid="property-options-editor"
    >
      <h2 className="text-base font-semibold">
        {t(locale, "editOptions")} — {property.name}
      </h2>

      {isOptions && (
        <ul className="mt-4 space-y-2">
          {draft.map((option, index) => (
            <li
              key={option.id}
              className="space-y-2 rounded border border-border p-2"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={option.name}
                  size="sm"
                  className="flex-1"
                  aria-label={`${t(locale, "optionNameLabel")}: ${option.name}`}
                  onChange={(event) =>
                    setDraft((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    )
                  }
                  onBlur={(event) => commitName(index, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitName(index, event.currentTarget.value);
                      event.currentTarget.blur();
                    }
                  }}
                />
                {property.type === "STATUS" && (
                  <span className="w-32 shrink-0">
                    <Select
                      size="sm"
                      options={[
                        { value: "", label: "—" },
                        { value: "todo", label: t(locale, "statusGroupTodo") },
                        { value: "doing", label: t(locale, "statusGroupDoing") },
                        { value: "done", label: t(locale, "statusGroupDone") },
                      ]}
                      value={option.group ?? ""}
                      allowClear={false}
                      aria-label={`${t(locale, "group")}: ${option.name}`}
                      onChange={(value) =>
                        saveOptions(
                          pending.current.map((entry, i) =>
                            i === index
                              ? { ...entry, group: value || undefined }
                              : entry,
                          ),
                        )
                      }
                    />
                  </span>
                )}
                <Tooltip label={`${t(locale, "removeOption")}: ${option.name}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${t(locale, "removeOption")}: ${option.name}`}
                    onClick={() =>
                      saveOptions(pending.current.filter((_, i) => i !== index))
                    }
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </Tooltip>
              </div>
              <OptionColorPicker
                locale={locale}
                value={option.color}
                name={option.name}
                onSelect={(color) =>
                  saveOptions(
                    pending.current.map((entry, i) =>
                      i === index ? { ...entry, color } : entry,
                    ),
                  )
                }
              />
            </li>
          ))}
          {draft.length === 0 && (
            <li className="text-sm text-muted">{t(locale, "noOptionsYet")}</li>
          )}
        </ul>
      )}

      {isUniqueId && (
        <section className="mt-4 space-y-3" data-testid="unique-id-config">
          <h3 className="text-sm font-medium">Unique ID</h3>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Prefix</span>
            <Input
              data-testid="unique-id-prefix"
              aria-label="Unique ID prefix"
              value={prefix}
              onChange={(event) => {
                setPrefix(event.target.value);
                commitUniqueId({ prefix: event.target.value });
              }}
              className="flex-1"
            />
          </div>
          {prefix !== "" && !isValidPrefix(prefix) && (
            <p className="text-xs text-danger" data-testid="unique-id-prefix-error">
              Letters, digits and underscores only.
            </p>
          )}
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Zero-pad</span>
            <Stepper
              value={zeroPadValue}
              min={1}
              aria-label="Unique ID zero-pad width"
              className="w-28"
              onValueChange={(next) => {
                setZeroPadText(String(next));
                commitUniqueId({ zeroPad: String(next) });
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Start at</span>
            <Stepper
              value={startAtValue}
              min={1}
              aria-label="Unique ID start number"
              className="w-28"
              onValueChange={(next) => {
                setStartAtText(String(next));
                commitUniqueId({ startAt: String(next) });
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Separator</span>
            <Input
              data-testid="unique-id-separator"
              aria-label="Unique ID separator"
              value={separator}
              onChange={(event) => {
                setSeparator(event.target.value);
                commitUniqueId({ separator: event.target.value });
              }}
              className="w-24"
            />
          </div>
          <p className="text-xs text-muted">
            Preview:{" "}
            <span className="font-mono" data-testid="unique-id-preview">
              {uniqueIdPreview ?? "—"}
            </span>
          </p>
        </section>
      )}

      {isPlace && (
        <section className="mt-4 space-y-3" data-testid="place-config">
          <h3 className="text-sm font-medium">Place</h3>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Latitude</span>
            <Input
              data-testid="place-lat"
              aria-label="Default latitude"
              value={latText}
              onChange={(event) => {
                setLatText(event.target.value);
                commitPlace({ lat: event.target.value });
              }}
              className="w-28"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Longitude</span>
            <Input
              data-testid="place-lng"
              aria-label="Default longitude"
              value={lngText}
              onChange={(event) => {
                setLngText(event.target.value);
                commitPlace({ lng: event.target.value });
              }}
              className="w-28"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Zoom</span>
            <Stepper
              value={Number.isFinite(Number(zoomText)) ? Number(zoomText) : MIN_ZOOM}
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              aria-label="Default zoom"
              className="w-28"
              onValueChange={(next) => {
                setZoomText(String(next));
                commitPlace({ zoom: String(next) });
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Label</span>
            <Input
              data-testid="place-label"
              aria-label="Default place label"
              placeholder="e.g. HQ"
              value={labelText}
              onChange={(event) => {
                setLabelText(event.target.value);
                commitPlace({ label: event.target.value });
              }}
              className="flex-1"
            />
          </div>
          {placeError && (
            <p className="text-xs text-danger" data-testid="place-error">
              {placeError}
            </p>
          )}
          <p className="text-xs text-muted">
            Preview:{" "}
            <span className="font-mono" data-testid="place-preview">
              {placePreview ?? "—"}
            </span>
          </p>
        </section>
      )}

      {isDate && (
        <section className="mt-4 space-y-3" data-testid="date-config">
          <h3 className="text-sm font-medium">Date</h3>
          <div data-testid="date-allow-range">
            <Switch
              checked={allowRange}
              label="Allow an end date (range)"
              aria-label="Allow an end date (range)"
              onCheckedChange={(next) => {
                setAllowRange(next);
                commitDate({ allowRange: next });
              }}
            />
          </div>
          <div data-testid="date-allday">
            <Switch
              checked={allDay}
              label="All-day by default"
              aria-label="All-day by default"
              onCheckedChange={(next) => {
                setAllDay(next);
                commitDate({ allDay: next });
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Time zone</span>
            <Input
              data-testid="date-time-zone"
              aria-label="Default time zone"
              placeholder="e.g. Europe/Paris"
              value={timeZoneText}
              onChange={(event) => {
                setTimeZoneText(event.target.value);
                commitDate({ timeZone: event.target.value });
              }}
              className="flex-1"
            />
          </div>
          {!timeZoneValid && (
            <p className="text-xs text-danger" data-testid="date-time-zone-error">
              Not a recognised time zone.
            </p>
          )}
          <p className="text-xs text-muted">
            Preview:{" "}
            <span className="font-mono" data-testid="date-preview">
              {datePreview}
            </span>
          </p>
          <div className="space-y-2" data-testid="date-reminder-config">
            <h4 className="text-xs font-medium">Reminders</h4>
            {reminders.length === 0 && (
              <p className="text-xs text-muted" data-testid="date-reminder-empty">
                No reminders. Add one to notify before or after the due date.
              </p>
            )}
            {reminders.map((reminder, index) => (
              <div
                key={`${index}-${reminder.amount}-${reminder.unit}-${reminder.direction}`}
                className="flex items-center gap-1"
                data-testid="date-reminder-row"
              >
                <Stepper
                  value={reminder.amount}
                  min={0}
                  aria-label={`Reminder amount (${describeOffset(reminder)})`}
                  className="w-24"
                  onValueChange={(amount) => updateReminder(index, { amount })}
                />
                <Select
                  size="sm"
                  options={REMINDER_UNITS.map((unit) => ({ value: unit, label: unit }))}
                  value={reminder.unit}
                  allowClear={false}
                  aria-label="Reminder unit"
                  className="w-24"
                  onChange={(value) => {
                    const unit = REMINDER_UNITS.find((candidate) => candidate === value);
                    if (unit) updateReminder(index, { unit });
                  }}
                />
                <Select
                  size="sm"
                  options={REMINDER_DIRECTIONS.map((direction) => ({
                    value: direction,
                    label: direction,
                  }))}
                  value={reminder.direction}
                  allowClear={false}
                  aria-label="Reminder direction"
                  className="w-24"
                  onChange={(value) => {
                    const direction = REMINDER_DIRECTIONS.find(
                      (candidate) => candidate === value,
                    );
                    if (direction) updateReminder(index, { direction });
                  }}
                />
                <span className="flex-1 text-xs text-muted" data-testid="date-reminder-label">
                  {describeOffset(reminder)}
                </span>
                <Tooltip label={`Remove reminder: ${describeOffset(reminder)}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid="date-reminder-remove"
                    aria-label={`Remove reminder: ${describeOffset(reminder)}`}
                    onClick={() => removeReminder(index)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </Tooltip>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="date-reminder-add"
              leftIcon={<Plus className="h-3 w-3" aria-hidden />}
              onClick={addReminder}
            >
              Add reminder
            </Button>
            {reminders.length > 0 && (
              <p className="text-xs text-muted">
                Sample due {PREVIEW_START}:{" "}
                <span className="font-mono" data-testid="date-reminder-preview">
                  {reminderPreview ?? "—"}
                </span>
              </p>
            )}
          </div>
        </section>
      )}

      {isNumber && (
        <section className="mt-4 space-y-3" data-testid="number-format-config">
          <h3 className="text-sm font-medium">Number</h3>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Style</span>
            <span className="flex-1" data-testid="number-format-style">
              <Select
                size="sm"
                allowClear={false}
                aria-label="Number format style"
                value={numberFormat.style}
                options={[
                  { value: "decimal", label: "Number" },
                  { value: "percent", label: "Percent" },
                  { value: "currency", label: "Currency" },
                  { value: "compact", label: "Compact" },
                ]}
                onChange={(value) => commitNumberFormat({ style: value })}
              />
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Decimals</span>
            <span data-testid="number-format-decimals">
              <Select
                size="sm"
                allowClear={false}
                aria-label="Number format decimals"
                value={
                  numberFormat.decimals === undefined ? "" : String(numberFormat.decimals)
                }
                placeholder="Default"
                options={[
                  { value: "", label: "Default" },
                  ...NUMBER_DECIMAL_CHOICES.map((value) => ({
                    value: String(value),
                    label: String(value),
                  })),
                ]}
                onChange={(value) =>
                  commitNumberFormat({
                    decimals: value === "" ? undefined : Number(value),
                  })
                }
              />
            </span>
          </div>
          {numberFormat.style === "currency" && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-24 shrink-0">Currency</span>
              <span className="flex-1" data-testid="number-format-currency">
                <Select
                  size="sm"
                  searchable
                  allowClear={false}
                  aria-label="Currency"
                  value={numberFormat.currency ?? "USD"}
                  options={CURRENCIES.map((currency) => ({
                    value: currency.code,
                    label: `${currency.name} (${currency.code})`,
                  }))}
                  onChange={(value) => {
                    if (isCurrencyCode(value)) commitNumberFormat({ currency: value });
                  }}
                />
              </span>
            </div>
          )}
          <p className="text-xs text-muted">
            Preview:{" "}
            <span className="font-mono" data-testid="number-format-preview">
              {numberPreview}
            </span>
          </p>
          <p className="text-xs text-muted" data-testid="number-format-description">
            {describeFormat(numberFormat)}
          </p>
        </section>
      )}

      {isButton && (
        <section className="mt-4 space-y-3" data-testid="button-config">
          <h3 className="text-sm font-medium">Button</h3>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Label</span>
            <Input
              data-testid="button-label"
              aria-label="Button label"
              value={buttonDraft.label}
              onChange={(event) => commitButton({ label: event.target.value })}
              className="flex-1"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Icon</span>
            <Input
              data-testid="button-icon"
              aria-label="Button icon"
              placeholder="e.g. 🔗"
              value={buttonDraft.icon}
              onChange={(event) => commitButton({ icon: event.target.value })}
              className="w-24"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Action</span>
            <span className="flex-1" data-testid="button-action-kind">
              <Select
                size="sm"
                allowClear={false}
                aria-label="Button action"
                value={buttonDraft.kind}
                options={BUTTON_ACTION_CATALOG.map((spec) => ({
                  value: spec.kind,
                  label: spec.label,
                }))}
                onChange={(value) => {
                  const spec = BUTTON_ACTION_CATALOG.find(
                    (candidate) => candidate.kind === value,
                  );
                  if (spec) commitButton({ kind: spec.kind });
                }}
              />
            </span>
          </div>
          {buttonSpec && <p className="text-xs text-muted">{buttonSpec.description}</p>}

          {buttonDraft.kind === "open_url" && (
            <>
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="w-24 shrink-0">URL</span>
                <Input
                  data-testid="button-url"
                  aria-label="Button URL"
                  placeholder="https://…"
                  value={buttonDraft.url}
                  onChange={(event) => commitButton({ url: event.target.value })}
                  className="flex-1"
                />
              </div>
              <div data-testid="button-open-new-tab">
                <Switch
                  checked={buttonDraft.openInNewTab}
                  label="Open in a new tab"
                  aria-label="Open in a new tab"
                  onCheckedChange={(next) => commitButton({ openInNewTab: next })}
                />
              </div>
            </>
          )}

          {buttonDraft.kind === "set_property" && (
            <>
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="w-24 shrink-0">Property ID</span>
                <Input
                  data-testid="button-property-id"
                  aria-label="Button target property id"
                  value={buttonDraft.propertyId}
                  onChange={(event) =>
                    commitButton({ propertyId: event.target.value })
                  }
                  className="flex-1"
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="w-24 shrink-0">Value</span>
                <Input
                  data-testid="button-value"
                  aria-label="Button property value"
                  value={buttonDraft.value}
                  onChange={(event) => commitButton({ value: event.target.value })}
                  className="flex-1"
                />
              </div>
            </>
          )}

          {buttonDraft.kind === "insert_template" && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-24 shrink-0">Template ID</span>
              <Input
                data-testid="button-template-id"
                aria-label="Button template id"
                value={buttonDraft.templateId}
                onChange={(event) =>
                  commitButton({ templateId: event.target.value })
                }
                className="flex-1"
              />
            </div>
          )}

          {buttonDraft.kind === "notify" && (
            <>
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="w-24 shrink-0">Message</span>
                <Input
                  data-testid="button-message"
                  aria-label="Button notification message"
                  value={buttonDraft.message}
                  onChange={(event) => commitButton({ message: event.target.value })}
                  className="flex-1"
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="w-24 shrink-0">Level</span>
                <span className="flex-1" data-testid="button-notify-level">
                  <Select
                    size="sm"
                    allowClear={false}
                    aria-label="Button notification level"
                    value={buttonDraft.level}
                    options={BUTTON_NOTIFY_LEVELS.map((level) => ({
                      value: level,
                      label: level,
                    }))}
                    onChange={(value) => {
                      const level = BUTTON_NOTIFY_LEVELS.find(
                        (candidate) => candidate === value,
                      );
                      if (level) commitButton({ level });
                    }}
                  />
                </span>
              </div>
            </>
          )}

          {buttonIssues.length > 0 && (
            <ul className="space-y-1" data-testid="button-issues">
              {buttonIssues.map((issue) => (
                <li key={issue.path} className="text-xs text-danger">
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            Preview:{" "}
            <span className="font-mono" data-testid="button-preview">
              {buttonIssues.length > 0
                ? "—"
                : `${buttonDraft.icon.trim() !== "" ? `${buttonDraft.icon.trim()} ` : ""}${buttonDraft.label}`}
            </span>
          </p>
        </section>
      )}

      {isFormula && (
        <section className="mt-4 space-y-3" data-testid="formula-config">
          <h3 className="text-sm font-medium">Formula</h3>
          <FormulaEditor
            value={expression}
            onChange={setExpression}
            onCommit={commitFormula}
            locale={locale}
            placeholder='concat(prop("Name"), " — done")'
            dataTestId="formula-editor"
          />
          <p className="text-xs text-muted">
            Reference other columns with prop(&quot;Name&quot;); functions,
            signature help and diagnostics appear as you type.
          </p>
        </section>
      )}

      {showDefault && (
        <section className="mt-4 space-y-3" data-testid="property-default-config">
          <h3 className="text-sm font-medium">Default value</h3>
          {(isTextLike || isDate) && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-24 shrink-0">Value</span>
              <Input
                data-testid="property-default-text"
                aria-label="Default value"
                type={isDate ? "date" : "text"}
                value={defaultString}
                onChange={(event) => commitDefault(event.target.value)}
                className="flex-1"
              />
            </div>
          )}
          {isNumber && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-24 shrink-0">Value</span>
              <Input
                data-testid="property-default-number"
                aria-label="Default value"
                type="number"
                value={defaultString}
                onChange={(event) => commitDefault(event.target.value)}
                className="w-32"
              />
            </div>
          )}
          {isDefaultCheckbox && (
            <div data-testid="property-default-checkbox">
              <Switch
                checked={defaultChecked}
                label="Checked by default"
                aria-label="Checked by default"
                onCheckedChange={(next) => commitDefault(next)}
              />
            </div>
          )}
          {isDefaultSelect && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-24 shrink-0">Option</span>
              <span className="flex-1" data-testid="property-default-select">
                <Select
                  size="sm"
                  allowClear={false}
                  aria-label="Default option"
                  placeholder="None"
                  value={defaultString}
                  options={[
                    { value: "", label: "None" },
                    ...options.map((option) => ({
                      value: option.id,
                      label: option.name,
                    })),
                  ]}
                  onChange={(value) => commitDefault(value)}
                />
              </span>
            </div>
          )}
          {isDefaultMulti && (
            <fieldset className="space-y-1" data-testid="property-default-multi">
              <legend className="text-xs text-muted">Options</legend>
              {options.length === 0 && (
                <p className="text-xs text-muted">{t(locale, "noOptionsYet")}</p>
              )}
              {options.map((option) => {
                const checked = defaultOptionIds.includes(option.id);
                return (
                  <Checkbox
                    key={option.id}
                    size="sm"
                    checked={checked}
                    label={option.name}
                    onCheckedChange={() =>
                      commitDefault(
                        checked
                          ? defaultOptionIds.filter((id) => id !== option.id)
                          : [...defaultOptionIds, option.id],
                      )
                    }
                  />
                );
              })}
            </fieldset>
          )}
          {isDefaultPeople && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-24 shrink-0">Names</span>
              <Input
                data-testid="property-default-people"
                aria-label="Default people"
                placeholder="Comma-separated"
                value={defaultNamesText}
                onChange={(event) =>
                  commitDefault(
                    event.target.value
                      .split(",")
                      .map((name) => name.trim())
                      .filter((name) => name !== ""),
                  )
                }
                className="flex-1"
              />
            </div>
          )}
          <p className="text-xs text-muted">
            Preview:{" "}
            <span className="font-mono" data-testid="property-default-preview">
              {describeDefault(defaultPreview, options)}
            </span>
          </p>
        </section>
      )}

      <div className="mt-4 flex items-center justify-between">
        {isOptions ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="add-option"
            leftIcon={<Plus className="h-3 w-3" aria-hidden />}
            onClick={() =>
              saveOptions([
                ...pending.current,
                {
                  id: `opt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                  name: `${t(locale, "optionWord")} ${pending.current.length + 1}`,
                  color: "gray",
                  ...(property.type === "STATUS" ? { group: "todo" } : {}),
                },
              ])
            }
          >
            {t(locale, "addOption")}
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          {t(locale, "close")}
        </Button>
      </div>
    </DialogContent>
  );
}
