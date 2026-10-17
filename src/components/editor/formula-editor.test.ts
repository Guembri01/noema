import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FormulaEditor,
  buildFormulaEditorModel,
  completionCategoryHue,
  type FormulaEditorProps,
} from "./formula-editor";

/**
 * dw09 — the formula editor's pure category mapping and a `renderToStaticMarkup`
 * pass over the completion popup, the signature help and the diagnostics list.
 */

const render = (props: Partial<FormulaEditorProps> = {}): string =>
  renderToStaticMarkup(
    createElement(FormulaEditor, {
      value: "ro",
      onChange: () => {},
      dataTestId: "fe",
      ...props,
    }),
  );

describe("completionCategoryHue", () => {
  it("maps each catalog category to a tag hue", () => {
    expect(completionCategoryHue("math")).toBe("blue");
    expect(completionCategoryHue("text")).toBe("purple");
    expect(completionCategoryHue("reference")).toBe("yellow");
    expect(completionCategoryHue("property")).toBe("gray");
  });

  it("falls back to gray for an unknown category", () => {
    expect(completionCategoryHue("mystery")).toBe("gray");
  });
});

describe("buildFormulaEditorModel — categories", () => {
  it("tags a function completion with its catalog category", () => {
    const model = buildFormulaEditorModel("ro", 2);
    const round = model.completions.find((item) => item.label === "round");
    expect(round?.kind).toBe("function");
    expect(round?.category).toBe("math");
  });

  it("tags a reference completion as a property", () => {
    const model = buildFormulaEditorModel('prop("', 6, ["Name"]);
    expect(model.context.kind).toBe("property");
    const name = model.completions.find((item) => item.label === "Name");
    expect(name?.category).toBe("property");
  });
});

describe("FormulaEditor render — completion popup", () => {
  const html = render({ value: "ro" });

  it("is a tokenised raised popup", () => {
    expect(html).toContain("surface-raised");
    expect(html).toContain("animate-rise");
    expect(html).toContain('data-testid="fe-completions"');
  });

  it("tags each reference row with its category", () => {
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("round");
    expect(html).toContain("math");
  });
});

describe("FormulaEditor render — signature help", () => {
  it("shows the enclosing call's signature with the active parameter", () => {
    const html = render({ value: "round(" });
    expect(html).toContain('data-testid="fe-signature"');
    expect(html).toContain("round(value, digits?)");
    expect(html).toContain("value");
  });
});

describe("FormulaEditor render — diagnostics", () => {
  it("renders the diagnostics list in danger ink inside a role=alert", () => {
    const html = render({ value: "nope(" });
    expect(html).toContain('data-testid="fe-diagnostics"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-danger");
    expect(html).toContain("unknown function");
  });
});
