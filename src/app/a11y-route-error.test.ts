import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RouteError from "./error";

// Structural contract copied from scripts/check-a11y.mjs for the parts a route
// error boundary contributes when it renders inside the root layout (main
// landmark + exactly one h1 + an accessible retry control).
const hasMain = (html: string) => /<main[\s>]/i.test(html);
const h1Count = (html: string) => (html.match(/<h1[\s>]/gi) ?? []).length;

describe("route-error fallback (app/error.tsx) check:a11y contract", () => {
  it("exposes a main landmark with exactly one h1 and a labelled retry button", () => {
    const html = renderToStaticMarkup(
      createElement(RouteError, { error: new Error("boom"), reset: () => {} }),
    );
    expect(hasMain(html)).toBe(true);
    expect(h1Count(html)).toBe(1);
    expect(html).toContain("Try again");
  });
});
