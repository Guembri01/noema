import { describe, expect, it, vi } from "vitest";
import { pageMentionResults } from "./page-embed";

/**
 * F13 — the mention-search half of the page-embed picker.
 *
 * The sandbox runs React in `node` (no DOM), so React effects do not execute
 * here. Mirroring `suggestions.test.ts` and `bookmark.test.ts` conventions, the
 * effect's completion path is extracted as a pure seam (`pageMentionResults`)
 * and driven directly, with the two overlapping async searches' promise
 * resolutions controlled from the test — the same out-of-order sequence the
 * component's `cancelled`-flag effect must survive (the pattern its sibling
 * content-fetch effect at `page-embed.tsx` already uses).
 */

vi.mock("@/server/actions/mentions", () => ({
  mentionSearchAction: vi.fn(async () => []),
}));
vi.mock("@/server/actions/pages", () => ({
  getPageContentAction: vi.fn(async () => ({ ok: true, content: null, title: "", icon: null })),
}));
vi.mock("@/components/doc-renderer", () => ({
  DocRenderer: () => null,
}));

type Mention = { id: string; label: string; type: string; icon?: string | null };

const mention = (id: string, type = "page"): Mention => ({ id, label: id, type });

describe("page-embed mention search — stale-response guard", () => {
  it("an older response resolving after a newer one never overwrites the newer results", async () => {
    // Two effect instances: the older query ("proj") is cleaned up (its
    // `cancelled` flag set) the moment the newer query ("project") begins —
    // yet its slow response resolves afterwards.
    let cancelledOlder = false;
    let settleOlder: (found: Mention[]) => void;
    let settleNewer: (found: Mention[]) => void;
    const older = new Promise<Mention[]>((resolve) => (settleOlder = resolve));
    const newer = new Promise<Mention[]>((resolve) => (settleNewer = resolve));

    const applied: string[][] = [];
    const run = async (cancelledFlag: () => boolean, pending: Promise<Mention[]>) => {
      const rows = pageMentionResults(cancelledFlag(), await pending);
      if (rows) applied.push(rows.map((r) => r.id));
    };

    // The newer query starts → the older effect's cleanup runs.
    cancelledOlder = true;

    const olderRun = run(() => cancelledOlder, older);
    const newerRun = run(() => false, newer);

    settleNewer!([mention("project-truth"), mention("some-user", "user")]);
    await newerRun;
    // The older response arrives, strictly afterwards.
    settleOlder!([mention("older-points")]);
    await olderRun;

    expect(applied).toEqual([["project-truth"]]);
  });

  it("the live effect instance applies results when its response resolves", async () => {
    let settleOnly: (found: Mention[]) => void;
    const only = new Promise<Mention[]>((resolve) => (settleOnly = resolve));
    settleOnly!([mention("p1"), mention("p2"), mention("u1", "user")]);
    const settled = await only.then((found) => pageMentionResults(false, found));

    // The page-only filter is preserved on the live path.
    expect(settled?.map((r) => r.id)).toEqual(["p1", "p2"]);
  });

  it("a cleaned-up effect instance drops its in-flight response entirely", () => {
    // Same decision the guard makes at the await seam: no state write at all.
    expect(pageMentionResults(true, [mention("older-points")])).toBeNull();
  });

  it("keeps the page-only filter for live responses", () => {
    const rows = pageMentionResults(false, [
      mention("p1"),
      mention("u1", "user"),
      mention("p2"),
    ]);
    expect(rows?.map((r) => r.id)).toEqual(["p1", "p2"]);
  });
});
