import type { PropertyType } from "@prisma/client";

/**
 * Notion → Noema mapping layer (pure, deterministic, total).
 *
 * This is the vocabulary half of the Notion importer: it answers "which Noema
 * node / property type does this Notion type become?" and "which Notion types
 * have no home yet?". It performs **no** I/O and never throws — an unknown or
 * malformed type always maps to `null` instead, and `unmappedBlocks` lets the
 * caller report the loss instead of silently dropping content.
 *
 * The block vocabulary is the editor's own node names (`src/lib/html-export.ts`
 * `BLOCK_TYPES`, the TipTap schema), so a mapped type can be written straight
 * into a document. Container nodes follow the editor's grouping rules: a Notion
 * `bulleted_list_item` maps to a `listItem` (the `bulletList` wrapper is added
 * by the converter when consecutive items are grouped), exactly as
 * `notion-api.ts` already does.
 *
 * Nothing here is Notion-proprietary: only the public API's type identifiers are
 * referenced, and everything unknown degrades rather than crashing.
 */

/** Noema block (TipTap node) names this layer can emit. */
export const NOEMA_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "listItem",
  "taskItem",
  "toggle",
  "blockquote",
  "callout",
  "codeBlock",
  "horizontalRule",
  "table",
  "tableRow",
  "columns",
  "column",
  "image",
  "bookmark",
  "embed",
  "blockMath",
  "tableOfContents",
  "breadcrumb",
] as const;

export type NoemaBlockType = (typeof NOEMA_BLOCK_TYPES)[number];

/** Noema option/tint palette (see `COLOR_CHOICES` / `BLOCK_COLOR_CATALOGUE`). */
export const NOEMA_PALETTE_IDS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export type NoemaColor = (typeof NOEMA_PALETTE_IDS)[number];

const NOEMA_COLOR_SET: ReadonlySet<string> = new Set(NOEMA_PALETTE_IDS);

/**
 * Notion block type → Noema node name.
 *
 * Types deliberately absent (they map to `null`): `child_page` / `child_database`
 * (become nested pages, not blocks), media `video` / `audio` / `file` / `pdf`
 * (no native node — the converter degrades them to a link paragraph),
 * `synced_block`, `unsupported` and any future type.
 */
export const NOTION_BLOCK_MAP = {
  paragraph: "paragraph",
  heading_1: "heading",
  heading_2: "heading",
  heading_3: "heading",
  bulleted_list_item: "listItem",
  numbered_list_item: "listItem",
  to_do: "taskItem",
  toggle: "toggle",
  quote: "blockquote",
  callout: "callout",
  code: "codeBlock",
  divider: "horizontalRule",
  table: "table",
  table_row: "tableRow",
  column_list: "columns",
  column: "column",
  image: "image",
  bookmark: "bookmark",
  link_preview: "bookmark",
  embed: "embed",
  equation: "blockMath",
  table_of_contents: "tableOfContents",
  breadcrumb: "breadcrumb",
} as const satisfies Readonly<Record<string, NoemaBlockType>>;

/**
 * Notion property (`properties[p].type`) → Prisma `PropertyType`.
 *
 * `title` folds onto `TEXT` because Noema expresses "name column" as a config
 * flag (`config.primary`), not a distinct enum. `verification` has no Noema
 * equivalent and maps to `null`.
 */
export const PROPERTY_MAP = {
  title: "TEXT",
  rich_text: "TEXT",
  number: "NUMBER",
  select: "SELECT",
  multi_select: "MULTI_SELECT",
  status: "STATUS",
  date: "DATE",
  checkbox: "CHECKBOX",
  url: "URL",
  email: "EMAIL",
  phone_number: "PHONE",
  people: "PEOPLE",
  files: "FILES",
  place: "PLACE",
  formula: "FORMULA",
  relation: "RELATION",
  rollup: "ROLLUP",
  created_time: "CREATED_TIME",
  created_by: "CREATED_BY",
  last_edited_time: "LAST_EDITED_TIME",
  last_edited_by: "LAST_EDITED_BY",
  unique_id: "UNIQUE_ID",
  button: "BUTTON",
} as const satisfies Readonly<Record<string, PropertyType>>;

const BLOCK_LOOKUP: Readonly<Record<string, NoemaBlockType>> = NOTION_BLOCK_MAP;
const PROPERTY_LOOKUP: Readonly<Record<string, PropertyType>> = PROPERTY_MAP;

/**
 * Map a Notion block type to a Noema block type, or `null` when there is no
 * native equivalent. Matches exactly (case- and whitespace-sensitive); any
 * non-string input maps to `null`.
 */
export function mapNotionBlockType(type: unknown): NoemaBlockType | null {
  if (typeof type !== "string") return null;
  return BLOCK_LOOKUP[type] ?? null;
}

/**
 * Map a Notion property type to a Noema `PropertyType`, or `null` when there is
 * no equivalent. Exact match; any non-string input maps to `null`.
 */
export function mapNotionPropertyType(type: unknown): PropertyType | null {
  if (typeof type !== "string") return null;
  return PROPERTY_LOOKUP[type] ?? null;
}

/**
 * Map a Notion colour value to a Noema palette name, or `null` for "default"
 * (no tint) and anything unrecognised. Notion's `_background` variants fold
 * onto the same palette entry as their foreground colour.
 */
export function mapNotionColor(value: unknown): NoemaColor | null {
  if (typeof value !== "string") return null;
  const name = value.endsWith("_background") ? value.slice(0, -"_background".length) : value;
  if (name === "default") return null;
  return NOEMA_COLOR_SET.has(name) ? (name as NoemaColor) : null;
}

/**
 * Collect the distinct Notion block types from `types` that have no Noema
 * mapping (`mapNotionBlockType` returns `null`), in first-seen order, so an
 * import can report what it dropped. Empty, whitespace-only and non-string
 * entries are ignored; input is never mutated.
 */
export function unmappedBlocks(types: readonly unknown[]): string[] {
  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    if (typeof type !== "string" || type.trim() === "" || seen.has(type)) continue;
    seen.add(type);
    if (mapNotionBlockType(type) === null) unmapped.push(type);
  }
  return unmapped;
}
