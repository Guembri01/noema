import { describe, expect, it } from "vitest";
import {
  MAX_MERMAID_SOURCE_CHARS,
  MERMAID_TEMPLATES,
  isMermaidBlock,
  isMermaidLanguage,
  looksLikeMermaidSource,
  mermaidRenderId,
  validateMermaidSource,
} from "./mermaid-policy";

describe("Mermaid source policy", () => {
  it("accepts ordinary diagram source and trims it", () => {
    expect(validateMermaidSource("  flowchart TD\n  A --> B  ")).toEqual({
      ok: true,
      source: "flowchart TD\n  A --> B",
    });
  });

  it("refuses empty source", () => {
    expect(validateMermaidSource("   ").ok).toBe(false);
    expect(validateMermaidSource(null).ok).toBe(false);
  });

  it("caps the payload", () => {
    expect(validateMermaidSource("x".repeat(MAX_MERMAID_SOURCE_CHARS + 1)).ok).toBe(false);
    expect(validateMermaidSource(Array.from({ length: 2_001 }, () => "x").join("\n")).ok).toBe(false);
  });

  it("refuses init/config directives", () => {
    expect(validateMermaidSource("%%{init: {'securityLevel': 'loose'}}%%\nflowchart TD\nA-->B").ok).toBe(false);
    expect(validateMermaidSource("%%{ config: { theme: 'dark' } }%%\nflowchart TD\nA-->B").ok).toBe(false);
  });

  it("recognises the Mermaid language", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage(" Mermaid ")).toBe(true);
    expect(isMermaidLanguage("typescript")).toBe(false);
  });

  it("infers Mermaid only for an empty language fence", () => {
    expect(looksLikeMermaidSource("\n  flowchart TD\n  A --> B")).toBe(true);
    expect(looksLikeMermaidSource("sequenceDiagram\n  Alice->>Bob: Hi")).toBe(true);
    expect(looksLikeMermaidSource("classDiagram-v2\n  A <|-- B")).toBe(true);
    expect(looksLikeMermaidSource("C4Context\n  title System")).toBe(true);
    expect(looksLikeMermaidSource("const graph = 1;")).toBe(false);

    expect(isMermaidBlock("", "flowchart TD\nA-->B")).toBe(true);
    expect(isMermaidBlock("   ", "graph LR\nA-->B")).toBe(true);
    // A directive without a body is still being typed; don't hide the source.
    expect(isMermaidBlock("", "flowchart TD")).toBe(false);
    expect(isMermaidBlock("mermaid", "")).toBe(true);
    // An explicit language always wins; inference must not hijack a real fence.
    expect(isMermaidBlock("text", "flowchart TD\nA-->B")).toBe(false);
    expect(isMermaidBlock("typescript", "graph TD")).toBe(false);
  });

  it("generates stable, distinct render ids", () => {
    expect(mermaidRenderId("same")).toBe(mermaidRenderId("same"));
    expect(mermaidRenderId("same")).not.toBe(mermaidRenderId("different"));
    expect(mermaidRenderId("same")).toMatch(/^mermaid-[a-z0-9]+$/);
  });

  it("ships UML and basic diagram templates", () => {
    const ids = MERMAID_TEMPLATES.map((template) => template.id);
    expect(ids).toEqual(expect.arrayContaining(["flowchart", "sequence", "class", "state", "er"]));
    for (const template of MERMAID_TEMPLATES) {
      expect(validateMermaidSource(template.source).ok).toBe(true);
    }
  });
});
