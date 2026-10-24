import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryEntry } from "@/lib/undo-redo";
import { UndoHistoryList } from "./undo-history";

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
  at: 1_000_000,
  ...overrides,
});

const render = (entries: HistoryEntry[]) =>
  renderToStaticMarkup(
    createElement(UndoHistoryList, {
      entries,
      locale: "en",
      now: 1_000_000,
      onUndoTo: vi.fn(),
      onRedoTo: vi.fn(),
    }),
  );

describe("UndoHistoryList render wiring", () => {
  it("renders an empty state rather than an empty list", () => {
    const html = render([]);
    expect(html).toContain('data-testid="undo-history-empty"');
    expect(html).toContain("No reversible actions yet.");
    expect(html).not.toContain('data-testid="undo-history-list"');
  });

  it("renders each real entry newest first with its label and age", () => {
    const html = render([entry(0), entry(1, { label: "Rename page" })]);
    const first = html.indexOf("Rename page");
    const second = html.indexOf("Action 0");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(html).toContain('data-testid="undo-history-entry-1"');
    expect(html).toContain('data-testid="undo-history-entry-0"');
    expect(html).toContain("<time");
    expect(html).toContain("now");
  });

  it("offers undo for an applied local entry", () => {
    const html = render([entry(0)]);
    expect(html).toContain('data-testid="undo-history-undo-0"');
    expect(html).toContain('aria-label="Undo: Action 0"');
    expect(html).not.toContain('data-testid="undo-history-redo-0"');
  });

  it("offers redo for an undone local entry", () => {
    const html = render([entry(0, { applied: false })]);
    expect(html).toContain('data-testid="undo-history-redo-0"');
    expect(html).toContain('aria-label="Redo: Action 0"');
    expect(html).not.toContain('data-testid="undo-history-undo-0"');
  });

  it("never offers an action for a collaborator's entry", () => {
    const html = render([entry(0, { remote: true })]);
    expect(html).toContain('data-remote="true"');
    expect(html).not.toContain('data-testid="undo-history-undo-0"');
    expect(html).not.toContain('data-testid="undo-history-redo-0"');
    expect(html).toContain("From a collaborator");
  });

  it("does not render a time when the command has no instant", () => {
    const html = render([entry(0, { at: undefined })]);
    expect(html).not.toContain("<time");
  });
});
