import { describe, expect, it } from "vitest";
import {
  ANON_PREFIX,
  ENTITY_KINDS,
  LEGAL_RETENTION_REASON,
  PERSONAL_DATA_FIELDS,
  REDACTED_VALUE,
  anonymizeValue,
  buildErasurePlan,
  buildExportPlan,
  exportableFields,
  fieldPolicy,
  personalFields,
  redactExport,
  summarizePlan,
  validateErasurePlan,
  type DataSubjectRecord,
  type EntityKind,
  type ErasurePlan,
} from "./gdpr";

/**
 * GDPR personal-data controls engine (Art. 15 export / Art. 17 erasure) — the
 * pure, deterministic core.
 *
 * Red-first: this file was written BEFORE `src/lib/gdpr.ts` existed, so every
 * import resolved to module-not-found and collection failed. It pins a
 * per-entity field registry (what is personal, exportable and erasable, and
 * whether erasure deletes, anonymises or is stayed by a legal-retention rule),
 * an ordered export bundle, a per-field erasure plan that refuses to touch
 * records under legal hold, deterministic pseudonyms, plan validation and a
 * one-line summary. Nothing here reads a clock, a DB or the network.
 */

const SUBJECT = "u1";
const OTHER = "u2";

/** A subject record builder: defaults to the subject under test, no fields. */
function record(
  overrides: Partial<DataSubjectRecord> & { entity: EntityKind; id: string },
): DataSubjectRecord {
  return { subjectId: SUBJECT, fields: {}, ...overrides };
}

/** One record of every entity kind, plus a same-kind sibling and a foreign one. */
const RECORDS: DataSubjectRecord[] = [
  record({
    entity: "user",
    id: "usr_1",
    fields: {
      email: "ada@example.com",
      name: "Ada Lovelace",
      theme: "dark",
      locale: "en",
      passwordHash: "$2b$hash",
    },
  }),
  record({ entity: "page", id: "pg_2", fields: { title: "Notes", content: { type: "doc" } } }),
  record({ entity: "page", id: "pg_1", fields: { title: "Inbox" } }),
  record({ entity: "comment", id: "cm_1", fields: { body: "hello", authorId: "usr_1", blockId: "b1" } }),
  record({ entity: "reaction", id: "rx_1", fields: { userId: "usr_1", emoji: "🎉", commentId: "cm_1" } }),
  record({ entity: "version", id: "vs_1", fields: { title: "v1", createdById: "usr_1", label: "auto" } }),
  record({ entity: "shareLink", id: "sl_1", fields: { token: "tok_abc", passwordHash: "h", permission: "READ" } }),
  record({ entity: "comment", id: "cm_other", subjectId: OTHER, fields: { body: "not mine" } }),
];

describe("PERSONAL_DATA_FIELDS registry", () => {
  it("registers exactly the nine entity kinds", () => {
    expect(Object.keys(PERSONAL_DATA_FIELDS).sort()).toEqual([...ENTITY_KINDS].sort());
    expect(ENTITY_KINDS).toEqual([
      "user",
      "page",
      "comment",
      "reaction",
      "version",
      "shareLink",
      "pageFollow",
      "favorite",
      "notification",
    ]);
  });

  it("gives every entity kind at least one personal field", () => {
    for (const kind of ENTITY_KINDS) {
      expect(personalFields(kind).length).toBeGreaterThan(0);
    }
  });

  it("never marks a non-personal field exportable or erasable", () => {
    for (const kind of ENTITY_KINDS) {
      for (const policy of Object.values(PERSONAL_DATA_FIELDS[kind])) {
        if (policy.personal) continue;
        expect(policy.exportable).toBe(false);
        expect(policy.erasable).toBe(false);
        expect(policy.strategy).toBe("retain-legal");
      }
    }
  });

  it("only exports personal data (exportable ⇒ personal)", () => {
    for (const kind of ENTITY_KINDS) {
      for (const policy of Object.values(PERSONAL_DATA_FIELDS[kind])) {
        if (policy.exportable) expect(policy.personal).toBe(true);
      }
    }
  });

  it("never erases a field whose strategy is retain-legal", () => {
    for (const kind of ENTITY_KINDS) {
      for (const policy of Object.values(PERSONAL_DATA_FIELDS[kind])) {
        if (policy.erasable) expect(policy.strategy).not.toBe("retain-legal");
      }
    }
  });

  it("keeps a retain-legal field non-erasable", () => {
    for (const kind of ENTITY_KINDS) {
      for (const policy of Object.values(PERSONAL_DATA_FIELDS[kind])) {
        if (policy.strategy === "retain-legal") expect(policy.erasable).toBe(false);
      }
    }
  });

  it("exposes personal fields in registry order and hides the rest", () => {
    expect(personalFields("user")).toEqual([
      "email",
      "name",
      "avatarUrl",
      "passwordHash",
      "notificationPrefs",
      "twoFactorSecret",
    ]);
    expect(exportableFields("user")).toEqual(["email", "name", "avatarUrl", "notificationPrefs"]);
    expect(exportableFields("shareLink")).toEqual([]);
  });

  it("looks a field policy up by entity and field name", () => {
    expect(fieldPolicy("user", "email")).toEqual({
      personal: true,
      exportable: true,
      erasable: true,
      strategy: "anonymize",
    });
    expect(fieldPolicy("user", "theme")).toEqual({
      personal: false,
      exportable: false,
      erasable: false,
      strategy: "retain-legal",
    });
    expect(fieldPolicy("user", "nope")).toBeUndefined();
  });
});

describe("anonymizeValue", () => {
  it("is deterministic for the same field and value", () => {
    expect(anonymizeValue("email", "ada@example.com")).toBe(anonymizeValue("email", "ada@example.com"));
  });

  it("differs across values", () => {
    expect(anonymizeValue("email", "a@x.com")).not.toBe(anonymizeValue("email", "b@x.com"));
  });

  it("namespaces by field, so the same value yields different pseudonyms", () => {
    expect(anonymizeValue("email", "ada")).not.toBe(anonymizeValue("name", "ada"));
  });

  it("is prefixed and never leaks the original value", () => {
    const pseudo = anonymizeValue("email", "ada@example.com");
    expect(pseudo.startsWith(`${ANON_PREFIX}email:`)).toBe(true);
    expect(pseudo).not.toContain("ada@example.com");
  });

  it("collapses null and undefined but distinguishes the empty string", () => {
    expect(anonymizeValue("email", null)).toBe(anonymizeValue("email", undefined));
    expect(anonymizeValue("email", "")).not.toBe(anonymizeValue("email", null));
  });

  it("handles structured values deterministically", () => {
    expect(anonymizeValue("content", { b: 1, a: 2 })).toBe(anonymizeValue("content", { b: 1, a: 2 }));
    expect(anonymizeValue("content", { a: 1 })).not.toBe(anonymizeValue("content", { a: 2 }));
  });

  it("is independent of call order", () => {
    const first = anonymizeValue("email", "one");
    anonymizeValue("name", "two");
    expect(anonymizeValue("email", "one")).toBe(first);
  });
});

describe("buildExportPlan", () => {
  it("includes only the subject's records", () => {
    const bundle = buildExportPlan(RECORDS, SUBJECT);
    expect(bundle.entries.map((entry) => entry.id)).not.toContain("cm_other");
  });

  it("includes only exportable, present fields", () => {
    const bundle = buildExportPlan(RECORDS, SUBJECT);
    const user = bundle.entries.find((entry) => entry.id === "usr_1");
    expect(Object.keys(user?.fields ?? {}).sort()).toEqual(["email", "name"]);
    expect(user?.fields.passwordHash).toBeUndefined();
    expect(user?.fields.theme).toBeUndefined();
  });

  it("orders entries by entity kind, then id, independent of input order", () => {
    const forward = buildExportPlan(RECORDS, SUBJECT).entries.map((entry) => entry.id);
    const reverse = buildExportPlan([...RECORDS].reverse(), SUBJECT).entries.map((entry) => entry.id);
    expect(forward).toEqual(["usr_1", "pg_1", "pg_2", "cm_1", "rx_1", "vs_1", "sl_1"]);
    expect(reverse).toEqual(forward);
  });

  it("tallies per-kind counts and the total", () => {
    const bundle = buildExportPlan(RECORDS, SUBJECT);
    expect(bundle.subjectId).toBe(SUBJECT);
    expect(bundle.counts).toEqual({
      user: 1,
      page: 2,
      comment: 1,
      reaction: 1,
      version: 1,
      shareLink: 1,
      pageFollow: 0,
      favorite: 0,
      notification: 0,
    });
    expect(bundle.total).toBe(7);
  });

  it("keeps a record even when it has no exportable fields", () => {
    const bundle = buildExportPlan(RECORDS, SUBJECT);
    const link = bundle.entries.find((entry) => entry.id === "sl_1");
    expect(link).toBeDefined();
    expect(link?.fields).toEqual({});
  });

  it("ignores records with a different or missing subject id", () => {
    const bundle = buildExportPlan(
      [record({ entity: "page", id: "mine" }), record({ entity: "page", id: "theirs", subjectId: OTHER })],
      SUBJECT,
    );
    expect(bundle.entries.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("returns an empty, well-formed bundle for a subject with no records", () => {
    const bundle = buildExportPlan(RECORDS, "nobody");
    expect(bundle.entries).toEqual([]);
    expect(bundle.total).toBe(0);
    expect(bundle.counts).toEqual({
      user: 0,
      page: 0,
      comment: 0,
      reaction: 0,
      version: 0,
      shareLink: 0,
      pageFollow: 0,
      favorite: 0,
      notification: 0,
    });
  });

  it("does not mutate its inputs", () => {
    const snapshot = JSON.stringify(RECORDS);
    buildExportPlan(RECORDS, SUBJECT);
    expect(JSON.stringify(RECORDS)).toBe(snapshot);
  });
});

describe("redactExport", () => {
  it("replaces every value with the redaction marker, preserving shape", () => {
    const bundle = buildExportPlan(RECORDS, SUBJECT);
    const redacted = redactExport(bundle);
    expect(redacted.entries.map((entry) => entry.id)).toEqual(
      bundle.entries.map((entry) => entry.id),
    );
    const user = redacted.entries.find((entry) => entry.id === "usr_1");
    expect(user?.fields).toEqual({ email: REDACTED_VALUE, name: REDACTED_VALUE });
  });

  it("preserves the subject, counts and total", () => {
    const bundle = buildExportPlan(RECORDS, SUBJECT);
    const redacted = redactExport(bundle);
    expect(redacted.subjectId).toBe(bundle.subjectId);
    expect(redacted.counts).toEqual(bundle.counts);
    expect(redacted.total).toBe(bundle.total);
  });

  it("does not mutate the source bundle", () => {
    const bundle = buildExportPlan(RECORDS, SUBJECT);
    const snapshot = JSON.stringify(bundle);
    redactExport(bundle);
    expect(JSON.stringify(bundle)).toBe(snapshot);
  });
});

describe("buildErasurePlan", () => {
  it("emits exactly one operation per personal field", () => {
    const plan = buildErasurePlan(RECORDS, SUBJECT);
    expect(plan.operations).toHaveLength(22);
    expect(plan.records).toHaveLength(7);
    expect(plan.total).toBe(22);
  });

  it("maps delete strategies to delete and anonymize strategies to anonymize", () => {
    const plan = buildErasurePlan(RECORDS, SUBJECT);
    const user = plan.operations.filter((op) => op.id === "usr_1");
    expect(user.find((op) => op.field === "email")?.action).toBe("anonymize");
    expect(user.find((op) => op.field === "passwordHash")?.action).toBe("delete");
  });

  it("retains a field whose strategy is retain-legal, with a reason", () => {
    const plan = buildErasurePlan(
      [record({ entity: "shareLink", id: "sl", fields: { token: "t" } })],
      SUBJECT,
    );
    const token = plan.operations.find((op) => op.field === "token");
    expect(token?.action).toBe("retain-legal");
    expect(token?.reason).toBe(LEGAL_RETENTION_REASON);
    expect(plan.counts).toEqual({ anonymize: 0, delete: 1, retain: 1 });
  });

  it("refuses to erase a record under legal hold: every field is retained", () => {
    const held = record({
      entity: "comment",
      id: "cm_hold",
      legalHold: true,
      legalHoldReason: "litigation-42",
      fields: { body: "x", authorId: "usr_1" },
    });
    const plan = buildErasurePlan([held], SUBJECT);
    expect(plan.operations).toHaveLength(3);
    expect(plan.operations.every((op) => op.action === "retain-legal")).toBe(true);
    expect(plan.operations.every((op) => op.reason === "litigation-42")).toBe(true);
    expect(plan.counts).toEqual({ anonymize: 0, delete: 0, retain: 3 });
  });

  it("lists held records under retained with their reason", () => {
    const held = record({ entity: "page", id: "pg_hold", legalHold: true, fields: {} });
    const plan = buildErasurePlan([held], SUBJECT);
    expect(plan.retained).toEqual([{ entity: "page", id: "pg_hold", reason: "legal hold" }]);
    expect(plan.records).toEqual([
      { entity: "page", id: "pg_hold", held: true, reason: "legal hold" },
    ]);
  });

  it("only covers the subject's records", () => {
    const plan = buildErasurePlan(RECORDS, SUBJECT);
    expect(plan.operations.some((op) => op.id === "cm_other")).toBe(false);
    expect(plan.subjectId).toBe(SUBJECT);
  });

  it("orders operations deterministically, independent of input order", () => {
    const forward = buildErasurePlan(RECORDS, SUBJECT);
    const reverse = buildErasurePlan([...RECORDS].reverse(), SUBJECT);
    expect(JSON.stringify(reverse.operations)).toBe(JSON.stringify(forward.operations));
    expect(JSON.stringify(reverse.records)).toBe(JSON.stringify(forward.records));
  });

  it("tallies the operations by action", () => {
    const plan = buildErasurePlan(RECORDS, SUBJECT);
    expect(plan.counts).toEqual({ anonymize: 17, delete: 4, retain: 1 });
  });
});

describe("validateErasurePlan", () => {
  const plan = (): ErasurePlan => buildErasurePlan(RECORDS, SUBJECT);

  it("accepts a plan produced by buildErasurePlan, covering every personal field", () => {
    const valid = plan();
    const result = validateErasurePlan(valid);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(valid.operations.length);
  });

  it("reports a personal field that has no operation", () => {
    const broken: ErasurePlan = {
      ...plan(),
      operations: plan().operations.filter((op) => op.field !== "quote"),
    };
    const result = validateErasurePlan(broken);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      entity: "comment",
      id: "cm_1",
      field: "quote",
      reason: "missing-field",
    });
  });

  it("rejects an erasure action on a record under legal hold", () => {
    const held = buildErasurePlan(
      [record({ entity: "comment", id: "c", legalHold: true, fields: {} })],
      SUBJECT,
    );
    const broken: ErasurePlan = {
      ...held,
      operations: held.operations.map((op, index) =>
        index === 0 ? { ...op, action: "anonymize" } : op,
      ),
    };
    const result = validateErasurePlan(broken);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      entity: "comment",
      id: "c",
      field: "body",
      reason: "legal-hold",
    });
  });

  it("rejects an action that contradicts the field strategy", () => {
    const broken: ErasurePlan = {
      ...plan(),
      operations: plan().operations.map((op) =>
        op.id === "usr_1" && op.field === "email" ? { ...op, action: "delete" } : op,
      ),
    };
    const result = validateErasurePlan(broken);
    expect(result.issues).toContainEqual({
      entity: "user",
      id: "usr_1",
      field: "email",
      reason: "action-mismatch",
    });
  });

  it("rejects an operation for a non-personal field", () => {
    const broken: ErasurePlan = {
      ...plan(),
      operations: plan().operations.map((op) =>
        op.id === "usr_1" && op.field === "email" ? { ...op, field: "theme" } : op,
      ),
    };
    const result = validateErasurePlan(broken);
    expect(result.issues).toContainEqual({
      entity: "user",
      id: "usr_1",
      field: "theme",
      reason: "non-personal-field",
    });
    expect(result.issues).toContainEqual({
      entity: "user",
      id: "usr_1",
      field: "email",
      reason: "missing-field",
    });
  });

  it("rejects an operation for an unknown field", () => {
    const broken: ErasurePlan = {
      ...plan(),
      operations: plan().operations.map((op) =>
        op.id === "usr_1" && op.field === "email" ? { ...op, field: "ssn" } : op,
      ),
    };
    const result = validateErasurePlan(broken);
    expect(result.issues).toContainEqual({
      entity: "user",
      id: "usr_1",
      field: "ssn",
      reason: "unknown-field",
    });
  });

  it("rejects a duplicated operation for the same field", () => {
    const first = plan().operations[0];
    const broken: ErasurePlan = { ...plan(), operations: [...plan().operations, first] };
    const result = validateErasurePlan(broken);
    expect(result.issues).toContainEqual({
      entity: first.entity,
      id: first.id,
      field: first.field,
      reason: "duplicate-operation",
    });
  });

  it("rejects an operation against a record the plan never declared", () => {
    const ghost = {
      entity: "page" as const,
      id: "ghost",
      field: "title",
      action: "anonymize" as const,
    };
    const broken: ErasurePlan = { ...plan(), operations: [...plan().operations, ghost] };
    const result = validateErasurePlan(broken);
    expect(result.issues).toContainEqual({
      entity: "page",
      id: "ghost",
      field: "title",
      reason: "unknown-record",
    });
  });
});

describe("summarizePlan", () => {
  it("summarizes counts, distinct fields and a one-line description", () => {
    const summary = summarizePlan(buildErasurePlan(RECORDS, SUBJECT));
    expect(summary.subjectId).toBe(SUBJECT);
    expect(summary.records).toBe(7);
    expect(summary.operations).toBe(22);
    expect(summary.anonymized).toBe(17);
    expect(summary.deleted).toBe(4);
    expect(summary.retained).toBe(1);
    expect(summary.held).toBe(0);
    expect(summary.fields).toHaveLength(19);
    expect(summary.text).toBe(
      "Erase 22 fields across 7 records: 17 anonymized, 4 deleted, 1 retained.",
    );
  });

  it("mentions records held under legal hold", () => {
    const held = record({ entity: "comment", id: "c", legalHold: true, fields: {} });
    const summary = summarizePlan(buildErasurePlan([held], SUBJECT));
    expect(summary.held).toBe(1);
    expect(summary.text).toContain("1 under legal hold");
  });

  it("describes an empty plan", () => {
    const summary = summarizePlan(buildErasurePlan([], SUBJECT));
    expect(summary).toMatchObject({
      records: 0,
      operations: 0,
      anonymized: 0,
      deleted: 0,
      retained: 0,
      held: 0,
      fields: [],
    });
    expect(summary.text).toBe("Erase 0 fields across 0 records: 0 anonymized, 0 deleted, 0 retained.");
  });
});

/**
 * B117 — the link rows: the pages the subject follows, the pages they
 * favourite and the notifications in their inbox. They are rows without
 * content of their own — what they hold is the relation between the subject
 * and someone else's content — so the erasure removes them as a whole, and
 * their personal columns (the owner, the followed page, the event type and the
 * payload with the page title) belong in the subject's export.
 */
const LINK_RECORDS: DataSubjectRecord[] = [
  record({
    entity: "pageFollow",
    id: "pf_1",
    fields: { userId: SUBJECT, pageId: "pg_1", createdAt: "2026-01-03T00:00:00.000Z" },
  }),
  record({
    entity: "favorite",
    id: "fv_1",
    fields: { userId: SUBJECT, pageId: "pg_2" },
  }),
  record({
    entity: "notification",
    id: "nt_1",
    fields: {
      userId: SUBJECT,
      type: "page.updated",
      payload: { pageId: "pg_1", title: "Roadmap", actorId: "u2" },
      read: false,
    },
  }),
];

describe("the link rows (B117)", () => {
  it("counts them as their own entity kinds", () => {
    const bundle = buildExportPlan(LINK_RECORDS, SUBJECT);
    expect(bundle.counts.pageFollow).toBe(1);
    expect(bundle.counts.favorite).toBe(1);
    expect(bundle.counts.notification).toBe(1);
    expect(bundle.total).toBe(3);
  });

  it("exports the notification payload — the page title is the subject's data", () => {
    const bundle = buildExportPlan(LINK_RECORDS, SUBJECT);
    const notification = bundle.entries.find((entry) => entry.entity === "notification");
    expect(notification?.fields).toEqual({
      userId: SUBJECT,
      type: "page.updated",
      payload: { pageId: "pg_1", title: "Roadmap", actorId: "u2" },
    });
  });

  it("exports the pages the subject follows and favourites", () => {
    const bundle = buildExportPlan(LINK_RECORDS, SUBJECT);
    const follow = bundle.entries.find((entry) => entry.entity === "pageFollow");
    const favorite = bundle.entries.find((entry) => entry.entity === "favorite");
    expect(follow?.fields.pageId).toBe("pg_1");
    expect(favorite?.fields.pageId).toBe("pg_2");
  });

  it("plans a delete for every personal column of a link row", () => {
    const plan = buildErasurePlan(LINK_RECORDS, SUBJECT);
    expect(plan.operations).toHaveLength(7);
    expect(plan.operations.every((op) => op.action === "delete")).toBe(true);
    expect(plan.counts).toEqual({ delete: 7, anonymize: 0, retain: 0 });
    expect(validateErasurePlan(plan).ok).toBe(true);
  });

  it("retains a link row under legal hold", () => {
    const held = record({
      entity: "notification",
      id: "nt_hold",
      legalHold: true,
      fields: { userId: SUBJECT, type: "page.updated", payload: { title: "Roadmap" } },
    });
    const plan = buildErasurePlan([held], SUBJECT);
    expect(plan.operations.every((op) => op.action === "retain-legal")).toBe(true);
    expect(plan.retained).toEqual([
      { entity: "notification", id: "nt_hold", reason: "legal hold" },
    ]);
  });
});
