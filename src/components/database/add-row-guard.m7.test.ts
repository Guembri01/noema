/**
 * P2-T10 (M7) — the "New row" in-flight guard.
 *
 * `addRow` used to wrap the create bare in a transition with no in-flight
 * guard, and transitions do not dedupe server actions — a rapid double click
 * wrote two whole rows (2+N writes when a default template prefilled cells).
 * The guard lives in `./add-row-guard` as a pure ref seam so this suite can
 * drive the real logic without a DOM:
 *
 *  1. single-flight ledger — the first click claims the slot and runs the
 *     create; a click while pending is dropped, so `createRowAction` fires
 *     exactly once (the unguarded pre-change shape is modelled as a
 *     documentation case below and provably fires twice);
 *  2. the slot always settles — success or failure — so a failed create never
 *     bricks the button and the next click is a real retry;
 *  3. all five `onAddRow` button sites (toolbar + table/list/board/gallery
 *     empty states) wire `disabled` + `aria-busy`, mirroring the form view's
 *     pending submit (`form-view.tsx`), via `react-dom/server` (no DOM here).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/server/actions/database", () => ({
  deleteTemplateAction: vi.fn(),
}));

import {
  claimRowCreation,
  settleRowCreation,
  type InFlightRef,
} from "./add-row-guard";
import { DatabaseActions } from "./database-actions";
import {
  BoardView,
  GalleryView,
  ListView,
  TableView,
} from "./view-renderers";
import type { DBProperty, DBRow, HeaderConfig } from "./database-types";

const properties: DBProperty[] = [
  { id: "title", name: "Title", type: "TEXT", config: { primary: true } },
];

const rows: DBRow[] = [];

const noop = () => {};

const headerConfig: HeaderConfig = {
  databases: [],
  relations: [],
  relationData: {},
  onLinkDatabase: noop,
  onConfigureRollup: noop,
  onSetRelationMulti: noop,
  onToggleTwoWay: noop,
};

/** Drain pending microtasks/macrotasks instead of hard-coding tick counts. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The component's exact wiring, modelled: claim outside the transition, the
 * task inside it, the settle mirrored into `finally` so failure resets too. */
const clickAddRow = (
  ref: InFlightRef,
  run: () => Promise<unknown>,
  onPending?: (pending: boolean) => void,
): Promise<unknown> | false => {
  if (!claimRowCreation(ref, onPending)) return false;
  return Promise.resolve()
    .then(run)
    .catch(() => {})
    .finally(() => settleRowCreation(ref, onPending));
};

describe("add-row guard — single-flight ledger", () => {
  it("without a guard a rapid double click reaches the create twice", async () => {
    // The pre-change shape: two transitions, no in-flight guard. Transitions
    // do not dedupe server actions, so both clicks land the create.
    let createCalls = 0;
    const run = async () => {
      createCalls += 1;
    };
    void Promise.resolve().then(run);
    void Promise.resolve().then(run);
    await settle();
    expect(createCalls).toBe(2);
  });

  it("fires the create exactly once across a rapid double click", async () => {
    let createCalls = 0;
    const pendings: boolean[] = [];
    const ref: InFlightRef = { current: false };
    const run = async () => {
      await settle();
      createCalls += 1;
    };

    const first = clickAddRow(ref, run, (p) => pendings.push(p));
    const second = clickAddRow(ref, run, (p) => pendings.push(p));
    expect(second).toBe(false); // second click dropped while pending

    await first; // settle the guarded create
    await settle();

    expect(pendings).toEqual([true, false]); // busy flag raised and settled
    expect(createCalls).toBe(1); // exactly one row, not two
  });

  it("settles the guard after a rejected create, so retry is possible", async () => {
    const ref: InFlightRef = { current: false };
    await clickAddRow(ref, async () => {
      throw new Error("create failed");
    });
    expect(ref.current).toBe(false); // `finally` released the slot
    expect(claimRowCreation(ref)).toBe(true); // next click is a real retry
    settleRowCreation(ref, undefined);
  });
});

describe("add-row guard — button wiring (disabled + aria-busy, like form-view)", () => {
  const actionsProps = {
    locale: "en",
    editable: true,
    nestSubItems: false,
    onToggleNest: noop,
    blockedRowCount: 0,
    canToggleLock: true,
    lockLabel: "Schema open",
    schemaLockedState: false,
    showReadOnlyLock: false,
    onToggleLock: noop,
    onAddRow: noop,
    defaultTemplateName: null,
    templates: [],
    onAddRowFromTemplate: noop,
    onToggleDeletedRows: noop,
    onNewProperty: noop,
    onDuplicateDatabase: noop,
    databasePageId: "db1",
    onImportCsv: noop,
  };

  const renderEmptyTable = (pending: boolean) =>
    renderToStaticMarkup(
      createElement(TableView, {
        locale: "en",
        workspaceSlug: "w",
        workspaceId: "ws",
        properties,
        rows,
        primary: properties[0],
        editable: false,
        config: {},
        valueFor: noop,
        setValue: noop,
        setPrimary: noop,
        removeRow: noop,
        onSaveTemplate: noop,
        computedFor: () => undefined,
        relationOptionsFor: () => [],
        peopleOptions: [],
        headerConfig,
        onRunButton: noop,
        onConfigureButton: noop,
        onOpenPeek: noop,
        onRunAi: noop,
        colorOf: () => null,
        onEditFormula: noop,
        onSetFormat: noop,
        onEditOptions: noop,
        editingProperty: null,
        setEditingProperty: noop,
        onDeleteProperty: noop,
        onRenameProperty: noop,
        onDuplicateProperty: noop,
        onReorderProperty: noop,
        onAddRow: noop,
        addRowPending: pending,
      }),
    );

  const renderEmptyList = (pending: boolean) =>
    renderToStaticMarkup(
      createElement(ListView, {
        locale: "en",
        workspaceSlug: "w",
        properties,
        rows,
        valueFor: noop,
        editable: false,
        onAddRow: noop,
        addRowPending: pending,
      }),
    );

  const renderEmptyBoard = (pending: boolean) =>
    renderToStaticMarkup(
      createElement(BoardView, {
        locale: "en",
        workspaceSlug: "w",
        workspaceId: "ws",
        properties: [
          ...properties,
          { id: "status", name: "Status", type: "STATUS", config: { options: [] } },
        ] as DBProperty[],
        rows,
        colorOf: () => null,
        groupBy: "status",
        primary: properties[0],
        valueFor: noop,
        setValue: noop,
        editable: false,
        onAddRow: noop,
        addRowPending: pending,
      }),
    );

  const renderEmptyGallery = (pending: boolean) =>
    renderToStaticMarkup(
      createElement(GalleryView, {
        locale: "en",
        workspaceSlug: "w",
        properties,
        rows,
        primary: properties[0],
        valueFor: noop,
        onAddRow: noop,
        addRowPending: pending,
      }),
    );

  it("renders the toolbar button busy while the create is in flight", () => {
    expect(
      renderToStaticMarkup(
        createElement(DatabaseActions, {
          ...actionsProps,
          addRowPending: true,
        }),
      ),
    ).toMatch(/<button[^>]*aria-busy="true"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  it("renders the toolbar button clickable when the guard is settled", () => {
    const html = renderToStaticMarkup(createElement(DatabaseActions, actionsProps));
    const newButton = html.match(/<button[^>]*aria-label="New row"[^>]*>/)?.[0] ?? "";
    expect(newButton).toContain('aria-label="New row"');
    expect(newButton).not.toContain("aria-busy");
    expect(newButton).not.toContain('disabled=""');
  });

  it("marks each view's empty-state add button busy while pending", () => {
    const busyButton = /aria-busy="true"[^>]*disabled=""|disabled=""[^>]*aria-busy="true"/;
    for (const html of [
      renderEmptyTable(true),
      renderEmptyList(true),
      renderEmptyBoard(true),
      renderEmptyGallery(true),
    ]) {
      expect(html).toMatch(/<button[^>]*data-testid=".*-add-row"/);
      const button = html.match(/<button[^>]*data-testid=".*-add-row"[^>]*>/)?.[0] ?? "";
      expect(button).toMatch(busyButton);
    }
  });

  it("keeps each view's empty-state add button clickable when settled", () => {
    for (const html of [
      renderEmptyTable(false),
      renderEmptyList(false),
      renderEmptyBoard(false),
      renderEmptyGallery(false),
    ]) {
      const button = html.match(/<button[^>]*data-testid=".*-add-row"[^>]*>/)?.[0] ?? "";
      expect(button).toContain('-add-row');
      expect(button).not.toContain('aria-busy="true"');
      expect(button).not.toContain('disabled=""');
    }
  });
});
