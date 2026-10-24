import { afterEach, describe, expect, it, vi } from "vitest";
import { runAiSkill } from "./ai-client";

/**
 * The skills client is the one place the editor turns a menu choice into a
 * request. These tests pin that the translate target actually travels with the
 * body (R25.19) and that the server's flags win over any client assumption.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    json: async () => response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

describe("runAiSkill", () => {
  it("forwards the workspace, the skill and the translate locale", async () => {
    const fetchMock = mockFetch({
      text: "Bonjour",
      replacesSelection: true,
      skill: "translate",
    });

    const result = await runAiSkill("translate", "Hello", "ws1", {
      targetLocale: "fr",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/skills",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sentBody(fetchMock)).toEqual({
      skillId: "translate",
      text: "Hello",
      workspaceId: "ws1",
      targetLocale: "fr",
    });
    expect(result).toEqual({
      text: "Bonjour",
      replacesSelection: true,
      skill: "translate",
    });
  });

  it("omits knobs the caller did not set", async () => {
    const fetchMock = mockFetch({
      text: "Summary",
      replacesSelection: false,
      skill: "summarize",
    });
    await runAiSkill("summarize", "Long text");
    expect(sentBody(fetchMock)).toEqual({
      skillId: "summarize",
      text: "Long text",
    });
  });

  it("surfaces the route's error", async () => {
    mockFetch({ error: "Unsupported target locale." }, false);
    await expect(runAiSkill("translate", "Hello", undefined, { targetLocale: "xx" })).resolves.toEqual({
      error: "Unsupported target locale.",
    });
  });
});
