"use client";

import { useState } from "react";
import { formatGeo, normalizeGeo, parseGeo } from "@/lib/geo";
import { t } from "@/lib/i18n";

type Draft = { lat: string; lng: string; label: string };

/**
 * PLACE cell.
 *
 * A stored `{ lat, lng, label? }` (or a `"lat, lng"` string) renders through
 * `@/lib/geo`; unparseable values stay blank. The edit draft is local so each
 * keystroke does not round-trip through the server; commit validates through the
 * same engine the query layer uses.
 */
export function PlaceCell({
  propertyName,
  value,
  editable,
  locale,
  onChange,
}: {
  propertyName: string;
  value: unknown;
  editable: boolean;
  locale: string;
  onChange: (value: unknown) => void;
}) {
  const parsed = parseGeo(value);
  const place = parsed.ok ? parsed.value : null;
  const display = place
    ? `${place.label ? `${place.label} · ` : ""}${formatGeo(place)}`
    : "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const commit = (next: Draft) => {
    const candidate = parseGeo({
      lat: Number(next.lat),
      lng: Number(next.lng),
      label: next.label.trim() || undefined,
    });
    if (!candidate.ok) return false;
    onChange(normalizeGeo(candidate.value));
    return true;
  };

  if (!editable) {
    return (
      <span
        aria-label={propertyName}
        title={display || undefined}
        className="min-w-0 max-w-full truncate text-muted"
      >
        {display || "—"}
      </span>
    );
  }

  if (editing && draft) {
    const update = (patch: Partial<Draft>) =>
      setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    const keyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (commit(draft)) setEditing(false);
      } else if (event.key === "Escape") {
        setEditing(false);
        setDraft(null);
      }
    };
    return (
      <div className="flex flex-col gap-1" role="group" aria-label={propertyName}>
        <div className="flex items-center gap-1">
          <input
            autoFocus
            type="text"
            inputMode="decimal"
            aria-label={`${propertyName} lat`}
            value={draft.lat}
            onChange={(event) => update({ lat: event.target.value })}
            onBlur={() => commit(draft)}
            onKeyDown={keyDown}
            className="focus-ring w-20 rounded-sm border border-border-control bg-bg px-1 tabular-nums outline-none"
          />
          <span className="text-muted">,</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label={`${propertyName} lng`}
            value={draft.lng}
            onChange={(event) => update({ lng: event.target.value })}
            onBlur={() => commit(draft)}
            onKeyDown={keyDown}
            className="focus-ring w-20 rounded-sm border border-border-control bg-bg px-1 tabular-nums outline-none"
          />
        </div>
        <input
          type="text"
          aria-label={`${propertyName} label`}
          value={draft.label}
          onChange={(event) => update({ label: event.target.value })}
          onBlur={() => commit(draft)}
          onKeyDown={keyDown}
          className="focus-ring w-full rounded-sm border border-border-control bg-bg px-1 outline-none"
        />
        <button
          type="button"
          onClick={() => {
            commit(draft);
            setEditing(false);
          }}
          className="focus-ring self-start text-xs text-accent hover:underline"
        >
          {t(locale, "close")}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={propertyName}
      title={display || undefined}
      onClick={() => {
        setDraft({
          lat: place ? String(place.lat) : "",
          lng: place ? String(place.lng) : "",
          label: place?.label ?? "",
        });
        setEditing(true);
      }}
      className="focus-ring w-full min-w-0 truncate rounded px-1 py-0.5 text-left hover:bg-surface-2"
    >
      {display || <span className="text-muted">—</span>}
    </button>
  );
}
