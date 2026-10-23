import { describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CODE_LANGUAGES } from "@/lib/code-languages";
import {
  CODE_CHROME_REVEAL,
  CODE_GUTTER,
  COPY_FEEDBACK_MS,
  CodeBlockChrome,
  codeChromeClass,
  codeChromeVisible,
  codeGutterStyle,
  codeWrapStyle,
  copyButtonClass,
  filterLanguages,
  languageOptions,
  nextCopyState,
  type CodeBlockChromeProps,
} from "./code-block";

/**
 * Pure mappings behind the code block's hover chrome: the Copy success state
 * machine, the language `Select` filter, the line-number gutter and the
 * hover/focus/selection visibility rule — plus `renderToStaticMarkup` of the
 * chrome in its idle, hover and copied states.
 */

const renderChrome = (props: Partial<CodeBlockChromeProps> = {}) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(CodeBlockChrome as ComponentType<CodeBlockChromeProps>, props),
    ),
  );

describe("copy-button state machine", () => {
  it("confirms for 1.5s", () => {
    expect(COPY_FEEDBACK_MS).toBe(1500);
  });

  it("moves idle → copied on copy", () => {
    expect(nextCopyState("idle", "copy")).toBe("copied");
  });

  it("keeps confirming when copied again (restarts the window)", () => {
    expect(nextCopyState("copied", "copy")).toBe("copied");
  });

  it("returns to idle on reset", () => {
    expect(nextCopyState("copied", "reset")).toBe("idle");
    expect(nextCopyState("idle", "reset")).toBe("idle");
  });

  it("tints the button with the success token only while copied", () => {
    expect(copyButtonClass("copied")).toContain("text-success");
    expect(copyButtonClass("idle")).not.toContain("text-success");
  });
});

describe("language list filter", () => {
  it("exposes every registry language with a stable value + label", () => {
    const options = languageOptions();
    expect(options).toHaveLength(CODE_LANGUAGES.length);
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
    expect(options.find((option) => option.value === "javascript")?.label).toBe("JavaScript");
  });

  it("carries aliases as search keywords", () => {
    const js = languageOptions().find((option) => option.value === "javascript");
    expect(js?.keywords).toContain("js");
  });

  it("returns the whole list for a blank query", () => {
    expect(filterLanguages("")).toHaveLength(CODE_LANGUAGES.length);
    expect(filterLanguages("   ")).toHaveLength(CODE_LANGUAGES.length);
  });

  it("matches label, value and alias, case-insensitively", () => {
    expect(filterLanguages("python")[0]?.value).toBe("python");
    expect(filterLanguages("PY")[0]?.value).toBe("python");
    expect(filterLanguages("ts").map((option) => option.value)).toContain("typescript");
    expect(filterLanguages("c++").map((option) => option.value)).toContain("cpp");
  });

  it("drops languages that do not match", () => {
    expect(filterLanguages("zzzzz")).toHaveLength(0);
  });
});

describe("line-number gutter + wrap tokens", () => {
  it("uses a 12px gutter inked with --fg-subtle", () => {
    expect(CODE_GUTTER.gap).toBe(12);
    expect(CODE_GUTTER.color).toBe("var(--fg-subtle)");
    expect(codeGutterStyle().color).toBe("var(--fg-subtle)");
    expect(codeGutterStyle().fontVariantNumeric).toBe("tabular-nums");
  });

  it("only wraps the code body when the wrap toggle is on", () => {
    expect(codeWrapStyle(false)).toEqual({});
    expect(codeWrapStyle(true).whiteSpace).toBe("pre-wrap");
  });
});

describe("chrome visibility (hover / focus / selection)", () => {
  it("is hidden with no hover, focus or selection", () => {
    expect(codeChromeVisible()).toBe(false);
    expect(codeChromeClass()).toContain("opacity-0");
    expect(codeChromeClass()).not.toContain("opacity-100");
  });

  it("shows on hover", () => {
    expect(codeChromeClass({ hovered: true })).toContain("opacity-100");
    expect(codeChromeClass({ hovered: true })).toContain("noema-code-chrome");
    expect(codeChromeClass({ hovered: true })).toContain("u-colors");
  });

  it("stays visible while focused or selected (keyboard parity)", () => {
    expect(codeChromeClass({ focused: true })).toContain("opacity-100");
    expect(codeChromeClass({ selected: true })).toContain("opacity-100");
  });

  it("fades with the token opacity transition (reduced-motion safe)", () => {
    expect(codeChromeClass({ hovered: true })).toContain("u-transform");
  });

  it("lifts on group hover and focus-within so nothing shifts", () => {
    expect(CODE_CHROME_REVEAL).toContain("group-hover:opacity-100");
    expect(CODE_CHROME_REVEAL).toContain("group-focus-within:opacity-100");
    expect(CODE_CHROME_REVEAL).toContain("focus-within:opacity-100");
  });
});

describe("CodeBlockChrome (renderToStaticMarkup)", () => {
  it("renders the picker + copy/line-number/wrap affordances", () => {
    const html = renderChrome({ state: { hovered: true }, language: "typescript" });
    expect(html).toContain("data-code-language-picker");
    expect(html).toContain('data-testid="code-copy"');
    expect(html).toContain('data-testid="code-line-numbers"');
    expect(html).toContain('data-testid="code-wrap"');
    expect(html).toContain('aria-label="Copy code"');
  });

  it("is hidden in the idle state", () => {
    const html = renderChrome({ state: {} });
    expect(html).toContain('data-chrome-visible="false"');
    expect(html).toContain("opacity-0");
    expect(html).toContain('data-copy-state="idle"');
  });

  it("is visible in the hover state", () => {
    const html = renderChrome({ state: { hovered: true } });
    expect(html).toContain('data-chrome-visible="true"');
    expect(html).toContain("opacity-100");
  });

  it("is visible when the block is selected", () => {
    const html = renderChrome({ state: { selected: true } });
    expect(html).toContain('data-chrome-visible="true"');
    expect(html).toContain("opacity-100");
  });

  it("reflects the copied state with the success tint", () => {
    const html = renderChrome({ state: { focused: true }, copy: "copied" });
    expect(html).toContain('data-copy-state="copied"');
    expect(html).toContain("text-success");
  });

  it("keeps only the Copy affordance on a read-only block", () => {
    const html = renderChrome({ editable: false, state: { hovered: true } });
    expect(html).toContain('data-testid="code-copy"');
    expect(html).not.toContain("data-code-language-picker");
    expect(html).not.toContain('data-testid="code-line-numbers"');
    expect(html).not.toContain('data-testid="code-wrap"');
  });
});


describe("Mermaid code block chrome", () => {
  it("offers a preview/source toggle when the language is Mermaid", () => {
    const html = renderChrome({ state: { hovered: true }, language: "mermaid", isMermaid: true, preview: true });
    expect(html).toContain('data-testid="code-mermaid-preview"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Show Mermaid source");
  });

  it("does not offer the diagram toggle on ordinary code", () => {
    const html = renderChrome({ state: { hovered: true }, language: "typescript" });
    expect(html).not.toContain('data-testid="code-mermaid-preview"');
  });
});
