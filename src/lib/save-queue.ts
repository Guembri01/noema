/**
 * Serialized autosave controller.
 *
 * Pure over injected refs and observers so the editor's save machinery can be
 * unit-tested without mounting TipTap (`src/lib/save-queue.test.ts`). The
 * editor wires the queue in `page-editor.tsx`'s `runSave`.
 *
 * The queue enforces two invariants the previous `runSave` pattern violated:
 *
 * 1. Single-flight — at most one write is on the wire. A second `runSaveQueue`
 *    call while a save is running declines immediately; the running loop drains
 *    any newer pending payload as it lands, so writes reach the server in the
 *    order they were made and an older response can never commit over a newer
 *    one. The drain terminates: every iteration either stops (nothing pending,
 *    already acked, offline-buffered, or failed) or awaits one network write
 *    for a payload distinct from the watermark, which the ack then advances —
 *    so identical payloads are never re-sent, and every extra round tracks a
 *    real edit that arrived during the previous request.
 *
 * 2. Payload-equal retirement — a resolved save only retires the pending
 *    payload it saved (`clearIfPayload`). A payload persisted by another edit
 *    while the request was in flight survives the resolve, and the caller can
 *    therefore also tell whether its crash-recovery draft still matters.
 */

export type SaveQueueRef<T> = { current: T };

export type SaveQueueDeps = {
  /** Latest document payload not yet acknowledged by the server. */
  pendingRef: SaveQueueRef<string | null>;
  /** Payload the server last acknowledged. */
  lastSavedRef: SaveQueueRef<string>;
  /** Single-flight lock shared by every writer that must not overlap. */
  inFlightRef: SaveQueueRef<boolean>;
  /**
   * Resolve the payload to attempt next, or `null` when nothing can be sent.
   * Implementations must read the pending ref BEFORE falling back to the
   * document snapshot so a destroyed editor cannot swallow a captured payload.
   * When `pendingOnly` is set, only the pending ref may be consulted — this is
   * the safety net that keeps rounds after the first from reaching into the
   * (possibly destroyed) editor and looping on live content.
   */
  resolvePayload: (pendingOnly: boolean) => string | null;
  /**
   * Capture `payload` without network (offline collaboration buffer). Return
   * `true` when the payload was buffered and the attempt is complete; the
   * pending payload is left for the replay path to retire.
   */
  bufferOffline: (payload: string) => boolean;
  /** Perform the network write. Resolve with the server error, or `null`. */
  send: (payload: string) => Promise<string | null>;
  /** The write for `payload` succeeded; refs are already committed. */
  onSaved: (payload: string) => void;
  /** Nothing new to save: the resolved payload was already acknowledged. */
  onAlreadySaved: (payload: string) => void;
  /** The write failed; the pending payload is kept for a retry. */
  onError: (error: string) => void;
};

/**
 * Retire a pending payload after a save it agrees with. When another edit
 * replaced the payload while the request was in flight, the newer one stays
 * pending; `null` inputs resolve to `null` (nothing was ever pending).
 */
export function clearIfPayload(
  current: string | null,
  saved: string,
): string | null {
  return current === saved ? null : current;
}

/**
 * Drive the serialized save loop for one queue invocation. Declines when a
 * save (or offline replay sharing the same lock) is already in flight.
 */
export async function runSaveQueue(deps: SaveQueueDeps): Promise<void> {
  const { pendingRef, lastSavedRef, inFlightRef } = deps;
  if (inFlightRef.current) return;
  inFlightRef.current = true;
  try {
    for (let round = 0; ; round += 1) {
      const payload = deps.resolvePayload(round > 0);
      if (payload === null) break;
      if (payload === lastSavedRef.current) {
        // Already acked by the server: retire the pending payload only when
        // the ref still holds exactly what was inspected, never a newer edit.
        pendingRef.current = clearIfPayload(pendingRef.current, payload);
        deps.onAlreadySaved(payload);
        break;
      }
      if (deps.bufferOffline(payload)) break;
      const error = await deps.send(payload);
      if (error !== null) {
        // Keep the pending payload so the retry path (toast button, next
        // debounce, teardown flush) can send it again.
        deps.onError(error);
        break;
      }
      // Serialization guarantees writes left in the order they were launched,
      // so this stamp never lets an older payload overwrite a newer ack.
      pendingRef.current = clearIfPayload(pendingRef.current, payload);
      lastSavedRef.current = payload;
      deps.onSaved(payload);
    }
  } finally {
    inFlightRef.current = false;
  }
}
