"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { canEditSchema, type LockRole } from "@/lib/database-lock";
import { pageSearchText } from "@/lib/search";
import {
  contentHashOf,
  createSnapshot,
  dedupeSnapshots,
  restoreFromSnapshot,
  type PageSnapshot,
  type PageSnapshotBlock,
} from "@/lib/page-snapshots";

/**
 * Page-snapshot action layer (§17 "Page snapshots" / "Restore from backup"):
 * the reachable surface over the pure `src/lib/page-snapshots.ts` engine.
 *
 * Snapshots are persisted as `PageVersion` rows — the existing version store —
 * because `Page.content` is a ProseMirror document whose **top-level nodes
 * carry stable ids** (the editor's block-ids extension mints them). That lets
 * the engine's block model round-trip losslessly without a new table:
 *
 *   • `createPageSnapshotAction`  — capture the page through `createSnapshot`
 *     (its title + top-level blocks, hash included) and persist the doc as a
 *     version row; an unnamed snapshot whose hash equals the newest row is
 *     deduped (`dedupeSnapshots`' no-op rule) instead of piling up a row.
 *   • `listPageSnapshotsAction`   — recent rows decoded back to `PageSnapshot`
 *     records and collapsed through `dedupeSnapshots` (consecutive equal
 *     hashes → the newest record).
 *   • `planPageSnapshotRestoreAction` — the read-only plan: `restoreFromSnapshot`
 *     over the page's current blocks (added / removed / changed / preserved ids).
 *   • `restorePageSnapshotAction` — apply that plan: push the current state
 *     onto history and write the restored document in one transaction, exactly
 *     like the version-restore path.
 *
 * A dedicated `PageSnapshot` Prisma model (with a denormalised `contentHash`)
 * is the reported follow-up; it would let the list avoid decoding documents
 * without changing any signature here.
 */

/** Result envelope matching the other content actions. */
export type SnapshotResult<T> = ({ ok: true } & T) | { error: string };

/** A `PageVersion` row as the snapshot engine reads it. */
type SnapshotRow = {
  id: string;
  pageId: string;
  title: string;
  content: unknown;
  createdAt: Date;
  label: string | null;
  createdById: string | null;
};

const SNAPSHOT_SELECT = {
  id: true,
  pageId: true,
  title: true,
  content: true,
  createdAt: true,
  label: true,
  createdById: true,
} as const;

/** Owner override for the content lock — same policy as the version-restore path. */
function lockRoleFor(role: WorkspaceRole): LockRole {
  return {
    isOwner: role === "OWNER",
    isMember: role === "ADMIN" || role === "MEMBER",
  };
}

/**
 * The engine's block list for a stored document: one block per top-level node,
 * keyed by the node's persisted `attrs.id` (the editor guarantees one) and
 * falling back to a positional id for legacy/imported id-less nodes. The whole
 * node JSON is preserved under `node`, so a restore is lossless.
 */
function blocksFromDoc(doc: unknown): PageSnapshotBlock[] {
  if (doc === null || typeof doc !== "object") return [];
  const content = (doc as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const blocks: PageSnapshotBlock[] = [];
  content.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    const node = raw as Record<string, unknown>;
    const attrs = node.attrs;
    const id =
      attrs !== null && typeof attrs === "object" && !Array.isArray(attrs) &&
      typeof (attrs as Record<string, unknown>).id === "string" &&
      ((attrs as Record<string, unknown>).id as string).trim() !== ""
        ? ((attrs as Record<string, unknown>).id as string)
        : `auto-${index}`;
    blocks.push({ id, node });
  });
  return blocks;
}

/** Rebuild a ProseMirror document from engine blocks, re-stamping each node's `id`. */
function docFromBlocks(blocks: readonly PageSnapshotBlock[]): unknown {
  const content = blocks.map((block) => {
    const raw = block.node;
    const node: Record<string, unknown> =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : { type: "paragraph" };
    const attrs = node.attrs;
    node.attrs = {
      ...(attrs !== null && typeof attrs === "object" && !Array.isArray(attrs)
        ? (attrs as Record<string, unknown>)
        : {}),
      id: block.id,
    };
    return node;
  });
  return { type: "doc", content };
}

/** Decode a stored version row back into the engine's `PageSnapshot` shape. */
function snapshotFromRow(row: SnapshotRow): PageSnapshot {
  const blocks = blocksFromDoc(row.content);
  const title = typeof row.title === "string" ? row.title : null;
  return {
    id: row.id,
    pageId: row.pageId,
    takenAt: row.createdAt.toISOString(),
    contentHash: contentHashOf({ title, blocks }),
    blocks,
    meta: {
      actorId: row.createdById ?? "",
      label: row.label,
      title,
    },
  };
}

/**
 * Snapshot a page's current state. Unnamed captures are deduped against the
 * newest row (equal content hash ⇒ no write); named captures always persist as
 * an explicit bookmark. The stored document is the page's own doc, so the row
 * stays a valid version even if restored through the version surface.
 */
export async function createPageSnapshotAction(
  pageId: string,
  options: { label?: string | null } = {},
): Promise<SnapshotResult<{ id: string; contentHash: string; deduped: boolean }>> {
  if (typeof pageId !== "string" || pageId.trim() === "") {
    return { error: "A page id is required." };
  }
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, title: true, content: true, workspaceId: true, locked: true },
  });
  if (!page) return { error: "Page not found." };

  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to snapshot this page." };
  }
  if (!canEditSchema({ locked: Boolean(page.locked) }, lockRoleFor(access.role))) {
    return { error: "This page is locked. Unlock it to snapshot it." };
  }

  let snapshot: PageSnapshot;
  try {
    snapshot = createSnapshot(
      { id: page.id, title: page.title, blocks: blocksFromDoc(page.content) },
      { actorId: user.id, label: options.label ?? null },
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (snapshot.meta.label === null) {
    const newest = await prisma.pageVersion.findFirst({
      where: { pageId },
      orderBy: { createdAt: "desc" },
      select: SNAPSHOT_SELECT,
    });
    if (newest) {
      const latest = snapshotFromRow(newest);
      if (latest.contentHash === snapshot.contentHash) {
        return { ok: true, id: latest.id, contentHash: latest.contentHash, deduped: true };
      }
    }
  }

  const row = await prisma.pageVersion.create({
    data: {
      pageId,
      title: page.title,
      content: page.content === null ? Prisma.DbNull : (page.content as Prisma.InputJsonValue),
      createdById: user.id,
      label: snapshot.meta.label,
      summary:
        snapshot.meta.label === null
          ? `Snapshot taken ${snapshot.takenAt}`
          : `Named snapshot “${snapshot.meta.label}”`,
    },
    select: { id: true },
  });

  revalidatePath("/w", "layout");
  return { ok: true, id: row.id, contentHash: snapshot.contentHash, deduped: false };
}

/** Recent snapshots for a page, consecutive equal hashes collapsed to their newest. */
export async function listPageSnapshotsAction(
  pageId: string,
  options: { limit?: number } = {},
): Promise<SnapshotResult<{ snapshots: PageSnapshot[] }>> {
  if (typeof pageId !== "string" || pageId.trim() === "") {
    return { error: "A page id is required." };
  }
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "You do not have access to this page." };

  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 100)
      : 25;
  const rows = await prisma.pageVersion.findMany({
    where: { pageId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: SNAPSHOT_SELECT,
  });

  return { ok: true, snapshots: dedupeSnapshots(rows.map(snapshotFromRow)) };
}

/** The read-only restore plan: what writing `snapshotId` back would change. */
export async function planPageSnapshotRestoreAction(
  snapshotId: string,
): Promise<
  SnapshotResult<{
    pageId: string;
    snapshotId: string;
    title: string | null;
    added: string[];
    removed: string[];
    changed: string[];
    preserved: [string, string][];
  }>
> {
  if (typeof snapshotId !== "string" || snapshotId.trim() === "") {
    return { error: "A snapshot id is required." };
  }
  const row = await prisma.pageVersion.findUnique({
    where: { id: snapshotId },
    select: {
      ...SNAPSHOT_SELECT,
      page: { select: { workspaceId: true, content: true } },
    },
  });
  if (!row) return { error: "Snapshot not found." };

  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, row.page.workspaceId);
  if (!access) return { error: "You do not have access to this page." };

  const snapshot = snapshotFromRow(row);
  const patch = restoreFromSnapshot(snapshot, {
    current: blocksFromDoc(row.page.content),
  });
  return {
    ok: true,
    pageId: row.pageId,
    snapshotId: row.id,
    title: patch.title,
    added: patch.added,
    removed: patch.removed,
    changed: patch.changed,
    preserved: [...patch.preserved.entries()],
  };
}

/**
 * Restore a snapshot onto its page. The current state is pushed onto history
 * first (so the restore is itself undoable) and the page write — title, doc,
 * search mirror — commits in the same transaction as that pre-restore row.
 */
export async function restorePageSnapshotAction(
  snapshotId: string,
): Promise<
  SnapshotResult<{
    pageId: string;
    snapshotId: string;
    restored: number;
    added: number;
    removed: number;
    changed: number;
  }>
> {
  if (typeof snapshotId !== "string" || snapshotId.trim() === "") {
    return { error: "A snapshot id is required." };
  }
  const row = await prisma.pageVersion.findUnique({
    where: { id: snapshotId },
    select: {
      ...SNAPSHOT_SELECT,
      page: { select: { workspaceId: true, title: true, content: true, locked: true } },
    },
  });
  if (!row) return { error: "Snapshot not found." };

  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, row.page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to restore this page." };
  }
  if (!canEditSchema({ locked: Boolean(row.page.locked) }, lockRoleFor(access.role))) {
    return { error: "This page is locked. Unlock it to restore a snapshot." };
  }

  const snapshot = snapshotFromRow(row);
  const patch = restoreFromSnapshot(snapshot, {
    current: blocksFromDoc(row.page.content),
  });
  const restoredDoc = docFromBlocks(patch.blocks);
  const title = (patch.title ?? row.page.title).slice(0, 500);

  await prisma.$transaction([
    prisma.pageVersion.create({
      data: {
        pageId: row.pageId,
        title: row.page.title,
        content:
          row.page.content === null
            ? Prisma.DbNull
            : (row.page.content as Prisma.InputJsonValue),
        createdById: user.id,
        summary: "Snapshot before restore",
      },
    }),
    prisma.page.update({
      where: { id: row.pageId },
      data: {
        title,
        content: restoredDoc === null ? Prisma.DbNull : (restoredDoc as Prisma.InputJsonValue),
        searchText: pageSearchText(title, restoredDoc),
      },
    }),
  ]);

  revalidatePath("/w", "layout");
  return {
    ok: true,
    pageId: row.pageId,
    snapshotId: row.id,
    restored: patch.blocks.length,
    added: patch.added.length,
    removed: patch.removed.length,
    changed: patch.changed.length,
  };
}
