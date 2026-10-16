import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PROGRESS_SIZE_CLASS,
  PROGRESS_TONE_CLASS,
  PROGRESS_TONE_TEXT,
  PROGRESS_TRACK_CLASS,
  PROGRESS_TRACK_STROKE,
  Progress,
  ProgressRing,
  clampPercent,
  progressPercent,
  ringGeometry,
  type ProgressProps,
  type ProgressRingProps,
  type ProgressSize,
  type ProgressTone,
} from "./progress";

/**
 * ds04 — the progress mappings (percentage clamp, size→height, tone→colour and
 * the ring geometry) plus a render check for every variant and state.
 */

const renderBar = (props: ProgressProps = {}) =>
  renderToStaticMarkup(createElement(Progress, props));
const renderRing = (props: ProgressRingProps = {}) =>
  renderToStaticMarkup(createElement(ProgressRing, props));

const TONES = Object.keys(PROGRESS_TONE_CLASS) as ProgressTone[];
const SIZES = Object.keys(PROGRESS_SIZE_CLASS) as ProgressSize[];

describe("clampPercent", () => {
  it("clamps to 0–100", () => {
    expect(clampPercent(-20)).toBe(0);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(37.5)).toBe(37.5);
    expect(clampPercent(100)).toBe(100);
    expect(clampPercent(180)).toBe(100);
  });

  it("treats null/NaN as zero", () => {
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("progressPercent", () => {
  it("scales a value by its max", () => {
    expect(progressPercent(50)).toBe(50);
    expect(progressPercent(3, 4)).toBe(75);
    expect(progressPercent(200)).toBe(100);
  });

  it("guards a zero/negative/invalid max", () => {
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(5, -1)).toBe(0);
    expect(progressPercent(5, Number.NaN)).toBe(0);
    expect(progressPercent(null, 10)).toBe(0);
  });
});

describe("ringGeometry", () => {
  it("derives radius, circumference and dash offset", () => {
    const g = ringGeometry(48, 4, 50);
    expect(g.center).toBe(24);
    expect(g.radius).toBe(22);
    expect(g.circumference).toBeCloseTo(2 * Math.PI * 22, 6);
    expect(g.offset).toBeCloseTo(g.circumference / 2, 6);
  });

  it("clamps the offset for out-of-range input", () => {
    const full = ringGeometry(48, 4, 100);
    const empty = ringGeometry(48, 4, -10);
    expect(full.offset).toBeCloseTo(0, 6);
    expect(empty.offset).toBeCloseTo(empty.circumference, 6);
  });
});

describe("progress maps", () => {
  it("orders the sizes and keeps tones/colour maps aligned", () => {
    expect(SIZES).toEqual(["xs", "sm", "md", "lg"]);
    expect(Object.keys(PROGRESS_TONE_TEXT).sort()).toEqual([...TONES].sort());
    expect(Object.values(PROGRESS_TONE_CLASS).every((c) => c.startsWith("bg-"))).toBe(true);
    expect(PROGRESS_TRACK_CLASS).toBe("bg-surface-2");
    expect(PROGRESS_TRACK_STROKE).toBe("stroke-surface-2");
  });
});

describe("Progress markup", () => {
  it("renders a determinate bar with the right aria and width", () => {
    const html = renderBar({ value: 30, tone: "success" });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuetext="30%"');
    expect(html).toMatch(/width:\s*30%/);
    expect(html).toContain(PROGRESS_TONE_CLASS.success);
  });

  it("renders an indeterminate bar with the shimmer and no value", () => {
    const html = renderBar({ label: "Importing…" });
    expect(html).toContain("animate-shimmer");
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain('aria-label="Importing…"');
  });

  it("shows a label and a rounded percentage", () => {
    const html = renderBar({ value: 33.4, label: "Upload", showValue: true });
    expect(html).toContain("Upload");
    expect(html).toContain(">33%<");
  });

  it.each(SIZES)("applies the %s size class", (size) => {
    expect(renderBar({ value: 1, size })).toContain(PROGRESS_SIZE_CLASS[size]);
  });

  it.each(TONES)("applies the %s tone class", (tone) => {
    expect(renderBar({ value: 1, tone })).toContain(PROGRESS_TONE_CLASS[tone]);
  });
});

describe("ProgressRing markup", () => {
  it("renders a determinate ring with a dash offset and centre value", () => {
    const html = renderRing({ value: 50, size: 48, stroke: 4, showValue: true });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("stroke-dasharray");
    expect(html).toContain(">50%<");
    expect(html).not.toContain("animate-spin");
  });

  it("spins when indeterminate", () => {
    const html = renderRing({ label: "Thinking" });
    expect(html).toContain("animate-spin");
    expect(html).toContain('aria-label="Thinking"');
    expect(html).not.toContain("aria-valuenow");
  });
});
