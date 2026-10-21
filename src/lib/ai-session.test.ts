import { describe, expect, it } from "vitest";

import {
  conversationSessionId,
  DEPLOYMENT_SESSION_ID,
  workspaceSessionId,
} from "./ai-session";

/**
 * The session a provider request belongs to (#271).
 *
 * OpenCode Go asks its clients for a stable session id per conversation, so
 * the provider can route and cache per conversation. The id must therefore be
 * *stable* for a conversation and *different* between conversations — and it
 * must not be guessable across installations, which is what the deployment id
 * is for.
 */
describe("the session ids", () => {
  it("names a conversation by its own id", () => {
    expect(conversationSessionId("t1")).toBe("noema:conversation:t1");
    expect(conversationSessionId("t1")).toBe(conversationSessionId("t1"));
    expect(conversationSessionId("t1")).not.toBe(conversationSessionId("t2"));
  });

  it("names a workspace by its own id", () => {
    expect(workspaceSessionId("w1")).toBe("noema:workspace:w1");
    expect(workspaceSessionId("w1")).not.toBe(conversationSessionId("w1"));
  });

  it("names the deployment without being guessable", () => {
    expect(DEPLOYMENT_SESSION_ID).toMatch(/^noema:deployment:[A-Za-z0-9_-]{12,}$/);
    // One process, one id: the provider can still cache.
    expect(DEPLOYMENT_SESSION_ID).toBe(DEPLOYMENT_SESSION_ID);
  });

  it("keeps the ids apart from each other", () => {
    const ids = [
      conversationSessionId("x"),
      workspaceSessionId("x"),
      DEPLOYMENT_SESSION_ID,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
