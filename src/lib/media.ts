/**
 * Pure media helpers — drag-drop upload progress, image resize-handle maths
 * and media alignment. Dependency-free so vitest owns the behaviour and the
 * node views only do DOM wiring (LOOP_PLAYBOOK: new logic starts as a lib).
 */

export type MediaAlign = "left" | "center" | "right";

/** The image block never shrinks below this fraction of the content width. */
export const MIN_IMAGE_WIDTH_PERCENT = 15;

/**
 * Upload progress as a whole percent, clamped to 0..100.
 * A missing/unknown length (`total <= 0`, the XHR `lengthComputable: false`
 * case) reports 0 — renderers treat that as an indeterminate indicator.
 */
export function uploadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  if (loaded <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}

/**
 * Turn a handle drag into a width percent for the image block.
 * `deltaX` is the pointer travel in px, `containerWidth` the measured block
 * width; an unmeasurable container keeps the starting size instead of
 * collapsing the image.
 */
export function resizeWidthPercent(input: {
  startPercent: number;
  deltaX: number;
  containerWidth: number;
}): number {
  const clamp = (value: number): number =>
    Math.min(100, Math.max(MIN_IMAGE_WIDTH_PERCENT, Math.round(value)));
  const start = clamp(Number.isFinite(input.startPercent) ? input.startPercent : 100);
  if (!Number.isFinite(input.containerWidth) || input.containerWidth <= 0) return start;
  return clamp(start + (input.deltaX / input.containerWidth) * 100);
}

/** Trust nothing stored in a document: unknown alignment falls back to left. */
export function alignOf(value: unknown): MediaAlign {
  return value === "center" || value === "right" ? value : "left";
}

/** Auto margins that push a block-level picture to its aligned edge. */
export function alignStyle(align: MediaAlign): { marginLeft: string; marginRight: string } {
  if (align === "center") return { marginLeft: "auto", marginRight: "auto" };
  if (align === "right") return { marginLeft: "auto", marginRight: "0" };
  return { marginLeft: "0", marginRight: "auto" };
}
