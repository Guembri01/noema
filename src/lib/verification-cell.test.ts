import { describe, expect, it } from "vitest";
import {
  aggregateVerification,
  cellDisplay,
  cellToValue,
  parseCsvVerification,
  toCsvVerification,
  toggleCell,
  validateCell,
  valueToCell,
  type CellValidation,
  type LegacyVerificationCell,
  type VerificationAggregate,
} from "@/lib/verification-cell";
import { parseVerification, VERIFICATION_NOTE_MAX } from "@/lib/verification";

/* The VERIFICATION property (database-deep.md R89.28) already has a pure
   engine in `@/lib/verification`; this module is the thin adapter between that
   canonical value and (a) the legacy inline cell shape the `PropertyValue`
   column actually stores (`{ verified: boolean, verifiedById?, verifiedAt? }`)
   and (b) the `yes`/`no` CSV column. Fixtures mirror both shapes plus the junk
   an untrusted JSON round-trip can produce. Every time-dependent call is handed
   a fixed `now`, so nothing here reads an ambient clock. */

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const T1 = Date.parse("2026-04-01T09:30:00.000Z");
const ISO0 = new Date(T0).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** A legacy cell that is verified by `u1` at the fixed instant. */
const legacyCell = (overrides: Partial<Record<string, unknown>> = {}) => ({
  verified: true,
  verifiedById: "u1",
  verifiedAt: ISO0,
  ...overrides,
});

const codes = (result: CellValidation): string[] =>
  result.ok ? [] : result.errors.map((error) => error.code);

describe("cellToValue", () => {
  it("returns the canonical empty value for non-object junk", () => {
    expect(cellToValue(null)).toEqual({});
    expect(cellToValue(undefined)).toEqual({});
    expect(cellToValue("u1")).toEqual({});
    expect(cellToValue(42)).toEqual({});
    expect(cellToValue(true)).toEqual({});
    expect(cellToValue([])).toEqual({});
    expect(cellToValue(() => undefined)).toEqual({});
  });

  it("lifts the canonical fields out of a legacy cell", () => {
    expect(cellToValue(legacyCell({ note: "looks good" }))).toEqual({
      verifiedById: "u1",
      verifiedAt: ISO0,
      note: "looks good",
    });
  });

  it("normalises the timestamp to canonical ISO", () => {
    expect(cellToValue(legacyCell({ verifiedAt: "2026-03-01" }))).toEqual({
      verifiedById: "u1",
      verifiedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("treats the boolean-only legacy alias as not verified (no actor)", () => {
    expect(cellToValue({ verified: true })).toEqual({});
    expect(cellToValue({ verified: true, checked: true })).toEqual({});
    expect(cellToValue({ verified: true, verifiedByName: "Ada" })).toEqual({});
  });

  it("honours an explicit verified:false by clearing the stamp pair", () => {
    expect(
      cellToValue(legacyCell({ verified: false })),
    ).toEqual({});
    expect(
      cellToValue({ verified: false, verifiedById: "u1", verifiedAt: ISO0 }),
    ).toEqual({});
  });

  it("keeps a note even when verified:false clears the stamp", () => {
    expect(cellToValue({ verified: false, note: "kept" })).toEqual({ note: "kept" });
  });

  it("treats the canonical cleared shape (explicit nulls) as not verified", () => {
    expect(cellToValue({ verifiedById: null, verifiedAt: null })).toEqual({});
    expect(cellToValue({ verified: false, verifiedById: null, verifiedAt: null })).toEqual({});
  });

  it("reads a bare canonical stamp without any boolean flag", () => {
    expect(cellToValue({ verifiedById: "u1", verifiedAt: ISO0 })).toEqual({
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
  });

  it("never mutates its input", () => {
    const input = legacyCell({ note: "keep" });
    cellToValue(input);
    expect(input).toEqual(legacyCell({ note: "keep" }));
  });
});

describe("valueToCell", () => {
  it("writes the legacy shape for a canonical stamp", () => {
    expect(valueToCell({ verifiedById: "u1", verifiedAt: ISO0 })).toEqual({
      verified: true,
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
  });

  it("carries the note through", () => {
    expect(valueToCell({ verifiedById: "u1", verifiedAt: ISO0, note: "ok" })).toEqual({
      verified: true,
      verifiedById: "u1",
      verifiedAt: ISO0,
      note: "ok",
    });
  });

  it("writes a complete cleared shape for an empty value", () => {
    expect(valueToCell({})).toEqual({
      verified: false,
      verifiedById: null,
      verifiedAt: null,
    });
    expect(valueToCell(null)).toEqual({
      verified: false,
      verifiedById: null,
      verifiedAt: null,
    });
  });

  it("keeps a note on a cleared cell", () => {
    expect(valueToCell({ note: "kept" })).toEqual({
      verified: false,
      verifiedById: null,
      verifiedAt: null,
      note: "kept",
    });
  });

  it("does not mark a half stamp as verified", () => {
    expect(valueToCell({ verifiedById: "u1" }).verified).toBe(false);
    expect(valueToCell({ verifiedAt: ISO0 }).verified).toBe(false);
  });

  it("round-trips canonical -> legacy -> canonical", () => {
    const cases: unknown[] = [
      {},
      { note: "n" },
      { verifiedById: "u1", verifiedAt: ISO0 },
      { verifiedById: "u1", verifiedAt: ISO0, note: "n" },
      { verifiedById: null, verifiedAt: null },
      "junk",
    ];
    for (const value of cases) {
      expect(cellToValue(valueToCell(value))).toEqual(parseVerification(value));
    }
  });
});

describe("cellDisplay", () => {
  it("labels an empty or junk cell as not verified with tone none", () => {
    for (const raw of [{}, null, "junk", { verified: true }, { verifiedById: null, verifiedAt: null }]) {
      const display = cellDisplay(raw, { now: T0 });
      expect(display.label).toBe("Not verified");
      expect(display.tone).toBe("none");
      expect(display.verified).toBe(false);
    }
  });

  it("labels a stamp as verified with tone verified", () => {
    const display = cellDisplay(legacyCell(), { now: T0 });
    expect(display.label).toBe("Verified ✓ · u1 · 2026-03-01");
    expect(display.tone).toBe("verified");
    expect(display.verified).toBe(true);
  });

  it("prefers the supplied actor name", () => {
    expect(cellDisplay(legacyCell(), { now: T0, actorName: "Ada Lovelace" }).label).toBe(
      "Verified ✓ · Ada Lovelace · 2026-03-01",
    );
  });

  it("marks an aged-out stamp stale but still verified", () => {
    const display = cellDisplay(legacyCell(), { now: T0 + 2 * DAY, maxAgeMs: DAY });
    expect(display.label).toBe("Verification stale · u1 · 2026-03-01");
    expect(display.tone).toBe("stale");
    expect(display.verified).toBe(true);
  });

  it("does not go stale without both a clock and a window", () => {
    expect(cellDisplay(legacyCell(), { now: T0 + 2 * DAY }).tone).toBe("verified");
    expect(cellDisplay(legacyCell(), { maxAgeMs: DAY }).tone).toBe("verified");
  });
});

describe("toggleCell", () => {
  it("stamps the acting user on an empty cell", () => {
    expect(toggleCell({}, { userId: "u1", now: T0 })).toEqual({
      verified: true,
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
    expect(toggleCell({ verified: false, verifiedById: null, verifiedAt: null }, { userId: "u1", now: T0 })).toEqual({
      verified: true,
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
  });

  it("clears the stamp pair for the same actor, keeping the note", () => {
    expect(
      toggleCell(legacyCell({ note: "checked" }), { userId: "u1", now: T1 }),
    ).toEqual({ verified: false, verifiedById: null, verifiedAt: null, note: "checked" });
  });

  it("refuses to clear a stamp left by a foreign actor", () => {
    const foreign: LegacyVerificationCell = valueToCell(legacyCell());
    expect(toggleCell(legacyCell(), { userId: "u2", now: T1 })).toEqual(foreign);
    expect(
      toggleCell(legacyCell({ note: "checked" }), { userId: "u2", now: T1 }),
    ).toEqual({ ...foreign, note: "checked" });
  });

  it("claims a legacy boolean-only cell for the acting user", () => {
    expect(toggleCell({ verified: true }, { userId: "u1", now: T0 })).toEqual({
      verified: true,
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
  });

  it("refuses to verify without a real session actor or instant", () => {
    expect(toggleCell({}, { userId: "   ", now: T0 })).toEqual({
      verified: false,
      verifiedById: null,
      verifiedAt: null,
    });
    expect(toggleCell({}, { userId: "u1", now: Number.NaN })).toEqual({
      verified: false,
      verifiedById: null,
      verifiedAt: null,
    });
  });
});

describe("parseCsvVerification", () => {
  it("accepts the affirmative tokens case-insensitively", () => {
    for (const token of ["yes", "YES", "Yes", " true ", "TRUE", "1", "✓"]) {
      expect(parseCsvVerification(token)).toEqual({ value: true });
    }
  });

  it("accepts the negative tokens case-insensitively", () => {
    for (const token of ["no", "NO", "False", "false", "0", "", "   "]) {
      expect(parseCsvVerification(token)).toEqual({ value: false });
    }
  });

  it("treats a blank or missing cell as unverified", () => {
    expect(parseCsvVerification("")).toEqual({ value: false });
    expect(parseCsvVerification(null)).toEqual({ value: false });
    expect(parseCsvVerification(undefined)).toEqual({ value: false });
  });

  it("reports malformed tokens as an error", () => {
    for (const token of ["maybe", "y", "n", "2", "checkbox", "✓✓"]) {
      const result = parseCsvVerification(token);
      expect("error" in result).toBe(true);
    }
  });

  it("errors on a non-string, non-null cell", () => {
    expect("error" in parseCsvVerification(42)).toBe(true);
    expect("error" in parseCsvVerification({})).toBe(true);
  });
});

describe("toCsvVerification", () => {
  it("exports yes for a verified stamp and no otherwise", () => {
    expect(toCsvVerification({ verifiedById: "u1", verifiedAt: ISO0 })).toBe("yes");
    expect(toCsvVerification({})).toBe("no");
    expect(toCsvVerification(null)).toBe("no");
    expect(toCsvVerification("junk")).toBe("no");
  });

  it("exports no for an actor-less legacy boolean, matching the chip", () => {
    expect(toCsvVerification({ verified: true })).toBe("no");
    expect(toCsvVerification({ verified: false, verifiedById: null, verifiedAt: null })).toBe("no");
    // ...and reads the same across the cell surface.
    expect(cellDisplay({ verified: true }).tone).toBe("none");
  });

  it("round-trips a value through the CSV column", () => {
    const verified = toCsvVerification({ verifiedById: "u1", verifiedAt: ISO0 });
    expect(parseCsvVerification(verified)).toEqual({ value: true });
    const cleared = toCsvVerification({});
    expect(parseCsvVerification(cleared)).toEqual({ value: false });
  });
});

describe("validateCell", () => {
  it("accepts empty, cleared and full cells", () => {
    expect(validateCell(null).ok).toBe(true);
    expect(validateCell(undefined).ok).toBe(true);
    expect(validateCell({}).ok).toBe(true);
    expect(validateCell({ verified: true }).ok).toBe(true);
    expect(validateCell(legacyCell({ note: "ok" })).ok).toBe(true);
  });

  it("flags a non-object shape", () => {
    expect(codes(validateCell("u1"))).toEqual(["INVALID_SHAPE"]);
    expect(codes(validateCell([]))).toEqual(["INVALID_SHAPE"]);
  });

  it("flags a half stamp as incomplete", () => {
    expect(codes(validateCell({ verifiedById: "u1" }))).toEqual(["INCOMPLETE_STAMP"]);
    expect(codes(validateCell({ verifiedAt: ISO0 }))).toEqual(["INCOMPLETE_STAMP"]);
  });

  it("flags a non-string note", () => {
    expect(codes(validateCell({ note: 12 }))).toEqual(["INVALID_NOTE"]);
  });

  it("honours the maxNoteLength option", () => {
    expect(validateCell({ note: "abcd" }, { maxNoteLength: 3 }).ok).toBe(false);
    expect(codes(validateCell({ note: "abcd" }, { maxNoteLength: 3 }))).toEqual(["NOTE_TOO_LONG"]);
    expect(validateCell({ note: "abcd" }, { maxNoteLength: 4 }).ok).toBe(true);
  });

  it("defaults the note cap to the engine's limit", () => {
    expect(validateCell({ note: "x".repeat(VERIFICATION_NOTE_MAX) }).ok).toBe(true);
    expect(validateCell({ note: "x".repeat(VERIFICATION_NOTE_MAX + 1) }).ok).toBe(false);
  });

  it("collects every problem it finds", () => {
    const result = validateCell({ verifiedById: "u1", note: 12 });
    expect(codes(result).sort()).toEqual(["INCOMPLETE_STAMP", "INVALID_NOTE"]);
  });
});

describe("aggregateVerification", () => {
  it("returns zeroed counts for an empty or non-array input", () => {
    const empty: VerificationAggregate = { verified: 0, unverified: 0, stale: 0, total: 0 };
    expect(aggregateVerification([])).toEqual(empty);
    expect(aggregateVerification(null)).toEqual(empty);
    expect(aggregateVerification("junk")).toEqual(empty);
  });

  it("counts verified, unverified and the total", () => {
    const values = [
      legacyCell(),
      { verifiedById: "u2", verifiedAt: ISO0 },
      {},
      null,
      { verified: true },
    ];
    expect(aggregateVerification(values)).toEqual({
      verified: 2,
      unverified: 3,
      stale: 0,
      total: 5,
    });
  });

  it("counts aged-out stamps as stale, not unverified", () => {
    const values = [legacyCell(), {}, legacyCell()];
    expect(
      aggregateVerification(values, { now: T0 + 2 * DAY, maxAgeMs: DAY }),
    ).toEqual({ verified: 0, unverified: 1, stale: 2, total: 3 });
  });

  it("keeps verified + stale + unverified equal to the total", () => {
    const values = [legacyCell(), {}, legacyCell(), "junk"];
    const totals = aggregateVerification(values, { now: T0 + 2 * DAY, maxAgeMs: DAY });
    expect(totals.verified + totals.stale + totals.unverified).toBe(totals.total);
  });
});
