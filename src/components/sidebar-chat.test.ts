/**
 * dz17 — node acceptance for the sidebar thread list.
 *
 * The row-action mapping and the relative-time formatter are pure, so they are
 * asserted directly. The skeleton and the empty state are rendered with
 * `react-dom/server` (the node test environment has no DOM).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/server/actions/chat", () => ({
  renameChatThreadAction: vi.fn(),
  deleteChatThreadAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import {
  ChatThreadSkeleton,
  ChatThreadsEmpty,
  THREAD_ROW_ACTIONS,
  relativeTime,
  threadLastAt,
  threadRowAction,
  threadRowActionLabel,
  type ChatThreadSummary,
} from "./sidebar-chat";

/* ------------------------------------------------------------- row actions */

describe("thread row actions", () => {
  it("offers rename (safe) and delete (danger)", () => {
    expect(THREAD_ROW_ACTIONS.map((action) => action.id)).toEqual(["rename", "delete"]);
    expect(threadRowAction("rename").danger).toBe(false);
    expect(threadRowAction("delete").danger).toBe(true);
  });

  it("localises the action labels", () => {
    expect(threadRowActionLabel("rename", "en")).toBe("Rename");
    expect(threadRowActionLabel("delete", "en")).toBe("Delete");
  });
});

/* ----------------------------------------------------------- relative time */

describe("relativeTime", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("formats recent times compactly", () => {
    expect(relativeTime(ago(30_000), now)).toBe("now");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m");
    expect(relativeTime(ago(3 * 60 * 60_000), now)).toBe("3h");
    expect(relativeTime(ago(2 * 24 * 60 * 60_000), now)).toBe("2d");
    expect(relativeTime(ago(20 * 24 * 60 * 60_000), now)).toBe("2w");
  });

  it("falls back to a date once it is older than a month", () => {
    const old = relativeTime(ago(120 * 24 * 60 * 60_000), now);
    expect(old).not.toMatch(/^[0-9]+[mhdw]$/);
    expect(old.length).toBeGreaterThan(0);
  });

  it("returns an empty string for missing or invalid input", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime(undefined, now)).toBe("");
    expect(relativeTime("", now)).toBe("");
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("threadLastAt", () => {
  const thread = (messages: ChatThreadSummary["messages"]): ChatThreadSummary => ({
    id: "t1",
    title: "Alpha",
    pageId: null,
    page: null,
    messages,
  });

  it("dates a row by its newest message", () => {
    const stamp = "2026-06-01T11:00:00Z";
    expect(threadLastAt(thread([{ id: "m1", body: "hi", role: "user", createdAt: stamp }]))).toBe(
      stamp,
    );
    expect(threadLastAt(thread([]))).toBeNull();
  });
});

/* --------------------------------------------------------- static renders */

describe("renderToStaticMarkup — loading skeleton", () => {
  it("renders the row-shaped skeleton, hidden from assistive tech", () => {
    const html = renderToStaticMarkup(createElement(ChatThreadSkeleton, { rows: 3 }));
    expect(html).toContain('data-testid="chat-thread-skeleton"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/notion-skeleton/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("renderToStaticMarkup — empty state", () => {
  it("renders an actionable empty state", () => {
    const html = renderToStaticMarkup(
      createElement(ChatThreadsEmpty, { locale: "en", onNew: () => {} }),
    );
    expect(html).toContain('data-testid="chat-threads-empty"');
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("No conversations yet.");
    expect(html).toContain("New discussion");
    expect(html).toContain("<button");
  });
});
