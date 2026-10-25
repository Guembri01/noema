"use client";

/**
 * The single/two-column layout control for a page's property panel.
 *
 * It edits the flat `@/lib/property-layout-engine` model: column count,
 * full-width spans, dividers and property order. The caller owns persistence;
 * every button computes the next layout through an immutable engine mutator, so
 * the control never holds a private copy that could drift from the saved value.
 */

import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  moveProperty,
  setSpan,
  toggleColumns,
  type LayoutProperty,
  type PropertyLayout,
  type PropertySpan,
} from "@/lib/property-layout-engine";

export function PropertyLayoutControl({
  layout,
  properties,
  onChange,
  locale = "en",
  disabled = false,
  compact = false,
  className,
}: {
  layout: PropertyLayout;
  properties: readonly LayoutProperty[];
  onChange: (layout: PropertyLayout) => void;
  locale?: string;
  disabled?: boolean;
  /** Show only the column toggle, for narrow surfaces such as the row peek. */
  compact?: boolean;
  className?: string;
}) {
  const nameOf = (id: string): string =>
    properties.find((property) => property.id === id)?.name ?? id;

  const move = (propertyId: string, delta: number) => {
    const index = layout.order.indexOf(propertyId);
    if (index === -1) return;
    onChange(moveProperty(layout, propertyId, index + delta));
  };

  const toggleSpan = (propertyId: string) => {
    const current: PropertySpan = layout.spans?.[propertyId] === 2 ? 2 : 1;
    onChange(setSpan(layout, propertyId, current === 2 ? 1 : 2));
  };

  return (
    <div
      data-testid="property-layout-control"
      data-compact={compact ? "true" : "false"}
      className={cn("flex flex-wrap items-center gap-1 text-xs text-muted", className)}
    >
      <span className="font-medium">{t(locale, "layoutWord")}</span>
      <div role="group" aria-label={t(locale, "layoutWord")} className="flex items-center gap-0.5">
        <button
          type="button"
          data-testid="property-layout-one-column"
          aria-pressed={layout.columns === 1}
          aria-label={`${t(locale, "layoutWord")}: 1`}
          disabled={disabled}
          onClick={() => layout.columns !== 1 && onChange(toggleColumns(layout))}
          className={cn(
            "focus-ring rounded-control px-2 py-0.5",
            layout.columns === 1 ? "bg-surface-2 text-fg" : "hover:bg-surface-2",
          )}
        >
          1
        </button>
        <button
          type="button"
          data-testid="property-layout-two-columns"
          aria-pressed={layout.columns === 2}
          aria-label={`${t(locale, "layoutWord")}: 2`}
          title={t(locale, "twoColumnsLabel")}
          disabled={disabled}
          onClick={() => layout.columns !== 2 && onChange(toggleColumns(layout))}
          className={cn(
            "focus-ring rounded-control px-2 py-0.5",
            layout.columns === 2 ? "bg-surface-2 text-fg" : "hover:bg-surface-2",
          )}
        >
          2
        </button>
      </div>

      {!compact && (
        <>
          <label className="ml-1 flex items-center gap-1">
            <input
              type="checkbox"
              data-testid="property-layout-dividers"
              checked={layout.dividers === true}
              disabled={disabled || layout.columns === 1}
              onChange={() =>
                onChange({ ...layout, dividers: layout.dividers !== true })
              }
            />
            {t(locale, "columnDividerAria")}
          </label>

          <ul className="mt-1 w-full space-y-0.5 border-t border-border pt-1">
            {layout.order.map((propertyId, index) => {
              const name = nameOf(propertyId);
              const fullWidth = layout.spans?.[propertyId] === 2;
              return (
                <li key={propertyId} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate" title={name}>
                    {name}
                  </span>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      data-testid={`property-layout-span-${propertyId}`}
                      checked={fullWidth}
                      disabled={disabled || layout.columns === 1}
                      aria-label={`${name} ${t(locale, "twoColumnLayoutAria")}`}
                      onChange={() => toggleSpan(propertyId)}
                    />
                    full
                  </label>
                  <button
                    type="button"
                    data-testid={`property-layout-up-${propertyId}`}
                    aria-label={`${name} ↑`}
                    disabled={disabled || index === 0}
                    onClick={() => move(propertyId, -1)}
                    className="focus-ring rounded-control px-1 hover:bg-surface-2 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-testid={`property-layout-down-${propertyId}`}
                    aria-label={`${name} ↓`}
                    disabled={disabled || index === layout.order.length - 1}
                    onClick={() => move(propertyId, 1)}
                    className="focus-ring rounded-control px-1 hover:bg-surface-2 disabled:opacity-30"
                  >
                    ↓
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
