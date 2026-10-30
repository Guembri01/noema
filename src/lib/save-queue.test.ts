import { describe, expect, it } from "vitest";

import { clearIfPayload, runSaveQueue, type SaveQueueDeps } from "@/lib/save-queue";

/**
 * P2-T01: autosave serialization contract. These assertions fail against the
 * previous `runSave` pattern (unguarded launches, unconditional pending
 * clearing on resolve) and pass once the save queue serializes writes and
 * only retires payloads it actually saved.
 */

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Refs = {
  pendingRef: { current: string | null };
  lastSavedRef: { current: string };
  inFlightRef: { current: boolean };
};

type TestHarness = Refs & {
  deps: SaveQueueDeps;
  /** ordered payloads handed to the network transport */
  sent: string[];
  /** payloads reported as newly acknowledged */
  savedLog: string[];
  /** payloads reported as already acknowledged */
  alreadySavedLog: string[];
  serverErrors: string[];
  /** highest number of network writes on the wire at the same moment */
  maxConcurrent: number;
  /** resolve the oldest in-flight write: null = success, string = error */
  release: (error?: string) => void;
  /** number of writes currently unresolved */
  inFlightWrites: () => number;
};

function createHarness(): TestHarness {
  const pendingRef: Refs["pendingRef"] = { current: null };
  const lastSavedRef: Refs["lastSavedRef"] = { current: "" };
  const inFlightRef: Refs["inFlightRef"] = { current: false };
  const sent: string[] = [];
  const savedLog: string[] = [];
  const alreadySavedLog: string[] = [];
  const serverErrors: string[] = [];
  let maxConcurrent = 0;
  let concurrent = 0;
  let writers: Array<(error: string | null) => void> = [];

  const deps: SaveQueueDeps = {
    pendingRef,
    lastSavedRef,
    inFlightRef,
    resolvePayload: (pendingOnly) => {
      const pending = pendingRef.current;
      if (pending !== null) return pending;
      if (pendingOnly) return null;
      return null;
    },
    bufferOffline: () => false,
    send: (payload) =>
      // A fresh writer stalls until the test releases it: `maxConcurrent`
      // witnesses whether two launches ever overlapped on the wire.
      new Promise((resolve) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        sent.push(payload);
        writers.push((error) => {
          concurrent -= 1;
          resolve(error);
        });
      }),
    onSaved: (payload) => savedLog.push(payload),
    onAlreadySaved: (payload) => alreadySavedLog.push(payload),
    onError: (error) => serverErrors.push(error),
  };

  return {
    deps,
    pendingRef,
    lastSavedRef,
    inFlightRef,
    sent,
    savedLog,
    alreadySavedLog,
    serverErrors,
    get maxConcurrent() {
      return maxConcurrent;
    },
    release(error?: string) {
      const writer = writers.shift();
      if (writer) writer(error ?? null);
    },
    inFlightWrites: () => concurrent,
  };
}

describe("runSaveQueue serialization (P2-T01)", () => {
  it("(a) overlapping save launches are serialized and complete in start order", async () => {
    const h = createHarness();
    h.pendingRef.current = "P1";

    const first = runSaveQueue(h.deps);
    await tick();
    expect(h.sent).toEqual(["P1"]);
    expect(h.inFlightWrites()).toBe(1);

    // A second autosave launch while the first is still on the wire.
    h.pendingRef.current = "P2";
    const second = runSaveQueue(h.deps);
    await tick();
    expect(h.sent).toEqual(["P1"]);
    expect(h.inFlightWrites()).toBe(1);
    expect(h.maxConcurrent).toBe(1);

    // The first save resolves, and only afterwards the newer payload goes out.
    h.release();
    await tick();
    expect(h.sent).toEqual(["P1", "P2"]);
    expect(h.lastSavedRef.current).toBe("P1");

    h.release();
    await Promise.all([first, second]);
    expect(h.sent).toEqual(["P1", "P2"]);
    expect(h.maxConcurrent).toBe(1);
    expect(h.lastSavedRef.current).toBe("P2");
    expect(h.inFlightRef.current).toBe(false);
    expect(h.savedLog).toEqual(["P1", "P2"]);
  });

  it("(b) a persist() during an in-flight save is drained as a subsequent save with the newer payload", async () => {
    const h = createHarness();
    h.pendingRef.current = "P1";

    const saving = runSaveQueue(h.deps);
    await tick();
    expect(h.sent).toEqual(["P1"]);

    // The user keeps editing while the write is in flight.
    h.pendingRef.current = "P2";

    h.release(); // P1 acknowledged server-side
    await tick();
    expect(h.sent).toEqual(["P1", "P2"]);

    h.release(); // P2 acknowledged
    await saving;

    expect(h.sent).toEqual(["P1", "P2"]);
    expect(h.savedLog).toEqual(["P1", "P2"]);
    expect(h.pendingRef.current).toBeNull();
    expect(h.lastSavedRef.current).toBe("P2");
    expect(h.inFlightRef.current).toBe(false);
  });

  it("(c) save-resolve does not retire a newer pending payload it did not save", async () => {
    const h = createHarness();
    h.pendingRef.current = "P1";

    const saving = runSaveQueue(h.deps);
    await tick();

    // A newer edit lands while P1 is on the wire; resolving the P1 response
    // must not treat P2 as saved.
    h.pendingRef.current = "P2";

    h.release();
    await tick();

    expect(h.sent).toEqual(["P1", "P2"]);
    // The watermark moved in start order: the older payload never overwrote
    // the newer ack after P2 is also saved below.
    h.release();
    await saving;

    expect(h.pendingRef.current).toBeNull();
    expect(h.sent).toEqual(["P1", "P2"]);
    expect(h.lastSavedRef.current).toBe("P2");
    expect(h.savedLog).toEqual(["P1", "P2"]);
  });

  describe("clearIfPayload (payload-equal retirement)", () => {
    it("retires the pending payload only when it equals the saved payload", () => {
      expect(clearIfPayload("P1", "P1")).toBeNull();
      expect(clearIfPayload("P2", "P1")).toBe("P2");
      expect(clearIfPayload(null, "P1")).toBeNull();
    });
  });

  it("keeps the payload pending when the write fails, then drains it on retry", async () => {
    const h = createHarness();
    h.pendingRef.current = "P1";

    const first = runSaveQueue(h.deps);
    await tick();
    expect(h.sent).toEqual(["P1"]);

    h.release("boom");
    await first;
    expect(h.serverErrors).toEqual(["boom"]);
    // A failure must not retire the payload — it stays queued for retry.
    expect(h.pendingRef.current).toBe("P1");
    expect(h.savedLog).toEqual([]);
    expect(h.inFlightRef.current).toBe(false);

    const retry = runSaveQueue(h.deps);
    await tick();
    expect(h.sent).toEqual(["P1", "P1"]);
    h.release();
    await retry;
    expect(h.savedLog).toEqual(["P1"]);
    expect(h.pendingRef.current).toBeNull();
    expect(h.lastSavedRef.current).toBe("P1");
  });

  it("retires an already-saved pending payload without a wire round-trip", async () => {
    const h = createHarness();
    h.lastSavedRef.current = "P1";
    h.pendingRef.current = "P1";

    await runSaveQueue(h.deps);

    expect(h.sent).toEqual([]);
    expect(h.alreadySavedLog).toEqual(["P1"]);
    expect(h.pendingRef.current).toBeNull();
    expect(h.inFlightRef.current).toBe(false);
  });

  it("hands the payload to the offline buffer and stays idle after (collab offline)", async () => {
    let buffered: string | null = null;
    const pendingRef: Refs["pendingRef"] = { current: "P1" };
    const lastSavedRef: Refs["lastSavedRef"] = { current: "" };
    const inFlightRef: Refs["inFlightRef"] = { current: false };
    await runSaveQueue({
      pendingRef,
      lastSavedRef,
      inFlightRef,
      resolvePayload: () => pendingRef.current,
      bufferOffline: (payload) => {
        buffered = payload;
        return true;
      },
      send: () => {
        throw new Error("must not hit the wire while offline");
      },
      onSaved: () => {},
      onAlreadySaved: () => {},
      onError: () => {},
    });
    expect(buffered).toBe("P1");
    // Offline buffering does not retire the pending payload (matches the
    // original behaviour; the replay path clears it).
    expect(pendingRef.current).toBe("P1");
  });

  it("consults the editor fallback only on the first round and terminates", async () => {
    let docReads = 0;
    const pendingRef: Refs["pendingRef"] = { current: null };
    const lastSavedRef: Refs["lastSavedRef"] = { current: "" };
    const inFlightRef: Refs["inFlightRef"] = { current: false };
    const sent: string[] = [];
    let writers: Array<(error: string | null) => void> = [];

    const deps: SaveQueueDeps = {
      pendingRef,
      lastSavedRef,
      inFlightRef,
      resolvePayload: (pendingOnly) => {
        const pending = pendingRef.current;
        if (pending !== null) return pending;
        if (pendingOnly) return null;
        docReads += 1;
        return "EDITORDOC";
      },
      bufferOffline: () => false,
      send: (payload) =>
        new Promise((resolve) => {
          sent.push(payload);
          writers.push((error) => resolve(error));
        }),
      onSaved: () => {},
      onAlreadySaved: () => {},
      onError: () => {},
    };

    const saving = runSaveQueue(deps);
    await tick();
    expect(docReads).toBe(1);
    expect(sent).toEqual(["EDITORDOC"]);

    // An edit lands mid-flight, captured into the pending ref.
    pendingRef.current = "P1";
    writers.shift()?.(null);
    await tick();
    expect(sent).toEqual(["EDITORDOC", "P1"]);
    expect(docReads).toBe(1); // no re-read of the document fallback

    writers.shift()?.(null);
    await saving;

    expect(docReads).toBe(1); // fallback consulted exactly once, never after
    expect(lastSavedRef.current).toBe("P1");
    expect(pendingRef.current).toBeNull();
    expect(inFlightRef.current).toBe(false);
  });

  it("declines immediately while a save is in flight and releases the lock afterwards", async () => {
    const h = createHarness();
    h.pendingRef.current = "P1";

    const saving = runSaveQueue(h.deps);
    await tick();
    expect(h.inFlightRef.current).toBe(true);

    await runSaveQueue(h.deps); // declined while P1 is on the wire
    expect(h.sent).toEqual(["P1"]);

    h.release();
    await saving;
    expect(h.inFlightRef.current).toBe(false);
  });
});
