/**
 * dz17 — node acceptance for the chat panel.
 *
 * The message → bubble / citation mapping, the grounding + token `Tag`s, the
 * streaming state machine, the autoscroll decision and the composer controls are
 * pure functions, so they are asserted directly. The user bubble, the assistant
 * bubble, the typing indicator and the empty state are then rendered with
 * `react-dom/server` (the node test environment has no DOM) to prove the markup
 * actually carries the state.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/server/actions/chat", () => ({
  createChatThreadAction: vi.fn(),
  deleteChatThreadAction: vi.fn(),
  executeChatActionAction: vi.fn(),
  postChatMessageAction: vi.fn(),
  regenerateChatAnswerAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { TAG_HUES, type TagHue } from "@/lib/design-tokens";
import { estimateTokens } from "@/lib/ai-context";
import {
  ChatEmptyState,
  ChatMessageItem,
  STREAM_INITIAL,
  TypingIndicator,
  answerChips,
  autoscrollDecision,
  citationChips,
  citationHue,
  composerControls,
  composerHeight,
  distanceFromBottom,
  isNearBottom,
  messageBubble,
  nextStreamPhase,
  resolveMessageRole,
  streamReducer,
  type ChatMessageMeta,
  type StreamPhase,
  type StreamState,
} from "./chat-panel";

/* ------------------------------------------------------------------ bubbles */

describe("messageBubble — alignment + surface, never a raw colour", () => {
  it("puts the user end-aligned on surface-2", () => {
    const spec = messageBubble("user");
    expect(spec.role).toBe("user");
    expect(spec.align).toBe("end");
    expect(spec.surface).toBe("user");
    expect(spec.bubbleClassName).toContain("bg-surface-2");
    expect(spec.rowClassName).toContain("justify-end");
  });

  it("puts the assistant start-aligned on surface with a hairline", () => {
    const spec = messageBubble("assistant");
    expect(spec.role).toBe("assistant");
    expect(spec.align).toBe("start");
    expect(spec.surface).toBe("assistant");
    expect(spec.bubbleClassName).toContain("bg-surface");
    expect(spec.bubbleClassName).toContain("border-border");
  });

  it("treats an unknown / missing role as the assistant", () => {
    expect(resolveMessageRole(undefined)).toBe("assistant");
    expect(resolveMessageRole(null)).toBe("assistant");
    expect(resolveMessageRole("system")).toBe("assistant");
    expect(resolveMessageRole("user")).toBe("user");
  });

  it("never emits a raw hex or raw palette class", () => {
    for (const role of ["user", "assistant"] as const) {
      const spec = messageBubble(role);
      expect(spec.bubbleClassName).not.toMatch(/#[0-9a-f]{3,8}/i);
      expect(spec.bubbleClassName).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|amber|emerald|slate)-\d/);
    }
  });
});

/* ---------------------------------------------------------------- citations */

describe("citation chips", () => {
  const references = [
    { id: "page-1", title: "Alpha", icon: "📄" },
    { id: "page-2", title: "  ", icon: null },
    { id: "page-3", title: "Gamma", icon: null },
  ];

  it("maps references to compact link chips", () => {
    const chips = citationChips("demo", references);
    expect(chips.map((chip) => chip.id)).toEqual(["page-1", "page-2", "page-3"]);
    expect(chips[0].href).toBe("/w/demo/page-1");
    expect(chips[0].title).toBe("Alpha");
    expect(chips[0].icon).toBe("📄");
    // Blank titles fall back to "Untitled" rather than rendering nothing.
    expect(chips[1].title).toBe("Untitled");
  });

  it("caps the number of chips and drops malformed references", () => {
    const chips = citationChips("demo", references, 2);
    expect(chips).toHaveLength(2);
    expect(chips.map((chip) => chip.id)).toEqual(["page-1", "page-2"]);
    expect(citationChips("demo", [{ id: "", title: "x", icon: null }])).toEqual([]);
    expect(citationChips("demo", undefined)).toEqual([]);
  });

  it("derives a stable hue from the tag palette", () => {
    for (const reference of references) {
      const hue = citationHue(reference.id);
      expect(TAG_HUES).toContain(hue);
      expect(citationHue(reference.id)).toBe(hue);
    }
  });
});

/* -------------------------------------------------------------- answer chips */

describe("answerChips — token budget + grounding", () => {
  it("always shows an estimated token chip", () => {
    const chips = answerChips(null, "**Hello** world");
    const tokens = chips.find((chip) => chip.key === "tokens");
    expect(tokens?.hue).toBe("gray");
    expect(tokens?.label).toBe(`${estimateTokens("**Hello** world")} tok`);
  });

  it("marks a grounded answer green and an ungrounded one yellow", () => {
    const grounded = answerChips({ references: [{ id: "p", title: "P", icon: null }] }, "hi");
    expect(grounded.find((chip) => chip.key === "grounding")?.hue).toBe("green");
    expect(grounded.find((chip) => chip.key === "grounding")?.label).toBe("1 source");

    const bare = answerChips({}, "hi");
    expect(bare.find((chip) => chip.key === "grounding")?.hue).toBe("yellow");
    expect(bare.find((chip) => chip.key === "grounding")?.label).toBe("No sources");

    const many = answerChips(
      { references: [
        { id: "a", title: "A", icon: null },
        { id: "b", title: "B", icon: null },
      ] },
      "hi",
    );
    expect(many.find((chip) => chip.key === "grounding")?.label).toBe("2 sources");
  });

  it("adds a context-budget chip only when the server recorded one", () => {
    expect(answerChips({}, "hi").some((chip) => chip.key === "budget")).toBe(false);
    const fit = answerChips({ contextTokens: 120, budgetTokens: 1024 }, "hi");
    expect(fit.find((chip) => chip.key === "budget")?.label).toBe("120/1024 ctx");
    expect(fit.find((chip) => chip.key === "budget")?.hue).toBe("blue");
    const trimmed = answerChips(
      { contextTokens: 900, budgetTokens: 1024, droppedTurns: 2 },
      "hi",
    );
    expect(trimmed.find((chip) => chip.key === "budget")?.hue).toBe("red");
  });
});

/* ----------------------------------------------------------------- streaming */

describe("streaming state machine", () => {
  it("walks idle → pending → streaming → idle", () => {
    let state: StreamState = STREAM_INITIAL;
    expect(state).toEqual({ phase: "idle", text: "" });
    state = streamReducer(state, { type: "send" });
    expect(state.phase).toBe("pending");
    state = streamReducer(state, { type: "open" });
    expect(state.phase).toBe("streaming");
    state = streamReducer(state, { type: "chunk", text: "Hel" });
    state = streamReducer(state, { type: "chunk", text: "lo" });
    expect(state).toEqual({ phase: "streaming", text: "Hello" });
    state = streamReducer(state, { type: "settle" });
    expect(state).toEqual({ phase: "idle", text: "" });
  });

  it("ignores a chunk that arrives while idle", () => {
    expect(streamReducer(STREAM_INITIAL, { type: "chunk", text: "x" })).toEqual(STREAM_INITIAL);
  });

  it("can open straight from pending or fall back with a settle", () => {
    const pending = streamReducer(STREAM_INITIAL, { type: "send" });
    const settled = streamReducer(pending, { type: "settle" });
    expect(settled).toEqual(STREAM_INITIAL);
    expect(streamReducer(pending, { type: "reset" })).toEqual(STREAM_INITIAL);
  });

  it("pins the phase transition table", () => {
    const phase = nextStreamPhase;
    expect(phase("idle", "send")).toBe("pending");
    expect(phase("pending", "open")).toBe("streaming");
    expect(phase("pending", "chunk")).toBe("streaming");
    expect(phase("streaming", "chunk")).toBe("streaming");
    expect(phase("streaming", "settle")).toBe("idle");
    expect(phase("pending", "reset")).toBe("idle");
    expect(phase("idle", "chunk")).toBe("idle");
  });
});

/* --------------------------------------------------------------- autoscroll */

describe("autoscroll decision", () => {
  const bottom = { scrollTop: 500, scrollHeight: 900, clientHeight: 400 };
  const scrolledUp = { scrollTop: 100, scrollHeight: 900, clientHeight: 400 };

  it("computes the distance from the bottom", () => {
    expect(distanceFromBottom(bottom)).toBe(0);
    expect(distanceFromBottom(scrolledUp)).toBe(400);
  });

  it("sticks when the list is near the bottom", () => {
    expect(isNearBottom(bottom)).toBe(true);
    expect(isNearBottom({ ...bottom, scrollTop: 470 })).toBe(true);
    expect(autoscrollDecision(bottom)).toEqual({ stick: true, showJump: false });
  });

  it("never yanks a user who scrolled up — offers the pill instead", () => {
    expect(isNearBottom(scrolledUp)).toBe(false);
    expect(autoscrollDecision(scrolledUp, { userScrolledUp: true })).toEqual({
      stick: false,
      showJump: true,
    });
    // Not near the bottom, but no manual scroll → do not stick, no pill yet.
    expect(autoscrollDecision(scrolledUp)).toEqual({ stick: false, showJump: false });
  });
});

/* ----------------------------------------------------------------- composer */

describe("composer controls", () => {
  it("enables send only with a non-empty draft and no work in flight", () => {
    expect(composerControls({ draft: "hi", phase: "idle", pending: false })).toEqual({
      canSend: true,
      sendDisabled: false,
      showCancel: false,
    });
    expect(composerControls({ draft: "   ", phase: "idle", pending: false }).sendDisabled).toBe(true);
    expect(composerControls({ draft: "hi", phase: "idle", pending: true }).canSend).toBe(false);
    expect(composerControls({ draft: "hi", phase: "streaming", pending: true }).showCancel).toBe(true);
    expect(composerControls({ draft: "hi", phase: "pending", pending: true }).showCancel).toBe(true);
  });

  it("clamps the auto-grow height into the composer window", () => {
    expect(composerHeight(10)).toBe(32);
    expect(composerHeight(80)).toBe(80);
    expect(composerHeight(1000)).toBe(160);
    expect(composerHeight(Number.NaN)).toBe(32);
  });
});

/* -------------------------------------------------------------- static render */

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

const createdAt = new Date("2026-01-02T10:00:00Z");

describe("renderToStaticMarkup — a user message", () => {
  it("renders an end-aligned surface-2 bubble", () => {
    const html = render(
      createElement(ChatMessageItem, {
        role: "user",
        body: "Hello there",
        createdAt,
        slug: "demo",
        locale: "en",
        user: { name: "Ada Lovelace", email: "ada@example.com" },
        onCopy: () => {},
      }),
    );
    expect(html).toContain('data-message-role="user"');
    expect(html).toContain('data-align="end"');
    expect(html).toContain('data-surface="user"');
    expect(html).toContain("bg-surface-2");
    expect(html).toContain("Hello there");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("<time");
    // The assistant surface must not leak into a user row.
    expect(html).not.toContain('data-surface="assistant"');
  });
});

describe("renderToStaticMarkup — an assistant message", () => {
  const meta: ChatMessageMeta = {
    model: "Noema AI",
    activity: ["read 2 notes"],
    contextTokens: 120,
    budgetTokens: 1024,
    references: [
      { id: "page-1", title: "Alpha", icon: "📄" },
      { id: "page-2", title: "Beta", icon: null },
    ],
  };

  it("renders Markdown, chips and citation links", () => {
    const body = "**Hello** friend";
    const html = render(
      createElement(ChatMessageItem, {
        role: "assistant",
        body,
        createdAt,
        meta,
        slug: "demo",
        locale: "en",
        modelLabel: "Noema AI",
        onCopy: () => {},
        onRegenerate: () => {},
      }),
    );
    expect(html).toContain('data-message-role="assistant"');
    expect(html).toContain('data-align="start"');
    expect(html).toContain('data-surface="assistant"');
    // Markdown renderer still in use.
    expect(html).toContain("<strong>");
    expect(html).toContain("Hello");
    // Token-budget / grounding chips.
    expect(html).toContain(`${estimateTokens(body)} tok`);
    expect(html).toContain("2 sources");
    expect(html).toContain("120/1024 ctx");
    // Citations as compact Tag links.
    expect(html).toContain('href="/w/demo/page-1"');
    expect(html).toContain("Alpha");
    expect(html).toContain("tag tag-");
    // Hover actions exist (revealed via group-hover / group-focus-within).
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("group-focus-within:opacity-100");
  });
});

describe("renderToStaticMarkup — the confirm button belongs to a stored proposal (B17)", () => {
  const proposal = {
    kind: "createTicket",
    args: { title: "Ship the beta" },
    summary: 'Create ticket "Ship the beta"',
    requiresConfirm: true,
  } as const;

  it("offers the confirm button for the proposal the turn stored", () => {
    const html = render(
      createElement(ChatMessageItem, {
        role: "assistant",
        body: 'Create ticket "Ship the beta".',
        createdAt,
        slug: "demo",
        locale: "en",
        meta: { proposal },
        onApplyProposal: () => {},
      }),
    );
    expect(html).toContain("Confirm to apply");
    expect(html).toContain("Create ticket");
  });

  it("withdraws it once the proposal was applied", () => {
    const html = render(
      createElement(ChatMessageItem, {
        role: "assistant",
        body: 'Create ticket "Ship the beta".',
        createdAt,
        slug: "demo",
        locale: "en",
        meta: { proposal, applied: true },
        onApplyProposal: () => {},
      }),
    );
    expect(html).not.toContain("Confirm to apply");
  });
});

describe("renderToStaticMarkup — typing indicator & empty state", () => {
  it("renders a three-dot status indicator", () => {
    const html = render(
      createElement(TypingIndicator, { label: "Thinking…", modelLabel: "Noema AI" }),
    );
    expect(html).toContain('data-testid="typing-indicator"');
    expect(html).toContain('role="status"');
    expect(html.match(/animate-pulse-soft/g)).toHaveLength(3);
    expect(html).toContain("Thinking…");
    expect(html).toContain("Noema AI");
  });

  it("renders an actionable empty state", () => {
    const html = render(createElement(ChatEmptyState, { locale: "en", onPrompt: () => {} }));
    expect(html).toContain('data-testid="chat-empty"');
    expect(html).toContain('data-empty-state="full"');
    expect(html).toContain("How can I help today?");
    expect(html).toContain("Summarize this note");
    expect(html).toContain("<button");
  });
});

/* -------------------------------------------------------------------- guards */

describe("streaming phases are the documented set", () => {
  it("keeps the three phases", () => {
    const phases: StreamPhase[] = ["idle", "pending", "streaming"];
    expect(new Set(phases).size).toBe(3);
  });

  it("keeps citation hues inside the palette", () => {
    const hue: TagHue = citationHue("any-page");
    expect(TAG_HUES).toContain(hue);
  });
});
