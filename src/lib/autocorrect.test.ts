import { describe, expect, it } from "vitest";
import {
  AUTOCORRECT_WORD_COUNT,
  autocorrectWord,
  isAutocorrectTrigger,
} from "./autocorrect";

describe("autocorrectWord", () => {
  it("rewrites only known, complete words", () => {
    expect(autocorrectWord("teh")).toBe("the");
    expect(autocorrectWord("recieve")).toBe("receive");
    expect(autocorrectWord("dont")).toBe("don't");
    expect(autocorrectWord("alot")).toBe("a lot");
  });

  it("preserves title case and all caps", () => {
    expect(autocorrectWord("Teh")).toBe("The");
    expect(autocorrectWord("TEH")).toBe("THE");
    expect(autocorrectWord("Recieve")).toBe("Receive");
  });

  it("leaves correct, unknown, short and non-word input alone", () => {
    expect(autocorrectWord("the")).toBeNull();
    expect(autocorrectWord("noema")).toBeNull();
    expect(autocorrectWord("a")).toBeNull();
    expect(autocorrectWord("teh1")).toBeNull();
    expect(autocorrectWord("")).toBeNull();
  });

  it("exposes a deliberately small dictionary", () => {
    expect(AUTOCORRECT_WORD_COUNT).toBeGreaterThan(20);
    expect(AUTOCORRECT_WORD_COUNT).toBeLessThan(100);
  });
});

describe("isAutocorrectTrigger", () => {
  it("accepts the word-ending keys", () => {
    for (const key of [" ", ".", ",", "!", "?", ";", ":"]) {
      expect(isAutocorrectTrigger(key)).toBe(true);
    }
  });

  it("rejects letters and multi-character input", () => {
    expect(isAutocorrectTrigger("a")).toBe(false);
    expect(isAutocorrectTrigger("  ")).toBe(false);
    expect(isAutocorrectTrigger("")).toBe(false);
  });
});
