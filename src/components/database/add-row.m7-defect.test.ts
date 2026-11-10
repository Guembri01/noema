import { describe, expect, it, vi } from "vitest";

/**
 * P2-T10 (M7) fail-first demonstration — TEMPORARY, delete after wiring.
 *
 * The pre-change `addRow` in `database-view.tsx` wraps the create in
 * `startTransition(async () => { … await createRowAction; router.refresh(); })`
 * with NO in-flight guard. Node has no DOM and no client transitions, so this
 * harness models that exact shape (a transition never dedupes server actions:
 * two rapid clicks land two transitions that each await the action) and runs
 * the ledger.
 */
const transitionClientTask = (run: () => Promise<void>) => run();

describe("P2-T10 fail-first — the unguarded addRow double-click ledger", () => {
  it("without a guard, a rapid double click reaches createRowAction twice", async () => {
    const createRowAction = vi.fn(async () => ({ id: "r", ok: true }));
    const router = vi.fn();

    // The pre-change handler shape, verbatim in spirit:
    const addRow = () =>
      transitionClientTask(async () => {
        await createRowAction();
        router();
      });

    await Promise.all([addRow(), addRow()]); // rapid double click

    expect(createRowAction).toHaveBeenCalledTimes(2); // ← the defect
  });
});
