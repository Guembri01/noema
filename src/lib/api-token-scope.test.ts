import { describe, expect, it } from "vitest";
import {
  API_SCOPES,
  API_SCOPE_IDS,
  describeScope,
  describeScopes,
  expandScopes,
  hasScope,
  impliedScopes,
  intersectScopes,
  isKnownScope,
  validateScopes,
} from "./api-token-scope";
import type { ApiScope } from "./api-token-scope";

/**
 * API token scopes — the permission vocabulary an API token carries.
 *
 * Red-first: `src/lib/api-token-scope.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 * This is the pure catalogue half: a fixed scope list with a `write:*` ⇒
 * `read:*` hierarchy (and `admin:workspace` at the top), an `expandScopes`
 * closure, `hasScope` checks, `validateScopes` diagnostics, an
 * `intersectScopes` reduction, and human `describeScopes` labels. No DB,
 * routes, React or clock.
 */

const ids = API_SCOPES.map((scope) => scope.id);

describe("API_SCOPES catalog", () => {
  it("exposes a non-empty catalogue with unique ids", () => {
    expect(API_SCOPES.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the read/write pairs and the workspace admin scope", () => {
    expect(ids).toEqual(
      expect.arrayContaining(["read:pages", "write:pages", "read:databases", "admin:workspace"]),
    );
  });

  it("keeps API_SCOPE_IDS in catalogue order", () => {
    expect([...API_SCOPE_IDS]).toEqual(ids);
  });

  it("only points its implied edges at real catalog scopes", () => {
    const known = new Set(ids);
    for (const scope of API_SCOPES) {
      for (const implied of scope.implies) expect(known.has(implied)).toBe(true);
    }
  });

  it("gives every scope a non-empty description", () => {
    for (const scope of API_SCOPES) expect(scope.description.trim().length).toBeGreaterThan(0);
  });

  it("puts read before write within each resource", () => {
    expect(ids.indexOf("read:pages")).toBeLessThan(ids.indexOf("write:pages"));
    expect(ids.indexOf("read:databases")).toBeLessThan(ids.indexOf("write:databases"));
  });
});

describe("isKnownScope", () => {
  it("recognises a catalogue id, ignoring case and whitespace", () => {
    expect(isKnownScope("read:pages")).toBe(true);
    expect(isKnownScope("  WRITE:Pages  ")).toBe(true);
  });

  it("rejects unknown, malformed and non-string inputs", () => {
    expect(isKnownScope("read:unicorns")).toBe(false);
    expect(isKnownScope("pages")).toBe(false);
    expect(isKnownScope("")).toBe(false);
    expect(isKnownScope(42)).toBe(false);
  });
});

describe("impliedScopes", () => {
  it("adds the read counterpart for a write scope", () => {
    expect(impliedScopes("write:pages")).toEqual(["read:pages"]);
  });

  it("returns nothing for a leaf read scope", () => {
    expect(impliedScopes("read:pages")).toEqual([]);
  });

  it("transitively closes admin:workspace over every other scope", () => {
    const implied = impliedScopes("admin:workspace");
    expect(implied).toHaveLength(API_SCOPES.length - 1);
    expect(implied).not.toContain("admin:workspace");
    expect(implied).toContain("write:pages");
    expect(implied).toContain("read:pages");
  });

  it("returns nothing for an unknown scope", () => {
    expect(impliedScopes("read:unicorns")).toEqual([]);
  });
});

describe("expandScopes", () => {
  it("adds implied scopes in catalogue order", () => {
    expect(expandScopes(["write:pages"])).toEqual(["read:pages", "write:pages"]);
  });

  it("de-duplicates and drops unknown entries", () => {
    expect(expandScopes(["read:pages", "read:pages", "bogus", "write:pages"])).toEqual([
      "read:pages",
      "write:pages",
    ]);
  });

  it("expands the workspace admin scope to the whole catalogue", () => {
    expect(expandScopes(["admin:workspace"])).toEqual(ids);
  });

  it("tolerates an empty list and a non-array input", () => {
    expect(expandScopes([])).toEqual([]);
    expect(expandScopes(undefined as unknown as string[])).toEqual([]);
  });
});

describe("hasScope", () => {
  it("grants a read scope from its write scope", () => {
    expect(hasScope(["write:pages"], "read:pages")).toBe(true);
  });

  it("does not grant write from read", () => {
    expect(hasScope(["read:pages"], "write:pages")).toBe(false);
  });

  it("grants everything from admin:workspace", () => {
    expect(hasScope(["admin:workspace"], "write:tickets")).toBe(true);
    expect(hasScope(["admin:workspace"], "read:members")).toBe(true);
  });

  it("matches case-insensitively on both sides", () => {
    expect(hasScope(["WRITE:PAGES"], "Read:Pages")).toBe(true);
  });

  it("never grants an unknown requirement", () => {
    expect(hasScope(["admin:workspace"], "read:unicorns")).toBe(false);
  });
});

describe("validateScopes", () => {
  it("accepts a known, unique catalogue list", () => {
    const result = validateScopes(["read:pages", "write:databases"]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it("flags a repeated scope once as a duplicate", () => {
    const result = validateScopes(["read:pages", "read:pages"]);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "duplicate_scope", scope: "read:pages" }]);
  });

  it("separates unknown from malformed and reports both", () => {
    const result = validateScopes(["read:pages", "read:unicorns", "pages"]);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(["unknown_scope", "malformed_scope"]);
    expect(result.unknown).toEqual(["read:unicorns", "pages"]);
  });

  it("reports a blank entry as empty", () => {
    expect(validateScopes(["read:pages", "   "]).issues).toEqual([
      { code: "empty_scope", scope: "   " },
    ]);
  });

  it("reports a non-string entry and a non-array input", () => {
    expect(validateScopes(["read:pages", 42]).issues).toEqual([
      { code: "not_a_string", scope: "42" },
    ]);
    expect(validateScopes("read:pages").ok).toBe(false);
    expect(validateScopes("read:pages").issues[0]?.code).toBe("not_a_string");
  });
});

describe("intersectScopes", () => {
  it("keeps a scope both sides effectively grant", () => {
    expect(intersectScopes(["write:pages"], ["read:pages"])).toEqual(["read:pages"]);
  });

  it("returns the shared slice in catalogue order", () => {
    expect(intersectScopes(["admin:workspace"], ["write:tickets"])).toEqual([
      "read:tickets",
      "write:tickets",
    ]);
  });

  it("returns an empty list for disjoint or empty grants", () => {
    expect(intersectScopes(["read:pages"], ["read:databases"])).toEqual([]);
    expect(intersectScopes([], ["write:pages"])).toEqual([]);
  });
});

describe("describeScopes", () => {
  it("labels a scope by its catalogue description", () => {
    const scope: ApiScope | undefined = API_SCOPES.find((entry) => entry.id === "read:pages");
    expect(scope).toBeDefined();
    expect(describeScope("read:pages")).toBe(scope?.description);
  });

  it("returns undefined for an unknown scope", () => {
    expect(describeScope("read:unicorns")).toBeUndefined();
  });

  it("joins the expanded descriptions with commas", () => {
    const described = describeScopes(["write:pages"]);
    expect(described).toContain(describeScope("read:pages") ?? "MISSING");
    expect(described).toContain(describeScope("write:pages") ?? "MISSING");
    expect(described).toBe(
      [describeScope("read:pages"), describeScope("write:pages")].join(", "),
    );
  });

  it("renders an empty string when nothing is recognised", () => {
    expect(describeScopes([])).toBe("");
    expect(describeScopes(["bogus"])).toBe("");
  });
});
