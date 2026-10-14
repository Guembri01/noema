import { describe, expect, it } from "vitest";
import { alignOf, alignStyle, resizeWidthPercent, uploadPercent } from "@/lib/media";

/**
 * B20 — pure media helpers:
 *  - upload progress math for the drag-drop progress indicator,
 *  - the image resize-handle maths (shared by the node view and any caller),
 *  - alignment sanitisation/styling for the media align controls.
 */
describe("media helpers", () => {
  it("reports upload progress as a clamped, rounded percent", () => {
    expect(uploadPercent(0, 100)).toBe(0);
    expect(uploadPercent(50, 100)).toBe(50);
    expect(uploadPercent(1, 3)).toBe(33);
    expect(uploadPercent(299, 300)).toBe(100);
    // Unknown/absent length (XHR lengthComputable false) → indeterminate (0).
    expect(uploadPercent(10, 0)).toBe(0);
    expect(uploadPercent(10, -1)).toBe(0);
    // Over-report and underflow must stay inside 0..100.
    expect(uploadPercent(500, 100)).toBe(100);
    expect(uploadPercent(-5, 100)).toBe(0);
    expect(uploadPercent(Number.NaN, 100)).toBe(0);
  });

  it("converts a handle drag into a width percent inside the block", () => {
    expect(resizeWidthPercent({ startPercent: 50, deltaX: 100, containerWidth: 400 })).toBe(75);
    expect(resizeWidthPercent({ startPercent: 50, deltaX: -100, containerWidth: 400 })).toBe(25);
    // Rounds to whole percents — the attribute stays a readable number.
    expect(resizeWidthPercent({ startPercent: 50, deltaX: 33, containerWidth: 400 })).toBe(58);
    // Clamped at both ends (15%..100%)…
    expect(resizeWidthPercent({ startPercent: 95, deltaX: 500, containerWidth: 400 })).toBe(100);
    expect(resizeWidthPercent({ startPercent: 10, deltaX: -500, containerWidth: 400 })).toBe(15);
    // …and when the container cannot be measured yet, the start value survives.
    expect(resizeWidthPercent({ startPercent: 50, deltaX: 40, containerWidth: 0 })).toBe(50);
    expect(resizeWidthPercent({ startPercent: 900, deltaX: 0, containerWidth: 0 })).toBe(100);
  });

  it("sanitises the stored alignment value", () => {
    expect(alignOf("center")).toBe("center");
    expect(alignOf("right")).toBe("right");
    expect(alignOf("left")).toBe("left");
    expect(alignOf("justify")).toBe("left");
    expect(alignOf(null)).toBe("left");
    expect(alignOf(undefined)).toBe("left");
    expect(alignOf(42)).toBe("left");
  });

  it("turns an alignment into auto margins for the picture", () => {
    expect(alignStyle("left")).toEqual({ marginLeft: "0", marginRight: "auto" });
    expect(alignStyle("center")).toEqual({ marginLeft: "auto", marginRight: "auto" });
    expect(alignStyle("right")).toEqual({ marginLeft: "auto", marginRight: "0" });
  });
});
