import { isValidAssetKey } from "@/lib/storage";

/**
 * Trash purge guards (B42) — the pure rules behind `deletePageAction` and
 * `emptyTrashAction` in `src/server/actions/pages.ts`.
 *
 * The database already cascades child rows when a page row is deleted, but the
 * purge must not rely on that alone: it needs the subtree explicitly (to reason
 * about uploads) and it must refuse to destroy anything that is not trashed
 * inside the workspace the caller asked for.
 */

/** A page as seen by the purge guards. */
export type PurgeablePage = {
  workspaceId: string;
  deletedAt: Date | null;
} | null;

/**
 * Only trashed pages of the expected workspace may be purged.
 * Returns the error message to surface, or `null` when the purge may proceed.
 */
export function purgeableError(page: PurgeablePage, workspaceId: string): string | null {
  if (!page) return "Page not found.";
  if (page.workspaceId !== workspaceId) return "That page is not in this workspace's trash.";
  if (!page.deletedAt) return "Only pages in the trash can be deleted forever.";
  return null;
}

/**
 * Every id reachable from `seeds` by following parent → child links, in BFS
 * order. Seeds are always included even when they have no entry in `nodes`,
 * and cycles terminate instead of hanging (a page can never be its own
 * ancestor in a healthy tree, but the purge must not trust that).
 */
export function subtreeClosure(
  nodes: ReadonlyArray<{ id: string; parentId: string | null }>,
  seeds: ReadonlyArray<string>,
): string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }

  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const child of children.get(id) ?? []) queue.push(child);
  }
  return order;
}

const FILE_URL = /\/api\/files\/[A-Za-z0-9_./-]+/g;

/**
 * Every `/api/files/...` upload URL reachable from an arbitrary JSON value
 * (page content, cover url, property values), deduplicated and in first-seen
 * order. Non-upload URLs (`data:`, absolute foreign hosts) are ignored.
 */
export function collectFileUrls(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(FILE_URL)) {
        const url = match[0].replace(/[./]+$/, "");
        if (url && !found.includes(url)) found.push(url);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return found;
}

/**
 * Map a `/api/files/<workspace>/<name>` route onto its storage key, refusing
 * traversal and anything that is not a well-formed asset key.
 */
export function fileKeyFromUrl(url: string): string | null {
  const match = /^\/api\/files\/(.+)$/.exec(url);
  if (!match) return null;
  const key = match[1];
  return isValidAssetKey(key) ? key : null;
}

/**
 * Upload URLs referenced by the purged pages but by nothing that survives —
 * the only ones a purge may delete from storage. Anything still referenced by
 * a remaining page (shared embed) stays untouched.
 */
export function staleFileUrls(purged: unknown, kept: unknown): string[] {
  const survivors = new Set(collectFileUrls(kept));
  const stale: string[] = [];
  for (const url of collectFileUrls(purged)) {
    if (survivors.has(url) || stale.includes(url)) continue;
    stale.push(url);
  }
  return stale;
}
