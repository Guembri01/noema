import { describe, expect, it } from "vitest";
import {
  LOCK_TTL_MS,
  acquire,
  canEdit,
  describeLock,
  heartbeat,
  listLocks,
  release,
  steal,
  sweepExpired,
  type EditLock,
} from "./edit-locks";

/**
 * Coarse edit locks (§7 "Coarse edit locks").
 *
 * Red-first: `src/lib/edit-locks.ts` did not exist when this file was written,
 * so the suite fails on the missing module until the engine lands. A page's
 * edit lock is a small lease: one `structural` takeover freezes the page for
 * everyone, while `content` locks compose so parallel typing is possible. Every
 * decision here is pure and clock-free — callers pass `now`.
 */

const T0 = 1_000;

/** Build a well-formed lock with sensible defaults for a test. */
const lock = (over: Partial<EditLock> = {}): EditLock => ({
  pageId: "p1",
  holderId: "alice",
  holderName: "Alice",
  scope: "structural",
  acquiredAt: T0,
  expiresAt: T0 + LOCK_TTL_MS,
  heartbeatAt: T0,
  ...over,
});

describe("LOCK_TTL_MS", () => {
  it("defaults to a 60s coarse lease", () => {
    expect(LOCK_TTL_MS).toBe(60_000);
  });
});

describe("acquire", () => {
  it("acquires a free page and stamps the lease fields", () => {
    const result = acquire([], {
      pageId: "p1",
      holderId: "alice",
      holderName: "Alice",
      scope: "structural",
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock).toEqual({
      pageId: "p1",
      holderId: "alice",
      holderName: "Alice",
      scope: "structural",
      acquiredAt: T0,
      expiresAt: T0 + LOCK_TTL_MS,
      heartbeatAt: T0,
    });
    expect(result.locks).toEqual([result.lock]);
  });

  it("accepted when the lock table is absent (defensive)", () => {
    const result = acquire(undefined as unknown as EditLock[], {
      pageId: "p1",
      holderId: "alice",
      scope: "content",
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locks).toHaveLength(1);
  });

  it("does not mutate the input table", () => {
    const input = [lock()];
    acquire(input, { pageId: "p1", holderId: "bob", scope: "structural", now: T0 + 1_000 });
    expect(input).toEqual([lock()]);
  });

  it("refuses a second holder while the lock is live", () => {
    const result = acquire([lock()], {
      pageId: "p1",
      holderId: "bob",
      scope: "content",
      now: T0 + 1_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("held");
    expect(result.holder.holderId).toBe("alice");
  });

  it("re-acquire by the same holder refreshes the lease and keeps acquiredAt", () => {
    const result = acquire([lock()], {
      pageId: "p1",
      holderId: "alice",
      scope: "structural",
      now: T0 + 5_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.acquiredAt).toBe(T0);
    expect(result.lock.heartbeatAt).toBe(T0 + 5_000);
    expect(result.lock.expiresAt).toBe(T0 + 5_000 + LOCK_TTL_MS);
    expect(result.locks).toHaveLength(1);
  });

  it("re-acquire by the same holder can change scope and name", () => {
    const result = acquire([lock({ scope: "content" })], {
      pageId: "p1",
      holderId: "alice",
      holderName: "Alicia",
      scope: "structural",
      now: T0 + 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.scope).toBe("structural");
    expect(result.lock.holderName).toBe("Alicia");
  });

  it("a live structural lock blocks another holder's content acquire", () => {
    const result = acquire([lock({ scope: "structural" })], {
      pageId: "p1",
      holderId: "bob",
      scope: "content",
      now: T0 + 1,
    });
    expect(result.ok).toBe(false);
  });

  it("a live content lock lets another holder take a content lock too", () => {
    const result = acquire([lock({ holderId: "alice", scope: "content" })], {
      pageId: "p1",
      holderId: "bob",
      scope: "content",
      now: T0 + 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locks.map((entry) => entry.holderId)).toEqual(["alice", "bob"]);
  });

  it("a live content lock blocks another holder's structural acquire", () => {
    const result = acquire([lock({ holderId: "alice", scope: "content" })], {
      pageId: "p1",
      holderId: "bob",
      scope: "structural",
      now: T0 + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.holder.holderId).toBe("alice");
  });

  it("treats a lock exactly at its expiry as gone", () => {
    const expired = lock({ expiresAt: T0 + 1_000 });
    const result = acquire([expired], {
      pageId: "p1",
      holderId: "bob",
      scope: "structural",
      now: T0 + 1_000,
    });
    expect(result.ok).toBe(true);
  });

  it("drops the page's expired locks from the returned table", () => {
    const stale = lock({ holderId: "carol", expiresAt: T0 });
    const result = acquire([stale], {
      pageId: "p1",
      holderId: "alice",
      scope: "structural",
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locks.map((entry) => entry.holderId)).toEqual(["alice"]);
  });

  it("leaves locks on other pages untouched", () => {
    const other = lock({ pageId: "p2", holderId: "dave", expiresAt: T0 });
    const result = acquire([other], {
      pageId: "p1",
      holderId: "alice",
      scope: "structural",
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locks).toHaveLength(2);
    expect(result.locks.some((entry) => entry.pageId === "p2" && entry.holderId === "dave")).toBe(true);
  });

  it("honours a custom ttlMs", () => {
    const result = acquire([], {
      pageId: "p1",
      holderId: "alice",
      scope: "content",
      now: T0,
      ttlMs: 5_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.expiresAt).toBe(T0 + 5_000);
  });
});

describe("heartbeat", () => {
  it("refreshes the holder's heartbeat and expiry", () => {
    const result = heartbeat([lock()], { pageId: "p1", holderId: "alice", now: T0 + 2_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.heartbeatAt).toBe(T0 + 2_000);
    expect(result.lock.expiresAt).toBe(T0 + 2_000 + LOCK_TTL_MS);
    expect(result.lock.acquiredAt).toBe(T0);
  });

  it("reports not_held for a non-holder", () => {
    const result = heartbeat([lock()], { pageId: "p1", holderId: "bob", now: T0 + 2_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_held");
  });

  it("reports not_held once the lease has expired (boundary)", () => {
    const result = heartbeat([lock({ expiresAt: T0 + 1_000 })], {
      pageId: "p1",
      holderId: "alice",
      now: T0 + 1_000,
    });
    expect(result.ok).toBe(false);
  });

  it("leaves other holders' locks untouched", () => {
    const bob = lock({ holderId: "bob", scope: "content" });
    const result = heartbeat([lock(), bob], { pageId: "p1", holderId: "alice", now: T0 + 3_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locks.find((entry) => entry.holderId === "bob")).toEqual(bob);
  });

  it("does not mutate the input table", () => {
    const input = [lock()];
    heartbeat(input, { pageId: "p1", holderId: "alice", now: T0 + 1 });
    expect(input).toEqual([lock()]);
  });

  it("honours a custom ttlMs", () => {
    const result = heartbeat([lock()], {
      pageId: "p1",
      holderId: "alice",
      now: T0 + 10,
      ttlMs: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.expiresAt).toBe(T0 + 10 + 1_000);
  });
});

describe("release", () => {
  it("removes the holder's lock and reports it released", () => {
    const result = release([lock()], { pageId: "p1", holderId: "alice", now: T0 + 1 });
    expect(result.released).toBe(true);
    expect(result.locks).toEqual([]);
  });

  it("reports a no-op for a non-holder", () => {
    const result = release([lock()], { pageId: "p1", holderId: "bob", now: T0 + 1 });
    expect(result.released).toBe(false);
    expect(result.locks).toHaveLength(1);
  });

  it("removes only the holder's lock from a shared page", () => {
    const result = release([lock({ scope: "content" }), lock({ holderId: "bob", scope: "content" })], {
      pageId: "p1",
      holderId: "alice",
      now: T0 + 1,
    });
    expect(result.locks.map((entry) => entry.holderId)).toEqual(["bob"]);
  });

  it("cleans up an expired lock too", () => {
    const result = release([lock({ expiresAt: T0 })], {
      pageId: "p1",
      holderId: "alice",
      now: T0 + 1_000,
    });
    expect(result.released).toBe(true);
    expect(result.locks).toEqual([]);
  });

  it("does not mutate the input table", () => {
    const input = [lock()];
    release(input, { pageId: "p1", holderId: "alice", now: T0 + 1 });
    expect(input).toEqual([lock()]);
  });
});

describe("steal", () => {
  it("lets an owner force-steal a live lock", () => {
    const result = steal([lock()], {
      pageId: "p1",
      newHolderId: "bob",
      newHolderName: "Bob",
      now: T0 + 1_000,
      force: true,
      byRole: "owner",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.holderId).toBe("bob");
    expect(result.lock.scope).toBe("structural");
    expect(result.locks).toHaveLength(1);
  });

  it("lets an admin force-steal a live lock", () => {
    const result = steal([lock({ scope: "content" })], {
      pageId: "p1",
      newHolderId: "bob",
      now: T0 + 1_000,
      force: true,
      byRole: "admin",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.scope).toBe("content");
  });

  it("refuses a member even with force", () => {
    const result = steal([lock()], {
      pageId: "p1",
      newHolderId: "bob",
      now: T0 + 1_000,
      force: true,
      byRole: "member",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("forbidden");
  });

  it("refuses a privileged role without force", () => {
    const result = steal([lock()], {
      pageId: "p1",
      newHolderId: "bob",
      now: T0 + 1_000,
      byRole: "owner",
    });
    expect(result.ok).toBe(false);
  });

  it("steals an expired lock without privilege or force", () => {
    const result = steal([lock({ expiresAt: T0 })], {
      pageId: "p1",
      newHolderId: "bob",
      now: T0 + 1_000,
      byRole: "guest",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.holderId).toBe("bob");
  });

  it("takes a vacant page for a plain member", () => {
    const result = steal([], {
      pageId: "p1",
      newHolderId: "bob",
      now: T0,
      byRole: "member",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.scope).toBe("structural");
  });

  it("replaces every lock on the page with the new holder's one", () => {
    const result = steal(
      [
        lock({ holderId: "alice", scope: "content" }),
        lock({ pageId: "p1", holderId: "carol", scope: "content" }),
        lock({ pageId: "p2", holderId: "dave" }),
      ],
      { pageId: "p1", newHolderId: "bob", now: T0 + 1, force: true, byRole: "admin" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locks.filter((entry) => entry.pageId === "p1")).toEqual([result.lock]);
    expect(result.locks.some((entry) => entry.pageId === "p2" && entry.holderId === "dave")).toBe(true);
    expect(result.lock.pageId).toBe("p1");
  });
});

describe("sweepExpired", () => {
  it("drops a lock at its expiry instant and keeps one a millisecond short", () => {
    const kept = lock({ holderId: "kept", expiresAt: T0 + 101 });
    const gone = lock({ holderId: "gone", expiresAt: T0 + 100 });
    expect(sweepExpired([kept, gone], T0 + 100).map((entry) => entry.holderId)).toEqual(["kept"]);
  });

  it("keeps everyone when now is not finite (fail-safe)", () => {
    expect(sweepExpired([lock()], Number.NaN)).toHaveLength(1);
  });

  it("does not mutate the input table", () => {
    const input = [lock()];
    sweepExpired(input, T0);
    expect(input).toEqual([lock()]);
  });
});

describe("canEdit", () => {
  it("allows editing while the page is unlocked", () => {
    expect(canEdit([], { pageId: "p1", holderId: "bob", scope: "structural", now: T0 })).toBe(true);
  });

  it("allows the holder their own lock", () => {
    expect(canEdit([lock()], { pageId: "p1", holderId: "alice", scope: "structural", now: T0 + 1 })).toBe(
      true,
    );
  });

  it("blocks a structural request while another holder holds the page", () => {
    expect(canEdit([lock()], { pageId: "p1", holderId: "bob", scope: "structural", now: T0 + 1 })).toBe(
      false,
    );
  });

  it("allows a content request beside another content lock", () => {
    expect(
      canEdit([lock({ holderId: "alice", scope: "content" })], {
        pageId: "p1",
        holderId: "bob",
        scope: "content",
        now: T0 + 1,
      }),
    ).toBe(true);
  });

  it("blocks a structural request while a content lock is live", () => {
    expect(
      canEdit([lock({ holderId: "alice", scope: "content" })], {
        pageId: "p1",
        holderId: "bob",
        scope: "structural",
        now: T0 + 1,
      }),
    ).toBe(false);
  });

  it("unblocks once the lock has expired", () => {
    expect(
      canEdit([lock({ expiresAt: T0 })], { pageId: "p1", holderId: "bob", scope: "structural", now: T0 }),
    ).toBe(true);
  });
});

describe("listLocks", () => {
  it("returns only the requested page's locks", () => {
    const table = [lock(), lock({ pageId: "p2", holderId: "dave" })];
    expect(listLocks(table, { pageId: "p1" }).map((entry) => entry.holderId)).toEqual(["alice"]);
  });

  it("returns a deterministic, freshly copied list", () => {
    const table = [
      lock({ holderId: "carol", acquiredAt: 30 }),
      lock({ holderId: "alice", acquiredAt: 10 }),
      lock({ holderId: "bob", acquiredAt: 10 }),
    ];
    const list = listLocks(table, { pageId: "p1" });
    expect(list.map((entry) => entry.holderId)).toEqual(["alice", "bob", "carol"]);
    expect(list[0]).not.toBe(table[1]);
  });
});

describe("describeLock", () => {
  it("describes a live lock with whole-second remaining time", () => {
    expect(describeLock(lock({ expiresAt: T0 + 42_000 }), T0)).toBe(
      "Alice editing structure · expires in 42s",
    );
  });

  it("rounds a partial second up", () => {
    expect(describeLock(lock({ scope: "content", expiresAt: T0 + 1_001 }), T0)).toBe(
      "Alice editing content · expires in 2s",
    );
  });

  it("reports an expired lock", () => {
    expect(describeLock(lock({ expiresAt: T0 }), T0)).toBe("Lock expired (was Alice editing structure)");
  });

  it("handles a missing lock", () => {
    expect(describeLock(null, T0)).toBe("No lock");
  });
});
