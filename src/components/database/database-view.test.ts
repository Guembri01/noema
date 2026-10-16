import { describe, expect, it } from "vitest";
import { clientLockRole, schemaLockToggle } from "./database-view";
import {
  canEditSchema,
  type LockRole,
  type LockState,
} from "@/lib/database-lock";

/**
 * The wired schema-lock decision path (docs/specs/database-deep.md R89.24;
 * FEATURE_MATRIX "Database lock" :245).
 *
 * `database-view.tsx` is a client component, so the JSX itself is not
 * node-testable here (no DOM). The *decision* it routes the lock action
 * through — `schemaLockToggle`, plus the `clientLockRole` mapping from the
 * `editable` prop — is pure, and that is what these tests exercise with real
 * inputs. The server action re-checks the same `canEditSchema` policy before
 * writing, so the component only ever decides what the toolbar *offers*.
 */

const owner: LockRole = { isOwner: true, isMember: false };
const member: LockRole = { isOwner: false, isMember: true };
const guest: LockRole = { isOwner: false, isMember: false };
const unlocked: LockState = { locked: false };
const locked: LockState = { locked: true };

describe("clientLockRole — the role the toolbar evaluates the policy against", () => {
  it("treats an editor as owner-capable so the unlock control stays reachable", () => {
    // The route passes only `editable` today; treating an editor as the
    // strongest role keeps the toggle present on a locked database (the same
    // rule the page actions menu documents), while the server owns the
    // owner-only unlock and a refused click is surfaced as an error.
    expect(clientLockRole(true)).toEqual({ isOwner: true, isMember: true });
  });

  it("fails closed for a viewer without edit access", () => {
    const role = clientLockRole(false);
    expect(canEditSchema(unlocked, role)).toBe(false);
    expect(canEditSchema(locked, role)).toBe(false);
  });
});

describe("schemaLockToggle — canToggle (enablement) + the value a click persists", () => {
  it("offers an editor the toggle on an unlocked database and flips it on", () => {
    expect(schemaLockToggle(unlocked, member)).toEqual({
      canToggle: true,
      nextLocked: true,
    });
    expect(schemaLockToggle(unlocked, owner)).toEqual({
      canToggle: true,
      nextLocked: true,
    });
  });

  it("lets only the owner unlock an already-locked schema (symmetric unlock)", () => {
    expect(schemaLockToggle(locked, owner)).toEqual({
      canToggle: true,
      nextLocked: false,
    });
    // A plain member keeps the read-only chip while the schema is locked.
    expect(schemaLockToggle(locked, member)).toEqual({
      canToggle: false,
      nextLocked: false,
    });
  });

  it("denies a guest/forged viewer even while unlocked (fail closed)", () => {
    expect(schemaLockToggle(unlocked, guest)).toEqual({
      canToggle: false,
      nextLocked: true,
    });
  });

  it("routes the wired control through the real client role", () => {
    // The component composes the two: an editor always gets the toggle (so the
    // owner can unlock), a read-only viewer never does.
    expect(schemaLockToggle(locked, clientLockRole(true)).canToggle).toBe(true);
    expect(schemaLockToggle(unlocked, clientLockRole(false)).canToggle).toBe(false);
  });
});
