import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  INPUT_BASE,
  INPUT_SIZES,
  Input,
  TEXTAREA_SIZES,
  Textarea,
  Field,
  inputClasses,
  textareaClasses,
} from "./input";

/**
 * Node tests for the form primitives: size class maps, the invalid/disabled
 * states, adornments and clear affordance, the `Field` ARIA wiring, and a
 * static render for each configuration.
 */

describe("input class maps", () => {
  it("exposes sm/md/lg sizes", () => {
    expect(Object.keys(INPUT_SIZES).sort()).toEqual(["lg", "md", "sm"]);
    expect(INPUT_SIZES.sm).toContain("h-8");
    expect(INPUT_SIZES.md).toContain("h-9");
    expect(INPUT_SIZES.lg).toContain("h-11");
  });

  it("wires focus-ring, disabled and token colours", () => {
    expect(INPUT_BASE).toContain("focus-ring");
    expect(INPUT_BASE).toContain("disabled:opacity-50");
    const classes = inputClasses({});
    expect(classes).toContain("border-border");
    expect(classes).toContain("focus-ring");
  });

  it("switches the ring to danger when invalid", () => {
    expect(inputClasses({ invalid: true })).toContain("border-danger");
    expect(inputClasses({ invalid: false })).toContain("border-border");
  });

  it("pads for leading and trailing adornments", () => {
    const classes = inputClasses({ leading: true, trailing: true });
    expect(classes).toContain("ps-8");
    expect(classes).toContain("pe-8");
  });
});

describe("renderToStaticMarkup — input states", () => {
  for (const size of ["sm", "md", "lg"] as const) {
    it(`renders size ${size}`, () => {
      const html = renderToStaticMarkup(createElement(Input, { size }));
      expect(html).toContain(INPUT_SIZES[size].split(" ")[0]);
    });
  }

  it("renders invalid with aria-invalid", () => {
    const html = renderToStaticMarkup(
      createElement(Input, { invalid: true, defaultValue: "x" }),
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-danger");
  });

  it("renders disabled", () => {
    const html = renderToStaticMarkup(createElement(Input, { disabled: true }));
    expect(html).toContain("disabled");
  });

  it("renders a leading addon", () => {
    const html = renderToStaticMarkup(
      createElement(Input, {
        leading: createElement("i", null, "L"),
      }),
    );
    expect(html).toContain(">L<");
    expect(html).toContain('data-slot="input-leading"');
    expect(html).toContain("ps-8");
  });

  it("renders a trailing addon", () => {
    const html = renderToStaticMarkup(
      createElement(Input, { trailing: createElement("i", null, "R") }),
    );
    expect(html).toContain(">R<");
    expect(html).toContain('data-slot="input-trailing"');
    expect(html).toContain("pe-8");
  });

  it("renders a clear button only when the field has text", () => {
    const empty = renderToStaticMarkup(createElement(Input, { clearable: true }));
    expect(empty).not.toContain('aria-label="Clear"');

    const filled = renderToStaticMarkup(
      createElement(Input, { clearable: true, value: "hi", readOnly: true }),
    );
    expect(filled).toContain('aria-label="Clear"');
  });

  it("keeps the empty-input fast path free of a wrapper", () => {
    const html = renderToStaticMarkup(createElement(Input, { id: "a" }));
    expect(html.startsWith("<input")).toBe(true);
  });
});

describe("textarea", () => {
  it("exposes the same size scale with min-heights", () => {
    expect(Object.keys(TEXTAREA_SIZES).sort()).toEqual(["lg", "md", "sm"]);
    expect(textareaClasses({ size: "md" })).toContain("min-h-20");
    expect(textareaClasses({ invalid: true })).toContain("border-danger");
  });

  it("renders invalid + disabled", () => {
    const html = renderToStaticMarkup(
      createElement(Textarea, { invalid: true, disabled: true }),
    );
    expect(html.startsWith("<textarea")).toBe(true);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("disabled");
  });
});

describe("field ARIA wiring", () => {
  it("links the label, hint and error to the control", () => {
    const html = renderToStaticMarkup(
      createElement(
        Field,
        { id: "email", label: "Email", hint: "We never share it", error: "Required" },
        createElement(Input, { name: "email" }),
      ),
    );
    expect(html).toContain('for="email"');
    expect(html).toContain('id="email"');
    expect(html).toContain('id="email-hint"');
    expect(html).toContain('id="email-error"');
    expect(html).toContain('aria-describedby="email-hint email-error"');
    expect(html).toContain('aria-errormessage="email-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    // The invalid shorthand reaches our own control.
    expect(html).toContain("border-danger");
  });

  it("omits error wiring when there is no error", () => {
    const html = renderToStaticMarkup(
      createElement(
        Field,
        { id: "name", label: "Name", hint: "Your display name" },
        createElement(Input, {}),
      ),
    );
    expect(html).toContain('aria-describedby="name-hint"');
    expect(html).not.toContain("aria-errormessage");
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("does not leak the invalid attribute onto a bare element", () => {
    const html = renderToStaticMarkup(
      createElement(
        Field,
        { id: "x", label: "X", error: "bad" },
        createElement("input", {}),
      ),
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain(' invalid="true"');
  });
});
