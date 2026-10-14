/**
 * Database lock + page locking: the pure capability policy behind
 * docs/specs/database-deep.md R89.23/R89.24 and the FEATURE_MATRIX rows
 * "Database lock" (:245) and "Page locking" (:158).
 *
 * The server's `authorizeDatabase` choke point needs to answer three questions
 * before it touches Prisma: may this viewer change the *structure* (add/edit/
 * delete properties, views, templates, import), may they change *row data*, and
 * may they write one specific *cell*? Today that is a single binary role check
 * (`canEditContent`); this module adds the lock dimension as a pure predicate so
 * the matrix can be unit-tested without a database or a browser.
 *
 * One `LockState` serves both features:
 *
 * - a **database** sets `locked` from `Page.schemaLocked` (structure frozen,
 *   rows stay editable) and may pin individual properties with
 *   `lockedPropertyIds`;
 * - a **page** reuses `locked` from `Page.locked` as its content lock, where
 *   `canEditSchema` is the "may edit page content" gate.
 *
 * Policy, fail-closed:
 *
 * - **Owner** (the unlock holder) may edit schema even while locked, and may
 *   override a property lock; this is what keeps the lock toggle reachable.
 * - **Member** may edit schema while unlocked and may always edit rows/cells,
 *   but a schema lock stops structural edits and a property lock stops that
 *   cell.
 * - **Anyone else** — guest, anonymous, a forged role, or a missing one — is
 *   denied every capability, even unlocked, and an `override` grant never
 *   substitutes for edit access.
 */

/**
 * The lock flags for one database or page. `lockedPropertyIds` is a per-property
 * refinement: a value write for a listed property needs an override.
 */
export type LockState = {
  /** Whole-schema (database) or whole-content (page) lock. */
  locked: boolean;
  /** Property ids whose cell values are frozen; absent or empty means none. */
  lockedPropertyIds?: string[];
};

/** The viewer, reduced to the two role facts the policy needs. */
export type LockRole = {
  isOwner: boolean;
  isMember: boolean;
  /**
   * Explicit unlock for a property-locked value. Ownership implies it; a
   * caller mapping a workspace admin to this shape can pass it to lift a single
   * property lock. It never grants edit access on its own.
   */
  override?: boolean;
};

/** Edit access is the base gate for every capability: owner or member. */
function hasEditAccess(role: LockRole | null | undefined): boolean {
  return Boolean(role?.isOwner || role?.isMember);
}

function isLocked(state: LockState | null | undefined): boolean {
  return Boolean(state?.locked);
}

/** The property locks, normalised to a clean list of non-empty ids. */
function propertyLocks(state: LockState | null | undefined): string[] {
  const ids = state?.lockedPropertyIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function isPropertyLocked(state: LockState | null | undefined, propertyId: string): boolean {
  return propertyLocks(state).includes(propertyId);
}

/**
 * May the viewer change the schema/content: add, edit or delete properties and
 * views, change view config, manage templates, import, duplicate? A schema lock
 * freezes all of it for members; the owner keeps access so they can unlock.
 */
export function canEditSchema(
  state: LockState | null | undefined,
  role: LockRole | null | undefined,
): boolean {
  if (!hasEditAccess(role)) return false;
  if (!isLocked(state)) return true;
  return Boolean(role?.isOwner);
}

/**
 * May the viewer change row data: create, update, delete, restore or import a
 * row? The schema lock does *not* apply — a locked database keeps its rows
 * editable (R89.24), so this depends on role alone.
 */
export function canEditRows(role: LockRole | null | undefined): boolean {
  return hasEditAccess(role);
}

/**
 * May the viewer write the cell value of `propertyId`? Requires edit access,
 * and is blocked only by that property's own lock: a schema lock leaves values
 * writable, while a property lock needs the owner or an explicit `override`.
 */
export function canEditValue(
  state: LockState | null | undefined,
  propertyId: string,
  role: LockRole | null | undefined,
): boolean {
  if (!hasEditAccess(role)) return false;
  if (!isPropertyLocked(state, propertyId)) return true;
  return Boolean(role?.isOwner || role?.override);
}

/** Flip the whole-schema/page lock, leaving property locks untouched. */
export function toggleLock(state: LockState): LockState {
  return { ...state, locked: !isLocked(state) };
}

/**
 * Add `propertyId` to the property locks, or remove it when already present.
 * The returned state is fresh — the input (and its id list) is never mutated.
 */
export function togglePropertyLock(state: LockState, propertyId: string): LockState {
  if (typeof propertyId !== "string" || propertyId.length === 0) return { ...state };
  const locks = propertyLocks(state);
  const next = locks.includes(propertyId)
    ? locks.filter((id) => id !== propertyId)
    : [...locks, propertyId];
  return { ...state, lockedPropertyIds: next };
}

/**
 * A stable, human-readable summary of the lock state, for a toolbar chip or a
 * tooltip: `"Unlocked"`, `"Schema locked"`, `"1 property locked"`,
 * `"2 properties locked"`, or `"Schema locked · 2 properties locked"`.
 */
export function describeLock(state: LockState | null | undefined): string {
  const count = propertyLocks(state).length;
  const plural = count === 1 ? "property" : "properties";
  const propertyLabel = `${count} ${plural} locked`;
  if (isLocked(state) && count > 0) return `Schema locked · ${propertyLabel}`;
  if (isLocked(state)) return "Schema locked";
  if (count > 0) return propertyLabel;
  return "Unlocked";
}
