/**
 * dz17 — node acceptance for the assistant answer menu.
 *
 * The action → `Tag` (hint + hue) mapping is pure and pinned here; the menu is
 * then rendered with a stub menu item to prove the token styling and the Tag
 * actions reach the markup.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/server/actions/chat", () => ({
  saveChatAnswerAction: vi.fn(),
  regenerateChatAnswerAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { TAG_PALETTE } from "@/lib/design-tokens";
import {
  ANSWER_ACTION_TAGS,
  ChatAnswerItems,
  answerActionTag,
  type ChatAnswerActionId,
} from "./chat-answer-menu";

/* ---------------------------------------------------------------- mapping */

describe("answer action tags", () => {
  it("gives every action a documented entry", () => {
    const ids: ChatAnswerActionId[] = [
      "copy",
      "copyPlain",
      "save",
      "followUp",
      "regenerate",
      "openNote",
      "openSaved",
    ];
    expect(Object.keys(ANSWER_ACTION_TAGS).sort()).toEqual([...ids].sort());
  });

  it("keeps every hint hue on the tag palette, and the open rows bare", () => {
    for (const tag of Object.values(ANSWER_ACTION_TAGS)) {
      if (tag) expect(TAG_PALETTE).toContain(tag.hue);
    }
    expect(answerActionTag("copy")).toEqual({ hint: "⌘C", hue: "blue" });
    expect(answerActionTag("save")?.hue).toBe("green");
    expect(answerActionTag("regenerate")?.hue).toBe("orange");
    expect(answerActionTag("openSaved")).toBeNull();
    expect(answerActionTag("openNote")).toBeNull();
  });
});

/* --------------------------------------------------------- static render */

const stubItem: ComponentType<{
  onSelect?: (event: Event) => void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}> = ({ children }) => createElement("div", { "data-item": "true" }, children as ReactNode);

describe("renderToStaticMarkup — the answer menu", () => {
  const render = (threadPageId?: string) =>
    renderToStaticMarkup(
      createElement(ChatAnswerItems, {
        Item: stubItem,
        message: { id: "m1", body: "**Hello**", threadPageId },
        slug: "demo",
        locale: "en",
        threadId: "t1",
        onFollowUp: () => {},
        onSaved: () => {},
      }),
    );

  it("renders every action with its Tag hint", () => {
    const html = render();
    expect(html).toContain("Copy answer");
    expect(html).toContain("Copy as plain text");
    expect(html).toContain("Save as new note");
    expect(html).toContain("Regenerate answer");
    // Tag actions: the hint chip uses the tokenised `.tag` class.
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("⌘C");
    expect(html).toContain("⌘S");
    expect(html).toContain("⌘R");
    // Without a thread page, the "open the note" row is absent.
    expect(html).not.toContain("Open the note this discusses");
  });

  it("adds the note row when the thread is pinned to a page", () => {
    expect(render("page-9")).toContain("Open the note this discusses");
  });
});
