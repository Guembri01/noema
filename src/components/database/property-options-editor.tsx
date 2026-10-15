"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COLOR_CHOICES,
  CONTROL_CLASS,
  type DBProperty,
  type PropertyConfig,
} from "@/components/database/database-types";
import { updatePropertyAction } from "@/server/actions/database";
import { useAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { formatUniqueId, isValidPrefix, type UniqueIdConfig } from "@/lib/unique-id";
import { formatGeo, normalizeGeo, parseGeo } from "@/lib/geo";
import { formatDateRange, isValidTimeZone, type DateValue } from "@/lib/date-range";
import {
  describeFormat,
  formatNumberValue,
  validateFormatSpec,
  type NumberFormatSpec,
} from "@/lib/number-format";
import { CURRENCIES, isCurrencyCode } from "@/lib/currency";
import { DialogContent } from "@/components/ui/dialog";

type OptionDraft = { id: string; name: string; color: string; group?: string };

const DEFAULT_ZERO_PAD = 4;
const DEFAULT_START_AT = 1;
const DEFAULT_SEPARATOR = "-";

/** Mapbox-style zoom bounds for the Place default-zoom control. */
const MIN_ZOOM = 0;
const MAX_ZOOM = 22;

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

  const placeParse = parseGeo(`${latText},${lngText}`);
  const placeCenter = placeParse.ok ? normalizeGeo(placeParse.value) : null;
  const placePreview = placeCenter ? formatGeo(placeCenter) : null;
  const placeError =
    latText.trim() !== "" && lngText.trim() !== "" && !placeParse.ok
      ? placeParse.error
      : null;

  const commitPlace = (patch: { lat?: string; lng?: string; zoom?: string }) => {
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
    persist({
      ...(configRef.current ?? {}),
      place: {
        ...(center ? { lat: center.lat, lng: center.lng } : {}),
        ...(zoom !== undefined ? { zoom } : {}),
      },
    });
  };

  // --- DATE: range / all-day / time zone -----------------------------------
  const [allowRange, setAllowRange] = useState(Boolean(property.config?.date?.allowRange));
  const [allDay, setAllDay] = useState(property.config?.date?.allDay ?? true);
  const [timeZoneText, setTimeZoneText] = useState(
    property.config?.date?.timeZone ?? "",
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
        <>
          <ul className="mt-4 space-y-2">
            {draft.map((option, index) => (
              <li
                key={option.id}
                className="flex items-center gap-2 rounded border border-border p-2"
              >
                <input
                  value={option.name}
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
                  className="h-8 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
                />
                <select
                  value={option.color}
                  aria-label={`${t(locale, "optionColorLabel")}: ${option.name}`}
                  onChange={(event) =>
                    saveOptions(
                      pending.current.map((entry, i) =>
                        i === index ? { ...entry, color: event.target.value } : entry,
                      ),
                    )
                  }
                  className="h-8 rounded border border-border bg-bg px-1 text-xs outline-none"
                >
                  {COLOR_CHOICES.map((color) => (
                    <option key={color} value={color}>
                      {color}
                    </option>
                  ))}
                </select>
                {property.type === "STATUS" && (
                  <select
                    value={option.group ?? ""}
                    aria-label={`${t(locale, "group")}: ${option.name}`}
                    onChange={(event) =>
                      saveOptions(
                        pending.current.map((entry, i) =>
                          i === index
                            ? { ...entry, group: event.target.value || undefined }
                            : entry,
                        ),
                      )
                    }
                    className="h-8 rounded border border-border bg-bg px-1 text-xs outline-none"
                  >
                    <option value="">—</option>
                    <option value="todo">{t(locale, "statusGroupTodo")}</option>
                    <option value="doing">{t(locale, "statusGroupDoing")}</option>
                    <option value="done">{t(locale, "statusGroupDone")}</option>
                  </select>
                )}
                <button
                  type="button"
                  aria-label={`${t(locale, "removeOption")}: ${option.name}`}
                  onClick={() => saveOptions(pending.current.filter((_, i) => i !== index))}
                  className="text-muted hover:text-red-500"
                >
                  ×
                </button>
              </li>
            ))}
            {draft.length === 0 && (
              <li className="text-sm text-muted">{t(locale, "noOptionsYet")}</li>
            )}
          </ul>
        </>
      )}

      {isUniqueId && (
        <section className="mt-4 space-y-3" data-testid="unique-id-config">
          <h3 className="text-sm font-medium">Unique ID</h3>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Prefix</span>
            <input
              data-testid="unique-id-prefix"
              aria-label="Unique ID prefix"
              value={prefix}
              onChange={(event) => {
                setPrefix(event.target.value);
                commitUniqueId({ prefix: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "flex-1")}
            />
          </label>
          {prefix !== "" && !isValidPrefix(prefix) && (
            <p className="text-xs text-red-500" data-testid="unique-id-prefix-error">
              Letters, digits and underscores only.
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Zero-pad</span>
            <input
              data-testid="unique-id-zero-pad"
              aria-label="Unique ID zero-pad width"
              type="number"
              min={1}
              value={zeroPadText}
              onChange={(event) => {
                setZeroPadText(event.target.value);
                commitUniqueId({ zeroPad: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "w-24")}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Start at</span>
            <input
              data-testid="unique-id-start-at"
              aria-label="Unique ID start number"
              type="number"
              min={1}
              value={startAtText}
              onChange={(event) => {
                setStartAtText(event.target.value);
                commitUniqueId({ startAt: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "w-24")}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Separator</span>
            <input
              data-testid="unique-id-separator"
              aria-label="Unique ID separator"
              value={separator}
              onChange={(event) => {
                setSeparator(event.target.value);
                commitUniqueId({ separator: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "w-24")}
            />
          </label>
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
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Latitude</span>
            <input
              data-testid="place-lat"
              aria-label="Default latitude"
              value={latText}
              onChange={(event) => {
                setLatText(event.target.value);
                commitPlace({ lat: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "w-28")}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Longitude</span>
            <input
              data-testid="place-lng"
              aria-label="Default longitude"
              value={lngText}
              onChange={(event) => {
                setLngText(event.target.value);
                commitPlace({ lng: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "w-28")}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Zoom</span>
            <input
              data-testid="place-zoom"
              aria-label="Default zoom"
              type="number"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              value={zoomText}
              onChange={(event) => {
                setZoomText(event.target.value);
                commitPlace({ zoom: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "w-24")}
            />
          </label>
          {placeError && (
            <p className="text-xs text-red-500" data-testid="place-error">
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
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              data-testid="date-allow-range"
              type="checkbox"
              checked={allowRange}
              onChange={(event) => {
                setAllowRange(event.target.checked);
                commitDate({ allowRange: event.target.checked });
              }}
            />
            <span>Allow an end date (range)</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              data-testid="date-allday"
              type="checkbox"
              checked={allDay}
              onChange={(event) => {
                setAllDay(event.target.checked);
                commitDate({ allDay: event.target.checked });
              }}
            />
            <span>All-day by default</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Time zone</span>
            <input
              data-testid="date-time-zone"
              aria-label="Default time zone"
              placeholder="e.g. Europe/Paris"
              value={timeZoneText}
              onChange={(event) => {
                setTimeZoneText(event.target.value);
                commitDate({ timeZone: event.target.value });
              }}
              className={cn(CONTROL_CLASS, "flex-1")}
            />
          </label>
          {!timeZoneValid && (
            <p className="text-xs text-red-500" data-testid="date-time-zone-error">
              Not a recognised time zone.
            </p>
          )}
          <p className="text-xs text-muted">
            Preview:{" "}
            <span className="font-mono" data-testid="date-preview">
              {datePreview}
            </span>
          </p>
        </section>
      )}

      {isNumber && (
        <section className="mt-4 space-y-3" data-testid="number-format-config">
          <h3 className="text-sm font-medium">Number</h3>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Style</span>
            <select
              data-testid="number-format-style"
              aria-label="Number format style"
              value={numberFormat.style}
              onChange={(event) => commitNumberFormat({ style: event.target.value })}
              className={cn(CONTROL_CLASS, "flex-1")}
            >
              <option value="decimal">Number</option>
              <option value="percent">Percent</option>
              <option value="currency">Currency</option>
              <option value="compact">Compact</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="w-24 shrink-0">Decimals</span>
            <select
              data-testid="number-format-decimals"
              aria-label="Number format decimals"
              value={numberFormat.decimals === undefined ? "" : String(numberFormat.decimals)}
              onChange={(event) =>
                commitNumberFormat({
                  decimals: event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
              className={cn(CONTROL_CLASS, "w-24")}
            >
              <option value="">Default</option>
              {NUMBER_DECIMAL_CHOICES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {numberFormat.style === "currency" && (
            <label className="flex items-center gap-2 text-xs text-muted">
              <span className="w-24 shrink-0">Currency</span>
              <select
                data-testid="number-format-currency"
                aria-label="Currency"
                value={numberFormat.currency ?? "USD"}
                onChange={(event) => {
                  if (isCurrencyCode(event.target.value)) {
                    commitNumberFormat({ currency: event.target.value });
                  }
                }}
                className={cn(CONTROL_CLASS, "flex-1")}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.name} ({currency.code})
                  </option>
                ))}
              </select>
            </label>
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

      <div className="mt-4 flex items-center justify-between">
        {isOptions ? (
          <button
            type="button"
            data-testid="add-option"
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
            className="flex items-center gap-1 text-xs text-accent"
          >
            + {t(locale, "addOption")}
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onClose}
          className={cn(
            "h-8 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2",
          )}
        >
          {t(locale, "close")}
        </button>
      </div>
    </DialogContent>
  );
}
