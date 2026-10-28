/**
 * "Turn into" block conversion graph (docs/FEATURE_MATRIX.md §"Turn into",
 * docs/MISSING_FEATURES.md §1).
 *
 * Pure, editor-agnostic model of the block-type conversions the block context
 * menu offers. It owns the canonical block list, the conversion matrix and the
 * attribute mapping (heading level, to-do `checked`, code `language`, callout
 * icon, toggle `open`) so the menu, any future keyboard layer and the tests
 * share one definition. No ProseMirror, no React, no DOM.
 *
 * THE GRAPH (deliberate, pinned by block-conversion.test.ts):
 *  - Every text-like block shares the same inline content model (text + marks),
 *    so any block can "turn into" any *other* block: the graph is complete
 *    minus the identity edge. `canConvert(x, x)` is `false` (there is nothing
 *    to do) and unknown types are rejected rather than guessed.
 *  - {@link allowedTargets} always answers in {@link BLOCK_TYPES} order, so the
 *    menu is byte-stable across renders, and never names the source type.
 *  - {@link convertBlock} preserves the inline content (deep-cloned, marks
 *    included) and maps only the target's own attributes; a source attribute
 *    the target cannot hold (a to-do `checked` on an `h2`) is dropped rather
 *    than smuggled through.
 */

import { DEFAULT_CALLOUT_ICON } from "@/lib/callout-icons";

/** The block types the "turn into" menu can produce or consume. */
export type BlockType =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "bulletedList"
  | "numberedList"
  | "todoList"
  | "toggle"
  | "quote"
  | "pullQuote"
  | "callout"
  | "code";

/** Canonical display order: also the order of every `allowedTargets` answer. */
export const BLOCK_TYPES: readonly BlockType[] = Object.freeze([
  "paragraph",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "bulletedList",
  "numberedList",
  "todoList",
  "toggle",
  "quote",
  "pullQuote",
  "callout",
  "code",
] as const);

const BLOCK_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_TYPES);

/** True when `value` is one of {@link BLOCK_TYPES}. Tolerates unknown input. */
export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && BLOCK_TYPE_SET.has(value);
}

/** Inline mark carried through a conversion untouched (`bold`, `link`, …). */
export type InlineMark = { type: string; attrs?: Record<string, unknown> };

/** Inline content node (text run, mention, inline math, …). */
export type InlineNode = {
  type?: string;
  text?: string;
  marks?: readonly InlineMark[];
  attrs?: Record<string, unknown>;
};

/** Attributes a convertible block may carry; each belongs to specific targets. */
export type BlockAttrs = {
  /** Heading level, for `h1`–`h6`. */
  level?: number;
  /** To-do box state, for `todoList`. */
  checked?: boolean;
  /** Fence language, for `code`. */
  language?: string;
  /** Callout icon glyph, for `callout`. */
  emoji?: string;
  /** Expanded state, for `toggle`. */
  open?: boolean;
};

/** A single block in the minimal shape a conversion needs. */
export type ConvertibleBlock = {
  type: BlockType;
  /** Inline content (text runs and marks). Absent means an empty block. */
  content?: readonly InlineNode[];
  /** Target-specific attributes; see {@link BlockAttrs}. */
  attrs?: BlockAttrs;
};

/** One menu section: an id (for an i18n label) plus its types in order. */
export type ConversionGroup = {
  id: string;
  types: readonly BlockType[];
};

/**
 * Menu sections, in display order. Their union is exactly {@link BLOCK_TYPES}
 * with no repetition, so a caller can render the whole menu by walking this
 * and never touch a separate list.
 */
export const CONVERSION_GROUPS: readonly ConversionGroup[] = Object.freeze([
  Object.freeze({
    id: "text",
    types: Object.freeze(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6"] as const),
  }),
  Object.freeze({
    id: "lists",
    types: Object.freeze(["bulletedList", "numberedList", "todoList"] as const),
  }),
  Object.freeze({
    id: "blocks",
    types: Object.freeze(["toggle", "quote", "pullQuote", "callout", "code"] as const),
  }),
]);

/** Heading level implied by a heading type; empty for every other target. */
const HEADING_LEVELS: Readonly<Partial<Record<BlockType, number>>> = Object.freeze({
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
});

/**
 * Whether `<from>` can turn into `<to>`. True for any two *distinct* known
 * types (the graph is complete minus the identity); false when either side is
 * unknown or the types match.
 */
export function canConvert(from: string, to: string): boolean {
  return isBlockType(from) && isBlockType(to) && from !== to;
}

/**
 * Every type `<from>` can turn into, in {@link BLOCK_TYPES} order and never
 * including `<from>` itself. Unknown sources yield `[]`; a fresh array is
 * returned each call.
 */
export function allowedTargets(from: string): BlockType[] {
  if (!isBlockType(from)) return [];
  return BLOCK_TYPES.filter((type) => type !== from);
}

/** Generic deep clone that keeps every own field, including `undefined`. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneValue(item);
    return clone as T;
  }
  return value;
}

/** A non-empty string, else `undefined` (so blank attrs fall back to defaults). */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The attributes `<to>` should carry, derived from the source only where the
 * target understands them (heading level, to-do `checked`, toggle `open`,
 * callout `emoji`, code `language`). Every other source attribute is dropped.
 */
function mapAttrs(block: ConvertibleBlock, to: BlockType): BlockAttrs {
  const level = HEADING_LEVELS[to];
  if (level !== undefined) return { level };

  const source = block.attrs ?? {};
  switch (to) {
    case "todoList":
      return { checked: source.checked === true };
    case "toggle":
      return { open: source.open !== false };
    case "callout":
      return { emoji: nonEmptyString(source.emoji) ?? DEFAULT_CALLOUT_ICON };
    case "code":
      return { language: nonEmptyString(source.language) ?? "" };
    default:
      return {};
  }
}

/**
 * Convert a block to type `<to>`, preserving its inline content and marks
 * (deep-cloned, so neither side aliases the other) and mapping only the
 * attributes `<to>` can hold. Returns `null` when `<to>` is not a known type.
 *
 * The conversion does not consult {@link canConvert}: converting a block to its
 * own type is a valid, idempotent normalisation (`checked`/`open` defaults are
 * re-applied), which lets callers round-trip without a special case.
 */
export function convertBlock(block: ConvertibleBlock, to: BlockType): ConvertibleBlock | null {
  if (!isBlockType(to)) return null;

  const result: ConvertibleBlock = {
    type: to,
    content: cloneValue(block.content ?? []),
  };
  const attrs = mapAttrs(block, to);
  if (Object.keys(attrs).length > 0) result.attrs = attrs;
  return result;
}
