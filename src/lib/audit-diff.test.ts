import { describe, expect, it } from "vitest";
import {
  diffObjects,
  isEmptyDiff,
  isSensitiveKey,
  redactValue,
  summarizeDiff,
  type DiffEntry,
} from "./audit-diff";

/**
 * Audit field diffs (F9) — pure, red-first.
 *
 * `src/lib/audit-diff.ts` did not exist when this file was first written
 * (module-not-found -> suite red; "Red-first").
 *
 * This is the *object* sibling of the block diff in `version-history.ts` and
 * the character diff in `text-diff.ts`: the audit feed records
 * `Activity.meta` snapshots, and a reader wants "which fields changed, from
 * what, to what" without diffing raw JSON blobs by eye. No Prisma, no React —
 * the unit sandbox is the harness.
 *
 * Contract pinned here:
 *  - `diffObjects` is shallow by default and walks nested plain objects only
 *    when asked (`maxDepth`), reporting dotted paths;
 *  - ordering is deterministic: the key union is visited ASCII-ascending, so
 *    identical input always yields an identical entry list;
 *  - change detection runs on the RAW values; only the *displayed* before/after
 *    are masked, so two distinct secrets still read as `changed`;
 *  - sensitive fields (`password`, `apiKey`, `access_token`, …) are masked by
 *    default and `redactKeys` extends that set;
 *  - inputs are never mutated and the helpers never throw.
 */

const mask = "\u2022\u2022\u2022\u2022"; // "••••"

describe("diffObjects — shallow", () => {
  it("returns no entries for equal records", () => {
    expect(diffObjects({ a: 1, b: "x" }, { a: 1, b: "x" })).toEqual([]);
  });

  it("ignores key order when records are deeply equal", () => {
    expect(diffObjects({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
    expect(diffObjects({ config: { x: 1, y: 2 } }, { config: { y: 2, x: 1 } })).toEqual([]);
  });

  it("reports an added field with only an after value", () => {
    expect(diffObjects({ a: 1 }, { a: 1, b: 2 })).toEqual([
      { field: "b", op: "added", after: 2 },
    ]);
  });

  it("reports a removed field with only a before value", () => {
    expect(diffObjects({ a: 1, b: 2 }, { a: 1 })).toEqual([
      { field: "b", op: "removed", before: 2 },
    ]);
  });

  it("reports a changed field with both values", () => {
    expect(diffObjects({ a: 1 }, { a: 2 })).toEqual([
      { field: "a", op: "changed", before: 1, after: 2 },
    ]);
  });

  it("treats an explicit null as a value, not as absence", () => {
    expect(diffObjects({}, { a: null })).toEqual([{ field: "a", op: "added", after: null }]);
    expect(diffObjects({ a: null }, {})).toEqual([{ field: "a", op: "removed", before: null }]);
  });

  it("compares arrays by content and position, not by reference", () => {
    expect(diffObjects({ tags: ["a", "b"] }, { tags: ["a", "b"] })).toEqual([]);
    expect(diffObjects({ tags: ["a", "b"] }, { tags: ["b", "a"] })).toEqual([
      { field: "tags", op: "changed", before: ["a", "b"], after: ["b", "a"] },
    ]);
  });

  it("orders the key union deterministically", () => {
    const entries = diffObjects({ b: 1, c: 1, a: 1 }, { b: 2, c: 2, a: 2 });
    expect(entries.map((entry) => entry.field)).toEqual(["a", "b", "c"]);
    expect(entries.map((entry) => entry.op)).toEqual(["changed", "changed", "changed"]);
  });

  it("does not mutate either input", () => {
    const before = { a: 1, nested: { keep: true } };
    const after = { a: 2, nested: { keep: false } };
    diffObjects(before, after);
    expect(before).toEqual({ a: 1, nested: { keep: true } });
    expect(after).toEqual({ a: 2, nested: { keep: false } });
  });

  it("never throws on non-record input", () => {
    expect(diffObjects(null, undefined)).toEqual([]);
    expect(diffObjects({ a: 1 }, null)).toEqual([{ field: "a", op: "removed", before: 1 }]);
    expect(diffObjects(42 as unknown, { a: 1 })).toEqual([{ field: "a", op: "added", after: 1 }]);
  });
});

describe("diffObjects — nested paths", () => {
  it("compares nested objects as one value when shallow", () => {
    expect(diffObjects({ user: { name: "ada" } }, { user: { name: "grace" } })).toEqual([
      { field: "user", op: "changed", before: { name: "ada" }, after: { name: "grace" } },
    ]);
  });

  it("reports dotted paths when nested walking is enabled", () => {
    expect(
      diffObjects({ user: { name: "ada" } }, { user: { name: "grace" } }, { maxDepth: 2 }),
    ).toEqual([{ field: "user.name", op: "changed", before: "ada", after: "grace" }]);
  });

  it("reports nested additions and removals", () => {
    expect(
      diffObjects(
        { user: { name: "ada" } },
        { user: { name: "ada", role: "admin" } },
        { maxDepth: 2 },
      ),
    ).toEqual([{ field: "user.role", op: "added", after: "admin" }]);
    expect(
      diffObjects(
        { user: { name: "ada", role: "admin" } },
        { user: { name: "ada" } },
        { maxDepth: 2 },
      ),
    ).toEqual([{ field: "user.role", op: "removed", before: "admin" }]);
  });

  it("stops at the requested depth and reports the whole subtree", () => {
    expect(
      diffObjects({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, { maxDepth: 2 }),
    ).toEqual([{ field: "a.b", op: "changed", before: { c: 1 }, after: { c: 2 } }]);
  });

  it("walks arbitrarily deep with maxDepth: Infinity", () => {
    expect(
      diffObjects({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, { maxDepth: Infinity }),
    ).toEqual([{ field: "a.b.c", op: "changed", before: 1, after: 2 }]);
  });

  it("orders nested keys deterministically", () => {
    const entries = diffObjects(
      { z: { b: 1, a: 1 } },
      { z: { b: 2, a: 2 } },
      { maxDepth: 2 },
    );
    expect(entries.map((entry) => entry.field)).toEqual(["z.a", "z.b"]);
  });

  it("treats arrays as leaves even when nested walking is on", () => {
    expect(
      diffObjects({ list: [1, 2] }, { list: [1, 2, 3] }, { maxDepth: 5 }),
    ).toEqual([{ field: "list", op: "changed", before: [1, 2], after: [1, 2, 3] }]);
  });
});

describe("isSensitiveKey / redactValue", () => {
  it("recognises common secret field names", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("access_token")).toBe(true);
    expect(isSensitiveKey("user.password")).toBe(true);
  });

  it("does not flag benign lookalikes", () => {
    expect(isSensitiveKey("author")).toBe(false);
    expect(isSensitiveKey("authorId")).toBe(false);
    expect(isSensitiveKey("publicKey")).toBe(false);
    expect(isSensitiveKey("title")).toBe(false);
  });

  it("returns non-sensitive values unchanged", () => {
    expect(redactValue("name", "ada")).toBe("ada");
    expect(redactValue("count", 0)).toBe(0);
  });

  it("masks sensitive strings while keeping a shape hint", () => {
    expect(redactValue("password", "hunter2secret")).toBe("hunt\u2026et");
    expect(redactValue("token", "abc")).toBe(mask);
  });

  it("masks non-string sensitive values outright", () => {
    expect(redactValue("apiKey", 12345)).toBe("[redacted]");
    expect(redactValue("apiKey", { nested: true })).toBe("[redacted]");
  });
});

describe("diffObjects — redaction", () => {
  it("masks a changed secret but still reports it as changed", () => {
    expect(diffObjects({ password: "old-secret-value" }, { password: "new-secret-value" })).toEqual([
      { field: "password", op: "changed", before: "old-\u2026ue", after: "new-\u2026ue" },
    ]);
  });

  it("detects two different secrets even when their masks look identical", () => {
    expect(diffObjects({ secret: "secretAAAA01" }, { secret: "secretBBBB01" })).toEqual([
      { field: "secret", op: "changed", before: "secr\u202601", after: "secr\u202601" },
    ]);
  });

  it("masks added and removed secrets", () => {
    expect(diffObjects({}, { token: "abcdefghijkl" })).toEqual([
      { field: "token", op: "added", after: "abcd\u2026kl" },
    ]);
    expect(diffObjects({ token: "abcdefghijkl" }, {})).toEqual([
      { field: "token", op: "removed", before: "abcd\u2026kl" },
    ]);
  });

  it("honours the redactKeys extension", () => {
    expect(
      diffObjects({ ssn: "123-45-6789" }, { ssn: "987-65-4321" }, { redactKeys: ["ssn"] }),
    ).toEqual([{ field: "ssn", op: "changed", before: "123-\u202689", after: "987-\u202621" }]);
  });

  it("leaves ordinary fields unmasked", () => {
    expect(diffObjects({ name: "ada" }, { name: "grace" })).toEqual([
      { field: "name", op: "changed", before: "ada", after: "grace" },
    ]);
  });

  it("redacts nested secrets by leaf name", () => {
    expect(
      diffObjects(
        { user: { password: "supersecret1" } },
        { user: { password: "supersecret2" } },
        { maxDepth: 2 },
      ),
    ).toEqual([
      { field: "user.password", op: "changed", before: "supe\u2026t1", after: "supe\u2026t2" },
    ]);
  });
});

describe("isEmptyDiff / summarizeDiff", () => {
  it("flags whether a diff changes anything", () => {
    expect(isEmptyDiff([])).toBe(true);
    expect(
      isEmptyDiff([{ field: "a", op: "changed", before: 1, after: 2 }]),
    ).toBe(false);
  });

  it("summarises an empty diff", () => {
    expect(summarizeDiff([])).toBe("No changes");
  });

  it("summarises a single entry", () => {
    expect(summarizeDiff([{ field: "role", op: "changed", before: "a", after: "b" }])).toBe(
      "1 field: 1 changed (role)",
    );
  });

  it("summarises a mixed diff with counts and fields", () => {
    const entries: DiffEntry[] = [
      { field: "b", op: "added", after: 1 },
      { field: "c", op: "removed", before: 2 },
      { field: "a", op: "changed", before: 3, after: 4 },
    ];
    expect(summarizeDiff(entries)).toBe("3 fields: 1 added, 1 removed, 1 changed (b, c, a)");
  });
});
