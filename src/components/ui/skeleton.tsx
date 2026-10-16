import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Loading skeletons — the `loading` half of the states contract in
 * docs/DESIGN_SYSTEM.md §8.
 *
 * Every variant is sized to match the layout it stands in for (a 20px text
 * line, a 36px table row, …) so nothing shifts when the data lands. The fill is
 * the token gradient from the existing `.notion-skeleton` utility (surface →
 * surface-2 → surface) with the design-system `animate-shimmer` token applied
 * alongside it; the global `prefers-reduced-motion` rule neutralises both.
 */

/** The shared fill: token gradient + the sanctioned shimmer animation. */
export const SKELETON_FILL = "notion-skeleton animate-shimmer";

/** The `text` variant renders between one and three lines. */
export const SKELETON_TEXT_MAX_LINES = 3;

/** A paragraph's last line — and a lone line — is 60% wide. */
export const SKELETON_LAST_LINE_WIDTH = "60%";

/** Table header cells read as shorter bars so the header is distinguishable. */
export const SKELETON_HEADER_WIDTH = "40%";

/** Upper bounds keep a bad `rows`/`cols` from rendering an unbounded tree. */
export const SKELETON_MAX_TABLE_ROWS = 50;
export const SKELETON_MAX_TABLE_COLS = 12;

/** Clamp a line count to the 1–3 range the `text` variant renders. */
export function skeletonLineCount(lines: number): number {
  if (!Number.isFinite(lines)) return 1;
  return Math.min(SKELETON_TEXT_MAX_LINES, Math.max(1, Math.trunc(lines)));
}

/**
 * Widths (CSS percentages) for a `text` skeleton: every line full width except
 * the last, which is {@link SKELETON_LAST_LINE_WIDTH}. Pure, so the node tests
 * can pin the shape that keeps the real copy from shifting the layout.
 */
export function skeletonLineWidths(lines: number): string[] {
  const count = skeletonLineCount(lines);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? SKELETON_LAST_LINE_WIDTH : "100%",
  );
}

function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Row plan for the `table` variant: a header row of narrower bars, then `rows`
 * body rows of `cols` full-width cells. Pure, so tests pin the geometry (row
 * heights mirror the real `h-9` table rows) that avoids a jump on load.
 */
export function skeletonTableRows(rows: number, cols: number): string[][] {
  const rowCount = clampInt(rows, 1, SKELETON_MAX_TABLE_ROWS, 3);
  const colCount = clampInt(cols, 1, SKELETON_MAX_TABLE_COLS, 3);
  const header = Array.from({ length: colCount }, () => SKELETON_HEADER_WIDTH);
  const body = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => "100%"),
  );
  return [header, ...body];
}

/** One shimmering bar. `aria-hidden` — a skeleton never reaches a screen reader. */
function Bar({ className, style, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <span
      aria-hidden
      className={cn(SKELETON_FILL, "block rounded-sm", className)}
      style={style}
      {...rest}
    />
  );
}

export type SkeletonVariant =
  | "text"
  | "block"
  | "circle"
  | "card"
  | "row"
  | "table";

export interface SkeletonProps extends HTMLAttributes<HTMLElement> {
  /** Which layout to stand in for. Defaults to `text`. */
  variant?: SkeletonVariant;
  /** `text` only: line count, clamped to 1–3. */
  lines?: number;
  /** `table` only: body rows (the header row is added on top). */
  rows?: number;
  /** `table` only: columns. */
  cols?: number;
  /** `block` / `circle`: explicit width (a number is treated as px). */
  width?: number | string;
  /** `block` / `circle`: explicit height (a number is treated as px). */
  height?: number | string;
}

/**
 * A layout-shaped loading placeholder.
 *
 * ```tsx
 * <Skeleton variant="text" lines={3} />
 * <Skeleton variant="table" rows={5} cols={4} />
 * ```
 */
export function Skeleton({
  variant = "text",
  lines,
  rows,
  cols,
  width,
  height,
  className,
  style,
  ...rest
}: SkeletonProps) {
  switch (variant) {
    case "block":
      return (
        <Bar
          className={cn("h-4 w-full", className)}
          style={{ width, height, ...style }}
          {...rest}
        />
      );

    case "circle":
      return (
        <Bar
          className={cn("size-8 rounded-full", className)}
          style={{
            width: width ?? height,
            height: height ?? width,
            ...style,
          }}
          {...rest}
        />
      );

    case "card":
      return (
        <div
          aria-hidden
          data-skeleton="card"
          className={cn(
            "rounded-md border border-border bg-bg p-4 shadow-1",
            className,
          )}
          style={style}
          {...rest}
        >
          <div className="flex items-center gap-3">
            <Bar className="size-8 rounded-full" />
            <Bar className="h-3" style={{ width: "45%" }} />
          </div>
          <div className="mt-4">
            {skeletonLineWidths(3).map((lineWidth, index) => (
              <div key={index} className="flex h-5 items-center">
                <Bar className="h-3" style={{ width: lineWidth }} />
              </div>
            ))}
          </div>
        </div>
      );

    case "row":
      return (
        <div
          aria-hidden
          data-skeleton="row"
          className={cn(
            "flex h-9 items-center gap-3 border-b border-border px-2",
            className,
          )}
          style={style}
          {...rest}
        >
          <Bar className="size-4 rounded-sm" />
          <Bar className="h-3 flex-1" />
          <Bar className="h-3 w-20" />
          <Bar className="h-3 w-12" />
        </div>
      );

    case "table":
      return (
        <div
          aria-hidden
          data-skeleton="table"
          className={cn(
            "w-full overflow-hidden rounded-md border border-border",
            className,
          )}
          style={style}
          {...rest}
        >
          {skeletonTableRows(rows ?? 3, cols ?? 3).map((cells, rowIndex) => (
            <div
              key={rowIndex}
              className={cn(
                "flex h-9 items-center gap-3 border-b border-border px-2 last:border-b-0",
                rowIndex === 0 && "bg-surface-2",
              )}
            >
              {cells.map((cellWidth, colIndex) => (
                <div key={colIndex} className="min-w-0 flex-1">
                  <Bar className="h-3" style={{ width: cellWidth }} />
                </div>
              ))}
            </div>
          ))}
        </div>
      );

    case "text":
    default:
      return (
        <div
          aria-hidden
          data-skeleton="text"
          className={cn("w-full", className)}
          style={style}
          {...rest}
        >
          {skeletonLineWidths(lines ?? 1).map((lineWidth, index) => (
            <div key={index} className="flex h-5 items-center">
              <Bar className="h-3" style={{ width: lineWidth }} />
            </div>
          ))}
        </div>
      );
  }
}
