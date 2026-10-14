
import { describe, expect, it } from "vitest";
import { stripLoneSurrogates } from "./utils";

describe("stripLoneSurrogates", () => {
  it("keeps valid emoji and text untouched", () => {
    expect(stripLoneSurrogates("Ship it \u{1F680} today")).toBe("Ship it \u{1F680} today");
  });

  it("drops a lone high surrogate (what broke Postgres with 22P05)", () => {
    expect(stripLoneSurrogates("note \uD83D end")).toBe("note  end");
  });

  it("drops a lone low surrogate", () => {
    expect(stripLoneSurrogates("a\uDE00b")).toBe("ab");
  });

  it("keeps both halves of a pair", () => {
    expect(stripLoneSurrogates("\uD83D\uDE00")).toBe("\u{1F600}");
  });

  it("leaves plain ASCII alone", () => {
    expect(stripLoneSurrogates("plain text")).toBe("plain text");
  });
});
