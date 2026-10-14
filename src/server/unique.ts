import { prisma } from "@/lib/db";
import { slugify } from "@/lib/slug";

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
