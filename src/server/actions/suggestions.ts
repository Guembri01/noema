"use server";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import type { Block } from "@/lib/suggestions";

/** Max blocks a persisted session can carry; a page is bounded in practice. */
const SUGGESTION_BASE_LIMIT = 2000;

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

/**
 * Validate an untrusted base snapshot. Suggestions are block-level
 * `{ id, type?, text? }` values, so every entry is checked and bounded; the
 * caller gets `null` instead of an exception or a partially valid list.
 */
function normalizeSuggestionBase(value: unknown): Block[] | null {
  if (!Array.isArray(value) || value.length > SUGGESTION_BASE_LIMIT) return null;
  const out: Block[] = [];
  let characters = 0;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id === "" || id.length > 120) return null;
    const type =
      typeof record.type === "string" && record.type.trim() !== ""
        ? record.type.trim().slice(0, 64)
        : undefined;
    const text =
      typeof record.text === "string" ? record.text.slice(0, 10_000) : undefined;
    characters += id.length + (type?.length ?? 0) + (text?.length ?? 0);
    if (characters > 2_000_000) return null;
    out.push({ id, ...(type ? { type } : {}), ...(text !== undefined ? { text } : {}) });
  }
  return out;
}

async function authorizePage(
  pageId: string,
  needEdit: boolean,
): Promise<{ user: { id: string }; page: { workspaceId: string } } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      workspaceId: true,
      deletedAt: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page || page.deletedAt) return { error: "Page not found." } as const;
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "Page not found." } as const;
  const capabilities = pageCapabilitiesFromRelation(access.role, page.permissions);
  if (!capabilities.read) return { error: "Page not found." } as const;
  if (needEdit && !capabilities.edit) return { error: "No permission." } as const;
  return { user, page };
}

/**
 * Load the page's in-progress Suggestions session. The base is the committed
 * block snapshot; the pending list is recomputed by the editor against the
 * current document.
 */
export async function loadSuggestionSessionAction(
  pageId: string,
): Promise<
  Result<{ active: boolean; base: Block[] | null; authorId: string | null }>
> {
  const auth = await authorizePage(pageId, false);
  if ("error" in auth) return auth;
  const session = await prisma.pageSuggestionSession.findUnique({
    where: { pageId },
    select: { base: true },
  });
  const base = normalizeSuggestionBase(session?.base);
  if (!session || !base) {
    return { ok: true, active: false, base: null, authorId: null };
  }
  return {
    ok: true,
    active: true,
    base,
    authorId: null,
  };
}

/**
 * Persist or clear the page's Suggestions session. `active: false` removes the
 * row (the on-screen edits stay). An active session stores the base snapshot and
 * the last writer as its author.
 */
export async function saveSuggestionSessionAction(
  pageId: string,
  input: { active: boolean; base?: unknown },
): Promise<Result> {
  const auth = await authorizePage(pageId, true);
  if ("error" in auth) return auth;

  if (!input.active) {
    await prisma.pageSuggestionSession.deleteMany({ where: { pageId } });
    return { ok: true };
  }

  const base = normalizeSuggestionBase(input.base);
  if (!base) return { error: "Invalid suggestion snapshot." };

  await prisma.pageSuggestionSession.upsert({
    where: { pageId },
    create: { pageId, base },
    update: { base },
  });
  return { ok: true };
}
