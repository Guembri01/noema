import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "./undo-redo";
import { formatUndoAge, undoHistoryRows } from "./undo-history";

const entry = (
  index: number,
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry => ({
  id: `cmd-${index}`,
  label: `Action ${index}`,
  index,
  applied: true,
  remote: false,
  skipped: false,
  ...overrides,
});

describe("formatUndoAge", () => {
  const now = 1_000_000;

  it("returns null without a usable instant", () => {
    expect(formatUndoAge(undefined, now)).toBeNull();
    expect(formatUndoAge(Number.NaN, now)).toBeNull();
  });

  it("clamps future instants to now", () => {
    expect(formatUndoAge(now + 5_000, now, "now")).toBe("now");
  });

  it("formats seconds, minutes, hours and days", () => {
    expect(formatUndoAge(now - 1_000, now, "now")).toBe("now");
    expect(formatUndoAge(now - 12_000, now)).toBe("12s");
    expect(formatUndoAge(now - 65_000, now)).toBe("1m");
    expect(formatUndoAge(now - 3_700_000, now)).toBe("1h");
    expect(formatUndoAge(now - 90_000_000, now)).toBe("1d");
  });
});

describe("undoHistoryRows", () => {
  it("lists the stack newest first", () => {
    const rows = undoHistoryRows([entry(0), entry(1), entry(2)], 1_000_000);
    expect(rows.map((row) => row.index)).toEqual([2, 1, 0]);
    expect(rows.map((row) => row.label)).toEqual(["Action 2", "Action 1", "Action 0"]);
  });

  it("offers undo only for applied local entries", () => {
    const rows = undoHistoryRows(
      [
        entry(0),
        entry(1, { applied: false }),
        entry(2, { remote: true }),
        entry(3, { skipped: true, remote: true }),
      ],
      1_000_000,
    );
    expect(rows.map((row) => row.action)).toEqual([null, null, "redo", "undo"]);
  });

  it("never advertises an action for a collaborator's entry", () => {
    const [row] = undoHistoryRows([entry(0, { remote: true })], 1_000_000);
    expect(row.remote).toBe(true);
    expect(row.action).toBeNull();
  });

  it("carries the age derived from the command's instant", () => {
    const [row] = undoHistoryRows(
      [entry(0, { at: 1_000_000 - 65_000 })],
      1_000_000,
      "now",
    );
    expect(row.age).toBe("1m");
  });
});
