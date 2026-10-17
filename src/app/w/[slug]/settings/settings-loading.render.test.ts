import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SettingsLoading from "./loading";
import TokensLoading from "./tokens/loading";
import NotificationsLoading from "./notifications/loading";
import DataLoading from "./data/loading";
import BillingLoading from "./billing/loading";
import PromptsLoading from "./prompts/loading";
import MoveLoading from "./move/loading";

/**
 * Render proof for the settings `loading.tsx` shells.
 *
 * `react-dom/server` (the node test environment has no DOM) renders each shell
 * and pins the two invariants every one must hold: it uses the shared settings
 * container, and it is built from the shared shimmer skeletons (never bespoke
 * grey boxes). The remaining geometry is asserted by the design-system checks.
 */

const SHELLS = {
  settings: SettingsLoading,
  tokens: TokensLoading,
  notifications: NotificationsLoading,
  data: DataLoading,
  billing: BillingLoading,
  prompts: PromptsLoading,
  move: MoveLoading,
} as const;

const CONTAINER = "mx-auto w-full max-w-[1600px] px-8 py-12";

const render = (component: (typeof SHELLS)[keyof typeof SHELLS]) =>
  renderToStaticMarkup(createElement(component));

describe("settings loading shells", () => {
  for (const [name, component] of Object.entries(SHELLS)) {
    it(`${name}: uses the shared container and skeleton fill`, () => {
      const html = render(component);
      expect(html).toContain(CONTAINER);
      expect(html).toContain("notion-skeleton");
      expect(html).toContain('aria-busy="true"');
    });
  }

  it("renders each shell without a live heading (the real page supplies it)", () => {
    for (const component of Object.values(SHELLS)) {
      const html = render(component);
      expect(html).not.toMatch(/<h1[\s>]/i);
    }
  });
});
