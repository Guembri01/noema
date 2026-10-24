/** Client-side unsaved-editor draft recovery. Pure over a storage adapter. */

export const DRAFT_VERSION = 1;
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type RecoverableDraft = { payload: string; savedAt: number };

export function draftKey(pageId: string): string {
  return `noema:draft:${pageId}`;
}

/** Read a valid, recent draft; malformed/stale data is discarded. */
export function readDraft(
  storage: DraftStorage,
  pageId: string,
  now = Date.now(),
): RecoverableDraft | null {
  try {
    const raw = storage.getItem(draftKey(pageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      payload?: unknown;
      savedAt?: unknown;
    };
    if (
      parsed.version !== DRAFT_VERSION ||
      typeof parsed.payload !== "string" ||
      typeof parsed.savedAt !== "number" ||
      now - parsed.savedAt > DRAFT_MAX_AGE_MS
    ) {
      storage.removeItem(draftKey(pageId));
      return null;
    }
    return { payload: parsed.payload, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function writeDraft(
  storage: DraftStorage,
  pageId: string,
  payload: string,
  now = Date.now(),
): void {
  try {
    storage.setItem(
      draftKey(pageId),
      JSON.stringify({ version: DRAFT_VERSION, payload, savedAt: now }),
    );
  } catch {
    // Quota/private mode: the server autosave remains the source of truth.
  }
}

export function clearDraft(storage: DraftStorage, pageId: string): void {
  try {
    storage.removeItem(draftKey(pageId));
  } catch {
    // Nothing to do.
  }
}
