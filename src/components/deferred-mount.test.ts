import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const imported = vi.hoisted(() => ({ comment: false, backlinks: false }));

vi.mock("@/components/comment-panel", () => {
  imported.comment = true;
  return { CommentPanel: () => createElement("div", null, "comments") };
});

vi.mock("@/components/backlinks", () => {
  imported.backlinks = true;
  return { Backlinks: () => createElement("div", null, "backlinks") };
});

import { DeferredMount } from "@/components/deferred-mount";
import { DeferredCommentPanel } from "@/components/deferred-comment-panel";
import { DeferredBacklinks } from "@/components/deferred-backlinks";

describe("DeferredMount", () => {
  it("renders only the fallback during server rendering", () => {
    const html = renderToStaticMarkup(
      // React 19's createElement typing requires `children` in props here.
      // eslint-disable-next-line react/no-children-prop
      createElement(DeferredMount, {
        fallback: createElement("span", null, "waiting"),
        children: createElement("span", null, "content"),
      }),
    );

    expect(html).toContain("waiting");
    expect(html).not.toContain("content");
  });

  it("does not import the heavy panels when the wrappers are deferred", () => {
    renderToStaticMarkup(
      createElement(DeferredCommentPanel, {
        pageId: "page-1",
        comments: [],
        currentUserId: "user-1",
        canComment: true,
        locale: "en",
      }),
    );
    renderToStaticMarkup(
      createElement(DeferredBacklinks, {
        items: [],
        workspaceSlug: "demo",
        locale: "en",
      }),
    );

    expect(imported.comment).toBe(false);
    expect(imported.backlinks).toBe(false);
  });
});
