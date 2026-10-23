import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CARD_MEDIA_ASPECT,
  CARD_PADDING,
  CARD_VARIANTS,
  Card,
  CardBody,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardMedia,
  CardTitle,
} from "./card";

/**
 * DS07 Card — pin the pure variant/padding maps and render every variant with
 * `react-dom/server` (the node test env has no DOM). This is the "live check"
 * the design-system checklist asks for.
 */

const h = createElement;

describe("Card variant map", () => {
  it("raises only `raised`/`interactive` with shadow-1", () => {
    expect(CARD_VARIANTS.raised).toContain("shadow-1");
    expect(CARD_VARIANTS.flat).toContain("border-border");
    expect(CARD_VARIANTS.flat).not.toMatch(/shadow-/);
  });

  it("makes `interactive` lift on hover and press via .u-interactive", () => {
    expect(CARD_VARIANTS.interactive).toContain("u-interactive");
    expect(CARD_VARIANTS.interactive).toContain("focus-ring");
    expect(CARD_VARIANTS.interactive).toContain("hover:shadow-2");
    // hover is colour/elevation only — never a size change.
    expect(CARD_VARIANTS.interactive).not.toMatch(/hover:(h|w|p|m)-/);
  });

  it("ships a 4px-grid padding scale", () => {
    expect(CARD_PADDING.none).toBe("");
    expect(CARD_PADDING.sm).toBe("p-3");
    expect(CARD_PADDING.md).toBe("p-4");
    expect(CARD_PADDING.lg).toBe("p-6");
  });

  it("maps every media aspect", () => {
    expect(CARD_MEDIA_ASPECT.video).toBe("aspect-video");
    expect(CARD_MEDIA_ASPECT.square).toBe("aspect-square");
    expect(CARD_MEDIA_ASPECT.auto).toBe("");
  });
});

describe("Card render", () => {
  it.each(["raised", "flat", "interactive"] as const)(
    "renders the %s variant",
    (variant) => {
      const html = renderToStaticMarkup(h(Card, { variant }, "content"));
      expect(html).toContain("rounded-card");
      for (const token of CARD_VARIANTS[variant].split(" ")) {
        expect(html).toContain(token);
      }
      expect(html).toContain("content");
    },
  );

  it.each(["none", "sm", "md", "lg"] as const)("renders padding=%s", (padding) => {
    const html = renderToStaticMarkup(h(Card, { padding }));
    const expected = CARD_PADDING[padding];
    if (expected) expect(html).toContain(expected);
    else expect(html).not.toMatch(/class="[^"]*\bp-\d/);
  });

  it("renders as an anchor when asked (keyboard activation path)", () => {
    const html = renderToStaticMarkup(
      h(Card, { as: "a", href: "/settings", variant: "interactive" }),
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/settings"');
  });

  it("renders a header with icon, title, subtitle and actions", () => {
    const html = renderToStaticMarkup(
      h(CardHeader, {
        icon: h("span", null, "★"),
        title: "Appearance",
        subtitle: "Theme and density",
        actions: h("button", null, "Reset"),
      }),
    );
    expect(html).toContain("Appearance");
    expect(html).toContain("Theme and density");
    expect(html).toContain("Reset");
    expect(html).toContain("★");
  });

  it("renders title/description/body/content/footer", () => {
    expect(renderToStaticMarkup(h(CardTitle, null, "Title"))).toContain(
      "text-sm font-semibold",
    );
    expect(renderToStaticMarkup(h(CardDescription, null, "Sub"))).toContain(
      "text-muted",
    );
    expect(renderToStaticMarkup(h(CardBody, null, "body"))).toContain("text-sm");
    expect(renderToStaticMarkup(h(CardContent, null, "body"))).toContain("text-sm");
    expect(renderToStaticMarkup(h(CardFooter, null, "ok"))).toContain(
      "justify-end",
    );
  });

  it("renders an optional cover/media slot", () => {
    const html = renderToStaticMarkup(
      h(CardMedia, { src: "/cover.png", alt: "Cover", aspect: "square" }),
    );
    expect(html).toContain("aspect-square");
    expect(html).toContain("<img");
    expect(html).toContain('alt="Cover"');
  });
});
