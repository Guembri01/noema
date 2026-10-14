/**
 * Toggle heading — pure outline logic for headings that double as collapsible
 * toggles (docs/MISSING_FEATURES §1, spec docs/specs/editor-deep.md R37).
 *
 * A heading of level L "owns" every following block until the next heading of
 * level <= L: that owned run is the heading's collapsible body. `headingSubtrees`
 * exposes the ownership runs, `visibleBlocks` intersects them with a set of
 * collapsed heading ids, and `toggleCollapse` edits that set immutably. Because
 * the model is a FLAT list, a nested heading is itself one of its parent's
 * children, so collapsing an ancestor hides the whole subtree without any tree
 * walk at render time.
 *
 * LEVEL RULES (deliberate, pinned by toggle-heading.test.ts):
 *  - Toggle headings exist only at levels 1–3 (Notion's toggle-heading range).
 *  - `canToggle` demands a well-formed integer level in range, so a malformed
 *    heading cannot be wired to a toggle affordance.
 *  - Structural walks never crash on malformed levels: `normalizeHeadingLevel`
 *    clamps finite numbers into 1–3 (fractional levels truncate) and floors
 *    anything non-finite/missing to 1. Out-of-range values (e.g. an h4 from the
 *    wider editor) therefore section as if they were h3.
 *
 * Pure and editor-agnostic: no ProseMirror, no DOM; safe for the editor and
 * read-only viewers alike.
 */

/** Heading levels that can act as toggles (Notion's toggle-heading range). */
export const MIN_HEADING_LEVEL = 1;
export const MAX_HEADING_LEVEL = 3;

/** Node type that represents a heading in the flat block list. */
export const HEADING_TYPE = "heading";

/** Minimal block shape: a stable id, a type and (for headings) a level. */
export interface ToggleBlock {
  /** Stable block id; when missing an index-derived `#n` id is used instead. */
  id?: string;
  type: string;
  /** Heading level. Only meaningful when `type` is `"heading"`. */
  level?: number;
}

/** A heading and the ids of the blocks it owns (its collapsible run). */
export interface HeadingSubtree {
  headingId: string;
  childIds: string[];
}

/** True when `block` is a heading node. Tolerates `null`/`undefined`. */
export function isHeading(block: ToggleBlock | null | undefined): boolean {
  return block?.type === HEADING_TYPE;
}

/** True for an integer level inside the toggle-heading range (1–3). */
export function isValidHeadingLevel(level: unknown): level is number {
  return (
    typeof level === "number" &&
    Number.isInteger(level) &&
    level >= MIN_HEADING_LEVEL &&
    level <= MAX_HEADING_LEVEL
  );
}

/**
 * Safe structural level for a heading: finite numbers truncate then clamp into
 * 1–3; missing/non-finite values fall back to {@link MIN_HEADING_LEVEL}. Never
 * throws and always returns a usable level.
 */
export function normalizeHeadingLevel(level: unknown): number {
  if (typeof level !== "number" || !Number.isFinite(level)) return MIN_HEADING_LEVEL;
  return Math.min(Math.max(Math.trunc(level), MIN_HEADING_LEVEL), MAX_HEADING_LEVEL);
}

/**
 * A block's stable identity: its non-empty string `id`, else a positional
 * `#<index>` fallback so blocks without ids still participate in ownership and
 * visibility. The same fallback is used everywhere, so ids stay consistent.
 */
export function blockId(block: ToggleBlock, index: number): string {
  const id = block?.id;
  return typeof id === "string" && id.trim() !== "" ? id : `#${index}`;
}

/**
 * Whether a block can be used as a collapsible toggle: a heading whose level is
 * a well-formed integer in 1–3. Malformed-level headings are ignored by the
 * toggle UI even though {@link headingSubtrees} still sections them safely.
 */
export function canToggle(block: ToggleBlock | null | undefined): boolean {
  return isHeading(block) && isValidHeadingLevel(block?.level);
}

/**
 * Ownership runs for every heading in document order. A heading of level L owns
 * all following blocks up to (but not including) the next heading of level <= L;
 * nested headings appear in the parent's `childIds` alongside their contents.
 * Empty documents, heading-free documents and malformed levels are handled
 * without throwing.
 */
export function headingSubtrees<T extends ToggleBlock>(
  blocks: readonly T[],
): HeadingSubtree[] {
  const subtrees: HeadingSubtree[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!isHeading(block)) continue;

    const level = normalizeHeadingLevel(block.level);
    const childIds: string[] = [];
    for (let j = i + 1; j < blocks.length; j += 1) {
      const next = blocks[j];
      if (isHeading(next) && normalizeHeadingLevel(next.level) <= level) break;
      childIds.push(blockId(next, j));
    }
    subtrees.push({ headingId: blockId(block, i), childIds });
  }
  return subtrees;
}

/**
 * Immutable toggle of one heading in the collapsed set: removes the id when
 * present (expand) and adds it when absent (collapse). Always returns a fresh
 * `Set`; the input is never mutated.
 */
export function toggleCollapse(
  collapsed: ReadonlySet<string>,
  headingId: string,
): Set<string> {
  const next = new Set(collapsed);
  if (next.has(headingId)) next.delete(headingId);
  else next.add(headingId);
  return next;
}

/**
 * The blocks a reader can currently see: everything except the owned runs of
 * collapsed headings. A collapsed heading itself stays visible (it is the
 * toggle header); nested collapses union, so collapsing an ancestor hides its
 * whole subtree whatever the descendants' state. Unknown or non-heading ids in
 * `collapsed` are ignored. Returns a fresh array; the input is not mutated.
 */
export function visibleBlocks<T extends ToggleBlock>(
  blocks: readonly T[],
  collapsed: ReadonlySet<string>,
): T[] {
  if (collapsed.size === 0) return blocks.slice();

  const hidden = new Set<string>();
  for (const { headingId, childIds } of headingSubtrees(blocks)) {
    if (collapsed.has(headingId)) {
      for (const id of childIds) hidden.add(id);
    }
  }
  return blocks.filter((block, index) => !hidden.has(blockId(block, index)));
}

/**
 * Indent a heading one level deeper (H1 → H2 → H3). Returns the new level, or
 * `null` when the level is malformed or already at {@link MAX_HEADING_LEVEL}.
 */
export function indentHeading(level: number): number | null {
  if (!isValidHeadingLevel(level)) return null;
  return level >= MAX_HEADING_LEVEL ? null : level + 1;
}

/**
 * Outdent a heading one level shallower (H3 → H2 → H1). Returns the new level,
 * or `null` when the level is malformed or already at {@link MIN_HEADING_LEVEL}.
 */
export function outdentHeading(level: number): number | null {
  if (!isValidHeadingLevel(level)) return null;
  return level <= MIN_HEADING_LEVEL ? null : level - 1;
}
