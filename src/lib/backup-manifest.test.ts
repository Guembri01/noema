import { describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_VERSION,
  buildManifest,
  checksum,
  mergeManifests,
  verifyManifest,
  type BackupManifest,
  type BackupSourceFile,
} from "./backup-manifest";

/**
 * Pure backup-manifest core (F5 backup slice).
 *
 * Red-first: this file was written BEFORE `src/lib/backup-manifest.ts` existed,
 * so every import resolved to module-not-found and the suite failed to collect.
 * It pins the descriptor that a backup restore can be checked against — a
 * deterministic FNV-1a checksum (no crypto dependency), a path-sorted manifest
 * with stable totals, a three-way verifier (mismatches/missing/extra) and a
 * merge that unions entries with later manifests winning.
 */

/** Terse `BackupSourceFile` builder; omits `kind` so the default is exercised. */
const file = (path: string, content: string, kind?: string): BackupSourceFile =>
  kind === undefined ? { path, content } : { path, content, kind };

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");

describe("checksum (deterministic FNV-1a hex)", () => {
  it("matches the canonical FNV-1a 32-bit test vectors", () => {
    expect(checksum("")).toBe("811c9dc5");
    expect(checksum("a")).toBe("e40c292c");
    expect(checksum("abc")).toBe("1a47e90b");
    expect(checksum("foobar")).toBe("bf9cf968");
  });

  it("is stable across calls and always 8 lowercase hex chars", () => {
    expect(checksum("abc")).toBe(checksum("abc"));
    expect(checksum("")).toMatch(/^[0-9a-f]{8}$/);
    expect(checksum("abc")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("hashes text identically to its UTF-8 bytes", () => {
    const text = "héllo ✨";
    expect(checksum(text)).toBe(checksum(new TextEncoder().encode(text)));
    // A multi-byte character must not collapse to a single code unit.
    expect(checksum("é")).not.toBe(checksum("e"));
  });

  it("separates similar inputs and byte arrays", () => {
    expect(checksum("a")).not.toBe(checksum("b"));
    expect(checksum("abc")).not.toBe(checksum("abd"));
    expect(checksum(new Uint8Array([1, 2, 3]))).not.toBe(checksum(new Uint8Array([1, 2, 4])));
    expect(checksum(new Uint8Array([1, 2, 3]))).toBe("56cf37ab");
  });
});

describe("buildManifest", () => {
  it("sorts entries by path, sums bytes and counts them", () => {
    const manifest = buildManifest([file("b.txt", "hello"), file("a.txt", "hi")], {
      now: FIXED_NOW,
    });
    expect(manifest.version).toBe(BACKUP_MANIFEST_VERSION);
    expect(manifest.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt"]);
    expect(manifest.entries[0].bytes).toBe(2);
    expect(manifest.entries[1].bytes).toBe(5);
    expect(manifest.totalBytes).toBe(7);
    expect(manifest.count).toBe(2);
  });

  it("checksums each entry and defaults its kind to `file`", () => {
    const manifest = buildManifest([file("a.txt", "hi"), file("p.md", "# x", "page")], {
      now: FIXED_NOW,
    });
    expect(manifest.entries[0].checksum).toBe(checksum("hi"));
    expect(manifest.entries[0].kind).toBe("file");
    expect(manifest.entries[1].kind).toBe("page");
    expect(manifest.entries[1].checksum).toBe(checksum("# x"));
  });

  it("accepts `now` as epoch millis and as a Date", () => {
    expect(buildManifest([], { now: 0 }).createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(buildManifest([], { now: FIXED_NOW }).createdAt).toBe(FIXED_NOW.toISOString());
  });

  it("defaults to the current time and an empty, well-formed manifest", () => {
    const manifest = buildManifest([]);
    expect(manifest.entries).toEqual([]);
    expect(manifest.count).toBe(0);
    expect(manifest.totalBytes).toBe(0);
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false);
  });

  it("sizes raw byte content by its byte length", () => {
    const manifest = buildManifest([{ path: "blob.bin", content: new Uint8Array([1, 2, 3]) }], {
      now: FIXED_NOW,
    });
    expect(manifest.entries[0].bytes).toBe(3);
    expect(manifest.entries[0].checksum).toBe(checksum(new Uint8Array([1, 2, 3])));
    expect(manifest.totalBytes).toBe(3);
  });

  it("does not mutate the input files", () => {
    const files = [file("b.txt", "hello"), file("a.txt", "hi")];
    const snapshot = files.map((entry) => ({ ...entry }));
    buildManifest(files, { now: FIXED_NOW });
    expect(files).toEqual(snapshot);
  });
});

describe("verifyManifest", () => {
  it("reports ok when every file matches, independent of order", () => {
    const files = [file("a.txt", "hi"), file("b.txt", "hello")];
    const manifest = buildManifest(files, { now: FIXED_NOW });
    const result = verifyManifest(manifest, [...files].reverse());
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("flags changed content as a checksum (and byte) mismatch", () => {
    const manifest = buildManifest([file("a.txt", "one")], { now: FIXED_NOW });
    const result = verifyManifest(manifest, [file("a.txt", "two")]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].path).toBe("a.txt");
    expect(result.mismatches[0].expectedBytes).toBe(3);
    expect(result.mismatches[0].actualBytes).toBe(3);
    expect(result.mismatches[0].expectedChecksum).toBe(checksum("one"));
    expect(result.mismatches[0].actualChecksum).toBe(checksum("two"));
  });

  it("flags a truncated file as a byte mismatch", () => {
    const manifest = buildManifest([file("a.txt", "hello")], { now: FIXED_NOW });
    const result = verifyManifest(manifest, [file("a.txt", "hell")]);
    expect(result.mismatches[0].expectedBytes).toBe(5);
    expect(result.mismatches[0].actualBytes).toBe(4);
  });

  it("lists manifest entries with no matching file as missing", () => {
    const manifest = buildManifest([file("a.txt", "hi"), file("gone.txt", "x")], {
      now: FIXED_NOW,
    });
    const result = verifyManifest(manifest, [file("a.txt", "hi")]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["gone.txt"]);
    expect(result.mismatches).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("lists files absent from the manifest as extra, sorted", () => {
    const manifest = buildManifest([file("a.txt", "hi")], { now: FIXED_NOW });
    const result = verifyManifest(manifest, [
      file("a.txt", "hi"),
      file("z.txt", "z"),
      file("new.txt", "n"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.extra).toEqual(["new.txt", "z.txt"]);
    expect(result.missing).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });
});

describe("mergeManifests", () => {
  it("unions entries sorted by path and recomputes the totals", () => {
    const first = buildManifest([file("a.txt", "aa")], { now: FIXED_NOW });
    const second = buildManifest([file("b.txt", "bbb")], { now: FIXED_NOW });
    const merged = mergeManifests([second, first]);
    expect(merged.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt"]);
    expect(merged.totalBytes).toBe(2 + 3);
    expect(merged.count).toBe(2);
    expect(merged.version).toBe(BACKUP_MANIFEST_VERSION);
  });

  it("lets the later manifest win for a shared path", () => {
    const first = buildManifest([file("a.txt", "old")], { now: FIXED_NOW });
    const second = buildManifest([file("a.txt", "newer")], { now: FIXED_NOW });
    const merged = mergeManifests([first, second]);
    expect(merged.count).toBe(1);
    expect(merged.entries[0].checksum).toBe(checksum("newer"));
    expect(merged.totalBytes).toBe(5);
  });

  it("keeps the newest createdAt and the highest version", () => {
    const older = buildManifest([file("a.txt", "a")], { now: new Date("2020-01-01T00:00:00.000Z") });
    const newer = buildManifest([file("b.txt", "b")], { now: FIXED_NOW });
    const bumped: BackupManifest = { ...newer, version: 7 };
    const merged = mergeManifests([older, bumped]);
    expect(merged.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(merged.version).toBe(7);
  });

  it("returns an empty manifest for no input", () => {
    const merged = mergeManifests([]);
    expect(merged.entries).toEqual([]);
    expect(merged.count).toBe(0);
    expect(merged.totalBytes).toBe(0);
    expect(merged.version).toBe(BACKUP_MANIFEST_VERSION);
  });

  it("does not mutate its inputs", () => {
    const first = buildManifest([file("a.txt", "aa")], { now: FIXED_NOW });
    const second = buildManifest([file("a.txt", "bb")], { now: FIXED_NOW });
    const snapshot = JSON.stringify([first, second]);
    mergeManifests([first, second]);
    expect(JSON.stringify([first, second])).toBe(snapshot);
  });
});
