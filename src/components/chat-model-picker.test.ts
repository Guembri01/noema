import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatModelPicker } from "./chat-model-picker";
import { chatModelInfo } from "@/lib/chat-model";

/**
 * The composer's model control, statically rendered.
 *
 * Radix keeps the menu closed until it is opened in a browser, so what a static
 * render can pin is the *trigger* — which is precisely what used to be wrong: the
 * model sat in a `<span>` Tag that could not be clicked. The menu contents are
 * covered by the pure helpers in `chat-model.test.ts` and by
 * `npm run check:floating`/the screenshots in `docs/screenshots/`.
 */

const deepseek = chatModelInfo({
  provider: "deepseek",
  model: "deepseek-flash",
  source: "env",
});

function render(props: Partial<Parameters<typeof ChatModelPicker>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ChatModelPicker, {
      slug: "demo-workspace",
      info: deepseek,
      model: "deepseek-chat",
      onSelect: () => {},
      locale: "en",
      ...props,
    }),
  );
}

describe("ChatModelPicker trigger", () => {
  it("is a real control, not a read-only tag", () => {
    const html = render();
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('data-testid="chat-model-trigger"');
    // The tag it replaced was a span: neither clickable nor focusable.
    expect(html).toContain("focus-ring");
  });

  it("shows the label of the model that will answer, not the configured default", () => {
    // The configured model is deepseek-flash; this conversation chose deepseek-chat.
    const html = render();
    expect(html).toContain("DeepSeek Chat (V3)");
    expect(html).not.toContain("DeepSeek Flash");
  });

  it("names itself with the model so screen readers hear the choice", () => {
    expect(render()).toContain('aria-label="Model: DeepSeek Chat (V3)"');
  });

  it("falls back to the message-metadata label when no model is configured", () => {
    const unconfigured = chatModelInfo({ provider: null, model: null, source: "none" });
    const html = render({ info: unconfigured, model: "", locale: "en" });
    // aiModel is the shipped key for the generic label.
    expect(html).toContain("AI model");
  });

  it("renders the model id when the catalogue does not know it", () => {
    const custom = chatModelInfo({ provider: "custom", model: "llama-3-70b", source: "workspace" });
    expect(render({ info: custom, model: "llama-3-70b" })).toContain("llama-3-70b");
  });

  it("carries no colour literals — the token layer owns the palette", () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
