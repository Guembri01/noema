import { describe, expect, it } from "vitest";
import { pickVersionAuthor, restoreVersionSummary } from "./version-history";

/**
 * B67 - pure version-history helpers (docs/specs/version-history-v2.md M1).
 *
 * Red-first: this file was written BEFORE `src/lib/version-history.ts` existed
 * (module-not-found), and after the fix the summary case still failed against
 * the old inline expression `new Date(version.id ? Date.now() : 0)` - i.e. it
 * always rendered *today*, never the restored version's date.
 *
 * Covers: R30.5 (summary cites `version.createdAt`), R30.11-lite (one
 * membership-independent author resolver shared by both history surfaces).
 */
describe("restoreVersionSummary (R30.5)", () => {
  it("cites the restored version's own date, not today", () => {
    const createdAt = new Date("2020-05-04T10:30:00.000Z");
    const summary = restoreVersionSummary(createdAt);
    expect(summary).toBe(`Restored the version from ${createdAt.toLocaleDateString()}`);
    // 2020-05-04 can never equal the day this test runs.
    expect(summary).not.toContain(new Date().toLocaleDateString());
    expect(summary).toContain("Restored the version from");
  });
});

describe("pickVersionAuthor (R30.11 lite)", () => {
  const users = [
    { id: "u1", name: "Ada Lovelace", email: "ada@example.test" },
    { id: "u2", name: "Grace Hopper", email: "grace@example.test" },
  ];

  it("resolves an author from the User row by id alone (membership is irrelevant)", () => {
    expect(pickVersionAuthor("u2", users)).toEqual(users[1]);
    expect(pickVersionAuthor("u1", users)).toEqual(users[0]);
  });

  it("returns null for a deleted/unknown author - the surface renders its label", () => {
    expect(pickVersionAuthor("deleted-user", users)).toBeNull();
  });

  it("returns null for versions that carry no author id", () => {
    expect(pickVersionAuthor(null, users)).toBeNull();
    expect(pickVersionAuthor(undefined, users)).toBeNull();
    expect(pickVersionAuthor("", users)).toBeNull();
  });
});
