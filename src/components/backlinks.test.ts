import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Backlinks panel — grouped linked/unlinked sections with tag-palette count
 * chips, a pending "Link" action for unlinked mentions, and the loading /
 * empty / error states. The server action and Next router are stubbed; the
 * panel itself renders through `react-dom/server`.
 */

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "ws", pageId: "target" }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children?: unknown;
      [key: string]: unknown;
    }) => h("a", { href, ...rest }, children as never),
  };
});

vi.mock("@/server/actions/backlinks", () => ({
  linkUnlinkedMentionAction: vi.fn(async () => ({ ok: true })),
}));

const { Backlinks, backlinkSections, backlinkTotal, BACKLINK_SECTION_HUE } = await import(
  "@/components/backlinks"
);

/* ------------------------------------------------------------------ pure ---- */

const item = (id: string, title = `Page ${id}`) => ({ id, title, icon: null });

describe("backlinkSections", () => {
  it("renders linked before unlinked and drops empty sections", () => {
    const sections = backlinkSections([item("l1")], [item("u1")]);
    expect(sections.map((s) => s.kind)).toEqual(["linked", "unlinked"]);
    expect(backlinkSections([], [item("u1")]).map((s) => s.kind)).toEqual(["unlinked"]);
    expect(backlinkSections([item("l1")], []).map((s) => s.kind)).toEqual(["linked"]);
    expect(backlinkSections([], [])).toEqual([]);
  });

  it("tags each section with its palette hue and returns fresh item arrays", () => {
    const linked = [item("l1")];
    const sections = backlinkSections(linked, []);
    expect(sections[0].hue).toBe(BACKLINK_SECTION_HUE.linked);
    expect(BACKLINK_SECTION_HUE.unlinked).toBe("orange");
    expect(sections[0].items).not.toBe(linked);
    expect(sections[0].items).toEqual(linked);
  });
});

describe("backlinkTotal", () => {
  it("sums both lists and tolerates missing input", () => {
    expect(backlinkTotal([item("a")], [item("b"), item("c")])).toBe(3);
    expect(backlinkTotal([], [])).toBe(0);
    expect(backlinkTotal()).toBe(0);
  });
});

/* ---------------------------------------------------------------- render ---- */

type PanelProps = Parameters<typeof Backlinks>[0];

const baseProps: PanelProps = {
  items: [],
  unlinked: [],
  workspaceSlug: "ws",
  locale: "en",
};

const render = (overrides: Partial<PanelProps> = {}): string =>
  renderToStaticMarkup(createElement(Backlinks, { ...baseProps, ...overrides }));

describe("Backlinks render", () => {
  it("renders nothing when there are no references and empty is not requested", () => {
    expect(render()).toBe("");
  });

  it("renders the linked section with a tag-palette count chip", () => {
    const html = render({ items: [item("l1", "Design doc")] });
    expect(html).toContain("Linked references");
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("Design doc");
    expect(html).toContain('href="/w/ws/l1"');
    expect(html).not.toContain("Unlinked mentions");
  });

  it("renders unlinked mentions with a Link action and an orange chip", () => {
    const html = render({
      items: [item("l1")],
      unlinked: [item("u1", "Old notes")],
    });
    expect(html).toContain("Unlinked mentions");
    expect(html).toContain("tag tag-orange");
    expect(html).toContain("Old notes");
    expect(html).toContain(">Link<");
    expect(html).toContain("<form");
  });

  it("shows the actionable empty state when opted in", () => {
    const html = render({ showEmpty: true });
    expect(html).toContain("notion-empty");
    expect(html).toContain("Mention this page with @");
    expect(html).toContain("Refresh");
  });

  it("shows a skeleton while loading", () => {
    const html = render({ loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("notion-skeleton");
    expect(html).not.toContain("Linked references");
  });

  it("shows the error state with a retry action", () => {
    const html = render({ error: "Could not load references." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load references.");
    expect(html).toContain("Retry");
  });
});
