import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DevicePreview } from "@/components/device-preview";

/**
 * Device-preview rendering. The geometry comes from the pure
 * `animated-media.ts` registry; this asserts the surface actually paints a
 * usable frame around live content (image/iframe), and unwraps malformed device
 * ids instead of replacing the content with a blank static block.
 */

const render = (props: Parameters<typeof DevicePreview>[0]): string =>
  renderToStaticMarkup(
    createElement(
      DevicePreview,
      props,
      createElement("iframe", {
        src: "https://www.youtube.com/embed/x",
        title: "video",
      }),
    ),
  );

describe("DevicePreview", () => {
  it("paints a phone frame around its live child", () => {
    const html = render({ device: "phone" });
    expect(html).toContain('data-device-preview="phone"');
    expect(html).toContain('data-device-viewport=""');
    expect(html).toContain('data-device-notch="top"');
    expect(html).toContain("max-width:390px");
    expect(html).toContain("aspect-ratio:390 / 844");
    expect(html).toContain("border-radius:40px");
    // The embed is rendered live inside the frame, not replaced by a poster.
    expect(html).toContain('src="https://www.youtube.com/embed/x"');
    expect(html).toContain('role="group"');
  });

  it("caps a desktop frame to the reading column", () => {
    const html = render({ device: "desktop" });
    expect(html).toContain('data-device-preview="desktop"');
    expect(html).toContain("max-width:720px");
    expect(html).toContain("aspect-ratio:1440 / 900");
  });

  it("clamps a requested scale and applies it to the frame", () => {
    const html = render({ device: "phone", scale: 0.1, maxWidth: 1000 });
    // 0.1 is below the 0.25 guard rail; the frame is scaled to that minimum.
    expect(html).toContain("aspect-ratio:98 / 211");
    expect(html).toContain("max-width:98px");
    expect(html).toContain("border-radius:10px");
  });

  it("unwraps an unknown device but still renders its content", () => {
    const html = render({ device: "toaster" });
    expect(html).not.toContain("data-device-preview");
    expect(html).toContain('src="https://www.youtube.com/embed/x"');
  });

  it("unwraps a missing device", () => {
    const html = render({});
    expect(html).not.toContain("data-device-preview");
    expect(html).toContain('src="https://www.youtube.com/embed/x"');
  });

  it("labels the frame with the resolved device when no label is supplied", () => {
    expect(render({ device: "phone" })).toContain('aria-label="Phone (390x844, radius 40, notched)"');
  });
});
