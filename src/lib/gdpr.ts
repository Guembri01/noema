import { createHash } from "node:crypto";

/**
 * GDPR personal-data controls engine — the pure, deterministic core behind the
 * admin tooling for Art. 15 (access/export) and Art. 17 (erasure).
 *
 * Nothing here reads a clock, a database or the network: callers load a
 * subject's records, hand them in, and get back a plan they can preview, audit
 * and then execute in the request layer. Three ideas hold the module together:
 *
 *  - `PERSONAL_DATA_FIELDS` — a registry that classifies every column of the
 *    six personal-data entities (user, page, comment, reaction, version,
 *    shareLink). A field records whether it is `personal`, whether it may leave
 *    the system in an export, whether erasure touches it, and *how* erasure
 *    treats it (`delete`, `anonymize`, or `retain-legal`). Non-personal fields
 *    are always retained.
 *  - `buildExportPlan` / `buildErasurePlan` — derive, from a subject's records
 *    and the registry, an ordered (Art. 15) export bundle and an ordered
 *    (Art. 17) per-field operation list. Records under a legal hold are never
 *    deleted or anonymised: every field is retained with the hold's reason.
 *  - `validateErasurePlan` — the coverage invariant. A plan is valid only when
 *    every personal field of every declared record is accounted for, no erase
 *    action targets a field under legal hold or one whose strategy forbids it,
 *    and no operation mentions a non-personal, unknown or undeclared target.
 *
 * Everything is pure: no function mutates its arguments, outputs are ordered by
 * entity kind then id (never by input order), and pseudonyms are deterministic
 * so plans and fixtures replay byte-for-byte.
 */

/** The entities that can hold personal data, in canonical order. */
export const ENTITY_KINDS = [
  "user",
  "page",
  "comment",
  "reaction",
  "version",
  "shareLink",
] as const;

/** One of the personal-data-bearing entities. */
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** How erasure treats a field. */
export type ErasureStrategy = "delete" | "anonymize" | "retain-legal";

/** The action a single erasure operation performs (same vocabulary). */
export type ErasureAction = ErasureStrategy;

/** Every strategy, in escalating order of intrusion. */
export const ERASURE_STRATEGIES: readonly ErasureStrategy[] = [
  "delete",
  "anonymize",
  "retain-legal",
];

/** Prefix every pseudonym carries, so redacted values are recognisable. */
export const ANON_PREFIX = "anon:";

/** Marker substituted for a value by `redactExport`. */
export const REDACTED_VALUE = "[redacted]";

/** Reason recorded when a record is retained because of a legal hold. */
export const DEFAULT_HOLD_REASON = "legal hold";

/** Reason recorded when a field's own strategy is `retain-legal`. */
export const LEGAL_RETENTION_REASON = "retain for legal obligation";

/** The classification of one field of one entity. */
export interface FieldPolicy {
  /** Whether the field is personal data about the subject. */
  personal: boolean;
  /** Whether the field belongs in a subject-access export. */
  exportable: boolean;
  /** Whether erasure may touch the field at all. */
  erasable: boolean;
  /** How erasure treats the field. */
  strategy: ErasureStrategy;
}

/** Field policies keyed by field name, per entity kind. */
export type PersonalDataRegistry = Record<EntityKind, Record<string, FieldPolicy>>;

/** A personal field erased by removing it. */
function deleted(exportable = true): FieldPolicy {
  return { personal: true, exportable, erasable: true, strategy: "delete" };
}

/** A personal field erased by replacing its value with a pseudonym. */
function anonymized(exportable = true): FieldPolicy {
  return { personal: true, exportable, erasable: true, strategy: "anonymize" };
}

/** A field that is not personal data; it is always retained in place. */
function retained(): FieldPolicy {
  return { personal: false, exportable: false, erasable: false, strategy: "retain-legal" };
}

/** A personal field that a legal obligation keeps in place (never erased). */
function legalRetention(): FieldPolicy {
  return { personal: true, exportable: false, erasable: false, strategy: "retain-legal" };
}

/**
 * The per-entity personal-data registry. It is the single source of truth for
 * export inclusion and erasure behaviour; the plan builders and the validator
 * never hard-code a field name.
 */
export const PERSONAL_DATA_FIELDS: PersonalDataRegistry = {
  user: {
    id: retained(),
    email: anonymized(),
    name: anonymized(),
    avatarUrl: anonymized(),
    locale: retained(),
    theme: retained(),
    passwordHash: deleted(false),
    notificationPrefs: deleted(),
    // The TOTP seed is stored SEALED since B05 (a `v1:` envelope, never the
    // raw base32 seed), and it is not exportable: it never leaves the system.
    // Erasure deletes the column, which is the only way to remove it.
    twoFactorSecret: deleted(false),
    twoFactorEnabled: retained(),
    createdAt: retained(),
    updatedAt: retained(),
  },
  page: {
    id: retained(),
    title: anonymized(),
    content: anonymized(),
    createdById: anonymized(),
    parentId: retained(),
    workspaceId: retained(),
  },
  comment: {
    id: retained(),
    body: anonymized(),
    authorId: anonymized(),
    quote: anonymized(),
    blockId: retained(),
    pageId: retained(),
    resolved: retained(),
  },
  reaction: {
    id: retained(),
    userId: anonymized(),
    emoji: retained(),
    commentId: retained(),
  },
  version: {
    id: retained(),
    title: anonymized(),
    content: anonymized(),
    createdById: anonymized(),
    summary: anonymized(),
    label: retained(),
    charDelta: retained(),
  },
  shareLink: {
    id: retained(),
    token: legalRetention(),
    passwordHash: deleted(false),
    pageId: retained(),
    permission: retained(),
    expiresAt: retained(),
  },
};

/** Whether `value` names a registered entity kind. */
export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value);
}

/** The policy for a field, or `undefined` when the entity/field is unknown. */
export function fieldPolicy(entity: EntityKind, field: string): FieldPolicy | undefined {
  if (!isEntityKind(entity)) return undefined;
  return PERSONAL_DATA_FIELDS[entity][field];
}

/** Personal field names of an entity, in registry order. */
export function personalFields(entity: EntityKind): string[] {
  if (!isEntityKind(entity)) return [];
  const fields = PERSONAL_DATA_FIELDS[entity];
  return Object.keys(fields).filter((name) => fields[name].personal);
}

/** Exportable field names of an entity, in registry order. */
export function exportableFields(entity: EntityKind): string[] {
  if (!isEntityKind(entity)) return [];
  const fields = PERSONAL_DATA_FIELDS[entity];
  return Object.keys(fields).filter((name) => fields[name].exportable);
}

/** A subject's record as loaded from the store. */
export interface DataSubjectRecord {
  /** Which entity the record belongs to. */
  entity: EntityKind;
  /** Stable record id, used for ordering and de-duplication. */
  id: string;
  /** The subject (user id) the record belongs to; others are ignored. */
  subjectId?: string;
  /** When true, a legal hold forbids erasure of this record. */
  legalHold?: boolean;
  /** Why the record is held; defaults to `DEFAULT_HOLD_REASON`. */
  legalHoldReason?: string;
  /** The record's column values. */
  fields?: Record<string, unknown>;
}

/** One entity's exported slice of a subject's data. */
export interface ExportEntry {
  entity: EntityKind;
  id: string;
  /** Exportable fields present on the record, in registry order. */
  fields: Record<string, unknown>;
}

/** An ordered bundle of every record a subject owns. */
export interface ExportBundle {
  subjectId: string;
  /** Entries ordered by entity kind, then id. */
  entries: ExportEntry[];
  /** Number of entries per entity kind. */
  counts: Record<EntityKind, number>;
  /** `entries.length`. */
  total: number;
}

/** One field-level erasure step. */
export interface ErasureOperation {
  entity: EntityKind;
  id: string;
  field: string;
  action: ErasureAction;
  /** Present for `retain-legal`, explaining why the field survives. */
  reason?: string;
}

/** A record the erasure plan accounts for, and whether a hold protects it. */
export interface ErasureRecordRef {
  entity: EntityKind;
  id: string;
  /** True when a legal hold forbids erasing this record. */
  held: boolean;
  /** The hold's reason, present when `held`. */
  reason?: string;
}

/** A record retained in full because of a legal hold. */
export interface RetainedRecord {
  entity: EntityKind;
  id: string;
  reason: string;
}

/** A per-field erasure plan for one subject. */
export interface ErasurePlan {
  subjectId: string;
  /** Every declared record, ordered by entity kind then id. */
  records: ErasureRecordRef[];
  /** Every operation, ordered by record then registry field order. */
  operations: ErasureOperation[];
  /** Records under legal hold that erasure must not touch. */
  retained: RetainedRecord[];
  /** Operations tallied by action. */
  counts: { delete: number; anonymize: number; retain: number };
  /** `operations.length`. */
  total: number;
}

/** Why `validateErasurePlan` flagged an operation or a missing one. */
export type ErasureValidationReason =
  | "missing-field"
  | "unknown-field"
  | "non-personal-field"
  | "action-mismatch"
  | "legal-hold"
  | "duplicate-operation"
  | "unknown-record";

/** One problem found by `validateErasurePlan`. */
export interface ErasureValidationIssue {
  entity: EntityKind;
  id: string;
  field: string;
  reason: ErasureValidationReason;
}

/** The result of auditing a plan. */
export interface ErasureValidation {
  ok: boolean;
  issues: ErasureValidationIssue[];
  /** Human-readable form of `issues`, one line each. */
  errors: string[];
  /** How many personal fields the plan was required to cover. */
  checked: number;
}

/** A compact, machine- and human-friendly digest of a plan. */
export interface ErasureSummary {
  subjectId: string;
  records: number;
  held: number;
  operations: number;
  anonymized: number;
  deleted: number;
  retained: number;
  /** Distinct `entity.field` pairs touched, in first-seen order. */
  fields: string[];
  /** A one-line description of the plan. */
  text: string;
}

/** A zeroed per-kind tally. */
function emptyCounts(): Record<EntityKind, number> {
  const counts = {} as Record<EntityKind, number>;
  for (const kind of ENTITY_KINDS) counts[kind] = 0;
  return counts;
}

/** Index of an entity kind in the canonical order. */
function kindRank(entity: EntityKind): number {
  return ENTITY_KINDS.indexOf(entity);
}

/** Canonical record order: entity kind, then id. */
function compareRecords(a: DataSubjectRecord, b: DataSubjectRecord): number {
  const rank = kindRank(a.entity) - kindRank(b.entity);
  if (rank !== 0) return rank;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** A record's key, unique within the subject's data. */
function recordKey(entity: EntityKind, id: string): string {
  return `${entity}\u0000${id}`;
}

/**
 * The subject's own records, valid and de-duplicated (first wins), in canonical
 * order. Anything with an unknown entity, an empty id or a different subject is
 * dropped rather than trusted.
 */
function subjectRecords(
  records: readonly DataSubjectRecord[],
  userId: string,
): DataSubjectRecord[] {
  const list = Array.isArray(records) ? records : [];
  const seen = new Set<string>();
  const subject: DataSubjectRecord[] = [];
  for (const raw of list) {
    if (!raw || !isEntityKind(raw.entity)) continue;
    if (typeof raw.id !== "string" || raw.id === "") continue;
    if (typeof userId !== "string" || raw.subjectId !== userId) continue;
    const key = recordKey(raw.entity, raw.id);
    if (seen.has(key)) continue;
    seen.add(key);
    subject.push(raw);
  }
  subject.sort(compareRecords);
  return subject;
}

/** A stable string for any field value, used as pseudonym material. */
function stableValue(value: unknown): string {
  if (value === null || value === undefined) return "\u0000null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * A deterministic pseudonym for a field value: same field and value always
 * yield the same token (`anon:<field>:<hex>`), while different fields or values
 * diverge. Namespacing by field means the same value in two columns does not
 * leak via a shared token. `null`/`undefined` collapse together; the empty
 * string is its own identity. Not reversible, and never contains the input.
 */
export function anonymizeValue(field: string, value: unknown): string {
  const name = typeof field === "string" ? field : "";
  const material = `${name}\u0000${stableValue(value)}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `${ANON_PREFIX}${name}:${digest}`;
}

/**
 * Build the ordered export bundle for `userId`: one entry per owned record, in
 * entity-kind then id order, holding just that record's exportable fields that
 * are actually present. Records belonging to another subject are ignored, and
 * the inputs are never mutated.
 */
export function buildExportPlan(
  records: readonly DataSubjectRecord[],
  userId: string,
): ExportBundle {
  const counts = emptyCounts();
  const entries: ExportEntry[] = [];
  for (const record of subjectRecords(records, userId)) {
    const source = record.fields ?? {};
    const fields: Record<string, unknown> = {};
    for (const name of exportableFields(record.entity)) {
      if (Object.prototype.hasOwnProperty.call(source, name)) fields[name] = source[name];
    }
    counts[record.entity] += 1;
    entries.push({ entity: record.entity, id: record.id, fields });
  }
  return {
    subjectId: typeof userId === "string" ? userId : "",
    entries,
    counts,
    total: entries.length,
  };
}

/**
 * Return a redacted copy of an export bundle: every field value becomes
 * `REDACTED_VALUE` while entity kinds, ids, field names, counts and totals are
 * preserved. Useful for logging or approval flows that must not leak the
 * subject's data; the source bundle is left untouched.
 */
export function redactExport(bundle: ExportBundle): ExportBundle {
  const source = Array.isArray(bundle.entries) ? bundle.entries : [];
  const counts = emptyCounts();
  const entries: ExportEntry[] = [];
  for (const entry of source) {
    const fields: Record<string, unknown> = {};
    for (const name of Object.keys(entry.fields ?? {})) fields[name] = REDACTED_VALUE;
    if (isEntityKind(entry.entity)) counts[entry.entity] += 1;
    entries.push({ entity: entry.entity, id: entry.id, fields });
  }
  return {
    subjectId: typeof bundle.subjectId === "string" ? bundle.subjectId : "",
    entries,
    counts,
    total: entries.length,
  };
}

/**
 * Build the per-field erasure plan for `userId`. Every personal field of every
 * owned record yields exactly one operation, in record then registry order:
 *
 *  - a record under legal hold is never erased — all its fields are
 *    `retain-legal`, carrying the hold's reason;
 *  - otherwise the field's strategy decides: `delete`, `anonymize`, or
 *    `retain-legal` (with the legal-retention reason).
 *
 * Inputs are not mutated and records of other subjects are ignored.
 */
export function buildErasurePlan(
  records: readonly DataSubjectRecord[],
  userId: string,
): ErasurePlan {
  const operations: ErasureOperation[] = [];
  const planRecords: ErasureRecordRef[] = [];
  const retained: RetainedRecord[] = [];
  const counts = { delete: 0, anonymize: 0, retain: 0 };

  for (const record of subjectRecords(records, userId)) {
    const held = record.legalHold === true;
    const holdReason =
      typeof record.legalHoldReason === "string" && record.legalHoldReason !== ""
        ? record.legalHoldReason
        : DEFAULT_HOLD_REASON;

    planRecords.push(
      held
        ? { entity: record.entity, id: record.id, held: true, reason: holdReason }
        : { entity: record.entity, id: record.id, held: false },
    );
    if (held) retained.push({ entity: record.entity, id: record.id, reason: holdReason });

    const fields = PERSONAL_DATA_FIELDS[record.entity];
    for (const field of personalFields(record.entity)) {
      let action: ErasureAction;
      let reason: string | undefined;
      if (held) {
        action = "retain-legal";
        reason = holdReason;
      } else if (fields[field].strategy === "retain-legal") {
        action = "retain-legal";
        reason = LEGAL_RETENTION_REASON;
      } else {
        action = fields[field].strategy;
      }

      operations.push(
        reason === undefined
          ? { entity: record.entity, id: record.id, field, action }
          : { entity: record.entity, id: record.id, field, action, reason },
      );
      if (action === "delete") counts.delete += 1;
      else if (action === "anonymize") counts.anonymize += 1;
      else counts.retain += 1;
    }
  }

  return {
    subjectId: typeof userId === "string" ? userId : "",
    records: planRecords,
    operations,
    retained,
    counts,
    total: operations.length,
  };
}

/** Issue order: entity kind, then id, then field, then reason. */
function compareIssues(a: ErasureValidationIssue, b: ErasureValidationIssue): number {
  const rank = kindRank(a.entity) - kindRank(b.entity);
  if (rank !== 0) return rank;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.field !== b.field) return a.field < b.field ? -1 : 1;
  if (a.reason === b.reason) return 0;
  return a.reason < b.reason ? -1 : 1;
}

/** `entity/id.field: reason` — one line per issue. */
function describeIssue(issue: ErasureValidationIssue): string {
  return `${issue.entity}/${issue.id}.${issue.field}: ${issue.reason}`;
}

/**
 * Audit an erasure plan against the registry. A plan is valid when, for every
 * declared record, every personal field has exactly one operation; when each
 * operation's action matches the field's strategy, except that a held record
 * may only be `retain-legal`; and when no operation targets a non-personal,
 * unknown or undeclared field/record. A plan from `buildErasurePlan` always
 * validates clean, with `checked` equal to its operation count.
 */
export function validateErasurePlan(plan: ErasurePlan): ErasureValidation {
  const issues: ErasureValidationIssue[] = [];
  const recordRefs = Array.isArray(plan.records) ? plan.records : [];
  const operations = Array.isArray(plan.operations) ? plan.operations : [];

  const recordKeys = new Set<string>();
  const recordsByKey = new Map<string, ErasureRecordRef>();
  for (const record of recordRefs) {
    if (!record || !isEntityKind(record.entity) || typeof record.id !== "string") continue;
    const key = recordKey(record.entity, record.id);
    if (recordsByKey.has(key)) continue;
    recordsByKey.set(key, record);
    recordKeys.add(key);
  }

  const opsByRecord = new Map<string, ErasureOperation[]>();
  for (const op of operations) {
    if (!op || !isEntityKind(op.entity) || typeof op.id !== "string") continue;
    const key = recordKey(op.entity, op.id);
    const bucket = opsByRecord.get(key) ?? [];
    bucket.push(op);
    opsByRecord.set(key, bucket);
  }

  let checked = 0;
  for (const [key, record] of recordsByKey) {
    const ops = opsByRecord.get(key) ?? [];
    const seenFields = new Set<string>();

    for (const op of ops) {
      const field = typeof op.field === "string" ? op.field : "";
      if (seenFields.has(field)) {
        issues.push({ entity: record.entity, id: record.id, field, reason: "duplicate-operation" });
        continue;
      }
      seenFields.add(field);

      const policy = fieldPolicy(record.entity, field);
      if (!policy) {
        issues.push({ entity: record.entity, id: record.id, field, reason: "unknown-field" });
        continue;
      }
      if (!policy.personal) {
        issues.push({ entity: record.entity, id: record.id, field, reason: "non-personal-field" });
        continue;
      }
      if (record.held) {
        if (op.action !== "retain-legal") {
          issues.push({ entity: record.entity, id: record.id, field, reason: "legal-hold" });
        }
        continue;
      }
      if (op.action !== policy.strategy) {
        issues.push({ entity: record.entity, id: record.id, field, reason: "action-mismatch" });
      }
    }

    for (const field of personalFields(record.entity)) {
      checked += 1;
      if (!seenFields.has(field)) {
        issues.push({ entity: record.entity, id: record.id, field, reason: "missing-field" });
      }
    }
  }

  // Operations that name a record the plan never declared as the subject's.
  for (const op of operations) {
    if (!op || !isEntityKind(op.entity) || typeof op.id !== "string") continue;
    if (!recordKeys.has(recordKey(op.entity, op.id))) {
      issues.push({
        entity: op.entity,
        id: op.id,
        field: typeof op.field === "string" ? op.field : "",
        reason: "unknown-record",
      });
    }
  }

  issues.sort(compareIssues);
  return { ok: issues.length === 0, issues, errors: issues.map(describeIssue), checked };
}

/**
 * A compact digest of an erasure plan: counts by action, how many records are
 * held, the distinct `entity.field` pairs touched, and a one-line description.
 * Tallying is derived from the operations themselves, so a hand-edited plan
 * still summarizes as it reads.
 */
export function summarizePlan(plan: ErasurePlan): ErasureSummary {
  const records = Array.isArray(plan.records) ? plan.records : [];
  const operations = Array.isArray(plan.operations) ? plan.operations : [];

  let anonymized = 0;
  let deleted = 0;
  let retained = 0;
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const op of operations) {
    if (op.action === "delete") deleted += 1;
    else if (op.action === "anonymize") anonymized += 1;
    else retained += 1;

    const key = `${op.entity}.${op.field}`;
    if (!seen.has(key)) {
      seen.add(key);
      fields.push(key);
    }
  }

  const held = records.filter((record) => record.held).length;
  const holdClause = held > 0 ? `, ${held} under legal hold` : "";
  const fieldLabel = operations.length === 1 ? "field" : "fields";
  const recordLabel = records.length === 1 ? "record" : "records";
  const text =
    `Erase ${operations.length} ${fieldLabel} across ${records.length} ${recordLabel}: ` +
    `${anonymized} anonymized, ${deleted} deleted, ${retained} retained${holdClause}.`;

  return {
    subjectId: typeof plan.subjectId === "string" ? plan.subjectId : "",
    records: records.length,
    held,
    operations: operations.length,
    anonymized,
    deleted,
    retained,
    fields,
    text,
  };
}
