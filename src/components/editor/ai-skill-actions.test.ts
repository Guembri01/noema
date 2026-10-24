import { describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import {
  aiInsertMode,
  applySkillResult,
  blockSkillTarget,
  pageSkillTarget,
  selectionSkillTarget,
  type AiSkillTarget,
} from "./ai-skill-actions";

/**
 * The shared insertion policy behind the selection toolbar and the block menu
 * (R25.19-R25.21). The editor is a tiny recorder: the tests pin the commands
 * the policy issues, not ProseMirror itself.
 */

type Call = { method: string; args: unknown[] };

function fakeEditor(options: {
  from?: number;
  to?: number;
  selectedText?: string;
  pageText?: string;
  beforeChar?: string;
  docSize?: number;
  node?: { textContent: string; nodeSize: number } | null;
}): { editor: Editor; calls: Call[] } {
  const calls: Call[] = [];
  const from = options.from ?? 0;
  const to = options.to ?? 0;
  const size = options.docSize ?? 20;
  const chain: Record<string, unknown> = {};
  chain.focus = () => chain;
  chain.run = () => {
    calls.push({ method: "run", args: [] });
    return true;
  };
  chain.insertContentAt = (...args: unknown[]) => {
    calls.push({ method: "insertContentAt", args });
    return chain;
  };
  const editor = {
    state: {
      selection: { from, to },
      doc: {
        content: { size },
        nodeAt: () => options.node ?? null,
        textBetween: (start: number, end: number) => {
          if (start === 0 && end === size) return options.pageText ?? "";
          if (start === from && end === to) return options.selectedText ?? "";
          if (start === end - 1) return options.beforeChar ?? "";
          return "";
        },
      },
    },
    chain: () => chain,
  } as unknown as Editor;
  return { editor, calls };
}

const insertions = (calls: Call[]) =>
  calls.filter((call) => call.method === "insertContentAt").map((call) => call.args);

describe("selectionSkillTarget", () => {
  it("uses a non-empty selection and its exact range", () => {
    const { editor } = fakeEditor({ from: 2, to: 9, selectedText: "  hello  " });
    expect(selectionSkillTarget(editor)).toEqual({
      text: "hello",
      from: 2,
      to: 9,
      insertAt: 9,
      scope: "selection",
    });
  });

  it("falls back to the whole page when nothing is selected", () => {
    const { editor } = fakeEditor({ from: 4, to: 4, pageText: "Page body", docSize: 30 });
    expect(selectionSkillTarget(editor)).toEqual({
      text: "Page body",
      from: 30,
      to: 30,
      insertAt: 30,
      scope: "page",
    });
  });

  it("returns null for an empty selection on an empty page", () => {
    const { editor } = fakeEditor({ from: 1, to: 1, pageText: "   " });
    expect(selectionSkillTarget(editor)).toBeNull();
  });
});

describe("pageSkillTarget", () => {
  it("always describes the whole document and appends at its end", () => {
    const { editor } = fakeEditor({ from: 2, to: 4, pageText: "Whole page", docSize: 18 });
    expect(pageSkillTarget(editor)).toEqual({
      text: "Whole page",
      from: 18,
      to: 18,
      insertAt: 18,
      scope: "page",
    });
  });

  it("returns null for an empty page", () => {
    expect(pageSkillTarget(fakeEditor({ pageText: "  " }).editor)).toBeNull();
  });
});

describe("blockSkillTarget", () => {
  it("targets the block's inner range and appends after the node", () => {
    const { editor } = fakeEditor({
      node: { textContent: "A paragraph", nodeSize: 12 },
    });
    expect(blockSkillTarget(editor, 5)).toEqual({
      text: "A paragraph",
      from: 6,
      to: 16,
      insertAt: 17,
      scope: "block",
    });
  });

  it("returns null for a missing or empty block", () => {
    expect(blockSkillTarget(fakeEditor({ node: null }).editor, 5)).toBeNull();
    expect(
      blockSkillTarget(fakeEditor({ node: { textContent: " ", nodeSize: 4 } }).editor, 5),
    ).toBeNull();
  });
});

describe("aiInsertMode", () => {
  it("continues inline, rewrites a real selection/block and appends a page", () => {
    expect(
      aiInsertMode({ skillId: "continue", replacesSelection: false, scope: "selection" }),
    ).toBe("continue");
    expect(
      aiInsertMode({ skillId: "simplify", replacesSelection: true, scope: "selection" }),
    ).toBe("replace");
    expect(
      aiInsertMode({ skillId: "simplify", replacesSelection: true, scope: "block" }),
    ).toBe("replace");
    expect(
      aiInsertMode({ skillId: "simplify", replacesSelection: true, scope: "page" }),
    ).toBe("append");
    expect(
      aiInsertMode({ skillId: "summarize", replacesSelection: false, scope: "selection" }),
    ).toBe("append");
  });
});

describe("applySkillResult", () => {
  const target = (scope: AiSkillTarget["scope"]): AiSkillTarget => ({
    text: "source",
    from: 2,
    to: 7,
    insertAt: 9,
    scope,
  });

  it("replaces a selection with a text node (never raw HTML)", () => {
    const { editor, calls } = fakeEditor({});
    expect(
      applySkillResult(editor, { target: target("selection"), mode: "replace", text: "New" }),
    ).toBe(true);
    expect(insertions(calls)).toEqual([
      [{ from: 2, to: 7 }, { type: "text", text: "New" }],
    ]);
  });

  it("joins a continuation inline with one separating space", () => {
    const { editor, calls } = fakeEditor({ beforeChar: "a" });
    expect(
      applySkillResult(editor, { target: target("selection"), mode: "continue", text: "more" }),
    ).toBe(true);
    expect(insertions(calls)).toEqual([[7, { type: "text", text: " more" }]]);
  });

  it("does not double a space already before the continuation", () => {
    const { editor, calls } = fakeEditor({ beforeChar: " " });
    applySkillResult(editor, { target: target("selection"), mode: "continue", text: "more" });
    expect(insertions(calls)).toEqual([[7, { type: "text", text: "more" }]]);
  });

  it("appends a paragraph below a selection or block", () => {
    const { editor, calls } = fakeEditor({});
    applySkillResult(editor, { target: target("block"), mode: "append", text: "Answer" });
    expect(insertions(calls)).toEqual([
      [9, { type: "paragraph", content: [{ type: "text", text: "Answer" }] }],
    ]);
  });

  it("appends a page-scoped answer at the end, even for a rewriting skill", () => {
    const { editor, calls } = fakeEditor({});
    const page: AiSkillTarget = { ...target("page"), from: 20, to: 20, insertAt: 20 };
    applySkillResult(editor, { target: page, mode: "append", text: "Translated" });
    expect(insertions(calls)).toEqual([
      [20, { type: "paragraph", content: [{ type: "text", text: "Translated" }] }],
    ]);
  });

  it("refuses an empty answer without touching the document", () => {
    const { editor, calls } = fakeEditor({});
    expect(
      applySkillResult(editor, { target: target("selection"), mode: "replace", text: "   " }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});
