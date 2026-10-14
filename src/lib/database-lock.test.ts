import { describe, expect, it } from "vitest";
import {
  canEditRows,
  canEditSchema,
  canEditValue,
  describeLock,
  toggleLock,
  togglePropertyLock,
  type LockRole,
  type LockState,
} from "./database-lock";

/**
 * Red-first suite for the database-lock + page-locking policy
 * (docs/specs/database-deep.md R89.23/R89.24; FEATURE_MATRIX "Database lock"
 * :245 and "Page locking" :158).
 *
 * The module owns the *pure* half: role (owner / member / unknown) × schema
 * lock × per-property lock → can-edit-schema / can-edit-value / can-edit-rows,
 * plus the lock-state mutators and a human-readable summary. No Prisma, no
 * React, no I/O.
 *
 * Every predicate fails closed: a viewer who is neither owner nor member
 * (guest, anonymous, a forged or missing role) is denied even while unlocked,
 * and an unknown role never earns a capability by carrying a stray override.
 */

const owner: LockRole = { isOwner: true, isMember: false };
const member: LockRole = { isOwner: false, isMember: true };
const guest: LockRole = { isOwner: false, isMember: false };
/** A forged/unknown role that also tries to smuggle an override grant. */
const forged = { isOwner: false, isMember: false, override: true } as LockRole;

const unlocked: LockState = { locked: false };
const locked: LockState = { locked: true };
const oneLocked: LockState = { locked: false, lockedPropertyIds: ["p1"] };

describe("canEditSchema — structural edits vs the schema/page lock", () => {
  it("lets the owner edit the schema whether or not it is locked", () => {
    expect([canEditSchema(unlocked, owner), canEditSchema(locked, owner)]).toEqual([true, true]);
  });

  it("lets a member edit the schema only while unlocked", () => {
    expect([canEditSchema(unlocked, member), canEditSchema(locked, member)]).toEqual([true, false]);
  });

  it("denies a guest or forged role even when unlocked (fail closed)", () => {
    expect(canEditSchema(unlocked, guest)).toBe(false);
    expect(canEditSchema(unlocked, forged)).toBe(false);
  });

  it("denies a missing role", () => {
    expect(canEditSchema(unlocked, undefined)).toBe(false);
    expect(canEditSchema(unlocked, null)).toBe(false);
  });
});

describe("canEditRows — row data is independent of the schema lock", () => {
  it("keeps rows editable for owner and member", () => {
    expect([canEditRows(owner), canEditRows(member)]).toEqual([true, true]);
  });

  it("denies a guest or forged role even with an override (fail closed)", () => {
    expect(canEditRows(guest)).toBe(false);
    expect(canEditRows(forged)).toBe(false);
    expect(canEditRows(undefined)).toBe(false);
  });
});

describe("canEditValue — cell writes respect the per-property lock", () => {
  it("lets a member write an unlocked property, locked schema or not", () => {
    expect(canEditValue(unlocked, "p1", member)).toBe(true);
    // A schema lock freezes structure, not row data.
    expect(canEditValue(locked, "p2", member)).toBe(true);
  });

  it("blocks a member from writing a property-locked value", () => {
    expect(canEditValue(oneLocked, "p1", member)).toBe(false);
    expect(canEditValue(oneLocked, "p2", member)).toBe(true);
  });

  it("lets the owner override a property lock", () => {
    expect(canEditValue(oneLocked, "p1", owner)).toBe(true);
  });

  it("lets an explicit override grant lift a property lock for a member", () => {
    expect(canEditValue(oneLocked, "p1", { isOwner: false, isMember: true, override: true })).toBe(
      true,
    );
  });

  it("never lets an unknown role write, even with an override (fail closed)", () => {
    expect(canEditValue(unlocked, "p1", guest)).toBe(false);
    expect(canEditValue(oneLocked, "p1", forged)).toBe(false);
  });
});

describe("toggleLock — flip the schema/page lock, keep property locks", () => {
  it("flips the flag, keeps property locks and never mutates its input", () => {
    expect(toggleLock(unlocked).locked).toBe(true);
    expect(toggleLock(oneLocked)).toEqual({ locked: true, lockedPropertyIds: ["p1"] });
    const state: LockState = { locked: false, lockedPropertyIds: ["p1"] };
    toggleLock(state);
    expect(state).toEqual({ locked: false, lockedPropertyIds: ["p1"] });
  });
});

describe("togglePropertyLock — add/remove a single property lock", () => {
  it("adds the id when absent and removes it when present", () => {
    expect(togglePropertyLock(unlocked, "p1").lockedPropertyIds).toEqual(["p1"]);
    expect(togglePropertyLock(oneLocked, "p1").lockedPropertyIds).toEqual([]);
  });

  it("is its own inverse and preserves the schema lock flag", () => {
    expect(togglePropertyLock(togglePropertyLock(locked, "p1"), "p1").lockedPropertyIds).toEqual([]);
    expect(togglePropertyLock(locked, "p1").locked).toBe(true);
  });

  it("never mutates the input list", () => {
    const state: LockState = { locked: false, lockedPropertyIds: ["p1"] };
    togglePropertyLock(state, "p2");
    expect(state.lockedPropertyIds).toEqual(["p1"]);
  });
});

describe("describeLock — human-readable summary", () => {
  it("reports the unlocked state", () => {
    expect(describeLock(unlocked)).toBe("Unlocked");
    expect(describeLock({ locked: false, lockedPropertyIds: [] })).toBe("Unlocked");
  });

  it("names the schema lock alone, and counts property locks with pluralisation", () => {
    expect(describeLock(locked)).toBe("Schema locked");
    expect(describeLock(oneLocked)).toBe("1 property locked");
    expect(describeLock({ locked: false, lockedPropertyIds: ["p1", "p2"] })).toBe(
      "2 properties locked",
    );
  });

  it("combines the schema lock with property locks", () => {
    expect(describeLock({ locked: true, lockedPropertyIds: ["p1", "p2"] })).toBe(
      "Schema locked · 2 properties locked",
    );
  });
});
