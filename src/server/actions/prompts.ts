"use server";

/**
 * Persistence for the workspace prompt library (R25.22, gap G8).
 *
 * The pure rules â€” token grammar, validation, ranking, rendering and the
 * create/update/delete/clone reducers â€” live in `@/lib/ai-prompt-library`.
 * These actions are the thin, authorised seam between that engine and the
 * `WorkspacePrompt` table: every row is mapped to a `PromptTemplate`, folded
 * through the engine, then written back. Keeping the engine authoritative means
 * the settings page, the composer picker and the database agree on what a
 * prompt is.
 *
 * Access model (fail closed):
 * - every action requires membership of the target workspace;
 * - `personal` rows are only listed, mutated or cloned by their creator;
 * - `workspace` rows are readable by any member (guests included) but only
 *   writable by a member with `canEditContent` (guests are read-only);
 * - a prompt's `scope` may only be changed by its creator, so a member cannot
 *   quietly turn shared content private (or vice versa);
 * - unknown scopes and duplicate names are refused rather than coerced.
 */

import { revalidatePath } from "next/cache";
import { Prisma, type WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import {
  PROMPT_LIMITS,
  clonePrompt,
  createPrompt,
  createPromptLibrary,
  extractVariables,
  listPrompts,
  updatePrompt,
  validatePrompt,
  type PromptScope,
  type PromptTemplate,
} from "@/lib/ai-prompt-library";

export type PromptListResult =
  | { ok: true; prompts: PromptTemplate[]; canEdit: boolean }
  | { ok: false; error: string };

export type PromptMutationResult =
  | { ok: true; prompt: PromptTemplate }
  | { ok: false; error: string };

export type PromptDeleteResult = { ok: true } | { ok: false; error: string };

const NOT_MEMBER = "You are not a member of this workspace.";
const NO_WRITE = "You do not have permission to change prompts in this workspace.";
const NOT_FOUND = "Prompt not found.";

type Authorized =
  | { ok: true; userId: string; role: WorkspaceRole }
  | { ok: false; error: string };

/** Resolve the caller and their membership, optionally requiring write access. */
async function authorize(workspaceId: string, write = false): Promise<Authorized> {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    return { ok: false, error: NOT_MEMBER };
  }
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { ok: false, error: NOT_MEMBER };
  if (write && !canEditContent(access.role)) return { ok: false, error: NO_WRITE };
  return { ok: true, userId: user.id, role: access.role };
}

/** A stored row, as much as the mapping needs (keeps tests free of Prisma types). */
type PromptRow = {
  id: string;
  workspaceId: string;
  createdById: string;
  name: string;
  body: string;
  scope: string;
  tags: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Normalise the JSON tag column; anything that is not a string is dropped. */
function readTags(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string");
}

/** The one place a DB row becomes the engine's plain `PromptTemplate`. */
function toTemplate(row: PromptRow): PromptTemplate {
  const scope: PromptScope = row.scope === "personal" ? "personal" : "workspace";
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    variables: extractVariables(row.body),
    scope,
    tags: readTags(row.tags),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The rows a caller may see: every shared prompt plus only their own personal ones. */
function visibleWhere(workspaceId: string, userId: string): Prisma.WorkspacePromptWhereInput {
  return {
    workspaceId,
    OR: [{ scope: "workspace" }, { scope: "personal", createdById: userId }],
  };
}

async function visibleRows(workspaceId: string, userId: string): Promise<PromptRow[]> {
  return prisma.workspacePrompt.findMany({
    where: visibleWhere(workspaceId, userId),
    orderBy: { updatedAt: "desc" },
  });
}

/** A valid scope, or `undefined` when the caller supplied something else. */
function readScope(value: unknown): PromptScope | undefined {
  return value === "personal" || value === "workspace" ? value : undefined;
}

/** Tags are normalised by the engine; their bounds are the engine's constants. */
function tagIssue(tags: readonly string[]): string | null {
  if (tags.length > PROMPT_LIMITS.maxTags) {
    return `A prompt may have at most ${PROMPT_LIMITS.maxTags} tags.`;
  }
  const tooLong = tags.find((tag) => tag.length > PROMPT_LIMITS.maxTagLength);
  return tooLong
    ? `Tags are limited to ${PROMPT_LIMITS.maxTagLength} characters.`
    : null;
}

/** The first validation problem, as a user-facing message (or `null`). */
function firstIssue(template: PromptTemplate, existing: readonly PromptTemplate[]): string | null {
  const issue = validatePrompt(template, existing)[0];
  return issue ? issue.message : null;
}

/** Whether this caller may edit/delete a row (write access is checked separately). */
function mayMutate(row: Pick<PromptRow, "scope" | "createdById">, userId: string): boolean {
  if (row.scope === "personal") return row.createdById === userId;
  if (row.scope === "workspace") return true;
  return false;
}

/** Fit a clone name inside the engine's cap, keeping the copy suffix readable. */
function copyName(base: string, index?: number): string {
  const suffix = index === undefined ? " (copy)" : ` (copy ${index})`;
  const room = Math.max(1, PROMPT_LIMITS.maxNameLength - suffix.length);
  return `${base.slice(0, room).trimEnd()}${suffix}`;
}

/** A clone name that does not collide with an existing name in the target scope. */
function uniqueCloneName(
  base: string,
  scope: PromptScope,
  existing: readonly PromptTemplate[],
  copySuffix: boolean,
): string {
  const taken = new Set(
    existing
      .filter((prompt) => prompt.scope === scope)
      .map((prompt) => prompt.name.trim().toLowerCase()),
  );
  const first = copySuffix
    ? copyName(base)
    : base.slice(0, PROMPT_LIMITS.maxNameLength).trimEnd();
  if (!taken.has(first.toLowerCase())) return first;
  let index = 2;
  while (taken.has(copyName(base, index).toLowerCase())) index += 1;
  return copyName(base, index);
}

/** Write the shared `tags` column; `null` clears it (SQL NULL). */
function tagsValue(tags: readonly string[] | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!tags || tags.length === 0) return Prisma.DbNull;
  return [...tags] as Prisma.InputJsonValue;
}

function touch(): void {
  revalidatePath("/w", "layout");
}

/**
 * List the prompts this caller may see, ranked/filtered by the pure engine.
 * `scope`, `tag` and `query` behave exactly as `listPrompts` documents them.
 */
export async function listPromptsAction(input: {
  workspaceId: string;
  scope?: string;
  tag?: string;
  query?: string;
}): Promise<PromptListResult> {
  const auth = await authorize(input?.workspaceId ?? "");
  if (!auth.ok) return { ok: false, error: auth.error };

  const scope = readScope(input?.scope);
  const where = visibleWhere(input.workspaceId, auth.userId);
  if (scope) where.scope = scope;

  const rows = await prisma.workspacePrompt.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });
  const library = createPromptLibrary(rows.map(toTemplate));
  const prompts = listPrompts(library, {
    scope,
    tag: typeof input?.tag === "string" ? input.tag : undefined,
    query: typeof input?.query === "string" ? input.query : undefined,
  });
  return { ok: true, prompts, canEdit: canEditContent(auth.role) };
}

/** Create a prompt in the caller's workspace (write access required). */
export async function createPromptAction(input: {
  workspaceId: string;
  name: string;
  body: string;
  scope: string;
  tags?: readonly string[];
}): Promise<PromptMutationResult> {
  const auth = await authorize(input?.workspaceId ?? "", true);
  if (!auth.ok) return { ok: false, error: auth.error };

  const scope = readScope(input?.scope);
  if (!scope) return { ok: false, error: "Choose whether the prompt is personal or shared." };

  const existingRows = await visibleRows(input.workspaceId, auth.userId);
  const existing = existingRows.map(toTemplate);

  // The engine derives the canonical name/variables/tags and refuses blanks.
  const next = createPrompt(createPromptLibrary(existing), {
    name: typeof input?.name === "string" ? input.name : "",
    body: typeof input?.body === "string" ? input.body : "",
    scope,
    tags: input?.tags,
    id: "draft",
  });
  const candidate = next.prompts.find((prompt) => prompt.id === "draft");
  if (!candidate) {
    return { ok: false, error: "A prompt needs a name and a body." };
  }

  const tagProblem = tagIssue(candidate.tags ?? []);
  if (tagProblem) return { ok: false, error: tagProblem };
  const problem = firstIssue(candidate, existing);
  if (problem) return { ok: false, error: problem };

  const row = await prisma.workspacePrompt.create({
    data: {
      workspaceId: input.workspaceId,
      createdById: auth.userId,
      name: candidate.name,
      body: candidate.body,
      scope: candidate.scope,
      tags: tagsValue(candidate.tags),
    },
  });

  touch();
  return { ok: true, prompt: toTemplate(row) };
}

/** Edit a visible prompt (personal prompts only by their creator). */
export async function updatePromptAction(input: {
  workspaceId: string;
  id: string;
  name?: string;
  body?: string;
  scope?: string;
  tags?: readonly string[];
}): Promise<PromptMutationResult> {
  const auth = await authorize(input?.workspaceId ?? "", true);
  if (!auth.ok) return { ok: false, error: auth.error };

  const row = await prisma.workspacePrompt.findFirst({
    where: { id: input?.id ?? "", workspaceId: input.workspaceId },
  });
  if (!row) return { ok: false, error: NOT_FOUND };
  // Another member's personal prompt is reported as missing: the action never
  // confirms that a private row exists.
  if (!mayMutate(row, auth.userId)) return { ok: false, error: NOT_FOUND };

  // `scope` is optional; a supplied-but-unknown value is refused, not coerced.
  let scope: PromptScope | undefined;
  if (input?.scope !== undefined) {
    scope = readScope(input.scope);
    if (!scope) return { ok: false, error: "Choose whether the prompt is personal or shared." };
    if (scope !== row.scope && row.createdById !== auth.userId) {
      return { ok: false, error: "Only the creator can change a prompt's scope." };
    }
  }

  if (
    input?.name !== undefined &&
    typeof input.name !== "string"
  ) {
    return { ok: false, error: "A prompt needs a name." };
  }
  if (input?.body !== undefined && typeof input.body !== "string") {
    return { ok: false, error: "A prompt needs a body." };
  }
  if (input?.tags !== undefined && !Array.isArray(input.tags)) {
    return { ok: false, error: "Tags must be a list." };
  }

  const existingRows = await visibleRows(input.workspaceId, auth.userId);
  const library = createPromptLibrary(existingRows.map(toTemplate));
  const next = updatePrompt(library, row.id, {
    name: input?.name,
    body: input?.body,
    scope,
    tags: input?.tags,
  });
  const candidate = next.prompts.find((prompt) => prompt.id === row.id);
  if (!candidate) return { ok: false, error: NOT_FOUND };

  const tagProblem = tagIssue(candidate.tags ?? []);
  if (tagProblem) return { ok: false, error: tagProblem };
  const problem = firstIssue(candidate, library.prompts);
  if (problem) return { ok: false, error: problem };

  const updated = await prisma.workspacePrompt.update({
    where: { id: row.id },
    data: {
      name: candidate.name,
      body: candidate.body,
      scope: candidate.scope,
      tags: tagsValue(candidate.tags),
    },
  });

  touch();
  return { ok: true, prompt: toTemplate(updated) };
}

/** Delete a visible prompt (personal prompts only by their creator). */
export async function deletePromptAction(input: {
  workspaceId: string;
  id: string;
}): Promise<PromptDeleteResult> {
  const auth = await authorize(input?.workspaceId ?? "", true);
  if (!auth.ok) return { ok: false, error: auth.error };

  const row = await prisma.workspacePrompt.findFirst({
    where: { id: input?.id ?? "", workspaceId: input.workspaceId },
    select: { id: true, scope: true, createdById: true },
  });
  if (!row) return { ok: false, error: NOT_FOUND };
  if (!mayMutate(row, auth.userId)) return { ok: false, error: NOT_FOUND };

  await prisma.workspacePrompt.delete({ where: { id: row.id } });
  touch();
  return { ok: true };
}

/**
 * Copy a visible prompt under a fresh row. A personal source can only be
 * cloned by its creator; producing a shared clone also needs write access (the
 * whole action is write-gated, so a guest can never clone).
 */
export async function clonePromptAction(input: {
  workspaceId: string;
  id: string;
  name?: string;
  scope?: string;
}): Promise<PromptMutationResult> {
  const auth = await authorize(input?.workspaceId ?? "", true);
  if (!auth.ok) return { ok: false, error: auth.error };

  const row = await prisma.workspacePrompt.findFirst({
    where: { id: input?.id ?? "", workspaceId: input.workspaceId },
  });
  // A personal prompt that is not the caller's is reported as missing so the
  // action never confirms another member's private prompt exists.
  if (!row || !mayMutate(row, auth.userId)) return { ok: false, error: NOT_FOUND };

  let scope = readScope(input?.scope);
  if (input?.scope !== undefined && !scope) {
    return { ok: false, error: "Choose whether the prompt is personal or shared." };
  }
  scope = scope ?? (row.scope === "personal" ? "personal" : "workspace");

  if (input?.name !== undefined && typeof input.name !== "string") {
    return { ok: false, error: "A prompt needs a name." };
  }

  const existingRows = await visibleRows(input.workspaceId, auth.userId);
  const existing = existingRows.map(toTemplate);
  const source = toTemplate(row);
  const baseName =
    typeof input?.name === "string" && input.name.trim().length > 0
      ? input.name.trim()
      : source.name;
  const customName = typeof input?.name === "string" && input.name.trim().length > 0;
  const name = uniqueCloneName(baseName, scope, existing, !customName);

  const candidate = clonePrompt(source, { name, scope, newId: "draft" });
  const problem = firstIssue(candidate, existing);
  if (problem) return { ok: false, error: problem };

  const created = await prisma.workspacePrompt.create({
    data: {
      workspaceId: input.workspaceId,
      createdById: auth.userId,
      name: candidate.name,
      body: candidate.body,
      scope: candidate.scope,
      tags: tagsValue(candidate.tags),
    },
  });

  touch();
  return { ok: true, prompt: toTemplate(created) };
}
