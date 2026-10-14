// B92 — backup script hardening (scripts/backup.mjs): --dry-run plan,
// per-backup manifest.json (timestamp, row counts, schema/app version) and
// keep-N retention pruning that never prunes the newest dump.
//
// Red-first: this file was written BEFORE scripts/backup-lib.mjs existed — the
// first run failed on the missing module (see the batch report for the red
// tail). The pure helpers live in backup-lib.mjs so they are unit-testable
// without touching pg_dump, docker or the backups/ directory.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP,
  buildManifest,
  formatDryRunPlan,
  isBackupDump,
  manifestNameFor,
  parseRowCounts,
  planRetention,
  schemaFingerprint,
} from "./backup-lib.mjs";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A trimmed pg_dump (custom plain format) with three COPY blocks. */
const SAMPLE_DUMP = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  'COPY public."User" (id, email) FROM stdin;',
  "user-1\talice@example.test",
  "user-2\tbob@example.test",
  "user-3\tcarol@example.test",
  "\\.",
  "",
  'COPY public."Workspace" (id, name) FROM stdin;',
  "ws-1\tAlpha",
  "ws-2\tBeta",
  "\\.",
  "",
  'COPY public."Page" (id, title) FROM stdin;',
  "page-1\tHello",
  "\\.",
  "",
].join("\n");

/** Dump naming convention: noema-<ISO-ish timestamp>.sql */
const dump = (stamp) => `noema-${stamp}.sql`;
const STAMPS = [
  "2026-10-13T21-09-10",
  "2026-10-13T21-09-23",
  "2026-10-14T08-00-00",
  "2026-10-14T09-30-15",
  "2026-10-15T07-45-30",
];

/* ------------------------------------------------------------------ *
 * Row counts — parsed from the dump's COPY blocks
 * ------------------------------------------------------------------ */

describe("parseRowCounts", () => {
  it("counts the data rows of every COPY block", () => {
    expect(parseRowCounts(SAMPLE_DUMP)).toEqual({ User: 3, Workspace: 2, Page: 1 });
  });

  it("returns an empty object for a dump with no COPY blocks", () => {
    expect(parseRowCounts("-- PostgreSQL database dump\n\n")).toEqual({});
    expect(parseRowCounts("")).toEqual({});
  });

  it("handles schemaless and unquoted COPY headers", () => {
    const dump = ['COPY "User" (id) FROM stdin;', "u1", "\\.", "COPY public.Ticket (id) FROM stdin;", "t1", "t2", "\\."].join("\n");
    expect(parseRowCounts(dump)).toEqual({ User: 1, Ticket: 2 });
  });

  it("stops counting at the data terminator, not at COPY-looking rows", () => {
    const dump = [
      'COPY public."Page" (id) FROM stdin;',
      "p1",
      "\\.",
      "",
      'COPY public."Trash" (id) FROM stdin;',
      "\\.",
    ].join("\n");
    expect(parseRowCounts(dump)).toEqual({ Page: 1, Trash: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * Schema / app version fingerprint
 * ------------------------------------------------------------------ */

describe("schemaFingerprint", () => {
  it("is deterministic for identical schema text", () => {
    expect(schemaFingerprint("model User {}")).toBe(schemaFingerprint("model User {}"));
  });

  it("returns 12 lowercase hex characters", () => {
    expect(schemaFingerprint("model User {}")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when the schema changes", () => {
    expect(schemaFingerprint("model User {}")).not.toBe(schemaFingerprint("model User { id String }"));
  });
});

/* ------------------------------------------------------------------ *
 * Manifest — timestamp, row counts, schema/app version
 * ------------------------------------------------------------------ */

describe("buildManifest", () => {
  const input = {
    timestamp: "2026-10-15T07:45:30.123Z",
    file: "noema-2026-10-15T07-45-30.sql",
    sizeBytes: 232591,
    rowCounts: { User: 3, Workspace: 2, Page: 1 },
    schemaVersion: "a1b2c3d4e5f6",
    appVersion: "0.1.0",
    keep: 5,
  };

  it("records timestamp, file, size, row counts and schema/app version", () => {
    expect(buildManifest(input)).toEqual({
      timestamp: "2026-10-15T07:45:30.123Z",
      file: "noema-2026-10-15T07-45-30.sql",
      sizeBytes: 232591,
      schemaVersion: "a1b2c3d4e5f6",
      appVersion: "0.1.0",
      keep: 5,
      rowCounts: { User: 3, Workspace: 2, Page: 1 },
      rowCountTotal: 6,
    });
  });

  it("sums rowCountTotal across every table", () => {
    const manifest = buildManifest({ ...input, rowCounts: { User: 10, Page: 32 } });
    expect(manifest.rowCountTotal).toBe(42);
    expect(buildManifest({ ...input, rowCounts: {} }).rowCountTotal).toBe(0);
  });

  it("does not mutate the rowCounts it is given", () => {
    const rowCounts = { User: 3 };
    buildManifest({ ...input, rowCounts });
    expect(rowCounts).toEqual({ User: 3 });
  });
});

/* ------------------------------------------------------------------ *
 * Retention — keep N, never prune the newest
 * ------------------------------------------------------------------ */

describe("isBackupDump / manifestNameFor", () => {
  it("recognises only noema-*.sql dumps", () => {
    expect(isBackupDump(dump(STAMPS[0]))).toBe(true);
    expect(isBackupDump("noema-2026-10-15.manifest.json")).toBe(false);
    expect(isBackupDump("README.md")).toBe(false);
    expect(isBackupDump("other.sql")).toBe(false);
  });

  it("maps a dump to its manifest file", () => {
    expect(manifestNameFor(dump(STAMPS[0]))).toBe("noema-2026-10-13T21-09-10.manifest.json");
    expect(manifestNameFor("noema-x.sql")).toBe("noema-x.manifest.json");
  });
});

describe("planRetention", () => {
  it("keeps the newest N dumps and prunes the rest", () => {
    const names = STAMPS.map(dump);
    const plan = planRetention(names, 2);
    expect(plan.retained).toEqual([dump(STAMPS[4]), dump(STAMPS[3])]);
    expect(plan.prunable).toEqual([dump(STAMPS[2]), dump(STAMPS[1]), dump(STAMPS[0])]);
    expect(plan.keep).toBe(2);
  });

  it("sorts an unsorted input newest-first before splitting", () => {
    const shuffled = [dump(STAMPS[2]), dump(STAMPS[4]), dump(STAMPS[0]), dump(STAMPS[3]), dump(STAMPS[1])];
    const plan = planRetention(shuffled, 3);
    expect(plan.retained).toEqual([dump(STAMPS[4]), dump(STAMPS[3]), dump(STAMPS[2])]);
    expect(plan.prunable).toEqual([dump(STAMPS[1]), dump(STAMPS[0])]);
  });

  it("never prunes the newest dump, whatever keep says", () => {
    const names = STAMPS.map(dump);
    for (const keep of [0, -3, 0.5, Number.NaN, undefined]) {
      const plan = planRetention(names, keep);
      expect(plan.prunable).not.toContain(dump(STAMPS[4]));
      expect(plan.retained[0]).toBe(dump(STAMPS[4]));
    }
  });

  it("falls back to the default keep for invalid values and clamps fractions", () => {
    const names = STAMPS.map(dump);
    expect(planRetention(names, "banana").keep).toBe(DEFAULT_KEEP);
    expect(planRetention(names, undefined).keep).toBe(DEFAULT_KEEP);
    expect(planRetention(names, 2.9).keep).toBe(2);
    expect(planRetention(names, 0).keep).toBe(1); // "keep only the newest"
    expect(planRetention(names, 99).prunable).toEqual([]);
  });

  it("ignores files that are not dumps (manifests, notes)", () => {
    const names = [...STAMPS.map(dump), dump(STAMPS[4]).replace(".sql", ".manifest.json"), "README.md"];
    const plan = planRetention(names, 1);
    expect(plan.retained).toEqual([dump(STAMPS[4])]);
    expect(plan.prunable).toEqual([dump(STAMPS[3]), dump(STAMPS[2]), dump(STAMPS[1]), dump(STAMPS[0])]);
    for (const name of plan.retained.concat(plan.prunable)) expect(isBackupDump(name)).toBe(true);
  });

  it("prunes nothing when the directory is empty", () => {
    expect(planRetention([], 5)).toEqual({ keep: 5, retained: [], prunable: [] });
  });
});

/* ------------------------------------------------------------------ *
 * Dry-run — the plan, printed, touching nothing
 * ------------------------------------------------------------------ */

describe("formatDryRunPlan", () => {
  const plan = planRetention(STAMPS.map(dump), 2);
  const text = formatDryRunPlan({
    root: "C:/app",
    database: "noema",
    host: "localhost",
    port: "5432",
    dumper: { kind: "docker", container: "noema-db" },
    target: "C:/app/backups/noema-2026-10-15T07-45-30.sql",
    keep: plan.keep,
    retained: plan.retained,
    prunable: plan.prunable,
  });

  it("declares that nothing is touched", () => {
    expect(text).toContain("DRY RUN");
    expect(text).toContain("nothing will be written or removed");
  });

  it("shows the dump source and target", () => {
    expect(text).toContain('database "noema"');
    expect(text).toContain("localhost:5432");
    expect(text).toContain("noema-db");
    expect(text).toContain("backups/noema-2026-10-15T07-45-30.sql");
  });

  it("shows the retention preview: what would be removed and what would be kept", () => {
    expect(text).toContain("keep 2");
    expect(text).toContain("would remove");
    expect(text).toContain(dump(STAMPS[0]));
    expect(text).toContain(dump(STAMPS[4]));
    // the newest dump is never on the removal list
    const removalSection = text.slice(text.indexOf("would remove"));
    expect(removalSection).not.toContain(dump(STAMPS[4]));
  });

  it("mentions the manifest and the restore-verification note", () => {
    expect(text).toContain("manifest.json");
    expect(text).toContain("restore");
  });

  it("reports a missing pg_dump as a would-fail condition", () => {
    const failing = formatDryRunPlan({
      root: "C:/app",
      database: "noema",
      host: "localhost",
      port: "5432",
      dumper: null,
      target: "C:/app/backups/noema-x.sql",
      keep: 5,
      retained: [],
      prunable: [],
    });
    expect(failing).toContain("no pg_dump");
    expect(failing).toContain("would FAIL");
  });
});
