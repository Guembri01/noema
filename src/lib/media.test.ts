import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPLOAD_LIMIT_BYTES,
  alignOf,
  alignStyle,
  checkFileSize,
  findOrphanedAssets,
  formatBytes,
  parseSizeLimit,
  resizeWidthPercent,
  summarizeGc,
  uploadPercent,
} from "@/lib/media";

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

/**
 * §15 — upload size limits: a per-workspace cap expressed as "5MB"/"2gb"/raw
 * bytes, checked before the upload starts with a reason the UI can show verbatim.
 */
describe("upload size limits", () => {
  it("parses string forms and raw byte counts into bytes", () => {
    // Unit suffixes are case-insensitive and spaces are tolerated.
    expect(parseSizeLimit("5MB")).toBe(5 * 1024 * 1024);
    expect(parseSizeLimit("2gb")).toBe(2 * 1024 ** 3);
    expect(parseSizeLimit("512kb")).toBe(512 * 1024);
    expect(parseSizeLimit("100 B")).toBe(100);
    expect(parseSizeLimit(" 8 mb ")).toBe(8 * 1024 ** 2);
    // Fractions and IEC spellings work too.
    expect(parseSizeLimit("1.5MB")).toBe(1.5 * 1024 ** 2);
    expect(parseSizeLimit("512MiB")).toBe(512 * 1024 ** 2);
    // Raw byte counts pass through, rounded to a whole byte.
    expect(parseSizeLimit(1024)).toBe(1024);
    expect(parseSizeLimit(1500.6)).toBe(1501);
  });

  it("falls back to the default cap for invalid, zero or negative limits", () => {
    expect(parseSizeLimit("")).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit("banana")).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit("5 elephants")).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit("5 parsecs")).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit("0MB")).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit("-5MB")).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit(0)).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit(-1)).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit(Number.NaN)).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
    expect(parseSizeLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_UPLOAD_LIMIT_BYTES);
  });

  it("accepts a file exactly at the cap and rejects one just over it", () => {
    const limit = parseSizeLimit("5MB");
    const atCap = checkFileSize(limit, limit);
    expect(atCap.ok).toBe(true);
    expect(atCap.reason).toBeNull();
    expect(atCap.overByBytes).toBe(0);
    expect(checkFileSize(1024, limit).ok).toBe(true);
    expect(checkFileSize(0, limit).ok).toBe(true);

    // One byte over the cap is over — the limit is inclusive.
    const justOver = checkFileSize(limit + 1, limit);
    expect(justOver.ok).toBe(false);
    expect(justOver.overByBytes).toBe(1);
  });

  it("explains an over-limit file with both sizes in human form", () => {
    const result = checkFileSize(6 * 1024 ** 2, "5MB");
    expect(result.ok).toBe(false);
    expect(result.limitBytes).toBe(5 * 1024 ** 2);
    expect(result.overByBytes).toBe(1024 ** 2);
    expect(result.reason).toContain("6 MB");
    expect(result.reason).toContain("5 MB");
    expect(result.reason).toContain("1 MB");
  });

  it("rejects unreadable file sizes instead of passing them", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = checkFileSize(bad, "5MB");
      expect(result.ok).toBe(false);
      expect(result.reason).not.toBeNull();
    }
  });

  it("formats byte counts for humans", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2 GB");
    // Nonsense sizes degrade to a safe label rather than NaN.
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

/**
 * §15 — media garbage collection: pure orphan detection + reclaimable-byte
 * math. Actually deleting the storage objects is the caller's job.
 */
describe("media garbage collection", () => {
  const asset = (key: string, bytes?: number) => ({ key, bytes });

  it("returns only unreferenced assets, preserving order and identity", () => {
    const assets = [asset("a", 10), asset("b", 20), asset("c", 30)];
    const orphans = findOrphanedAssets(assets, ["a", "c"]);
    expect(orphans.map((o) => o.key)).toEqual(["b"]);
    // Original row identity is preserved so callers can read url/size off it.
    expect(orphans[0]).toBe(assets[1]);
  });

  it("never returns a referenced asset, even with duplicate keys", () => {
    const assets = [asset("a", 10), asset("a", 10), asset("b", 20)];
    expect(findOrphanedAssets(assets, ["a"]).map((o) => o.key)).toEqual(["b"]);
    // Duplicate unreferenced keys collapse — one storage object, one candidate.
    const dupes = findOrphanedAssets([asset("x", 5), asset("x", 5), asset("b")], []);
    expect(dupes.map((o) => o.key)).toEqual(["x", "b"]);
  });

  it("handles empty asset sets and empty reference sets", () => {
    expect(findOrphanedAssets([], ["a", "b"])).toEqual([]);
    const assets = [asset("a", 1), asset("b", 2)];
    // Nothing referenced → everything is an orphan.
    expect(findOrphanedAssets(assets, []).map((o) => o.key)).toEqual(["a", "b"]);
    // Sets work as well as arrays for the referenced keys.
    expect(findOrphanedAssets(assets, new Set(["a", "b"]))).toEqual([]);
    expect(summarizeGc([], [])).toEqual({
      totalAssets: 0,
      orphanedCount: 0,
      reclaimableBytes: 0,
    });
  });

  it("summarises counts and reclaimable bytes", () => {
    const assets = [asset("a", 100), asset("b", 200), asset("a", 100), asset("c")];
    expect(summarizeGc(assets, ["a"])).toEqual({
      totalAssets: 4,
      orphanedCount: 2, // b + c; the duplicate "a" row is referenced, "c" lacks a size.
      reclaimableBytes: 200, // unknown sizes count as 0 bytes.
    });
    // Duplicate unreferenced keys are counted and weighed once.
    expect(summarizeGc([asset("x", 5), asset("x", 5)], [])).toEqual({
      totalAssets: 2,
      orphanedCount: 1,
      reclaimableBytes: 5,
    });
    // Fully referenced → nothing to reclaim.
    expect(summarizeGc(assets, ["a", "b", "c"]).reclaimableBytes).toBe(0);
  });
});
