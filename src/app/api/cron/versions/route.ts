import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  pruneVersions,
  type RetentionConfig,
  type RetentionRow,
} from "@/lib/version-history";
import { rateLimit } from "@/lib/api-guard";
import { guardOpsSecret } from "@/lib/ops-guard";

export const runtime = "nodejs";

/** A policy row plus the page it belongs to — the isolation unit for failures. */
type VersionRow = RetentionRow & { pageId: string };

/**
 * R30.7 retention tier boundaries are deployment configurators, not code
 * constants (matrix `:446` "configurable"), so each env knob is read through
 * the same guard: unset, blank or non-positive input yields `undefined` and
 * `pruneVersions` falls back to its own `DEFAULT_RETENTION`. `NaN` must never
 * reach the policy — `NaN` would slip past `config.x ?? default` and silently
 * collapse every age comparison (all rows falling into the weekly tier).
 */
function envCount(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** `VERSION_RETENTION_FULL_D` / `_MED_D` / `_MAX_ROWS` (spec §5 env knobs). */
function retentionConfig(): RetentionConfig {
  return {
    fullFidelityDays: envCount("VERSION_RETENTION_FULL_D"),
    dailyWindowDays: envCount("VERSION_RETENTION_MED_D"),
    maxRows: envCount("VERSION_RETENTION_MAX_ROWS"),
  };
}

/**
 * Version-retention cron (R30.13 prune phase): point a scheduler (cron, Vercel
 * Cron, GitHub Actions, Task Scheduler) at this endpoint. Protect it by setting
 * CRON_SECRET and sending `x-cron-secret: <value>` — same fail-closed guard as
 * `api/cron/templates`. Its only write is the retention delete, so a
 * misconfigured secret is still a hard error rather than an open endpoint.
 *
 * Each page's whole version set is handed to the pure `pruneVersions` policy
 * (the newest row and every labelled row are structural keepers), and only the
 * ids the policy returns are deleted. The full set — not just the pre-window
 * slice — is loaded because the `maxRows` cap ranks unlabelled rows
 * newest-first across the page, so a pre-filtered input would hand back cap
 * headroom the policy never intends.
 *
 * D3-style isolation: one page is one unit of work. A failed `deleteMany` is
 * reported as `{ id: <pageId>, error }` in `failed[]` (the ids stay in the
 * database, so the next tick retries) and never blocks the pages after it.
 *
 * Response mapping: `due` = version rows evaluated for retention, `pruned` =
 * rows deleted (the `deleteMany` count), `failed` = isolated page failures.
 */
export async function GET(request: Request) {
  // The shared gate: fail closed without a secret, throttle before the
  // comparison (a wrong secret is bounded, not an unbounded guessing oracle),
  // and compare the secret in constant time.
  const gate = guardOpsSecret(request, {
    secret: process.env.CRON_SECRET,
    limit: () => rateLimit(request, "cron", 12, 60_000),
  });
  if (!gate.ok) return gate.response;

  const now = new Date();
  const config = retentionConfig();

  // `label` and `createdAt` are the policy's only inputs; `pageId` groups the
  // independent units. Ordered by page so the in-memory grouping is stable.
  const rows: VersionRow[] = await prisma.pageVersion.findMany({
    select: { id: true, pageId: true, createdAt: true, label: true },
    orderBy: [{ pageId: "asc" }, { createdAt: "desc" }],
  });

  const byPage = new Map<string, VersionRow[]>();
  for (const row of rows) {
    const versions = byPage.get(row.pageId);
    if (versions) versions.push(row);
    else byPage.set(row.pageId, [row]);
  }

  let pruned = 0;
  const failed: { id: string; error: string }[] = [];

  for (const [pageId, versions] of byPage) {
    // One page's failure is reported, not thrown — the sweep continues.
    try {
      const { prunedIds } = pruneVersions(versions, now, config);
      if (prunedIds.length === 0) continue;
      const { count } = await prisma.pageVersion.deleteMany({
        where: { id: { in: prunedIds } },
      });
      pruned += count;
    } catch (error) {
      failed.push({
        id: pageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (pruned > 0 || failed.length > 0) {
    console.info(
      `[cron/versions] evaluated ${rows.length} versions across ${byPage.size} pages: pruned ${pruned}, failed ${failed.length}`,
    );
  }

  return NextResponse.json({ due: rows.length, pruned, failed });
}
