import { prisma } from "@/lib/db";
import { slugify } from "@/lib/slug";

/**
 * True when a workspace write failed because the slug it tries to store is
 * already taken: a `P2002` on the slug index (`meta.target` name(s) it — an
 * array of fields or a single compound key string). Slug collisions are the
 * one unique violation a sign-up can recover from by regeneration — the next
 * free variant is a different value, not the same address — so callers retry
 * instead of surfacing the raw error. A `P2002` on any other field does not
 * match and is never mistaken for a slug race.
 */
export function isWorkspaceSlugConflict(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { code?: unknown }).code !== "P2002"
  ) {
    return false;
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some(
    (field) => typeof field === "string" && field.toLowerCase().includes("slug"),
  );
}

/** Ensure a globally-unique workspace slug by appending a numeric suffix. */
export async function uniqueWorkspaceSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let n = 1;
  // Bounded loop; collisions beyond this are vanishingly unlikely.
  while (n < 1000) {
    const existing = await prisma.workspace.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
  return `${base}-${Date.now().toString(36)}`;
}
