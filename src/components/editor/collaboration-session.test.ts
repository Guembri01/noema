import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  doc: 0,
  provider: 0,
  awareness: 0,
}));

vi.mock("yjs", () => ({
  Doc: class {
    constructor() {
      calls.doc += 1;
    }
  },
}));

vi.mock("y-websocket", () => ({
  WebsocketProvider: class {
    awareness = {
      setLocalStateField: () => {
        calls.awareness += 1;
      },
    };
    constructor() {
      calls.provider += 1;
    }
  },
}));

vi.mock("@tiptap/extension-collaboration", () => ({
  default: { configure: () => ({ name: "collaboration" }) },
}));

vi.mock("@tiptap/extension-collaboration-caret", () => ({
  default: { configure: () => ({ name: "collaborationCaret" }) },
}));

import { loadCollaborationSession } from "@/components/editor/collaboration-session";

describe("loadCollaborationSession", () => {
  beforeEach(() => {
    calls.doc = 0;
    calls.provider = 0;
    calls.awareness = 0;
  });

  it("does nothing when collaboration is off", async () => {
    const session = await loadCollaborationSession("", "page-1", {
      name: "Ada",
      color: "#3b82f6",
    });

    expect(session).toBeNull();
    expect(calls.doc).toBe(0);
    expect(calls.provider).toBe(0);
  });

  it("creates a provider and two extensions when configured", async () => {
    const session = await loadCollaborationSession("ws://collab.test", "page-1", {
      name: "Ada",
      color: "#3b82f6",
    });

    expect(session).not.toBeNull();
    expect(calls.doc).toBe(1);
    expect(calls.provider).toBe(1);
    expect(calls.awareness).toBe(1);
    expect(session?.extensions).toHaveLength(2);
  });
});
