import { describe, expect, it } from "vitest";
import { currentActorUserId, runAsActor } from "./actor-context";

describe("MCP actor context", () => {
  it("has no actor outside a tool call", () => {
    expect(currentActorUserId()).toBeNull();
  });

  it("exposes the actor only inside the scoped callback", async () => {
    const seen = await runAsActor("user-1", async () => {
      expect(currentActorUserId()).toBe("user-1");
      await Promise.resolve();
      return currentActorUserId();
    });
    expect(seen).toBe("user-1");
    expect(currentActorUserId()).toBeNull();
  });

  it("isolates concurrent tool calls", async () => {
    const result = await Promise.all([
      runAsActor("user-a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentActorUserId();
      }),
      runAsActor("user-b", async () => {
        await Promise.resolve();
        return currentActorUserId();
      }),
    ]);
    expect(result).toEqual(["user-a", "user-b"]);
  });

  it("does not leak a nested actor into the parent context", () => {
    runAsActor("outer", () => {
      expect(currentActorUserId()).toBe("outer");
      runAsActor("inner", () => expect(currentActorUserId()).toBe("inner"));
      expect(currentActorUserId()).toBe("outer");
    });
  });
});
