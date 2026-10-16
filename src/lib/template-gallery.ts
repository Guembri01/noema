import { prosemirrorToText, type RichNode } from "./blocks";

/**
 * Page-template gallery model (docs/specs/templates.md §6 "Page templates",
 * "Template duplication").
 *
 * A {@link PageTemplate} is the client-facing projection of a `kind=PAGE`
 * template: the display metadata the gallery cards need, a snapshot of the
 * source page's blocks (used by {@link previewTemplate} and duplication) and
 * the lifecycle counters (`usageCount`, `createdAt`/`updatedAt`). Everything
 * here is pure and deterministic — no Prisma, no auth, no React — so the
 * gallery UI, the picker and the server actions can all share one model.
 *
 * The functions are deliberately immutable: `recordUsage`, `duplicateTemplate`
 * and `createFromPage` always return fresh records (and fresh block snapshots)
 * so a caller can keep the previous state for undo, and a template never
 * aliases the page it was captured from.
 */

/** Workspace templates are shared; personal templates are private (R31.8). */
export type PageTemplateScope = "workspace" | "personal";

/** A page template as browsed in the gallery and listed by the picker. */
export type PageTemplate = {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  cover?: string;
  scope: PageTemplateScope;
  tags?: string[];
  /** The page this template was captured from (never mutated by this model). */
  sourcePageId: string;
  /** Number of blocks in the snapshot; the gallery card shows this. */
  blockCount: number;
  /** ISO-8601 timestamp of capture. */
  createdAt: string;
  /** ISO-8601 timestamp of the last change (rename, edit, usage bump). */
  updatedAt: string;
  /** How many times the template has been applied (R31.10). */
  usageCount: number;
  /** Deep-copied block snapshot; absent/empty for a metadata-only record. */
  blocks?: RichNode[];
};

/** The source page `createFromPage` snapshots (R31.9). */
export type TemplateSourcePage = {
  id: string;
  icon?: string;
  cover?: string;
  description?: string;
  tags?: readonly string[];
  /** Top-level blocks; each may carry an id in `attrs.id`. */
  blocks?: readonly RichNode[];
  /** A full `doc`; its `content` is used when `blocks` is absent. */
  content?: unknown;
};

export type CreateFromPageOptions = {
  name: string;
  scope: PageTemplateScope;
  /** Optional subset of block ids (`attrs.id`, else the index) to snapshot. */
  blockIds?: readonly string[];
  /** Stable id; defaults to `tpl_<slug(name)>`. */
  id?: string;
  /** Injectable clock: an ISO string, epoch millis, or a `Date`. */
  now?: string | number | Date;
};

export type DuplicateTemplateOptions = {
  newId: string;
  /** Display name; defaults to `${source.name} copy`. */
  name?: string;
  /** Destination scope; defaults to the source's scope. */
  scope?: PageTemplateScope;
};

/** One outline line of a preview: the block type plus its first text line. */
export type TemplateOutlineEntry = { type: string; text: string };

export type TemplatePreview = {
  entries: TemplateOutlineEntry[];
  /** How many outline lines are shown (≤ `maxBlocks`). */
  shown: number;
  /** The template's total block count. */
  blockCount: number;
  /** True when the snapshot has more blocks than are shown. */
  truncated: boolean;
};

export type PreviewOptions = { maxBlocks?: number };

/** Metadata submitted to {@link validateTemplateMeta}. */
export type TemplateMetaInput = {
  /** Present when editing an existing template (so a rename is not a clash). */
  id?: string;
  name?: string;
  scope?: PageTemplateScope;
  tags?: readonly string[];
};

export type TemplateMetaValidation =
  | { ok: true; errors?: undefined }
  | { ok: false; errors: string[] };

export type TemplateSortKey = "relevance" | "name" | "created" | "updated" | "usage";

export type ListTemplatesOptions = {
  scope?: PageTemplateScope;
  /** Exact tag filter, case-insensitive. */
  tag?: string;
  /** Case-insensitive name search; ranks exact > prefix > tag > description. */
  query?: string;
  sort?: TemplateSortKey;
};

export type TemplateScopeGroups = {
  workspace: PageTemplate[];
  personal: PageTemplate[];
};

/** Default number of outline lines a preview shows. */
export const DEFAULT_PREVIEW_BLOCKS = 5;

/** Lowercase kebab-case tag: `weekly-report`, `v2`. */
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A tag is valid when it is non-empty lowercase kebab-case (R31.9). */
export function isValidTag(tag: string): boolean {
  return typeof tag === "string" && TAG_PATTERN.test(tag);
}

/** Lowercase, hyphen-separated slug; `"template"` when nothing survives. */
function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "template";
}

/** An ISO-8601 timestamp from a `Date` / epoch millis / parseable string. */
function toIso(now: string | number | Date | undefined): string {
  if (now === undefined) return new Date().toISOString();
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "number") return new Date(now).toISOString();
  const parsed = Date.parse(now);
  return Number.isNaN(parsed) ? now : new Date(parsed).toISOString();
}

/** Deep-copy a JSON-safe block list so no snapshot aliases its source. */
function cloneBlocks(blocks: readonly RichNode[]): RichNode[] {
  return JSON.parse(JSON.stringify(blocks)) as RichNode[];
}

/** The page's top-level blocks, from `blocks` or a `doc`'s `content`. */
function resolveBlocks(page: TemplateSourcePage): RichNode[] {
  if (Array.isArray(page.blocks)) return page.blocks.slice();
  const content = page.content as RichNode | null | undefined;
  if (content && Array.isArray(content.content)) return content.content.slice();
  return [];
}

/** Keep the requested block ids (by `attrs.id`, else index), in page order. */
function selectBlocks(blocks: RichNode[], blockIds?: readonly string[]): RichNode[] {
  if (!blockIds || blockIds.length === 0) return blocks;
  const wanted = new Set(blockIds.map((id) => String(id)));
  return blocks.filter((block, index) => wanted.has(String(block.attrs?.id ?? index)));
}

/** The first non-empty text line inside a block, or `""` when it has none. */
function firstTextLine(block: RichNode): string {
  const text = prosemirrorToText({ type: "doc", content: [block] });
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? "";
}

/**
 * Snapshot a page into a new template (R31.9). The blocks are deep-copied (so
 * editing the template or the page never affects the other), the id defaults to
 * a slug of the name, and `createdAt`/`updatedAt` share the injected `now`.
 * `blockIds` narrows the snapshot to a subset, preserving page order.
 */
export function createFromPage(
  page: TemplateSourcePage,
  options: CreateFromPageOptions,
): PageTemplate {
  const name = options.name.trim();
  const blocks = selectBlocks(resolveBlocks(page), options.blockIds);
  const timestamp = toIso(options.now);
  const template: PageTemplate = {
    id: options.id?.trim() || `tpl_${slugify(name)}`,
    name,
    scope: options.scope,
    sourcePageId: page.id,
    blockCount: blocks.length,
    createdAt: timestamp,
    updatedAt: timestamp,
    usageCount: 0,
    blocks: cloneBlocks(blocks),
  };
  if (page.description) template.description = page.description;
  if (page.icon) template.icon = page.icon;
  if (page.cover) template.cover = page.cover;
  if (page.tags && page.tags.length > 0) template.tags = [...page.tags];
  return template;
}

/**
 * Deep-copy a template into a new, independent one (R31.8): a fresh id/name, an
 * optional destination scope (defaults to the source's), a fresh block snapshot
 * and a reset `usageCount` (a copy starts unapplied). The source is untouched.
 */
export function duplicateTemplate(
  template: PageTemplate,
  options: DuplicateTemplateOptions,
): PageTemplate {
  const newId = options.newId.trim();
  if (!newId) {
    throw new Error("duplicateTemplate requires a new template id.");
  }
  return {
    ...template,
    id: newId,
    name: options.name?.trim() || `${template.name} copy`,
    scope: options.scope ?? template.scope,
    usageCount: 0,
    blocks: template.blocks ? cloneBlocks(template.blocks) : undefined,
    tags: template.tags ? [...template.tags] : undefined,
  };
}

/**
 * Outline the first `maxBlocks` blocks as `{ type, text }` (R31.15): the block
 * type plus its first text line. `truncated` reports whether the snapshot has
 * more blocks than are shown, and `maxBlocks` is clamped to `>= 0`.
 */
export function previewTemplate(
  template: PageTemplate,
  options: PreviewOptions = {},
): TemplatePreview {
  const maxBlocks =
    options.maxBlocks === undefined
      ? DEFAULT_PREVIEW_BLOCKS
      : Math.max(0, Math.floor(options.maxBlocks));
  const blocks = template.blocks ?? [];
  const entries = blocks.slice(0, maxBlocks).map((block) => ({
    type: block.type ?? "block",
    text: firstTextLine(block),
  }));
  const blockCount = template.blockCount ?? blocks.length;
  return {
    entries,
    shown: entries.length,
    blockCount,
    truncated: blockCount > entries.length,
  };
}

/**
 * Bump a template's usage counter and `updatedAt` (R31.10). Returns a fresh
 * record; the input is never mutated, so the caller can keep the previous state.
 */
export function recordUsage(
  template: PageTemplate,
  options: { now: string | number | Date },
): PageTemplate {
  return {
    ...template,
    usageCount: template.usageCount + 1,
    updatedAt: toIso(options.now),
  };
}

/**
 * Validate template metadata before saving (R31.8/R31.9): a non-empty name, a
 * name unique within its scope (case-insensitively, ignoring the record being
 * edited by `id`), a supported scope, and lowercase kebab-case tags. Every
 * problem is reported in one pass with stable codes (`empty_name`,
 * `invalid_scope`, `duplicate_name`, `invalid_tag:<tag>`).
 */
export function validateTemplateMeta(
  meta: TemplateMetaInput,
  existing: readonly PageTemplate[] = [],
): TemplateMetaValidation {
  const errors: string[] = [];
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!name) errors.push("empty_name");

  const scope = meta.scope;
  const scopeValid = scope === "workspace" || scope === "personal";
  if (!scopeValid) errors.push("invalid_scope");

  if (name && scopeValid) {
    const needle = name.toLowerCase();
    const id = typeof meta.id === "string" ? meta.id : undefined;
    const duplicate = existing.some(
      (template) =>
        template.id !== id &&
        template.scope === scope &&
        template.name.trim().toLowerCase() === needle,
    );
    if (duplicate) errors.push("duplicate_name");
  }

  for (const tag of meta.tags ?? []) {
    if (!isValidTag(tag)) errors.push(`invalid_tag:${tag}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** 0 exact, 1 prefix, 2 tag match, 3 description match, -1 no match. */
function templateRank(template: PageTemplate, query: string): number {
  const name = template.name.trim().toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if ((template.tags ?? []).some((tag) => tag.toLowerCase().includes(query))) return 2;
  if ((template.description ?? "").toLowerCase().includes(query)) return 3;
  return -1;
}

function compareTemplates(
  a: PageTemplate,
  b: PageTemplate,
  sort: TemplateSortKey,
  rankOf: (template: PageTemplate) => number,
): number {
  if (sort === "name") {
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
    if (byName !== 0) return byName;
  } else if (sort === "created") {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    if (byCreated !== 0) return byCreated;
  } else if (sort === "updated") {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
  } else if (sort === "usage") {
    const byUsage = b.usageCount - a.usageCount;
    if (byUsage !== 0) return byUsage;
  } else {
    const byRank = rankOf(a) - rankOf(b);
    if (byRank !== 0) return byRank;
  }
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

/**
 * List templates for the gallery/picker (R31.12/R31.15): filtered by `scope`
 * and an exact `tag`, ranked for an optional name `query` (exact > prefix >
 * tag > description; unmatched templates are dropped), then sorted by the
 * requested key — `"relevance"` by default. The tie-break is deterministic
 * (name, then id). Never mutates the input.
 */
export function listTemplates(
  templates: readonly PageTemplate[],
  options: ListTemplatesOptions = {},
): PageTemplate[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const tag = options.tag?.trim().toLowerCase();
  const sort = options.sort ?? "relevance";
  const rankOf = (template: PageTemplate): number =>
    query === "" ? 0 : templateRank(template, query);
  const kept = templates
    .filter((template) => (options.scope ? template.scope === options.scope : true))
    .filter((template) =>
      tag ? (template.tags ?? []).some((entry) => entry.toLowerCase() === tag) : true,
    )
    .filter((template) => rankOf(template) >= 0);
  return [...kept].sort((a, b) => compareTemplates(a, b, sort, rankOf));
}

/**
 * One-line human description for a gallery card / picker row (R31.15):
 * `"Report (workspace, 3 blocks, tags: a, b, used 4×)"`. Deterministic, so the
 * string is snapshottable in UI tests.
 */
export function describeTemplate(template: PageTemplate): string {
  const name = template.name.trim() || "Untitled template";
  const parts: string[] = [template.scope, `${template.blockCount} ${template.blockCount === 1 ? "block" : "blocks"}`];
  if (template.tags && template.tags.length > 0) parts.push(`tags: ${template.tags.join(", ")}`);
  if (template.usageCount > 0) parts.push(`used ${template.usageCount}×`);
  return `${name} (${parts.join(", ")})`;
}

/** Split templates into workspace/personal buckets, preserving input order. */
export function groupByScope(templates: readonly PageTemplate[]): TemplateScopeGroups {
  const groups: TemplateScopeGroups = { workspace: [], personal: [] };
  for (const template of templates) {
    groups[template.scope].push(template);
  }
  return groups;
}
