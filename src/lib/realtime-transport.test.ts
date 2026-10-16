import { describe, expect, it } from "vitest";
import { PRESENCE_PALETTE, assignColor } from "./presence";
import {
  DEFAULT_PRESENCE_TTL_MS,
  WIRE_VERSION,
  applyRemote,
  compare,
  connectionPlan,
  createClock,
  createPresence,
  decodeOp,
  describePresence,
  encodeOp,
  heartbeat,
  join,
  leave,
  merge,
  moveCursor,
  restore,
  snapshot,
  sweepStale,
  tick,
  type PresenceState,
  type WireOp,
} from "./realtime-transport";

/**
 * Realtime collaboration transport engine (docs/specs/realtime-collab.md §7 —
 * "Real-time multiplayer editing", "CRDT data model", "Presence", "Live
 * cursors"). The pure, headless half of the feature: a Lamport clock, a compact
 * versioned wire format for ops, the presence/awareness reducer (join, leave,
 * heartbeat, stale sweep, cursors), and the per-origin op-application rules
 * (dedupe by id, rebase-vs-drop when a clock arrives behind). No socket, no
 * DOM, no database — every decision is provable here.
 *
 * Red-first: `src/lib/realtime-transport.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the engine lands.
 */

/** A `set` op with sane defaults; `over` overrides any field. */
const op = (id: string, origin: string, clock: number, over: Partial<WireOp> = {}): WireOp => ({
  id,
  origin,
  clock,
  kind: "set",
  payload: null,
  ...over,
});

/** `decodeOp` result, asserted non-null so the tests stay `any`-free. */
function mustDecode(text: string): WireOp {
  const decoded = decodeOp(text);
  if (decoded === null) throw new Error(`expected a decodable op: ${text}`);
  return decoded;
}

/** Join a user at a fixed time, returning the next state. */
function joined(state: PresenceState, id: string, now = 1_000): PresenceState {
  return join(state, { id, name: id.toUpperCase() }, { now });
}

describe("LamportClock", () => {
  it("creates a clock at time zero with its actor", () => {
    expect(createClock("actor-a")).toEqual({ actor: "actor-a", time: 0 });
    expect(createClock("actor-a", 5)).toEqual({ actor: "actor-a", time: 5 });
  });

  it("tick advances the local time by one and keeps the actor", () => {
    expect(tick(createClock("a", 4))).toEqual({ actor: "a", time: 5 });
    expect(tick(tick(createClock("a", 4)))).toEqual({ actor: "a", time: 6 });
  });

  it("tick returns a fresh clock and never mutates its input", () => {
    const clock = createClock("a", 4);
    const next = tick(clock);
    expect(next).not.toBe(clock);
    expect(clock).toEqual({ actor: "a", time: 4 });
  });

  it("compare orders causally by time first", () => {
    expect(compare(createClock("a", 1), createClock("b", 2))).toBe(-1);
    expect(compare(createClock("a", 2), createClock("b", 1))).toBe(1);
  });

  it("compare breaks equal times by actor so the order is total", () => {
    expect(compare(createClock("a", 2), createClock("b", 2))).toBe(-1);
    expect(compare(createClock("b", 2), createClock("a", 2))).toBe(1);
    expect(compare(createClock("a", 2), createClock("a", 2))).toBe(0);
  });

  it("merge applies the Lamport receive rule: max(time) + 1 on the receiver's actor", () => {
    expect(merge(createClock("a", 3), createClock("b", 7))).toEqual({ actor: "a", time: 8 });
  });

  it("merge advances even when the observed clock is behind", () => {
    expect(merge(createClock("a", 9), createClock("b", 2))).toEqual({ actor: "a", time: 10 });
  });
});

describe("encodeOp / decodeOp", () => {
  it("round-trips a set op's fields", () => {
    const decoded = mustDecode(encodeOp(op("o1", "alice", 3, { payload: { blockId: "b1" } })));
    expect(decoded).toEqual({
      id: "o1",
      origin: "alice",
      clock: 3,
      kind: "set",
      payload: { blockId: "b1" },
    });
  });

  it("round-trips a delete op with a null payload", () => {
    const decoded = mustDecode(encodeOp(op("o2", "bob", 1, { kind: "delete" })));
    expect(decoded.kind).toBe("delete");
    expect(decoded.payload).toBeNull();
  });

  it("stamps the wire version and uses compact short keys", () => {
    const text = encodeOp(op("o1", "alice", 3));
    expect(text).toContain(`"v":${WIRE_VERSION}`);
    expect(text).not.toContain('"origin"');
    expect(text).not.toContain('"kind"');
    expect(JSON.parse(text).v).toBe(WIRE_VERSION);
  });

  it("preserves unknown fields from a newer producer (forward compatibility)", () => {
    const text = JSON.stringify({
      v: 1,
      id: "o9",
      o: "alice",
      c: 4,
      k: "set",
      p: { text: "hi" },
      futureField: 42,
      nested: { a: 1 },
    });
    const decoded = mustDecode(text);
    expect(decoded.extra).toEqual({ futureField: 42, nested: { a: 1 } });
    const reencoded = encodeOp(decoded);
    expect(mustDecode(reencoded).extra).toEqual(decoded.extra);
    expect(reencoded).toContain("futureField");
  });

  it("returns null for malformed JSON", () => {
    expect(decodeOp("{not json")).toBeNull();
  });

  it("returns null for a non-object frame", () => {
    expect(decodeOp("42")).toBeNull();
    expect(decodeOp("null")).toBeNull();
  });

  it("returns null when a required field is missing or unusable", () => {
    expect(decodeOp(JSON.stringify({ v: 1, id: "", o: "a", c: 1, k: "set" }))).toBeNull();
    expect(decodeOp(JSON.stringify({ v: 1, id: "x", o: "a", c: "NaN", k: "set" }))).toBeNull();
    expect(decodeOp(JSON.stringify({ v: 1, id: "x", o: "a", c: 1, k: "wat" }))).toBeNull();
    expect(decodeOp(JSON.stringify({ id: "x", o: "a", c: 1, k: "set" }))).toBeNull();
  });

  it("returns null for empty or non-string input", () => {
    expect(decodeOp("")).toBeNull();
    expect(decodeOp("   ")).toBeNull();
    expect(decodeOp(null)).toBeNull();
    expect(decodeOp(undefined)).toBeNull();
  });
});

describe("presence reducer", () => {
  it("join adds a participant with a deterministic colour from the palette", () => {
    const state = joined(createPresence("self"), "alice");
    const user = state.participants.alice;
    expect(user.name).toBe("ALICE");
    expect(user.color).toBe(assignColor("alice"));
    expect(PRESENCE_PALETTE).toContain(user.color);
    expect(user.joinedAt).toBe(1_000);
    expect(user.lastSeen).toBe(1_000);
  });

  it("join honours an explicit colour override", () => {
    const state = join(createPresence("self"), { id: "a", name: "A", color: "#123456" }, { now: 1 });
    expect(state.participants.a.color).toBe("#123456");
  });

  it("join sets selfId from the first participant and never overwrites it", () => {
    const first = joined(createPresence(""), "alice");
    expect(first.selfId).toBe("alice");
    const second = joined(first, "bob");
    expect(second.selfId).toBe("alice");
  });

  it("join preserves joinedAt on rejoin but refreshes lastSeen and name", () => {
    const first = joined(createPresence("self"), "alice", 1_000);
    const again = join(first, { id: "alice", name: "Alice II" }, { now: 5_000 });
    expect(again.participants.alice.joinedAt).toBe(1_000);
    expect(again.participants.alice.lastSeen).toBe(5_000);
    expect(again.participants.alice.name).toBe("Alice II");
  });

  it("join ignores a blank id and still returns a fresh state", () => {
    const state = joined(createPresence("self"), "alice");
    const next = join(state, { id: "  ", name: "ghost" }, { now: 2_000 });
    expect(Object.keys(next.participants)).toEqual(["alice"]);
    expect(next).not.toBe(state);
  });

  it("join never mutates the input state", () => {
    const state = joined(createPresence("self"), "alice");
    const before = snapshot(state);
    joined(state, "bob");
    expect(snapshot(state)).toBe(before);
  });

  it("leave removes a participant and returns a fresh state", () => {
    const state = joined(joined(createPresence("self"), "alice"), "bob");
    const next = leave(state, "alice");
    expect(Object.keys(next.participants)).toEqual(["bob"]);
    expect(next).not.toBe(state);
  });

  it("leave clears selfId when the local user leaves", () => {
    const state = joined(createPresence(""), "alice");
    expect(leave(state, "alice").selfId).toBeNull();
  });

  it("leave of an unknown id is a no-op copy", () => {
    const state = joined(createPresence("self"), "alice");
    const next = leave(state, "nobody");
    expect(next).not.toBe(state);
    expect(next.participants.alice).toEqual(state.participants.alice);
  });

  it("heartbeat advances lastSeen without touching joinedAt", () => {
    const state = joined(createPresence("self"), "alice", 1_000);
    const next = heartbeat(state, "alice", { now: 9_000 });
    expect(next.participants.alice.lastSeen).toBe(9_000);
    expect(next.participants.alice.joinedAt).toBe(1_000);
  });

  it("heartbeat for an unknown user does not add one", () => {
    const state = joined(createPresence("self"), "alice");
    const next = heartbeat(state, "ghost", { now: 9_000 });
    expect(Object.keys(next.participants)).toEqual(["alice"]);
    expect(next).not.toBe(state);
  });

  it("sweepStale keeps a participant exactly at the ttl boundary", () => {
    const state = joined(createPresence("self"), "edge", 900);
    expect(Object.keys(sweepStale(state, 1_000, 100).participants)).toEqual(["edge"]);
  });

  it("sweepStale drops a participant one millisecond past the ttl", () => {
    const state = joined(createPresence("self"), "gone", 899);
    expect(Object.keys(sweepStale(state, 1_000, 100).participants)).toEqual([]);
  });

  it("sweepStale keeps everyone when now or ttl is not finite (fail-safe)", () => {
    const state = joined(createPresence("self"), "alice", 0);
    expect(Object.keys(sweepStale(state, Number.NaN, 100).participants)).toEqual(["alice"]);
    expect(Object.keys(sweepStale(state, 1_000, Number.NaN).participants)).toEqual(["alice"]);
  });

  it("defaults the stale ttl constant to the awareness drop window", () => {
    expect(DEFAULT_PRESENCE_TTL_MS).toBe(45_000);
  });
});

describe("moveCursor", () => {
  it("assigns the user's deterministic colour when none is supplied", () => {
    const state = joined(createPresence("self"), "alice");
    const next = moveCursor(state, "alice", { anchor: 2, head: 5 });
    expect(next.participants.alice.cursor).toEqual({ anchor: 2, head: 5, color: assignColor("alice") });
  });

  it("honours an explicit cursor colour", () => {
    const state = joined(createPresence("self"), "alice");
    const next = moveCursor(state, "alice", { anchor: 1, head: 1, color: "purple" });
    expect(next.participants.alice.cursor?.color).toBe("purple");
  });

  it("normalises fractional and reversed endpoints", () => {
    const state = joined(createPresence("self"), "alice");
    const next = moveCursor(state, "alice", { anchor: 8.9, head: 3.2 });
    expect(next.participants.alice.cursor).toMatchObject({ anchor: 3, head: 8 });
  });

  it("is a no-op copy for an unknown user", () => {
    const state = joined(createPresence("self"), "alice");
    const next = moveCursor(state, "ghost", { anchor: 1, head: 2 });
    expect(Object.keys(next.participants)).toEqual(["alice"]);
    expect(next).not.toBe(state);
  });
});

describe("applyRemote", () => {
  it("applies an op, advancing the per-origin order and the local clock", () => {
    const state = applyRemote(createPresence("me"), [op("o1", "alice", 4)], { origin: "alice" });
    expect(Object.keys(state.ops)).toEqual(["o1"]);
    expect(state.order.alice).toBe(4);
    expect(state.clock.time).toBe(4);
    expect(state.stats.applied).toBe(1);
  });

  it("dedupes by op id across repeated batches", () => {
    const first = applyRemote(createPresence("me"), [op("o1", "alice", 1)], { origin: "alice" });
    const second = applyRemote(first, [op("o1", "alice", 1)], { origin: "alice" });
    expect(Object.keys(second.ops)).toEqual(["o1"]);
    expect(second.stats.applied).toBe(1);
    expect(second.stats.dropped).toBe(1);
  });

  it("rebases an unseen op whose clock arrives behind the origin high-water mark", () => {
    const first = applyRemote(createPresence("me"), [op("o1", "alice", 5)], { origin: "alice" });
    const second = applyRemote(first, [op("late", "alice", 3)], { origin: "alice" });
    expect(second.order.alice).toBe(6);
    expect(second.ops.late.clock).toBe(6);
    expect(second.stats.rebased).toBe(1);
    expect(second.stats.dropped).toBe(0);
  });

  it("orders a shuffled batch by (origin, clock, id) so arrival order never matters", () => {
    const batch = [op("c", "alice", 3), op("a", "alice", 1), op("b", "alice", 2)];
    const shuffled = [batch[1], batch[2], batch[0]];
    const one = applyRemote(createPresence("me"), batch, { origin: "alice" });
    const two = applyRemote(createPresence("me"), shuffled, { origin: "alice" });
    expect(snapshot(two)).toBe(snapshot(one));
  });

  it("tracks per-origin high-water marks independently", () => {
    const state = applyRemote(createPresence("me"), [op("a1", "alice", 2), op("b1", "bob", 1)], {
      origin: "alice",
    });
    expect(state.order).toEqual({ alice: 2, bob: 1 });
    expect(state.clock.time).toBe(2);
  });

  it("seeds the local clock actor from options.origin when the clock has none", () => {
    const state = applyRemote(createPresence(""), [op("o1", "alice", 1)], { origin: "me" });
    expect(state.clock.actor).toBe("me");
  });

  it("keeps an existing local clock actor over options.origin", () => {
    const state = applyRemote(createPresence("me"), [op("o1", "alice", 1)], { origin: "alice" });
    expect(state.clock.actor).toBe("me");
  });

  it("skips malformed ops without throwing or poisoning state", () => {
    const junk = [
      op("", "alice", 1),
      op("x", "", 1),
      op("y", "alice", Number.NaN),
    ];
    const state = applyRemote(createPresence("me"), junk, { origin: "alice" });
    expect(Object.keys(state.ops)).toEqual([]);
    expect(state.stats.applied).toBe(0);
  });

  it("never mutates the input state or the ops array", () => {
    const state = createPresence("me");
    const before = snapshot(state);
    const ops = [op("o1", "alice", 1)];
    const copy = [...ops];
    applyRemote(state, ops, { origin: "alice" });
    expect(snapshot(state)).toBe(before);
    expect(ops).toEqual(copy);
  });
});

describe("snapshot / restore", () => {
  it("round-trips participants, ops and ordering", () => {
    let state = joined(createPresence("me"), "alice", 100);
    state = moveCursor(state, "alice", { anchor: 1, head: 3 });
    state = applyRemote(state, [op("o1", "bob", 7)], { origin: "bob" });
    expect(restore(snapshot(state))).toEqual(state);
  });

  it("produces canonical text regardless of key insertion order", () => {
    const a = joined(joined(joined(createPresence(""), "self"), "alice"), "bob");
    const b = joined(joined(joined(createPresence(""), "self"), "bob"), "alice");
    expect(snapshot(b)).toBe(snapshot(a));
  });

  it("restores an empty state from garbage or missing input", () => {
    expect(restore("{not json")).toEqual(createPresence());
    expect(restore(null)).toEqual(createPresence());
    expect(restore(undefined)).toEqual(createPresence());
    expect(restore("")).toEqual(createPresence());
  });
});

describe("connectionPlan", () => {
  it("computes subscribers, fan-out rooms and edge count for a document", () => {
    const plan = connectionPlan({
      users: [
        { id: "u1", rooms: ["doc:1", "doc:2"] },
        { id: "u2", rooms: ["doc:1"] },
      ],
      rooms: ["doc:1", "doc:2", "doc:3"],
    });
    expect(plan.subscribers).toEqual({ "doc:1": ["u1", "u2"], "doc:2": ["u1"], "doc:3": [] });
    expect(plan.rooms).toEqual(["doc:1", "doc:2"]);
    expect(plan.emptyRooms).toEqual(["doc:3"]);
    expect(plan.fanOut).toEqual(["doc:1"]);
    expect(plan.edges).toBe(3);
  });

  it("lists users who subscribe to no candidate room as idle", () => {
    const plan = connectionPlan({
      users: [
        { id: "u1", rooms: ["doc:1"] },
        { id: "u2", rooms: [] },
        { id: "u3", rooms: ["other:9"] },
      ],
      rooms: ["doc:1"],
    });
    expect(plan.idleUsers).toEqual(["u2", "u3"]);
    expect(plan.edges).toBe(1);
  });

  it("dedupes repeated rooms and ignores rooms outside the candidate set", () => {
    const plan = connectionPlan({
      users: [{ id: "u1", rooms: ["doc:1", "doc:1", "ghost:1"] }],
      rooms: ["doc:1"],
    });
    expect(plan.subscribers["doc:1"]).toEqual(["u1"]);
    expect(plan.edges).toBe(1);
    expect(plan.idleUsers).toEqual([]);
  });

  it("emits rooms in a deterministic sorted order", () => {
    const plan = connectionPlan({ users: [], rooms: ["b", "a", "a"] });
    expect(plan.rooms).toEqual([]);
    expect(plan.emptyRooms).toEqual(["a", "b"]);
  });
});

describe("describePresence", () => {
  it("summarises self, others and the viewing count", () => {
    let state = joined(createPresence("alice"), "alice");
    state = joined(state, "bob");
    state = moveCursor(state, "bob", { anchor: 0, head: 0 });
    const summary = describePresence(state);
    expect(summary.count).toBe(2);
    expect(summary.self?.id).toBe("alice");
    expect(summary.others.map((user) => user.id)).toEqual(["bob"]);
    expect(summary.others[0].hasCursor).toBe(true);
    expect(summary.label).toBe("2 people viewing");
  });

  it("lists the ids of everyone with a live cursor", () => {
    let state = joined(createPresence("alice"), "alice");
    state = joined(state, "bob");
    state = moveCursor(state, "alice", { anchor: 1, head: 1 });
    expect(describePresence(state).editing).toEqual(["alice"]);
  });

  it("labels an empty room and a single viewer grammatically", () => {
    expect(describePresence(createPresence()).label).toBe("No one viewing");
    expect(describePresence(joined(createPresence("a"), "a")).label).toBe("1 person viewing");
  });
});
