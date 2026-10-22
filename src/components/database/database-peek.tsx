"use client";

import { type CSSProperties, useEffect, useRef } from "react";
import Link from "next/link";
import { Ban, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import { t } from "@/lib/i18n";
import {
  OPTION_FOREGROUND,
  type DBProperty,
  type DBRow,
} from "@/components/database/database-types";
import { FloatingHostProvider } from "@/components/ui/floating-layer";
import { Cell, icon as propertyIcon } from "./view-parts";

/*
 * dw07 — the side peek's design-system layer.
 *
 * The peek used to be a hand-rolled `<aside>`: a raw `z-40`, a legacy
 * `shadow-2xl`, and no scrim, entrance or exit. It now speaks the same
 * vocabulary as every other overlay in the app:
 *  - colour from tokens — the scrim is `--overlay` (`bg-overlay`), the panel
 *    `.surface-raised` (`--shadow-2` + `--radius-lg`);
 *  - layering from `Z.*` — scrim `Z.overlay`, panel `Z.modal`;
 *  - motion from tokens — the panel enters on the named
 *    `animate-slide-in-right` and mirrors it out on `--dur-3` / `--ease-smooth`,
 *    while the scrim merely fades.
 *
 * The mappings are pure so the node tests can pin them without a browser.
 */

/**
 * The tint a hovered/selected row shares between the table body
 * (`view-renderers.tsx`) and the peek, so the two surfaces read as one.
 */
export const ROW_HOVER_TINT = "hover:bg-surface-2/60";

/** The rail the open row carries when it has no colour of its own. */
export const ROW_ACCENT_RAIL = "3px solid var(--accent)";

/** The peek scrim: a fixed `--overlay` wash at `Z.overlay`. */
export function peekScrimClass(): string {
  return "fixed inset-0 bg-overlay u-colors";
}

/** The scrim's fade — token-only, so reduced-motion neutralises it globally. */
export function peekScrimStyle(entered: boolean): CSSProperties {
  return {
    zIndex: Z.overlay,
    opacity: entered ? 1 : 0,
    transition: "opacity var(--dur-3) var(--ease-smooth)",
  };
}

/** The entrance: the design system's named right-drawer animation. */
export function peekPanelClass(entered: boolean): string {
  return entered ? "animate-slide-in-right" : "";
}

/**
 * The panel's inline motion. While open the named animation owns the transform;
 * on the way out the exact mirror (`translateX(8px)` + fade) replays on the
 * `--dur-3` token — no ad-hoc millisecond anywhere, and `Z.modal` either way.
 */
export function peekPanelStyle(entered: boolean): CSSProperties {
  if (entered) return { zIndex: Z.modal };
  return {
    zIndex: Z.modal,
    transform: "translateX(8px)",
    opacity: 0,
    transition:
      "transform var(--dur-3) var(--ease-smooth), opacity var(--dur-3) var(--ease-smooth)",
  };
}

/**
 * The rail colour for a row: the table body's stripe hue when the row carries a
 * colour (the same `OPTION_FOREGROUND` map `view-renderers.tsx` uses), otherwise the
 * accent token — so the peek's selected rail always matches the table.
 */
export function peekRail(rowColor?: string | null): string {
  return rowColor ? `3px solid ${OPTION_FOREGROUND[rowColor] ?? rowColor}` : ROW_ACCENT_RAIL;
}

/** A peek row's shared treatment: the table body tint + a colour transition. */
export function peekRowClass(): string {
  return cn("u-colors rounded-sm", ROW_HOVER_TINT);
}

/**
 * The peek header — the open row's identity, carrying the same tint + accent
 * rail as a hovered/selected table body row, plus the focus-ringed
 * "Open as page" and close affordances. The rename affordance is the primary
 * title {@link PeekRow} below.
 */
export function PeekHeader({
  row,
  locale,
  workspaceSlug,
  rowColor,
  onClose,
}: {
  row: DBRow;
  locale: string;
  workspaceSlug: string;
  rowColor: string | null;
  onClose: () => void;
}) {
  return (
    <header
      data-testid="peek-header"
      className={cn(
        "-mx-1 mb-4 flex items-center justify-between gap-3 rounded-sm py-1 pe-1 ps-3",
        peekRowClass(),
      )}
      style={{ borderInlineStart: peekRail(rowColor) }}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {t(locale, "rowLabel")}
      </p>
      <div className="flex items-center gap-3">
        <Link
          href={`/w/${workspaceSlug}/${row.id}`}
          title={t(locale, "openAsPage")}
          // Navigating away should not leave the drawer hanging over the row's page.
          onClick={onClose}
          className="focus-ring u-colors rounded-sm text-xs text-accent hover:underline"
        >
          {t(locale, "openAsPage")}
        </Link>
        <button
          type="button"
          aria-label={t(locale, "closeSidePeek")}
          onClick={onClose}
          className="focus-ring u-colors rounded-sm text-muted hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

/**
 * One labelled property row in the peek. Computed (formula/rollup/system)
 * values stay read-only, and the primary property edits the row title in place
 * — exactly as the panel did inline. Carries {@link peekRowClass} so it shares
 * the table body's row treatment.
 */
export function PeekRow({
  locale,
  property,
  row,
  isPrimary,
  computed,
  value,
  relationOptions,
  peopleOptions,
  workspaceId,
  editable,
  onChange,
  onRenamePrimary,
}: {
  locale: string;
  property: DBProperty;
  row: DBRow;
  isPrimary: boolean;
  computed: string | undefined;
  value: unknown;
  relationOptions: { id: string; title: string; icon: string | null }[];
  peopleOptions: { id: string; name: string }[];
  workspaceId: string;
  editable: boolean;
  onChange: (value: unknown) => void;
  onRenamePrimary: (text: string) => void;
}) {
  return (
    <div
      data-testid={`peek-row-${property.id}`}
      className={cn(
        "-mx-1 grid grid-cols-[7.5rem_1fr] items-start gap-3 rounded-sm px-1 py-2",
        peekRowClass(),
      )}
    >
      <dt className="flex items-center gap-1.5 truncate text-muted" title={property.name}>
        <span aria-hidden>{propertyIcon(property.type)}</span>
        <span className="truncate">{property.name}</span>
      </dt>
      <dd className="min-w-0">
        {isPrimary ? (
          <input
            defaultValue={row.title}
            aria-label={t(locale, "nameLabel")}
            readOnly={!editable}
            placeholder={t(locale, "untitled")}
            onBlur={(event) =>
              event.target.value !== row.title && onRenamePrimary(event.target.value)
            }
            className="focus-ring u-colors w-full rounded-sm bg-transparent outline-none placeholder:text-muted"
          />
        ) : computed !== undefined ? (
          <span className="text-muted">{computed}</span>
        ) : (
          <Cell
            locale={locale}
            property={property}
            value={value}
            relationOptions={relationOptions}
            peopleOptions={peopleOptions}
            workspaceId={workspaceId}
            editable={editable}
            onChange={onChange}
          />
        )}
      </dd>
    </div>
  );
}

/**
 * The side peek panel.
 *
 * The parent owns when the drawer mounts and when it has finished entering, so
 * the exit animation can play after the selection clears. Everything the panel
 * renders is passed in already resolved: the row, its dependency/sub-issue
 * summaries, the relation counts, and the per-property value accessors.
 */
export function DatabasePeek({
  row,
  locale,
  workspaceSlug,
  rowColor,
  entered,
  onClose,
  dependencySummary,
  blockedByTitles,
  subItemCount,
  collapsed,
  onToggleCollapse,
  rollupText,
  isNested,
  onPromote,
  mutualRelations,
  properties,
  primaryId,
  computedFor,
  valueFor,
  relationOptionsFor,
  peopleOptions,
  workspaceId,
  editable,
  onChange,
  onRenamePrimary,
}: {
  row: DBRow;
  locale: string;
  workspaceSlug: string;
  rowColor: string | null;
  entered: boolean;
  onClose: () => void;
  dependencySummary: string;
  blockedByTitles: string[];
  subItemCount: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  rollupText: string | null;
  isNested: boolean;
  onPromote: () => void;
  mutualRelations: number;
  properties: DBProperty[];
  primaryId: string | null;
  computedFor: (property: DBProperty) => string | undefined;
  valueFor: (propertyId: string) => unknown;
  relationOptionsFor: (propertyId: string) => { id: string; title: string; icon: string | null }[];
  peopleOptions: { id: string; name: string }[];
  workspaceId: string;
  editable: boolean;
  onChange: (propertyId: string, value: unknown) => void;
  onRenamePrimary: (text: string) => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // A dialog must own Escape even when focus has not moved inside it yet (the
  // row trigger keeps focus after the click). Focusing the panel also gives
  // keyboard users a predictable starting point for the property grid.
  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <FloatingHostProvider>
      {/* Token scrim: `--overlay` at `Z.overlay`, fading with `--dur-3`. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="peek-scrim"
        onClick={onClose}
        className={cn("focus-ring", peekScrimClass())}
        style={peekScrimStyle(entered)}
      />
      {/* `.surface-raised` supplies bg + border + `--shadow-2` + radius; the
          panel rides `animate-slide-in-right` in and mirrors that out. */}
      <aside
        ref={panelRef}
        tabIndex={-1}
        data-testid="peek-drawer"
        data-state={entered ? "open" : "closed"}
        role="dialog"
        aria-modal="false"
        aria-label={t(locale, "rowLabel")}
        className={cn(
          "surface-raised scrollbar-thin fixed inset-y-0 right-0 w-[26rem] max-w-full overflow-y-auto p-5 outline-none",
          "focus-ring",
          peekPanelClass(entered),
        )}
        style={peekPanelStyle(entered)}
      >
        <PeekHeader
          row={row}
          locale={locale}
          workspaceSlug={workspaceSlug}
          rowColor={rowColor}
          onClose={onClose}
        />
        <h2 className="mb-4 text-xl font-semibold">
          {row.icon ? `${row.icon} ` : ""}
          {row.title || t(locale, "untitled")}
        </h2>
        {/* R89.31 — the open row's dependency indicator: what blocks it and
            what it blocks, resolved to titles where the view has them. Blank
            (and rendered nothing) until the caller supplies edges. */}
        {dependencySummary !== "" && (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-muted">
            <Ban className="h-3.5 w-3.5" aria-hidden />
            <span>{dependencySummary}</span>
          </p>
        )}
        {blockedByTitles.length > 0 && (
          <p className="mb-2 text-xs text-muted">
            {t(locale, "relationBlockedBy")}: {blockedByTitles.join(", ")}
          </p>
        )}
        {/* R89.30 — sub-issue controls: fold children, read the rolled-up
            estimate/done state, or promote a nested row to the top level.
            No-ops until rows carry a `parentId`. */}
        {subItemCount > 0 && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="focus-ring u-colors mb-2 flex items-center gap-1.5 rounded-sm text-xs text-accent hover:underline"
          >
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", !collapsed && "rotate-90")}
            />
            {collapsed ? t(locale, "toggleExpand") : t(locale, "toggleCollapse")} (
            {subItemCount} {t(locale, "subTicketMany")})
          </button>
        )}
        {rollupText !== null && <p className="mb-2 text-xs text-muted">{rollupText}</p>}
        {isNested && (
          <button
            type="button"
            aria-label={t(locale, "subticketsHeading")}
            title={t(locale, "subticketsHeading")}
            onClick={onPromote}
            className="focus-ring u-colors mb-2 flex items-center gap-1.5 rounded-sm text-xs text-accent hover:underline"
          >
            ↥
          </button>
        )}
        {mutualRelations > 0 && (
          <p className="mb-2 text-xs text-muted">
            ↔ {mutualRelations} {t(locale, "relationsHeading")}
          </p>
        )}
        {/* Properties panel: one labelled row per property, editable in
            place — computed values (formula, rollup, system) stay read-only.
            Each row carries the same hover tint + rail as a table body row. */}
        <dl className="divide-y divide-border border-t border-border text-sm">
          {properties.map((property) => (
            <PeekRow
              key={property.id}
              locale={locale}
              property={property}
              row={row}
              isPrimary={property.id === primaryId}
              computed={computedFor(property)}
              value={valueFor(property.id)}
              relationOptions={relationOptionsFor(property.id)}
              peopleOptions={peopleOptions}
              workspaceId={workspaceId}
              editable={editable}
              onChange={(value) => onChange(property.id, value)}
              onRenamePrimary={onRenamePrimary}
            />
          ))}
        </dl>
      </aside>
    </FloatingHostProvider>
  );
}
