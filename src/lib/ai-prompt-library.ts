/**
 * Reusable prompt library engine (docs/specs/ai-surface.md §14 "Prompt
 * library", R25.22 — matrix row `Prompt library 🟡`, gap **G8**: "Registry is
 * code (`ai-skills.ts`); no user-defined prompt model").
 *
 * A `PromptTemplate` is a named, reusable instruction whose body may carry
 * `{{name}}` placeholders. This module is the pure engine a future
 * `WorkspacePrompt` row, the chat composer picker and the settings manage-list
 * all share: token extraction, validation, strict rendering and the
 * create/update/delete/list/clone reducers. It deliberately has no React, no
 * Prisma and no network — the DB row (R25.22's `{id, workspaceId, title,
 * prompt, createdById, shared, createdAt}`) and the server actions are a later
 * slice; everything here round-trips as plain values.
 *
 * The built-in skills in `ai-skills.ts` stay code-owned and are **not**
 * editable through this engine (spec §4 R25.22): they are prompts as functions
 * of a single text slot, whereas a library template is data with named
 * variables.
 *
 * ## Token grammar
 *
 * A variable token is `{{name}}` where `name` is `[\w.-]+` with surrounding
 * whitespace allowed. A backslash immediately before the braces escapes the
 * token (`\{{name}}`), so a template can show literal braces without a value;
 * an even number of backslashes is not an escape. Malformed braces (`{{}}`,
 * `{{unclosed`, `{{a|b}}`) are never tokens and are preserved verbatim. Unlike
 * `template-variables.ts` (which also supports `{{name|fallback}}`), the
 * library grammar is bare-name only — a fallback is a template the user can
 * write with a default, not a hidden substitution rule.
 *
 * ## Purity
 *
 * Every function is pure: inputs are never mutated and new arrays/objects are
 * returned. The only ambient read is the clock, and it is **injected** through
 * a `now` option; when omitted it falls back to the current instant so callers
 * that do not care are not forced to thread a timestamp, while tests and
 * deterministic reducers pass `now` explicitly (the same posture as
 * `undo-stack.ts`'s `at`).
 */

/** Where a prompt lives: private to its author, or shared with the workspace. */
export type PromptScope = "personal" | "workspace";

/** A reusable prompt: a name, a body with `{{variable}}` slots, and metadata. */
export type PromptTemplate = {
  /** Stable identity, unique within a library. */
  id: string;
  /** Display name, trimmed. Unique per scope (see `validatePrompt`). */
  name: string;
  /** The instruction text; may contain `{{variable}}` tokens. */
  body: string;
  /** Declared variable names, deduped and sorted. */
  variables: string[];
  /** Personal prompts are private; workspace prompts are shared. */
  scope: PromptScope;
  /** Optional labels for grouping and search, deduped and trimmed. */
  tags?: string[];
  /** ISO-8601 creation instant. */
  createdAt: string;
  /** ISO-8601 instant of the last edit. */
  updatedAt: string;
};

/** The serialisable state the reducers fold over. */
export type PromptLibraryState = {
  readonly prompts: readonly PromptTemplate[];
};

/** Values substituted into a template body; `null`/`undefined` count as missing. */
export type PromptValues = Record<string, string | number | boolean | null | undefined>;

/** A new prompt, minus the fields the engine derives (`variables`, times). */
export type PromptInput = {
  name: string;
  body: string;
  scope: PromptScope;
  /** Explicit id; a slug of the name is used when omitted. */
  id?: string;
  /** Explicit declaration; derived from the body when omitted. */
  variables?: readonly string[];
  tags?: readonly string[];
  /** Injected clock; defaults to now. */
  now?: string | Date;
};

/** A partial edit applied by `updatePrompt`. */
export type PromptPatch = {
  name?: string;
  body?: string;
  scope?: PromptScope;
  variables?: readonly string[];
  tags?: readonly string[];
  now?: string | Date;
};

/** Filters accepted by `listPrompts`. */
export type PromptListFilter = {
  scope?: PromptScope;
  /** Case-insensitive exact tag match. */
  tag?: string;
  /** Ranked substring query over name, tags and body. */
  query?: string;
};

/** Options accepted by `clonePrompt`. */
export type ClonePromptOptions = {
  scope?: PromptScope;
  newId?: string;
  name?: string;
  now?: string | Date;
};

/** A validation problem, reported one per issue so a caller can show them all. */
export type PromptIssueCode =
  | "EMPTY_NAME"
  | "EMPTY_BODY"
  | "NAME_TOO_LONG"
  | "BODY_TOO_LONG"
  | "DUPLICATE_NAME"
  | "TOO_MANY_VARIABLES"
  | "UNKNOWN_VARIABLE"
  | "UNUSED_VARIABLE";

/** One problem with a prompt template. */
export type PromptIssue = {
  code: PromptIssueCode;
  message: string;
  /** The variable involved, for `UNKNOWN_VARIABLE` / `UNUSED_VARIABLE`. */
  variable?: string;
};

/** The inclusive bounds every template is validated against. */
export const PROMPT_LIMITS = {
  maxNameLength: 80,
  maxBodyLength: 4000,
  maxVariables: 32,
  maxTags: 10,
  maxTagLength: 32,
} as const;

/** A fresh, empty library. */
export function createPromptLibrary(
  prompts: readonly PromptTemplate[] = [],
): PromptLibraryState {
  return { prompts: [...prompts] };
}

/** Raised by `renderPrompt` when a referenced variable has no value. */
export class PromptRenderError extends Error {
  /** The missing variable names, sorted and deduped. */
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Missing value${missing.length === 1 ? "" : "s"} for prompt variable${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}`,
    );
    this.name = "PromptRenderError";
    this.missing = missing;
  }
}

/** A fresh global regex per call, so `lastIndex` never leaks between calls. */
function tokenPattern(): RegExp {
  return /\{\{\s*([\w.-]+)\s*\}\}/g;
}

/** Whether the `{{` at `index` is preceded by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text.charAt(i) === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** A non-empty, trimmed string, or `undefined`. */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

/** Dedupe, drop blanks and sort variable names, so declarations are canonical. */
function normalizeVariables(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const entry of input) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (name.length > 0) seen.add(name);
  }
  return [...seen].sort();
}

/** Trim, drop blanks and dedupe (case-insensitively), preserving first order. */
function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const tag = typeof entry === "string" ? entry.trim() : "";
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** An ISO-8601 instant from an injected clock value. */
function toIso(value: string | Date | undefined): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return new Date().toISOString();
}

/** A URL-safe slug for a name; `"prompt"` when nothing survives. */
function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "prompt";
}

/** A slug-based id that does not collide with an existing one. */
function uniqueId(state: PromptLibraryState, base: string): string {
  const taken = new Set(state.prompts.map((prompt) => prompt.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Read a present value as a string; `undefined` means "missing". */
function readValue(values: PromptValues, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(values, name)) return undefined;
  const value = values[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  return value ? "true" : "false";
}

/**
 * Every variable referenced by `body`, deduped and **sorted**. Escaped
 * (`\{{name}}`) tokens are ignored; malformed braces are never tokens. Never
 * throws, even for empty or non-string input.
 */
export function extractVariables(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const names = new Set<string>();
  for (const match of body.matchAll(tokenPattern())) {
    const index = match.index ?? 0;
    if (isEscaped(body, index)) continue;
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/**
 * Substitute `values` into `template.body`, preserving literal braces and
 * unescaping `\{{name}}` to a literal `{{name}}`.
 *
 * Rendering is **strict**: every variable referenced by the body must have a
 * present value (a present-but-empty string counts as present), otherwise a
 * `PromptRenderError` listing the missing names is thrown. A variable declared
 * but unused by the body is not required. Extra values are ignored.
 */
export function renderPrompt(template: PromptTemplate, values: PromptValues = {}): string {
  const body = typeof template?.body === "string" ? template.body : "";
  const safeValues = typeof values === "object" && values !== null ? values : {};

  const missing = extractVariables(body).filter((name) => readValue(safeValues, name) === undefined);
  if (missing.length > 0) throw new PromptRenderError(missing);

  let output = "";
  let cursor = 0;
  for (const match of body.matchAll(tokenPattern())) {
    const index = match.index ?? 0;
    const token = match[0];
    output += body.slice(cursor, index);
    if (isEscaped(body, index)) {
      // Drop the single escaping backslash, keep the braces literal.
      output = output.slice(0, -1);
      output += token;
    } else {
      output += readValue(safeValues, match[1]) ?? "";
    }
    cursor = index + token.length;
  }
  output += body.slice(cursor);
  return output;
}

/**
 * Validate a template, returning one issue per problem and never throwing.
 * Checks, in order: a non-empty name within its length cap; a non-empty body
 * within its length cap; a name unique (case-insensitively) per scope among
 * `existing` (ignoring the template's own stored copy); a variable count cap;
 * body tokens that were not declared (`UNKNOWN_VARIABLE`); and declared
 * variables the body never uses (`UNUSED_VARIABLE`). Unknown/unused names are
 * reported once each, sorted.
 */
export function validatePrompt(
  template: PromptTemplate,
  existing: readonly PromptTemplate[] = [],
): PromptIssue[] {
  const issues: PromptIssue[] = [];
  const name = typeof template?.name === "string" ? template.name.trim() : "";
  const body = typeof template?.body === "string" ? template.body : "";
  const scope: PromptScope = template?.scope === "personal" ? "personal" : "workspace";

  if (name.length === 0) {
    issues.push({ code: "EMPTY_NAME", message: "A prompt needs a name." });
  } else if (name.length > PROMPT_LIMITS.maxNameLength) {
    issues.push({
      code: "NAME_TOO_LONG",
      message: `Prompt name is limited to ${PROMPT_LIMITS.maxNameLength} characters.`,
    });
  }

  if (body.trim().length === 0) {
    issues.push({ code: "EMPTY_BODY", message: "A prompt needs a body." });
  } else if (body.length > PROMPT_LIMITS.maxBodyLength) {
    issues.push({
      code: "BODY_TOO_LONG",
      message: `Prompt body is limited to ${PROMPT_LIMITS.maxBodyLength} characters.`,
    });
  }

  if (name.length > 0) {
    const key = name.toLowerCase();
    const duplicate = existing.some(
      (other) =>
        other &&
        other.id !== template.id &&
        other.scope === scope &&
        typeof other.name === "string" &&
        other.name.trim().toLowerCase() === key,
    );
    if (duplicate) {
      issues.push({
        code: "DUPLICATE_NAME",
        message: `A ${scope} prompt named "${name}" already exists.`,
      });
    }
  }

  const declared = normalizeVariables(template?.variables);
  const used = extractVariables(body);
  if (declared.length > PROMPT_LIMITS.maxVariables) {
    issues.push({
      code: "TOO_MANY_VARIABLES",
      message: `A prompt may declare at most ${PROMPT_LIMITS.maxVariables} variables.`,
    });
  }

  const declaredSet = new Set(declared);
  const usedSet = new Set(used);
  for (const variable of used) {
    if (!declaredSet.has(variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        variable,
        message: `"${variable}" appears in the body but is not declared.`,
      });
    }
  }
  for (const variable of declared) {
    if (!usedSet.has(variable)) {
      issues.push({
        code: "UNUSED_VARIABLE",
        variable,
        message: `"${variable}" is declared but never used in the body.`,
      });
    }
  }

  return issues;
}

/**
 * Append a new template. The `variables` field is derived from the body when
 * not supplied; the id is an explicit `input.id` or a slug of the name, made
 * unique against the state. A blank name/body is a no-op returning the same
 * state. Pure: the input state is never mutated.
 */
export function createPrompt(state: PromptLibraryState, input: PromptInput): PromptLibraryState {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const body = typeof input?.body === "string" ? input.body : "";
  if (name.length === 0 || body.trim().length === 0) return state;

  const scope: PromptScope = input?.scope === "personal" ? "personal" : "workspace";
  const now = toIso(input?.now);
  const id =
    typeof input?.id === "string" && input.id.trim().length > 0
      ? input.id.trim()
      : uniqueId(state, slugify(name));

  const template: PromptTemplate = {
    id,
    name,
    body,
    variables: normalizeVariables(input?.variables ?? extractVariables(body)),
    scope,
    createdAt: now,
    updatedAt: now,
  };

  const tags = normalizeTags(input?.tags);
  if (tags.length > 0) template.tags = tags;

  return { prompts: [...state.prompts, template] };
}

/**
 * Edit the template with `id`. When `body` changes, `variables` is recomputed
 * from it unless the patch supplies an explicit list; `id`/`createdAt` are
 * preserved and `updatedAt` is stamped. An unknown id (or no change) returns
 * the same state. Pure: the input state is never mutated.
 */
export function updatePrompt(
  state: PromptLibraryState,
  id: string,
  patch: PromptPatch,
): PromptLibraryState {
  const index = state.prompts.findIndex((prompt) => prompt.id === id);
  if (index < 0) return state;

  const next: PromptTemplate = { ...state.prompts[index] };

  if (typeof patch?.name === "string") next.name = patch.name.trim();
  if (typeof patch?.body === "string") {
    next.body = patch.body;
    next.variables =
      patch.variables !== undefined
        ? normalizeVariables(patch.variables)
        : extractVariables(patch.body);
  } else if (patch?.variables !== undefined) {
    next.variables = normalizeVariables(patch.variables);
  }
  if (patch?.scope === "personal" || patch?.scope === "workspace") next.scope = patch.scope;
  if (patch?.tags !== undefined) {
    const tags = normalizeTags(patch.tags);
    if (tags.length > 0) next.tags = tags;
    else delete next.tags;
  }
  next.updatedAt = toIso(patch?.now);

  const prompts = [...state.prompts];
  prompts[index] = next;
  return { prompts };
}

/**
 * Remove the template with `id`. An unknown id returns the same state. Pure:
 * the input state is never mutated.
 */
export function deletePrompt(state: PromptLibraryState, id: string): PromptLibraryState {
  const prompts = state.prompts.filter((prompt) => prompt.id !== id);
  if (prompts.length === state.prompts.length) return state;
  return { prompts };
}

/** Rank a template against a lowercased query; `0` means "no match". */
function scorePrompt(template: PromptTemplate, query: string): number {
  const name = template.name.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  const tags = normalizeTags(template.tags).map((tag) => tag.toLowerCase());
  if (tags.includes(query)) return 50;
  if (tags.some((tag) => tag.includes(query))) return 40;
  if (template.body.toLowerCase().includes(query)) return 20;
  return 0;
}

/** Newer `updatedAt` first (ISO strings compare lexicographically). */
function compareUpdatedDesc(a: PromptTemplate, b: PromptTemplate): number {
  if (a.updatedAt === b.updatedAt) return 0;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/**
 * Filter and rank the library. `scope` and `tag` are exact filters (tags
 * case-insensitively); `query` is a ranked substring search over the name, the
 * tags and the body, with an exact name beating a prefix, a prefix beating a
 * substring, a tag beating a body hit. Results are ordered by rank, then by
 * most-recently-updated, then by name. With no `query` the whole (filtered)
 * library is returned, newest first. The state is never mutated.
 */
export function listPrompts(
  state: PromptLibraryState,
  filter: PromptListFilter = {},
): PromptTemplate[] {
  const prompts = Array.isArray(state?.prompts) ? state.prompts : [];
  const tag = typeof filter?.tag === "string" ? filter.tag.trim().toLowerCase() : "";
  const query = typeof filter?.query === "string" ? filter.query.trim().toLowerCase() : "";
  const scope = filter?.scope;

  const matches = prompts.filter((prompt) => {
    if (!prompt) return false;
    if (scope !== undefined && prompt.scope !== scope) return false;
    if (tag.length > 0 && !normalizeTags(prompt.tags).some((t) => t.toLowerCase() === tag)) {
      return false;
    }
    if (query.length > 0 && scorePrompt(prompt, query) <= 0) return false;
    return true;
  });

  return [...matches].sort((a, b) => {
    if (query.length > 0) {
      const byScore = scorePrompt(b, query) - scorePrompt(a, query);
      if (byScore !== 0) return byScore;
    }
    const byUpdated = compareUpdatedDesc(a, b);
    if (byUpdated !== 0) return byUpdated;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Copy a template under a new identity. Defaults: id `<id>-copy`, name
 * `<name> (copy)`, the source scope, and the source `updatedAt` as the clone's
 * timestamp (pass `now` to re-stamp). Arrays are freshly copied, so the source
 * is never aliased or mutated.
 */
export function clonePrompt(
  template: PromptTemplate,
  options: ClonePromptOptions = {},
): PromptTemplate {
  const scope: PromptScope =
    options?.scope === "personal" || options?.scope === "workspace"
      ? options.scope
      : template.scope;
  const id = trimmed(options?.newId) ?? `${template.id}-copy`;
  const name = trimmed(options?.name) ?? `${template.name} (copy)`;
  const stamp = toIso(options?.now ?? template.updatedAt);

  const clone: PromptTemplate = {
    id,
    name,
    body: template.body,
    variables: Array.isArray(template.variables) ? [...template.variables] : [],
    scope,
    createdAt: stamp,
    updatedAt: stamp,
  };

  const tags = normalizeTags(template.tags);
  if (tags.length > 0) clone.tags = tags;

  return clone;
}

/**
 * A one-line, human-readable description for menus and tooltips, e.g.
 * `"Notes" (personal) [meeting, weekly] — variables: text, tone`. A template
 * with no variables reads `— no variables`. Never throws.
 */
export function describePrompt(template: PromptTemplate): string {
  if (!template || typeof template !== "object") return "";
  const name = typeof template.name === "string" ? template.name : "";
  const scope: PromptScope = template.scope === "personal" ? "personal" : "workspace";
  const tags = normalizeTags(template.tags);
  const variables = normalizeVariables(template.variables);
  const tagPart = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  const variablePart =
    variables.length > 0 ? `variables: ${variables.join(", ")}` : "no variables";
  return `"${name}" (${scope})${tagPart} — ${variablePart}`;
}
