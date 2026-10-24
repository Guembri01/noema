import { describe, expect, it } from "vitest";
import {
  DRAFT_MAX_AGE_MS,
  clearDraft,
  draftKey,
  readDraft,
  writeDraft,
  type DraftStorage,
} from "./draft-store";

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

describe("draft-store", () => {
  it("round-trips a draft and clears it", () => {
    const storage = memory();
    writeDraft(storage, "page-1", '{"type":"doc"}', 1000);
    expect(readDraft(storage, "page-1", 2000)).toEqual({
      payload: '{"type":"doc"}',
      savedAt: 1000,
    });
    clearDraft(storage, "page-1");
    expect(readDraft(storage, "page-1", 2000)).toBeNull();
  });

  it("discards malformed and stale drafts", () => {
    const storage = memory();
    storage.setItem(draftKey("bad"), "not json");
    expect(readDraft(storage, "bad")).toBeNull();

    writeDraft(storage, "old", "payload", 1000);
    expect(readDraft(storage, "old", 1000 + DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(storage.getItem(draftKey("old"))).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDraft(broken, "p")).toBeNull();
    expect(() => writeDraft(broken, "p", "{}")).not.toThrow();
    expect(() => clearDraft(broken, "p")).not.toThrow();
  });
});
