import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/ai/skills` routing: the editor registry (`@/lib/ai-skills`) and the
 * writing builders (`@/lib/ai-writing`) must be driven through the same route,
 * with model output post-processed before it leaves the server.
 *
 * Only the transport edges — auth, rate limiting and the provider client — are
 * mocked; the route's own resolution, prompt building, chunking and
 * post-processing run for real.
 */

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const ai = vi.hoisted(() => ({ resolveAiConfig: vi.fn(), chatComplete: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));
vi.mock("@/lib/ai-provider", () => ({
  AI_NOT_CONFIGURED: "AI is not configured.",
  chatComplete: ai.chatComplete,
  resolveAiConfig: ai.resolveAiConfig,
}));

import { GET, POST } from "./route";

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost:1/v1",
  model: "m",
  apiKey: "k",
  source: "env" as const,
};

type SkillResponse = {
  text?: string;
  skill?: string;
  replacesSelection?: boolean;
  error?: string;
  skills?: { id: string; label: string; hint: string; replacesSelection: boolean }[];
};

const postSkill = (body: unknown) =>
  POST(
    new Request("http://test/api/ai/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUser.mockResolvedValue({ id: "u1" });
  guard.rateLimit.mockReturnValue(null);
  ai.resolveAiConfig.mockResolvedValue(CONFIG);
  ai.chatComplete.mockResolvedValue({ ok: true, text: "MODEL OUTPUT" });
});

describe("authentication and validation", () => {
  it("rejects an unauthenticated POST", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    expect((await postSkill({ skillId: "proofread", text: "hi" })).status).toBe(401);
  });

  it("rejects an unauthenticated GET", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("rejects an unknown skill", async () => {
    expect((await postSkill({ skillId: "does-not-exist", text: "hi" })).status).toBe(400);
  });

  it("rejects empty text", async () => {
    expect((await postSkill({ skillId: "proofread", text: "   " })).status).toBe(400);
  });

  it("reports AI as unconfigured with 503", async () => {
    ai.resolveAiConfig.mockResolvedValue(null);
    expect((await postSkill({ skillId: "summarize", text: "hi" })).status).toBe(503);
  });
});

describe("editor skills still use the registry prompts", () => {
  it("routes proofread through the ai-skills wording", async () => {
    const response = await postSkill({ skillId: "proofread", text: "teh fox" });
    const body = (await response.json()) as SkillResponse;
    expect(response.status).toBe(200);
    expect(body.skill).toBe("proofread");
    expect(ai.chatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.stringContaining("Proofread") }),
      CONFIG,
    );
  });
});

describe("writing skills route through ai-writing", () => {
  it("summarizes and strips a leading label from the model output", async () => {
    ai.chatComplete.mockResolvedValue({ ok: true, text: "Summary: - one\n- two" });
    const response = await postSkill({ skillId: "summarize", text: "Alpha beta gamma." });
    const body = (await response.json()) as SkillResponse;
    expect(response.status).toBe(200);
    expect(body.text).toBe("- one\n- two");
    expect(body.replacesSelection).toBe(false);
    expect(ai.chatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.stringContaining("Alpha beta gamma.") }),
      CONFIG,
    );
  });

  it("translates to English by default and unwraps quotes", async () => {
    ai.chatComplete.mockResolvedValue({ ok: true, text: '"Bonjour le monde"' });
    const response = await postSkill({ skillId: "translate", text: "Bonjour le monde" });
    const body = (await response.json()) as SkillResponse;
    expect(body.text).toBe("Bonjour le monde");
    expect(body.replacesSelection).toBe(true);
    expect(ai.chatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.stringContaining("English") }),
      CONFIG,
    );
  });

  it("accepts the new `continue` skill", async () => {
    const response = await postSkill({ skillId: "continue", text: "Once upon a time." });
    const body = (await response.json()) as SkillResponse;
    expect(response.status).toBe(200);
    expect(body.skill).toBe("continue");
    expect(body.replacesSelection).toBe(false);
    expect(ai.chatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.stringContaining("Continue") }),
      CONFIG,
    );
  });

  it("accepts the new `simplify` skill", async () => {
    const response = await postSkill({ skillId: "simplify", text: "Quantum chromodynamics." });
    const body = (await response.json()) as SkillResponse;
    expect(response.status).toBe(200);
    expect(body.replacesSelection).toBe(true);
  });

  it("map-reduces a long document into more than one provider call", async () => {
    ai.chatComplete.mockResolvedValue({ ok: true, text: "partial" });
    const paragraph = `${"word ".repeat(140)}\n\n`;
    const longText = paragraph.repeat(10);
    const response = await postSkill({ skillId: "summarize", text: longText });
    expect(response.status).toBe(200);
    expect(ai.chatComplete.mock.calls.length).toBeGreaterThan(1);
  });

  it("propagates a provider failure with its status", async () => {
    ai.chatComplete.mockResolvedValue({ ok: false, status: 502, error: "provider down" });
    const response = await postSkill({ skillId: "summarize", text: "hi" });
    expect(response.status).toBe(502);
    expect(((await response.json()) as SkillResponse).error).toBe("provider down");
  });

  it("scrubs a credential-shaped provider error before answering", async () => {
    ai.chatComplete.mockResolvedValue({
      ok: false,
      status: 502,
      error: "AI provider error (401): sk-live-abcdef1234567890",
    });
    const response = await postSkill({ skillId: "summarize", text: "hi" });
    const raw = await response.text();
    expect(response.status).toBe(502);
    expect(raw).not.toContain("sk-live-abcdef1234567890");
  });
});

describe("GET catalogue", () => {
  it("includes the writing-only ids alongside the editor skills", async () => {
    const response = await GET();
    const body = (await response.json()) as SkillResponse;
    const ids = (body.skills ?? []).map((skill) => skill.id);
    expect(ids).toContain("proofread");
    expect(ids).toContain("summarize");
    expect(ids).toContain("continue");
    expect(ids).toContain("simplify");
    expect(new Set(ids).size).toBe(ids.length);
  });
});
