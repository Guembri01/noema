/**
 * Inline-database block shell engine (docs/specs/database-deep.md §1 "Inline
 * database block" — "view config incomplete", height/scroll shell).
 *
 * An inline-database block is an *instance* of a database embedded inside a
 * page. It records two things the renderer needs and the source `DatabaseView`
 * does not own:
 *  - which presentation the instance shows (`display`, a per-instance override
 *    of the source view's type);
 *  - how tall the shell is and, past a threshold, whether it scrolls and
 *    virtualizes its rows (`heightMode` + `heightPx` / `maxRows`).
 *
 * Everything here is pure: no Prisma, no React, no clock, no I/O. Nothing is
 * mutated in place. `parseInlineDatabaseBlock` tolerates junk (it never throws,
 * it normalizes), `validateInlineDatabaseBlock` reports issues against known
 * runtime facts, and the resolvers are total.
 */

import { normalizeViewConfig, type ViewConfig } from "@/lib/database-query";

export const INLINE_DISPLAYS = [
  "table",
  "list",
  "board",
  "gallery",
  "calendar",
  "timeline",
  "chart",
] as const;

export type InlineDisplay = (typeof INLINE_DISPLAYS)[number];

export const INLINE_HEIGHT_MODES = ["auto", "fixed", "full"] as const;

export type InlineHeightMode = (typeof INLINE_HEIGHT_MODES)[number];

export type InlineDatabaseBlock = {
  /** The block's identity inside its parent document. */
  id: string;
  /** The source database page this block is an instance of. */
  databaseId: string;
  /** The bound source view; absent means the source's default/first view. */
  viewId?: string;
  /** The per-instance presentation (overrides the source view's type). */
  display: InlineDisplay;
  /** `auto` grows with content, `fixed` clamps to `heightPx`, `full` fills the viewport. */
  heightMode: InlineHeightMode;
  /** Requested height for `fixed`; ignored by the other modes. */
  heightPx?: number;
  /** Show the instance's title bar above the view. */
  showTitle?: boolean;
  /** Show the source view's tab bar inside the block. */
  showViewsBar?: boolean;
  /** In `auto` mode, grow up to this many rows before scrolling; also the virtual window size. */
  maxRows?: number;
};

/** The pixel height a single row occupies when no measured height is known. */
export const DEFAULT_ROW_HEIGHT = 32;
/** Default `fixed` height when the block does not name one. */
export const DEFAULT_HEIGHT_PX = 420;
/** A shell is never laid out shorter than this. */
export const MIN_HEIGHT_PX = 120;
/** A `fixed` shell is never laid out taller than this. */
export const MAX_HEIGHT_PX = 1200;
/** Rows kept on either side of the visible window when virtualizing. */
export const DEFAULT_OVERSCAN = 4;
/** Visible rows assumed when a block does not cap them. */
export const DEFAULT_VISIBLE_ROWS = 25;
/** Rows beyond this many screens of content are virtualized, not just scrolled. */
const VIRTUAL_SCREENS = 2;

const DISPLAY_LABELS: Record<InlineDisplay, string> = {
  table: "Table",
  list: "List",
  board: "Board",
  gallery: "Gallery",
  calendar: "Calendar",
  timeline: "Timeline",
  chart: "Chart",
};

/** Row-shaped displays that own a sticky header and row virtualization. */
function isRowDisplay(display: InlineDisplay): boolean {
  return display === "table" || display === "list";
}

function isDisplay(value: unknown): value is InlineDisplay {
  return typeof value === "string" && (INLINE_DISPLAYS as readonly string[]).includes(value);
}

function isHeightMode(value: unknown): value is InlineHeightMode {
  return typeof value === "string" && (INLINE_HEIGHT_MODES as readonly string[]).includes(value);
}

/** A plain object view of an unknown value (`null` for anything else). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A finite, strictly positive integer (floored), or `undefined`. */
function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

/** A boolean passthrough, or `undefined` for anything else. */
function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A finite, non-negative number, or `0`. */
function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Normalize raw stored/patched attrs into a block. Tolerant by design: an
 * unknown `display`/`heightMode` falls back to `"table"`/`"auto"`, malformed
 * numbers and non-boolean flags are dropped, strings are trimmed. Missing or
 * blank identity (`id` / `databaseId`) yields `null` — a block cannot exist
 * without an identity. The input is never mutated.
 */
export function parseInlineDatabaseBlock(raw: unknown): InlineDatabaseBlock | null {
  const record = asRecord(raw);
  if (!record) return null;

  const id = typeof record.id === "string" ? record.id.trim() : "";
  const databaseId = typeof record.databaseId === "string" ? record.databaseId.trim() : "";
  if (id === "" || databaseId === "") return null;

  const block: InlineDatabaseBlock = {
    id,
    databaseId,
    display: isDisplay(record.display) ? record.display : "table",
    heightMode: isHeightMode(record.heightMode) ? record.heightMode : "auto",
  };

  if (typeof record.viewId === "string") {
    const viewId = record.viewId.trim();
    if (viewId !== "") block.viewId = viewId;
  }

  const heightPx = toPositiveInt(record.heightPx);
  if (heightPx !== undefined) block.heightPx = heightPx;

  const showTitle = toBoolean(record.showTitle);
  if (showTitle !== undefined) block.showTitle = showTitle;

  const showViewsBar = toBoolean(record.showViewsBar);
  if (showViewsBar !== undefined) block.showViewsBar = showViewsBar;

  const maxRows = toPositiveInt(record.maxRows);
  if (maxRows !== undefined) block.maxRows = maxRows;

  return block;
}

export type InlineDatabaseIssueCode =
  | "empty_id"
  | "empty_database_id"
  | "missing_database"
  | "unknown_view"
  | "unknown_display"
  | "invalid_height_mode"
  | "invalid_height_px"
  | "invalid_max_rows";

export type InlineDatabaseIssue = {
  code: InlineDatabaseIssueCode;
  message: string;
};

export type InlineDatabaseValidation = {
  valid: boolean;
  issues: InlineDatabaseIssue[];
};

export type InlineDatabaseValidationContext = {
  /** Whether the source database exists (a dangling pointer is reported). */
  exists: (databaseId: string) => boolean;
  /**
   * Optional: whether the bound source view still exists. Omitted when the
   * caller cannot resolve views; the check is then skipped (never assumed).
   */
  viewExists?: (databaseId: string, viewId: string) => boolean;
};

/**
 * Validate a block against known runtime facts. Returns every issue it can see
 * (not just the first) plus a `valid` flag: broken identity, a dangling
 * database, a missing bound source view (only when a checker is provided), an
 * unknown display, or a bad height. Known-but-out-of-range numbers are the only
 * value checks; the resolvers clamp the rest.
 */
export function validateInlineDatabaseBlock(
  block: InlineDatabaseBlock,
  context: InlineDatabaseValidationContext,
): InlineDatabaseValidation {
  const issues: InlineDatabaseIssue[] = [];

  const id = typeof block.id === "string" ? block.id : "";
  const databaseId = typeof block.databaseId === "string" ? block.databaseId : "";

  if (id === "") {
    issues.push({ code: "empty_id", message: "Block id is required" });
  }
  if (databaseId === "") {
    issues.push({ code: "empty_database_id", message: "databaseId is required" });
  }

  const databaseKnown = databaseId !== "" && context.exists(databaseId);
  if (databaseId !== "" && !databaseKnown) {
    issues.push({
      code: "missing_database",
      message: `Database "${databaseId}" does not exist`,
    });
  }
  if (
    typeof block.viewId === "string" &&
    block.viewId !== "" &&
    databaseKnown &&
    context.viewExists !== undefined &&
    !context.viewExists(databaseId, block.viewId)
  ) {
    issues.push({
      code: "unknown_view",
      message: `View "${block.viewId}" does not exist`,
    });
  }

  if (!isDisplay(block.display)) {
    issues.push({
      code: "unknown_display",
      message: `Unknown display "${String(block.display)}"`,
    });
  }
  if (!isHeightMode(block.heightMode)) {
    issues.push({
      code: "invalid_height_mode",
      message: `Unknown height mode "${String(block.heightMode)}"`,
    });
  }
  if (block.heightPx !== undefined && toPositiveInt(block.heightPx) === undefined) {
    issues.push({
      code: "invalid_height_px",
      message: `heightPx must be a positive number, got "${String(block.heightPx)}"`,
    });
  }
  if (block.maxRows !== undefined && toPositiveInt(block.maxRows) === undefined) {
    issues.push({
      code: "invalid_max_rows",
      message: `maxRows must be a positive number, got "${String(block.maxRows)}"`,
    });
  }

  return { valid: issues.length === 0, issues };
}

export type ShellContext = {
  /** The natural height of the instance's rows, in pixels. */
  contentHeight: number;
  /** The height of the surrounding viewport, in pixels (`0` when unknown). */
  viewportHeight: number;
};

export type ShellLayout = {
  /** A CSS height value: `"auto"` or an explicit `"<n>px"`. */
  heightCss: string;
  /** The content overflows the shell and needs an internal scroll region. */
  scroll: boolean;
  /** The block's header stays pinned while its own scroll region moves. */
  stickyHeader: boolean;
  /** Rows should be windowed rather than all mounted. */
  virtual: boolean;
};

/**
 * Resolve the shell layout for a block:
 *  - `auto`  — grow with the content; with a `maxRows` cap, clamp to
 *    `maxRows * DEFAULT_ROW_HEIGHT` and scroll past it;
 *  - `fixed` — a clamped `heightPx` (default {@link DEFAULT_HEIGHT_PX}), never
 *    taller than the viewport;
 *  - `full`  — fill the viewport (at least {@link MIN_HEIGHT_PX}).
 * A row display (table/list) pins its header and — once the content passes two
 * screens — virtualizes its rows; other displays never do.
 */
export function resolveShell(block: InlineDatabaseBlock, context: ShellContext): ShellLayout {
  const content = nonNegative(context.contentHeight);
  const viewport = nonNegative(context.viewportHeight);

  let container: number;
  let heightCss: string;

  if (block.heightMode === "fixed") {
    const requested = toPositiveInt(block.heightPx) ?? DEFAULT_HEIGHT_PX;
    const ceiling = viewport > 0 ? Math.max(MIN_HEIGHT_PX, viewport) : MAX_HEIGHT_PX;
    const clamped = Math.min(Math.max(requested, MIN_HEIGHT_PX), MAX_HEIGHT_PX);
    container = Math.min(clamped, ceiling);
    heightCss = `${container}px`;
  } else if (block.heightMode === "full") {
    container = viewport > 0 ? Math.max(MIN_HEIGHT_PX, viewport) : MIN_HEIGHT_PX;
    heightCss = `${container}px`;
  } else {
    const cap = toPositiveInt(block.maxRows);
    const capPx = cap !== undefined ? cap * DEFAULT_ROW_HEIGHT : Number.POSITIVE_INFINITY;
    if (content > capPx) {
      container = capPx;
      heightCss = `${container}px`;
    } else {
      container = content;
      heightCss = "auto";
    }
  }

  const scroll = content > container;
  const rowDisplay = isRowDisplay(block.display);
  const stickyHeader = rowDisplay && scroll;
  const virtual = rowDisplay && scroll && content > container * VIRTUAL_SCREENS;

  return { heightCss, scroll, stickyHeader, virtual };
}

export type InlineViewSource = ViewConfig & { type?: string };

export type ResolvedInlineView = ViewConfig & { display: InlineDisplay };

/**
 * The effective view config an instance renders: the normalized source view
 * config with the block's per-instance `display` layered on top. Unknown source
 * keys (including the source's `type`, which `ViewConfig` does not carry) are
 * dropped by the shared normalizer, so a malformed config never reaches a
 * renderer. Neither argument is mutated.
 */
export function resolveViewConfig(
  block: InlineDatabaseBlock,
  databaseViewConfig?: InlineViewSource | null,
): ResolvedInlineView {
  const normalized = normalizeViewConfig(databaseViewConfig ?? {});
  return { ...normalized, display: block.display };
}

export type RowWindowContext = {
  /** The scroll region's offset from the top, in pixels. */
  scrollTop: number;
  /** The measured row height, in pixels (falls back to {@link DEFAULT_ROW_HEIGHT}). */
  rowHeight: number;
  /** Extra rows kept on each side of the viewport (falls back to {@link DEFAULT_OVERSCAN}). */
  overscan?: number;
};

export type RowWindow = {
  /** First mounted index (inclusive). */
  start: number;
  /** One past the last mounted index (exclusive). */
  end: number;
  /** `end - start`. */
  count: number;
  /** The overscan actually applied. */
  overscan: number;
};

/**
 * The visible index range a virtualized shell should mount. The window size is
 * the block's `maxRows` (the same count the `auto` shell grows to) or
 * {@link DEFAULT_VISIBLE_ROWS}; the visible rows are derived from `scrollTop`
 * and `rowHeight`, then padded by `overscan` on both sides. `start` is clamped
 * to `0`; `end` is not clamped to a row count, which the caller owns.
 */
export function rowWindow(block: InlineDatabaseBlock, context: RowWindowContext): RowWindow {
  const rowHeight = toPositiveInt(context.rowHeight) ?? DEFAULT_ROW_HEIGHT;
  const overscan =
    typeof context.overscan === "number" &&
    Number.isFinite(context.overscan) &&
    context.overscan >= 0
      ? Math.floor(context.overscan)
      : DEFAULT_OVERSCAN;
  const scrollTop =
    typeof context.scrollTop === "number" &&
    Number.isFinite(context.scrollTop) &&
    context.scrollTop > 0
      ? context.scrollTop
      : 0;
  const visible = toPositiveInt(block.maxRows) ?? DEFAULT_VISIBLE_ROWS;

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = firstVisible + visible + overscan;

  return { start, end, count: end - start, overscan };
}

/**
 * A human-readable label for a block. Locale-independent (the caller wraps it
 * for display); deterministic so tests and logs can assert on it.
 */
export function describeInlineDatabase(block: InlineDatabaseBlock): string {
  const label = DISPLAY_LABELS[block.display] ?? "Table";
  const view =
    typeof block.viewId === "string" && block.viewId !== ""
      ? `view ${block.viewId}`
      : "default view";

  const details: string[] = ["auto height"];
  if (block.heightMode === "fixed") {
    const heightPx = toPositiveInt(block.heightPx) ?? DEFAULT_HEIGHT_PX;
    details[0] = `fixed ${heightPx}px`;
  } else if (block.heightMode === "full") {
    details[0] = "full height";
  }
  const maxRows = toPositiveInt(block.maxRows);
  if (maxRows !== undefined) details.push(`max ${maxRows} rows`);
  if (block.showTitle) details.push("title");
  if (block.showViewsBar) details.push("views bar");

  return `${label} inline database of ${block.databaseId} via ${view} (${block.id}; ${details.join(", ")})`;
}
