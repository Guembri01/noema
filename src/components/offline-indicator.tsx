"use client";

/**
 * Offline indicator (§17 Offline cache) — the always-available badge that makes
 * the mounted offline engine visible: whether the tab is online, how many edits
 * are still waiting to sync, how stale the last sync is, and — the point of the
 * whole conflict path — any merge conflicts with their provenance, resolvable in
 * place.
 *
 * It reads the {@link useOffline} handle from `offline-provider.tsx`, so it
 * renders nothing when the shell is online with a clear queue: the sidebar of a
 * calm app stays calm. The formatting helpers are pure and DOM-free so
 * `offline-indicator.test.ts` can pin the copy and the conflict summaries in the
 * Node sandbox.
 */

import { useOffline } from "@/components/providers/offline-provider";
import { Button } from "@/components/ui/button";
import { describeConflict, type MergeConflict } from "@/lib/sync-conflict";

/**
 * The pending-queue copy, or `null` when nothing is waiting. Kept pure so the
 * pluralisation is unit-testable without rendering React.
 */
export function offlineLabel(pending: number): string | null {
  if (!Number.isFinite(pending) || pending <= 0) return null;
  return pending === 1 ? "1 change waiting to sync" : `${Math.floor(pending)} changes waiting to sync`;
}

/**
 * A coarse, deterministic "synced N ago" line. Takes `now` explicitly so a test
 * can pin it (the component passes `Date.now()`); a null stamp is "Never synced".
 */
export function stalenessLabel(lastSyncedAt: number | null, now: number): string {
  if (lastSyncedAt === null || !Number.isFinite(lastSyncedAt)) return "Never synced";
  const ageMs = Math.max(0, now - lastSyncedAt);
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `Synced ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Synced ${hours}h ago`;
}

/** One provenance line per conflict, via `sync-conflict.describeConflict`. */
export function summarizeConflicts(conflicts: readonly MergeConflict[]): string[] {
  return conflicts.map((conflict) => describeConflict(conflict));
}

export function OfflineIndicator() {
  const { online, pending, conflicts, lastSyncedAt, flush, resolve } = useOffline();

  const visible = !online || pending > 0 || conflicts.length > 0;
  if (!visible) return null;

  const pendingText = offlineLabel(pending);

  return (
    <aside
      aria-label="Sync status"
      data-testid="offline-indicator"
      className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-bg p-3 text-sm shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{online ? "Online" : "Offline"}</span>
        <span className="text-xs text-muted">{stalenessLabel(lastSyncedAt, Date.now())}</span>
      </div>

      {pendingText ? <p className="mt-1">{pendingText}</p> : null}

      {pending > 0 ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void flush();
          }}
        >
          Sync now
        </Button>
      ) : null}

      {conflicts.length > 0 ? (
        <ul className="mt-2 space-y-2" aria-label="Unresolved conflicts">
          {conflicts.map((conflict) => (
            <li
              key={conflict.field}
              className="rounded border border-border bg-surface-2 p-2"
            >
              <p className="text-xs">{describeConflict(conflict)}</p>
              <div className="mt-1 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => resolve(conflict.field, "before")}>
                  Keep overwritten
                </Button>
                <Button size="sm" variant="ghost" onClick={() => resolve(conflict.field, "after")}>
                  Keep current
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
