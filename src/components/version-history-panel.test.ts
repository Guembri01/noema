import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionHistory } from "@/components/version-history";
import { VersionHistoryPanel } from "@/components/version-history-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/server/actions/page-versions", () => ({
  restorePageVersionAction: vi.fn(),
}));

const versions = [
  {
    id: "v1",
    title: "First draft",
    content: "Hello",
    summary: null,
    charDelta: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    author: { id: "user-1", name: "Ada", email: "ada@example.com" },
    label: null,
  },
];

const current = {
  title: "Current",
  updatedAt: "2026-10-22T10:00:00.000Z",
  content: "Hello",
};

describe("VersionHistory", () => {
  it("renders only the trigger while closed", () => {
    const html = renderToStaticMarkup(
      createElement(VersionHistory, {
        pageId: "page-1",
        locale: "en",
        current,
        versions,
      }),
    );

    expect(html).toContain("Version history");
    expect(html).not.toContain("version-history-panel");
  });

  it("renders the extracted panel directly", () => {
    const html = renderToStaticMarkup(
      createElement(VersionHistoryPanel, {
        pageId: "page-1",
        locale: "en",
        current,
        versions,
        onClose: vi.fn(),
        returnFocusRef: { current: null },
      }),
    );

    expect(html).toContain("First draft");
    expect(html).toContain('data-testid="version-history-panel"');
  });
});
