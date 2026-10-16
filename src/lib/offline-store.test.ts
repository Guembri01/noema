import { describe, expect, it } from "vitest";
import { nextBatch, type MutationDraft, type QueuedMutation } from "@/lib/offline-queue";
import {
  createMemoryBackend,
  createOfflineStore,
  type OfflineBackend,
} from "@/lib/offline-store";

/** A minimal, valid draft with sensible defaults; override per test. */
const draft = (over: Partial<MutationDraft> & { id: string }): MutationDraft => ({
  kind: "update",
  targetId: "block-1",
  payload: { text: "x" },
  createdAt: 100,
  ...over,
});

/** Build a fully-formed queued mutation for hand-rolled fixtures. */
const raw = (over: Partial<QueuedMutation> & { id: string }): QueuedMutation => ({
  seq: 1,
  kind: "update",
  targetId: "block-1",
  payload: { text: "x" },
  createdAt: 100,
  attempts: 0,
  ...over,
});

describe("createMemoryBackend", () => {
  it("reads null before anything is written", async () => {
    await expect(createMemoryBackend().read()).resolves.toBeNull();
  });

  it("round-trips a written queue", async () => {
    const backend = createMemoryBackend();
    const queue = [raw({ id: "a", seq: 1 }), raw({ id: "b", seq: 2 })];
    await backend.write(queue);
    await expect(backend.read()).resolves.toEqual(queue);
  });

  it("snapshots the queue so later array edits do not leak in", async () => {
    const backend = createMemoryBackend();
    const source: QueuedMutation[] = [raw({ id: "a" })];
    await backend.write(source);
    source.push(raw({ id: "b" }));
    await expect(backend.read()).resolves.toMatchObject([{ id: "a" }]);
  });

  it("handles successive reads with independent arrays", async () => {
    const backend = createMemoryBackend();
    await backend.write([raw({ id: "a" })]);
    const first = await backend.read();
    const second = await backend.read();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.[0]).not.toBe(second?.[0]);
  });
});

describe("createOfflineStore — snapshot", () => {
  it("summarizes an empty store with neutral defaults", async () => {
    const snapshot = await createOfflineStore(createMemoryBackend()).snapshot();
    expect(snapshot).toEqual({
      mutations: [],
      pending: 0,
      nextSeq: 1,
      attempts: 0,
      oldestCreatedAt: null,
      newestCreatedAt: null,
    });
  });

  it("reports counts, next seq, attempts and time bounds of a preloaded queue", async () => {
    const backend = createMemoryBackend([
      raw({ id: "a", seq: 5, createdAt: 300, attempts: 2 }),
      raw({ id: "b", seq: 2, createdAt: 100, attempts: 1 }),
    ]);
    const snapshot = await createOfflineStore(backend).snapshot();
    expect(snapshot.pending).toBe(2);
    expect(snapshot.mutations.map((m) => m.id)).toEqual(["b", "a"]);
    expect(snapshot.nextSeq).toBe(6);
    expect(snapshot.attempts).toBe(3);
    expect(snapshot.oldestCreatedAt).toBe(100);
    expect(snapshot.newestCreatedAt).toBe(300);
  });
});

describe("offline store — enqueue", () => {
  it("assigns seq from 1, defaults attempts, and returns the stored mutation", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await expect(store.enqueue(draft({ id: "a" }))).resolves.toEqual({
      id: "a",
      seq: 1,
      kind: "update",
      targetId: "block-1",
      payload: { text: "x" },
      createdAt: 100,
      attempts: 0,
    });
  });

  it("persists across store instances over the same backend", async () => {
    const backend = createMemoryBackend();
    await createOfflineStore(backend).enqueue(draft({ id: "a" }));
    const reopened = await createOfflineStore(backend).pending();
    expect(reopened.map((m) => m.id)).toEqual(["a"]);
  });

  it("hands out a monotonic seq across calls", async () => {
    const store = createOfflineStore(createMemoryBackend());
    const a = await store.enqueue(draft({ id: "a" }));
    const b = await store.enqueue(draft({ id: "b" }));
    const c = await store.enqueue(draft({ id: "c" }));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });

  it("honours an explicit attempt count", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await expect(store.enqueue(draft({ id: "a", attempts: 4 }))).resolves.toMatchObject({
      attempts: 4,
    });
  });

  it("does not mutate the draft it is handed", async () => {
    const store = createOfflineStore(createMemoryBackend());
    const input = draft({ id: "a" });
    const copy = { ...input };
    await store.enqueue(input);
    expect(input).toEqual(copy);
  });

  it("continues seq from a queue already persisted by another writer", async () => {
    const backend = createMemoryBackend([raw({ id: "a", seq: 7 })]);
    const added = await createOfflineStore(backend).enqueue(draft({ id: "b" }));
    expect(added.seq).toBe(8);
  });
});

describe("offline store — pending", () => {
  it("returns an empty queue for a fresh backend", async () => {
    await expect(createOfflineStore(createMemoryBackend()).pending()).resolves.toEqual([]);
  });

  it("sorts a backend's out-of-order rows into replay order", async () => {
    const backend = createMemoryBackend([
      raw({ id: "c", seq: 3 }),
      raw({ id: "a", seq: 1 }),
      raw({ id: "b", seq: 2 }),
    ]);
    expect((await createOfflineStore(backend).pending()).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("returns a fresh array the caller can mutate without side effects", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await store.enqueue(draft({ id: "a" }));
    const first = await store.pending();
    first.push(raw({ id: "ghost" }));
    expect((await store.pending()).map((m) => m.id)).toEqual(["a"]);
  });

  it("observes writes made through another store on the same backend", async () => {
    const backend = createMemoryBackend();
    const writer = createOfflineStore(backend);
    const reader = createOfflineStore(backend);
    await writer.enqueue(draft({ id: "x" }));
    expect((await reader.pending()).map((m) => m.id)).toEqual(["x"]);
  });
});

describe("offline store — drain", () => {
  it("removes a batch of mutations by identity and persists the removal", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await store.enqueue(draft({ id: "a" }));
    await store.enqueue(draft({ id: "b" }));
    const remaining = await store.drain([raw({ id: "a" })]);
    expect(remaining.map((m) => m.id)).toEqual(["b"]);
    expect((await store.pending()).map((m) => m.id)).toEqual(["b"]);
  });

  it("accepts a batch of bare ids", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await store.enqueue(draft({ id: "a" }));
    await store.enqueue(draft({ id: "b" }));
    expect((await store.drain(["a"])).map((m) => m.id)).toEqual(["b"]);
  });

  it("ignores ids it does not hold", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await store.enqueue(draft({ id: "a" }));
    await store.enqueue(draft({ id: "b" }));
    expect((await store.drain(["zzz"])).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("treats an empty batch as a no-op", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await store.enqueue(draft({ id: "a" }));
    await store.enqueue(draft({ id: "b" }));
    expect((await store.drain([])).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns the remainder in replay order", async () => {
    const backend = createMemoryBackend([
      raw({ id: "a", seq: 1 }),
      raw({ id: "b", seq: 2 }),
      raw({ id: "c", seq: 3 }),
    ]);
    const remaining = await createOfflineStore(backend).drain([raw({ id: "b" })]);
    expect(remaining.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("lowers the pending count reported by a later snapshot", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await store.enqueue(draft({ id: "a" }));
    await store.enqueue(draft({ id: "b" }));
    await store.drain(["a"]);
    expect((await store.snapshot()).pending).toBe(1);
  });
});

describe("offline store — serialization", () => {
  it("serializes concurrent enqueues so no write is lost", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await Promise.all([
      store.enqueue(draft({ id: "a" })),
      store.enqueue(draft({ id: "b" })),
      store.enqueue(draft({ id: "c" })),
    ]);
    const pending = await store.pending();
    expect(pending.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(pending.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("serializes an enqueue against a concurrent drain", async () => {
    const store = createOfflineStore(createMemoryBackend());
    await store.enqueue(draft({ id: "a" }));
    await store.enqueue(draft({ id: "b" }));
    await Promise.all([store.drain(["a"]), store.enqueue(draft({ id: "c" }))]);
    expect((await store.pending()).map((m) => m.id)).toEqual(["b", "c"]);
  });
});

describe("offline store — integration", () => {
  it("supports the enqueue → nextBatch → drain round trip", async () => {
    const store = createOfflineStore(createMemoryBackend());
    for (const id of ["a", "b", "c"]) {
      await store.enqueue(draft({ id }));
    }
    const batch = nextBatch(await store.pending(), { max: 2 });
    expect(batch.map((m) => m.id)).toEqual(["a", "b"]);
    await store.drain(batch);
    expect((await store.pending()).map((m) => m.id)).toEqual(["c"]);
  });

  it("propagates a backend read failure without wedging later calls", async () => {
    const memory = createMemoryBackend();
    let failures = 1;
    const flaky: OfflineBackend = {
      read: async () => {
        if (failures-- > 0) throw new Error("offline backend unavailable");
        return memory.read();
      },
      write: (queue) => memory.write(queue),
    };
    const store = createOfflineStore(flaky);
    await expect(store.pending()).rejects.toThrow("offline backend unavailable");
    await expect(store.enqueue(draft({ id: "a" }))).resolves.toMatchObject({ id: "a", seq: 1 });
  });
});
