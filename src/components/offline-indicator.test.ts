import { describe, expect, it } from "vitest";
import { offlineLabel, stalenessLabel, summarizeConflicts } from "./offline-indicator";
import { describeConflict, type MergeConflict } from "@/lib/sync-conflict";

/**
 * Wiring proof for the offline indicator's pure presentation layer.
 *
 * The indicator is the surface that makes `sync-conflict.ts` visible: it must
 * render the pending-queue copy, the "synced N ago" staleness line, and one
 * provenance line per conflict. Those decisions are extracted as pure helpers so
 * they can be pinned in the Node sandbox without a DOM.
 */

const conflict: MergeConflict = {
  field: "title",
  before: { clock: 1, actorId: "alice", value: "A", at: 0 },
  after: { clock: 2, actorId: "bob", value: "B", at: 0 },
  actors: ["alice", "bob"],
  resolved: false,
};

describe("offlineLabel", () => {
  it("is silent when nothing is pending", () => {
    expect(offlineLabel(0)).toBeNull();
    expect(offlineLabel(-1)).toBeNull();
    expect(offlineLabel(Number.NaN)).toBeNull();
  });

  it("pluralises the pending count", () => {
    expect(offlineLabel(1)).toBe("1 change waiting to sync");
    expect(offlineLabel(3)).toBe("3 changes waiting to sync");
  });
});

describe("stalenessLabel", () => {
  it("reports a never-synced queue", () => {
    expect(stalenessLabel(null, 1_000)).toBe("Never synced");
  });

  it("scales seconds to minutes to hours", () => {
    expect(stalenessLabel(0, 30_000)).toBe("Synced 30s ago");
    expect(stalenessLabel(0, 5 * 60_000)).toBe("Synced 5m ago");
    expect(stalenessLabel(0, 3 * 60 * 60_000)).toBe("Synced 3h ago");
  });

  it("clamps a future stamp to now", () => {
    expect(stalenessLabel(5_000, 1_000)).toBe("Synced 0s ago");
  });
});

describe("summarizeConflicts", () => {
  it("renders one provenance line per conflict", () => {
    expect(summarizeConflicts([conflict])).toEqual([describeConflict(conflict)]);
    const [line] = summarizeConflicts([conflict]);
    expect(line).toContain("title");
    expect(line).toContain("alice@1");
    expect(line).toContain("bob@2");
    expect(line).toContain("unresolved");
  });

  it("is empty for a clean merge", () => {
    expect(summarizeConflicts([])).toEqual([]);
  });
});
