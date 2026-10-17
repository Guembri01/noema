/**
 * Scroll restore — remember where a scroll container was, keyed per surface.
 *
 * Long, scrollable surfaces (the windowed trash/search lists, panels that mount
 * and unmount as the user navigates) used to each roll their own save/restore
 * against `scrollTop`. This is the shared primitive: {@link useScrollRestore}
 * returns a `ref` that restores the saved offset when the container mounts and a
 * `save` the surface calls from its scroll handler.
 *
 * Everything is per-surface and namespaced under {@link SCROLL_RESTORE_PREFIX},
 * so two lists can never collide. The store defaults to `sessionStorage` — a
 * restored position belongs to the visit, not to a fresh reload — and every
 * storage access is guarded, so private mode / a blocked quota degrades to "no
 * restore" instead of throwing.
 *
 * The DOM-free pieces ({@link clampScrollPosition}, {@link readScrollPosition},
 * {@link writeScrollPosition}, {@link applyScrollPosition}) are exported and
 * pinned by `scroll-restore.test.ts`.
 */

import { useCallback, useRef, type RefCallback } from "react";

/** localStorage / sessionStorage, or any compatible stand-in. */
export type ScrollStorage = Pick<Storage, "getItem" | "setItem">;

/** Namespace for every stored position. */
export const SCROLL_RESTORE_PREFIX = "noema:scroll";

/** The storage key a surface's offset lives under. */
export function scrollRestoreKey(surface: string): string {
  return `${SCROLL_RESTORE_PREFIX}:${surface}`;
}

/** Coerce a value to a finite, non-negative whole px offset. */
export function clampScrollPosition(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * The saved offset for `key`, or `0` when it is absent, corrupt or the storage
 * cannot be read. A corrupt value degrades to "top" rather than throwing.
 */
export function readScrollPosition(storage: ScrollStorage | null, key: string): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw.trim() === "") return 0;
    return clampScrollPosition(Number(raw));
  } catch {
    return 0;
  }
}

/**
 * Persist an offset under `key`. Storage being unavailable (private mode,
 * quota) is a silent no-op — the session keeps its in-memory position.
 */
export function writeScrollPosition(
  storage: ScrollStorage | null,
  key: string,
  value: number,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, String(clampScrollPosition(value)));
  } catch {
    /* ignore a blocked write; the live scroll position is unaffected */
  }
}

/**
 * Apply a saved offset to a scroll container and return the value actually
 * applied. Takes the minimal `{ scrollTop }` shape, so it is testable without a
 * DOM, and a missing node applies nothing (`0`).
 */
export function applyScrollPosition(
  node: { scrollTop: number } | null,
  stored: number,
): number {
  if (!node) return 0;
  const top = clampScrollPosition(stored);
  node.scrollTop = top;
  return top;
}

/** The session store when it is reachable; `null` during SSR or when blocked. */
function defaultStorage(): ScrollStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export type ScrollRestoreOptions = {
  /**
   * Store to read/write. Defaults to `sessionStorage`; pass `null` to disable
   * persistence (the hook still exposes a stable `ref`/`save`).
   */
  storage?: ScrollStorage | null;
  /** Called with the offset after a restore, so the surface can sync its state. */
  onRestore?: (scrollTop: number) => void;
};

export type ScrollRestore = {
  /** Attach to the scroll container; the saved offset is applied on mount. */
  ref: RefCallback<HTMLElement>;
  /** Persist the current offset (call from the surface's scroll handler). */
  save: (scrollTop: number) => void;
};

/**
 * Save and restore one scroll container's position, keyed per surface.
 *
 * The returned `ref` identity is stable (it depends only on the surface and the
 * store), so React never re-runs the restore on an unrelated re-render — a
 * restored position cannot fight the user's own scrolling.
 */
export function useScrollRestore(
  surface: string,
  options: ScrollRestoreOptions = {},
): ScrollRestore {
  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  const key = scrollRestoreKey(surface);
  // Read the latest callback through a ref: `onRestore` is usually an inline
  // lambda, and tying the restore to its identity would replay it every render.
  const onRestoreRef = useRef(options.onRestore);
  onRestoreRef.current = options.onRestore;

  const ref = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      if (!node) return;
      const stored = readScrollPosition(storage, key);
      if (stored <= 0) return;
      onRestoreRef.current?.(applyScrollPosition(node, stored));
    },
    [storage, key],
  );

  const save = useCallback(
    (scrollTop: number) => {
      writeScrollPosition(storage, key, scrollTop);
    },
    [storage, key],
  );

  return { ref, save };
}
