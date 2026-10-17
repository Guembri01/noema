import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ds08 — the workspace empty state, rendered statically on the shared
 * `EmptyState` primitive with two actionable design-system buttons.
 */
import { EmptyTicketsState } from "./empty-tickets";

const render = (hasLabels: boolean) =>
  renderToStaticMarkup(
    createElement(EmptyTicketsState, {
      onCreate: () => {},
      onAddLabel: () => {},
      hasLabels,
      locale: "en",
    }),
  );

describe("EmptyTicketsState markup", () => {
  it("renders the shared empty-state block with both actions", () => {
    const html = render(false);
    expect(html).toContain('data-testid="tickets-empty"');
    expect(html).toContain('data-empty-state="full"');
    expect(html).toContain("No tickets yet");
    expect(html).toContain("Create ticket");
    expect(html).toContain("Add a label");
  });

  it("swaps the second CTA once labels exist", () => {
    expect(render(true)).toContain("Add another label");
  });

  it("uses the design-system buttons (token + interaction classes)", () => {
    const html = render(false);
    expect(html).toContain("animate-fade");
    expect(html).toContain("u-interactive");
    expect(html).toContain("focus-ring");
  });
});
