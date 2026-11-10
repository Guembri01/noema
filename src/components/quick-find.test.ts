import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DS18 — evidence for quick find.
 *
 * The launcher's decisions live in pure helpers (recent-visit log, "recents
 * first" ordering, breadcrumb, capped-list footer) so they can be pinned in the
 * Node sandbox; a `renderToStaticMarkup` pass proves the dialog/listbox/a11y
 * wiring. The Server Actions and Sonner are stubbed — there is no Next runtime
 * or DB here — and Radix's portal is a pass-through, matching the palette test.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@/server/actions/search", () => ({
  quickFindAction: vi.fn(async () => []),
}));

vi.mock("@/server/actions/pages", () => ({
  createPageAction: vi.fn(async () => ({ ok: true, id: "new" })),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@radix-ui/react-dialog", async () => {
  const { createElement: h } = await import("react");
  type MockProps = {
    children?: ReactNode;
    open?: boolean;
    role?: string;
    className?: string;
    "aria-modal"?: string | boolean;
    [key: string]: unknown;
  };
  const PassThrough = ({ children }: { children?: ReactNode }) => h("div", null, children ?? null);
  return {
    Root: ({ open, children }: MockProps) =>
      open === false ? null : h("div", null, (children as ReactNode) ?? null),
    Trigger: PassThrough,
    Close: PassThrough,
    Portal: PassThrough,
    Overlay: PassThrough,
    Content: ({ children, role, className, ...rest }: MockProps) =>
      h(
        "div",
        { role, className, "aria-modal": rest["aria-modal"] },
        (children as ReactNode) ?? null,
      ),
  };
});

const {
  DEFAULT_QUICK_FIND_MAX_RESULTS,
  MAX_QUICK_FIND_RECENTS,
  createRequestSequence,
  orderRowsByRecents,
  recentOrder,
  recentToRow,
  rememberVisit,
  resultBreadcrumb,
  settleSearchResults,
  showingFooter,
  loadRecents,
  QuickFind,
} = await import("@/components/quick-find");

const visit = (id: string, title = id, at = 0) => ({
  id,
  title,
  icon: null,
  type: "PAGE",
  snippet: "",
  at,
});

describe("rememberVisit", () => {
  it("moves a repeat visit to the front and re-stamps it (no duplicate)", () => {
    const list = [visit("a", "A", 1), visit("b", "B", 2)];
    const next = rememberVisit(list, { id: "b", title: "B", type: "PAGE" }, 10);
    expect(next.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(next[0].at).toBe(10);
    expect(next).toHaveLength(2);
  });

  it("caps the history and never mutates the input", () => {
    const list = [visit("a"), visit("b"), visit("c")];
    const snapshot = JSON.stringify(list);
    const next = rememberVisit(list, { id: "d", title: "D", type: "PAGE" }, 5, 2);
    expect(next.map((entry) => entry.id)).toEqual(["d", "a"]);
    expect(JSON.stringify(list)).toBe(snapshot);
  });

  it("ignores a blank id and coerces a non-finite clock", () => {
    const list = [visit("a")];
    expect(rememberVisit(list, { id: "  ", title: "X", type: "PAGE" }, 1).map((e) => e.id)).toEqual([
      "a",
    ]);
    expect(rememberVisit(null, { id: "b", title: "B", type: "PAGE" }, Number.NaN)[0].at).toBe(0);
  });

  it("keeps a bounded, richer record shape", () => {
    const next = rememberVisit([], { id: "p", title: "Roadmap", icon: "🚀", type: "DATABASE", snippet: "s" }, 3);
    expect(next[0]).toEqual({
      id: "p",
      title: "Roadmap",
      icon: "🚀",
      type: "DATABASE",
      snippet: "s",
      at: 3,
    });
    expect(MAX_QUICK_FIND_RECENTS).toBeGreaterThan(0);
  });
});

describe("recentOrder", () => {
  it("maps ids to their first-seen rank, de-duplicating", () => {
    const order = recentOrder([visit("a"), visit("b"), visit("a")]);
    expect(order.get("a")).toBe(0);
    expect(order.get("b")).toBe(1);
    expect(order.size).toBe(2);
  });
});

describe("orderRowsByRecents (recents first)", () => {
  it("promotes recents in rank order and keeps the rest stable", () => {
    const rows = [{ id: "x" }, { id: "a" }, { id: "y" }, { id: "b" }];
    const rank = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    expect(orderRowsByRecents(rows, rank).map((row) => row.id)).toEqual([
      "a",
      "b",
      "x",
      "y",
    ]);
  });

  it("is a stable copy when nothing is recent", () => {
    const rows = [{ id: "x" }, { id: "y" }];
    const ordered = orderRowsByRecents(rows, new Map());
    expect(ordered.map((row) => row.id)).toEqual(["x", "y"]);
    expect(ordered).not.toBe(rows);
  });
});

describe("resultBreadcrumb", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "p1",
    title: "Milestones",
    icon: null,
    type: "PAGE",
    snippet: "",
    ...over,
  });

  it("uses real ancestor titles when the search layer supplies them", () => {
    const path = resultBreadcrumb(
      row({ parents: [{ id: "r", title: "Roadmap" }, { id: "q", title: "Q3" }] }) as never,
      "ws",
      "en",
    );
    expect(path).toEqual(["ws", "Roadmap", "Q3"]);
  });

  it("falls back to the workspace + type when there are no parents", () => {
    expect(resultBreadcrumb(row() as never, "ws", "en")).toEqual(["ws", "Pages"]);
    expect(resultBreadcrumb(row({ type: "DATABASE" }) as never, "ws", "en")).toEqual([
      "ws",
      "Databases",
    ]);
  });

  it("labels an untitled ancestor", () => {
    const path = resultBreadcrumb(
      row({ parents: [{ id: "r", title: "  " }] }) as never,
      "ws",
      "en",
    );
    expect(path).toEqual(["ws", "Untitled"]);
  });
});

describe("showingFooter (capped list)", () => {
  it("reports N of M only when the list is capped", () => {
    expect(showingFooter(6, 8)).toBe("Showing 6 of 8");
    expect(showingFooter(3, 3)).toBeNull();
    expect(showingFooter(0, 0)).toBeNull();
  });
});

describe("recentToRow", () => {
  it("maps a remembered visit back to a renderable row", () => {
    expect(
      recentToRow({ id: "p", title: "Alpha", icon: "📄", type: "PAGE", snippet: "body", at: 1 }),
    ).toEqual({ id: "p", title: "Alpha", icon: "📄", type: "PAGE", snippet: "body" });
  });
});

describe("loadRecents", () => {
  it("returns [] when storage is unavailable", () => {
    expect(loadRecents("k")).toEqual([]);
  });

  it("parses valid JSON and drops corrupt entries", () => {
    const store = new Map<string, string>();
    store.set(
      "k",
      JSON.stringify([{ id: "p", title: "Alpha", at: 1 }, { nope: true }, 42]),
    );
    (globalThis as unknown as { window?: unknown }).window = {
      localStorage: { getItem: (key: string) => store.get(key) ?? null },
    };
    try {
      const rows = loadRecents("k");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "p", title: "Alpha", type: "PAGE" });

      store.set("k", "{ not json");
      expect(loadRecents("k")).toEqual([]);
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
});

describe("QuickFind SSR", () => {
  it("wires the dialog, listbox, labelled input and live region", () => {
    const html = renderToStaticMarkup(
      createElement(QuickFind, {
        open: true,
        onOpenChange: () => {},
        workspaceId: "ws-id",
        workspaceSlug: "ws",
        locale: "en",
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain("quick-find-list");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-activedescendant="quick-find-option-0"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("animate-rise");
    expect(html).toContain("scrollbar-thin");
    // The always-present "create" row is the first option.
    expect(html).toContain('role="option"');
    expect(DEFAULT_QUICK_FIND_MAX_RESULTS).toBeGreaterThan(0);
  });
});

describe("stale-response guard (F8)", () => {
  /** Rows shaped exactly like the action's success/error union. */
  type Results = Array<{ id: string; title: string; icon: string | null; type: string; snippet: string }> | {
    error: string;
  };
  const row = (id: string) => ({ id, title: id, icon: null, type: "PAGE", snippet: "" });

  /**
   * The debounced-search effect body, verbatim, with the external seams
   * (`startTransition` + `setItems` + `toast.error`) replaced by captures so
   * the action mock's promise resolutions can be controlled from the node
   * sandbox (React effects do not run there — see the component effect for the
   * exact parity of this harness and the production body).
   */
  const harness = () => {
    const sequence = createRequestSequence();
    const applied: string[][] = [];
    const toasts: string[] = [];

    const run = (seq: number, pending: Promise<Results>) =>
      pending.then((results) =>
        settleSearchResults(sequence, seq, results, {
          onRows: (rows) => applied.push(rows.map((r) => r.id)),
          onError: (error) => toasts.push(error),
        }),
      );

    return { sequence, applied, toasts, run };
  };

  it("an older response resolving after a newer one never overwrites the newer results", async () => {
    // Two searches issued in start order ("proj", then "project"); the action
    // mock resolves the newer first, then — later — the slower older one.
    const { sequence, applied, run } = harness();

    let settleOlder: (results: Results) => void;
    let settleNewer: (results: Results) => void;
    const older = new Promise<Results>((resolve) => (settleOlder = resolve));
    const newer = new Promise<Results>((resolve) => (settleNewer = resolve));

    const seqOlder = sequence.issue();
    const seqNewer = sequence.issue();

    const olderRun = run(seqOlder, older);
    const newerRun = run(seqNewer, newer);

    // The newer ("project") response lands first; its results are the state.
    settleNewer!([row("project-truth")]);
    await newerRun;
    // The older ("proj") response now resolves, strictly afterwards.
    settleOlder!([row("older-points")]);
    await olderRun;

    expect(applied).toEqual([["project-truth"]]);
  });

  it("the newer response is applied whenever it resolves", async () => {
    const { sequence, applied, run } = harness();

    let resolveOnly: (results: Results) => void;
    const only = new Promise<Results>((resolve) => (resolveOnly = resolve));
    const seqNewer = sequence.issue();
    resolveOnly!([row("fresh")]);
    await run(seqNewer, only);

    expect(applied).toEqual([["fresh"]]);
  });

  it("a stale response is dropped whole — including its error toast", async () => {
    const { sequence, applied, toasts, run } = harness();

    let settleOlder: (results: Results) => void;
    let settleNewer: (results: Results) => void;
    const older = new Promise<Results>((resolve) => (settleOlder = resolve));
    const newer = new Promise<Results>((resolve) => (settleNewer = resolve));

    const seqOlder = sequence.issue();
    const seqNewer = sequence.issue();

    const olderRun = run(seqOlder, older);
    const newerRun = run(seqNewer, newer);

    settleNewer!([row("newer")]);
    await newerRun;
    settleOlder!({ error: "session expired" });
    await olderRun;

    expect(applied).toEqual([["newer"]]);
    expect(toasts).toEqual([]); // The older query's toast must not resurface.
  });

  it("issued tokens are monotonic: the newest one issued wins", () => {
    const sequence = createRequestSequence();
    const first = sequence.issue();
    const second = sequence.issue();
    expect(first).toBe(1);
    expect(second).toBe(2);
    // The newest token still loses/supersedes correctly: a superseded token has
    // lost the race the moment a newer one was issued.
    expect(sequence.isLatest(first)).toBe(false);
    expect(sequence.isLatest(second)).toBe(true);
  });
});
