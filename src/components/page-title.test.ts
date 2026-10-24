import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_COVER_POSITION } from "@/lib/cover-position";
import { GRADIENTS } from "@/lib/page-cover";
import type { BreadcrumbItem } from "@/lib/breadcrumb";

/**
 * Page header — the first thing a user sees.
 *
 * The heavy collaborators (server actions, dialogs, the actions menu) are
 * stubbed so the *pure* header model and the presentational `PageTitleRow` can
 * be exercised without a Next runtime: the breadcrumb truncation budget +
 * overflow split, the cover decode/encode round-trip, the sticky-title
 * threshold, and the row's normal/scrolled/empty markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock("@/server/actions/pages", () => ({
  archivePageAction: vi.fn(),
  getPageContentAction: vi.fn(),
  movePageAction: vi.fn(),
  toggleFavoriteAction: vi.fn(),
  toggleFollowAction: vi.fn(),
  transferPageAction: vi.fn(),
  updatePageAction: vi.fn(),
}));

vi.mock("@/server/actions/page-menu", () => ({
  duplicatePageAction: vi.fn(),
  getPageEditedAction: vi.fn(),
  getPageMenuDataAction: vi.fn(),
}));

vi.mock("@/server/actions/teamspaces", () => ({ setPageTeamspaceAction: vi.fn() }));
vi.mock("@/components/who-has-access", () => ({ WhoHasAccess: () => null }));
vi.mock("@/components/share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("@/components/notion-import-dialog", () => ({ NotionImportDialog: () => null }));
vi.mock("@/components/topbar/chat-bridge", () => ({ sendChatPrompt: vi.fn() }));
vi.mock("@/components/topbar/actions-menu", () => ({
  ActionsMenu: () => null,
  EMOJIS: [],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  HEADER_BREADCRUMB_MAX,
  HEADER_BREADCRUMB_MIN,
  HEADER_BREADCRUMB_WIDTH_PX,
  PageTitleRow,
  crumbWidthPx,
  decodeCover,
  encodeCover,
  headerBreadcrumbBudget,
  layoutHeaderBreadcrumbs,
  splitBreadcrumbOverflow,
  stickyTitleVisible,
} = await import("@/components/page-title");

/* ------------------------------------------------------------------ pure ---- */

describe("stickyTitleVisible", () => {
  it("hides the title until the in-page h1 scrolls fully out", () => {
    expect(stickyTitleVisible(0, 100)).toBe(false);
    expect(stickyTitleVisible(99, 100)).toBe(false);
    expect(stickyTitleVisible(100, 100)).toBe(false); // exactly in view
    expect(stickyTitleVisible(101, 100)).toBe(true);
  });

  it("fails closed for a not-yet-measured heading or NaN scroll", () => {
    expect(stickyTitleVisible(0, Number.POSITIVE_INFINITY)).toBe(false);
    expect(stickyTitleVisible(Number.NaN, 0)).toBe(false);
    expect(stickyTitleVisible(0, Number.NaN)).toBe(false);
  });
});

const crumb = (id: string, label = id.toUpperCase()): BreadcrumbItem => ({ id, label });

describe("headerBreadcrumbBudget", () => {
  const five = [crumb("a"), crumb("b"), crumb("c"), crumb("d"), crumb("e")];

  it("returns 0 for an empty trail and 1 for a single crumb", () => {
    expect(headerBreadcrumbBudget([])).toBe(0);
    expect(headerBreadcrumbBudget([crumb("a")])).toBe(1);
  });

  it("keeps root + current when they fit and grows from the deepest middles", () => {
    // "A" is one ordinary glyph: 1 * 14 + 18 = 32px per crumb.
    expect(crumbWidthPx("A")).toBe(14 + 18);
    expect(headerBreadcrumbBudget(five, 70)).toBe(2); // ends fit (64), no room for a middle
    expect(headerBreadcrumbBudget(five, 100)).toBe(3); // one middle fits (96)
    expect(headerBreadcrumbBudget(five, 100000)).toBe(5);
  });

  it("collapses to the current page alone when there is no room for both ends", () => {
    expect(headerBreadcrumbBudget(five, 10)).toBe(1);
  });

  it("falls back to the default width for a non-finite / non-positive budget", () => {
    expect(headerBreadcrumbBudget(five, 0)).toBe(
      headerBreadcrumbBudget(five, HEADER_BREADCRUMB_WIDTH_PX),
    );
    expect(headerBreadcrumbBudget(five, Number.NaN)).toBe(
      headerBreadcrumbBudget(five, HEADER_BREADCRUMB_WIDTH_PX),
    );
  });

  it("never exceeds the header maximum", () => {
    const many = Array.from({ length: 12 }, (_, i) => crumb(`c${i}`));
    expect(headerBreadcrumbBudget(many, 100000)).toBe(HEADER_BREADCRUMB_MAX);
  });
});

describe("splitBreadcrumbOverflow", () => {
  const five = [crumb("a"), crumb("b"), crumb("c"), crumb("d"), crumb("e")];

  it("shows everything while the trail fits the budget", () => {
    expect(splitBreadcrumbOverflow(five, 5)).toEqual({ visible: five, overflow: [] });
    expect(splitBreadcrumbOverflow(five, 9)).toEqual({ visible: five, overflow: [] });
  });

  it("keeps the root + current and folds the middle into the overflow", () => {
    expect(splitBreadcrumbOverflow(five, 3)).toEqual({
      visible: [five[0], five[3], five[4]],
      overflow: [five[1], five[2]],
    });
  });

  it("keeps the current page alone at budget 1, and nothing at 0", () => {
    expect(splitBreadcrumbOverflow(five, 1)).toEqual({
      visible: [five[4]],
      overflow: [five[0], five[1], five[2], five[3]],
    });
    expect(splitBreadcrumbOverflow(five, 0)).toEqual({ visible: [], overflow: five });
  });

  it("returns fresh arrays and never mutates the input", () => {
    const input = five.map((item) => ({ ...item }));
    const out = splitBreadcrumbOverflow(input, 4);
    expect(out.visible).not.toBe(input);
    expect(input).toEqual(five);
  });
});

describe("layoutHeaderBreadcrumbs", () => {
  it("budgets by width and then splits", () => {
    const five = [crumb("a"), crumb("b"), crumb("c"), crumb("d"), crumb("e")];
    expect(layoutHeaderBreadcrumbs(five, 70).visible.map((c) => c.id)).toEqual(["a", "e"]);
    expect(layoutHeaderBreadcrumbs(five, 70).overflow.map((c) => c.id)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("exposes the documented minimum budget", () => {
    expect(HEADER_BREADCRUMB_MIN).toBe(2);
  });
});

describe("cover decode/encode round-trip", () => {
  it("round-trips a gradient preset without the default focal point", () => {
    const stored = encodeCover({ type: "gradient", gradientId: "ocean" }, DEFAULT_COVER_POSITION);
    expect(stored).toBe(GRADIENTS.ocean);
    expect(decodeCover(stored)).toEqual({
      value: { type: "gradient", gradientId: "ocean" },
      position: DEFAULT_COVER_POSITION,
    });
  });

  it("round-trips an image cover with a non-default focal point", () => {
    const value = { type: "image" as const, url: "https://cdn.example.com/a.png" };
    const position = { x: 20, y: 80 };
    const stored = encodeCover(value, position);
    expect(stored).toContain("url(\"https://cdn.example.com/a.png\")");
    const decoded = decodeCover(stored);
    expect(decoded?.value).toEqual(value);
    expect(decoded?.position).toEqual(position);
  });

  it("is idempotent: decode(encode(v)) re-encodes byte-for-byte", () => {
    const value = { type: "image" as const, url: "https://cdn.example.com/b.png" };
    const position = { x: 33, y: 66 };
    const once = encodeCover(value, position);
    const decoded = decodeCover(once);
    expect(decoded).not.toBeNull();
    expect(encodeCover(decoded!.value, decoded!.position)).toBe(once);
  });

  it("fails closed for a hostile URL, empty and unrecognised values", () => {
    expect(encodeCover({ type: "image", url: "javascript:alert(1)" }, DEFAULT_COVER_POSITION)).toBe("");
    expect(decodeCover("")).toBeNull();
    expect(decodeCover(null)).toBeNull();
    expect(decodeCover("linear-gradient(120deg, #000 0%, #fff 100%)")).toBeNull();
    expect(decodeCover("not a cover at all")).toBeNull();
  });
});

/* ---------------------------------------------------------------- render ---- */

const baseCrumbTrail: BreadcrumbItem[] = [crumb("root", "Home"), crumb("p1", "Roadmap")];

type RowProps = Parameters<typeof PageTitleRow>[0];

const baseProps: RowProps = {
  workspaceSlug: "ws",
  workspaceName: "Acme",
  pageId: "p1",
  title: "Roadmap",
  icon: { kind: "emoji", value: "🚀" },
  crumbs: baseCrumbTrail,
  locked: false,
  canEdit: true,
  favorite: false,
  following: false,
  scrolled: false,
  showStickyTitle: false,
  onTitleChange: () => {},
  onTitleBlur: () => {},
  onTitleKeyDown: () => {},
  onToggleIcon: () => {},
  onToggleFavorite: () => {},
  onToggleFollow: () => {},
  onCopyLink: () => {},
  onShare: () => {},
};

const render = (overrides: Partial<RowProps> = {}): string =>
  renderToStaticMarkup(createElement(PageTitleRow, { ...baseProps, ...overrides }));

describe("PageTitleRow render", () => {
  it("renders the normal state: sticky bar, breadcrumb, H1 title, actions", () => {
    const html = render();
    expect(html).toContain('data-testid="page-title-bar"');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('href="/w/ws"'); // workspace crumb
    expect(html).toContain('href="/w/ws/root"'); // ancestor crumb
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Page title"');
    expect(html).toContain("Roadmap");
    expect(html).toContain('aria-label="Follow page"');
    expect(html).toContain('aria-label="Add to favorites"');
    expect(html).toContain('aria-label="Copy link"');
    // No sticky title and no hairline until the user scrolls.
    expect(html).not.toContain('data-testid="sticky-title"');
    expect(html).toContain("border-transparent");
  });

  it("renders the scrolled state: compact sticky title and the hairline", () => {
    const html = render({ scrolled: true, showStickyTitle: true });
    expect(html).toContain('data-testid="sticky-title"');
    expect(html).toContain("animate-fade");
    expect(html).toContain("border-b border-border");
    // The compact title mirrors the page title.
    expect(html).toContain("Roadmap");
  });

  it("renders the empty state: Untitled placeholder + add-icon affordance", () => {
    const html = render({
      title: "",
      icon: { kind: "none", value: "" },
      crumbs: [],
      showStickyTitle: true,
      scrolled: true,
    });
    expect(html).toContain('placeholder="Untitled"');
    expect(html).toContain('aria-label="Add icon"');
    // The sticky title falls back to "Untitled" when the page has no title.
    expect(html).toContain("Untitled");
    expect(html).not.toContain('data-testid="breadcrumb-overflow"');
  });

  it("folds a long breadcrumb trail into the shared popover overflow menu", () => {
    const crumbs = ["a", "b", "c", "d", "e"].map((id) => crumb(id));
    const html = render({ crumbs, pageId: "e", breadcrumbWidth: 70 });
    expect(html).toContain('data-testid="breadcrumb-overflow"');
    // Radix owns the trigger contract; the collapsed crumbs render in the
    // portalled content only once the popover opens.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Show 3 more pages"');
    expect(html).not.toContain("<summary");
  });

  it("marks a locked page and a favourited star", () => {
    const html = render({ locked: true, favorite: true, following: true });
    expect(html).toContain('aria-label="Page locked"');
    expect(html).toContain('aria-label="Remove from favorites"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("gives the title its own bidi direction", () => {
    const arabic = "\u0645\u0631\u062D\u0628\u0627"; // مرحبا
    const rtl = render({ title: arabic, scrolled: true, showStickyTitle: true });
    // Both the editable field and the compact sticky title follow the content.
    expect(rtl.match(/dir="rtl"/g)?.length).toBe(2);
    expect(rtl).toContain("dir-rtl");
    // An empty title stays auto so it inherits the document direction rather
    // than forcing LTR inside an Arabic layout.
    const empty = render({ title: "", scrolled: true, showStickyTitle: true });
    expect(empty).toContain('dir="auto"');
  });
});
