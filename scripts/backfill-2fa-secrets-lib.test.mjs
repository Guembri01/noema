// Unit tests for the B05 backfill (`scripts/backfill-2fa-secrets-lib.mjs`).
//
// The library owns the decisions of the run, so every rule is pinned here
// without a database:
//   - the key must be PROVEN before a row is written (a rotated AUTH_SECRET
//     must not seal anything);
//   - the run is idempotent (a sealed row is never touched again) and
//     fail-closed (a row that cannot be re-sealed is never deleted and never
//     overwritten — it is only reported);
//   - the state of a run does not grow with the number of rows in the table.
import { describe, expect, it, vi } from "vitest";

import {
  BATCH_SIZE,
  ENVELOPE_PREFIX,
  KEY_CONFIRMATION_FLAG,
  applyBackfillPlan,
  assessEnvelopeKey,
  checkEnvelopeColumns,
  checkExistingEnvelopes,
  createBackfillState,
  foldBatchIntoState,
  isSealedValue,
  planTwoFactorBackfill,
  runBackfill,
} from "./backfill-2fa-secrets-lib.mjs";

const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const OTHER_SEED = "KRSXG5DSNFXGOIDBKRSXG5DSNFXGOIDB";

/**
 * How many rows that need a human the run keeps.
 *
 * The same number as `MAX_REPORTED_PROBLEMS` in the library — written out
 * here on purpose: the limit is part of the contract of the report, so it is
 * pinned, not mirrored.
 */
const PROBLEM_LIMIT = 100;

/** The shape the stand-in sealer produces: `v1:iv:tag:<seed>`. */
const ENVELOPE_SHAPE = `${ENVELOPE_PREFIX}iv:tag:`;

/** A stand-in for `encryptTwoFactorSecret` / `openTwoFactorSecret`. */
function ops(overrides = {}) {
  const seal = overrides.seal ?? ((seed) => `${ENVELOPE_SHAPE}${seed}`);
  const open =
    overrides.open ??
    ((stored) =>
      stored.startsWith(ENVELOPE_SHAPE)
        ? { kind: "sealed", secret: stored.slice(ENVELOPE_SHAPE.length) }
        : { kind: "legacy", secret: stored });
  return { seal, open };
}

/**
 * A stand-in for the envelope, keyed: only the envelope written under the
 * right key opens again — exactly what a rotated `AUTH_SECRET` does to the
 * envelopes of a database.
 */
function keyedOps(key) {
  const prefix = `${ENVELOPE_PREFIX}${key}:`;
  return {
    seal: (seed) => `${prefix}${seed}`,
    open: (stored) => {
      if (typeof stored !== "string") return { kind: "unreadable", secret: null };
      if (stored.startsWith(prefix)) {
        return { kind: "sealed", secret: stored.slice(prefix.length) };
      }
      if (stored.startsWith(ENVELOPE_PREFIX)) {
        return { kind: "unreadable", secret: null };
      }
      return { kind: "legacy", secret: stored };
    },
  };
}

/**
 * A stand-in for the database: the rows, the other sealed columns and the
 * writes the run made.
 *
 * `other` maps a column label to the sealed values it holds — the CLI probes
 * BOTH columns of the schema, whether they hold anything or not, so the fake
 * does the same.
 */
function fakeDatabase({ users = [], other = {} } = {}) {
  const rows = users.map((row) => ({ ...row }));
  const writes = [];
  return {
    rows,
    writes,
    other,
    readTwoFactorProbe: async () =>
      rows.filter((row) => String(row.twoFactorSecret ?? "").startsWith(ENVELOPE_PREFIX)),
    readOtherEnvelopes: async () => [
      {
        label: "AiProviderConfig.apiKeyEncrypted",
        values: other["AiProviderConfig.apiKeyEncrypted"] ?? [],
      },
      {
        label: "EmailConfig.passwordEncrypted",
        values: other["EmailConfig.passwordEncrypted"] ?? [],
      },
    ],
    readBatch: async (cursor) => {
      const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      return rows.slice(start, start + BATCH_SIZE);
    },
    write: async (id, envelope) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error(`no such row: ${id}`);
      row.twoFactorSecret = envelope;
      writes.push({ id, envelope });
    },
  };
}

/** Collects what the run prints. */
function recorder() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (message) => out.push(message),
    error: (message) => err.push(message),
    printed: () => [...out, ...err].join("\n"),
  };
}

describe("isSealedValue", () => {
  it("recognises the envelope prefix", () => {
    expect(isSealedValue(`${ENVELOPE_PREFIX}iv:tag:payload`)).toBe(true);
  });

  it("recognises a v2 envelope as sealed too — it is untouchable", () => {
    expect(isSealedValue("v2:1:iv:tag:payload")).toBe(true);
  });

  it("treats a raw base32 seed as unsealed", () => {
    expect(isSealedValue(SEED)).toBe(false);
  });

  it("is false for an empty or missing value", () => {
    expect(isSealedValue("")).toBe(false);
    expect(isSealedValue(null)).toBe(false);
    expect(isSealedValue(undefined)).toBe(false);
  });
});

describe("planTwoFactorBackfill", () => {
  it("re-seals a cleartext seed", () => {
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: SEED }],
      ops(),
    );
    expect(plan.toSeal).toHaveLength(1);
    expect(plan.toSeal[0].id).toBe("u1");
    expect(plan.toSeal[0].envelope).toContain(SEED);
    expect(plan.failed).toHaveLength(0);
  });

  it("is idempotent — a sealed row is skipped, not re-sealed", () => {
    const sealed = `${ENVELOPE_PREFIX}iv:tag:payload`;
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: sealed }],
      ops(),
    );
    expect(plan.toSeal).toHaveLength(0);
    expect(plan.alreadySealed).toBe(1);
    expect(plan.failed).toHaveLength(0);
  });

  it("never touches a v2 envelope — it is sealed and therefore untouchable", () => {
    const seal = vi.fn((seed) => `${ENVELOPE_SHAPE}${seed}`);
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: "v2:1:iv:tag:payload" }],
      ops({ seal }),
    );
    // The row must not be sealed again — its payload would be the literal
    // string "v2:1:iv:tag:payload" and the account would be locked out.
    expect(plan.toSeal).toHaveLength(0);
    expect(seal).not.toHaveBeenCalled();
    expect(plan.alreadySealed).toBe(1);
    expect(plan.unreadable).toHaveLength(0);
    expect(plan.failed).toHaveLength(0);
  });

  it("ignores a row without a stored seed", () => {
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: null }],
      ops(),
    );
    expect(plan.toSeal).toHaveLength(0);
    expect(plan.alreadySealed).toBe(0);
    expect(plan.unreadable).toHaveLength(0);
    expect(plan.failed).toHaveLength(0);
  });

  it("fails closed when the seed cannot be sealed (no AUTH_SECRET)", () => {
    const seal = vi.fn(() => {
      throw new Error("AUTH_SECRET is required to store provider keys.");
    });
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: SEED }],
      ops({ seal }),
    );
    expect(plan.toSeal).toHaveLength(0);
    expect(plan.failed).toEqual([
      { id: "u1", email: null, reason: "seal-failed" },
    ]);
    expect(seal).toHaveBeenCalledWith(SEED);
  });

  it("fails closed when the new envelope does not open back to the same seed", () => {
    const seal = vi.fn(() => `${ENVELOPE_PREFIX}iv:tag:${OTHER_SEED}`);
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: SEED }],
      ops({ seal }),
    );
    expect(plan.toSeal).toHaveLength(0);
    expect(plan.failed).toEqual([
      { id: "u1", email: null, reason: "round-trip-failed" },
    ]);
  });

  it("fails closed when sealing returns something that is not an envelope", () => {
    const seal = vi.fn(() => SEED);
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: SEED }],
      ops({ seal }),
    );
    expect(plan.toSeal).toHaveLength(0);
    expect(plan.failed).toEqual([
      { id: "u1", email: null, reason: "invalid-envelope" },
    ]);
  });

  it("reports a sealed row that does not open and never rewrites it", () => {
    const open = vi.fn(() => ({ kind: "unreadable", secret: null }));
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: `${ENVELOPE_PREFIX}iv:tag:payload` }],
      ops({ open }),
    );
    expect(plan.toSeal).toHaveLength(0);
    expect(plan.alreadySealed).toBe(0);
    expect(plan.unreadable).toEqual([
      { id: "u1", email: null, reason: "not-openable" },
    ]);
  });

  it("survives an opener that throws", () => {
    const open = vi.fn(() => {
      throw new Error("boom");
    });
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: `${ENVELOPE_PREFIX}iv:tag:payload` }],
      ops({ open }),
    );
    expect(plan.unreadable).toEqual([
      { id: "u1", email: null, reason: "not-openable" },
    ]);
  });

  it("classifies every row of a mixed batch exactly once", () => {
    const plan = planTwoFactorBackfill(
      [
        { id: "clear", twoFactorSecret: SEED },
        { id: "sealed", twoFactorSecret: `${ENVELOPE_PREFIX}iv:tag:payload` },
        { id: "empty", twoFactorSecret: null },
      ],
      ops(),
    );
    expect(plan.toSeal.map((item) => item.id)).toEqual(["clear"]);
    expect(plan.alreadySealed).toBe(1);
    expect(plan.failed).toHaveLength(0);
    expect(plan.unreadable).toHaveLength(0);
  });
});

describe("checkExistingEnvelopes", () => {
  it("counts the sealed rows that open with the current key", () => {
    const result = checkExistingEnvelopes(
      [
        { id: "a", twoFactorSecret: `${ENVELOPE_PREFIX}iv:tag:payload` },
        { id: "b", twoFactorSecret: SEED },
        { id: "c", twoFactorSecret: null },
      ],
      ops().open,
    );
    expect(result).toEqual({ checked: 1, opened: 1 });
  });

  it("reports that no sealed row opens when the key is the wrong one", () => {
    const result = checkExistingEnvelopes(
      [{ id: "a", twoFactorSecret: `${ENVELOPE_PREFIX}iv:tag:payload` }],
      () => ({ kind: "unreadable", secret: null }),
    );
    expect(result).toEqual({ checked: 1, opened: 0 });
  });

  it("has nothing to check when the table holds no envelope yet", () => {
    const result = checkExistingEnvelopes(
      [
        { id: "a", twoFactorSecret: SEED },
        { id: "b", twoFactorSecret: null },
      ],
      ops().open,
    );
    expect(result).toEqual({ checked: 0, opened: 0 });
  });

  it("survives an opener that throws", () => {
    const result = checkExistingEnvelopes(
      [{ id: "a", twoFactorSecret: `${ENVELOPE_PREFIX}iv:tag:payload` }],
      () => {
        throw new Error("boom");
      },
    );
    expect(result).toEqual({ checked: 1, opened: 0 });
  });
});

describe("checkEnvelopeColumns", () => {
  it("counts the envelopes of the other columns that open with the current key", () => {
    const result = checkEnvelopeColumns(
      [{ label: "AiProviderConfig.apiKeyEncrypted", values: [`${ENVELOPE_PREFIX}iv:tag:payload`] }],
      ops().open,
    );
    expect(result).toEqual([
      { label: "AiProviderConfig.apiKeyEncrypted", checked: 1, opened: 1 },
    ]);
  });

  it("ignores values that are not envelopes", () => {
    const result = checkEnvelopeColumns(
      [{ label: "EmailConfig.passwordEncrypted", values: [null, "", "plain"] }],
      ops().open,
    );
    expect(result).toEqual([
      { label: "EmailConfig.passwordEncrypted", checked: 0, opened: 0 },
    ]);
  });
});

describe("assessEnvelopeKey", () => {
  it("confirms the key when a sealed two-factor row opens", () => {
    const result = assessEnvelopeKey({
      twoFactor: { checked: 3, opened: 1 },
      other: [],
    });
    expect(result.confirmed).toBe(true);
  });

  it("confirms the key when another sealed column opens", () => {
    const result = assessEnvelopeKey({
      twoFactor: { checked: 0, opened: 0 },
      other: [{ label: "AiProviderConfig.apiKeyEncrypted", checked: 1, opened: 1 }],
    });
    expect(result.confirmed).toBe(true);
  });

  it("does NOT confirm the key when nothing opens — the table alone proves nothing", () => {
    const result = assessEnvelopeKey({
      twoFactor: { checked: 0, opened: 0 },
      other: [
        { label: "AiProviderConfig.apiKeyEncrypted", checked: 1, opened: 0 },
        { label: "EmailConfig.passwordEncrypted", checked: 0, opened: 0 },
      ],
    });
    expect(result.confirmed).toBe(false);
  });
});

describe("applyBackfillPlan", () => {
  it("writes every planned envelope", async () => {
    const write = vi.fn(async () => {});
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: SEED }],
      ops(),
    );

    const result = await applyBackfillPlan(plan, write, () => {});

    expect(result.written).toBe(1);
    expect(result.failed).toEqual([]);
    expect(write).toHaveBeenCalledWith("u1", plan.toSeal[0].envelope);
  });

  it("writes nothing when the plan is empty", async () => {
    const write = vi.fn(async () => {});
    const result = await applyBackfillPlan(
      { toSeal: [] },
      write,
      () => {},
    );
    expect(result.written).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("fails closed on a write error — the row is reported, not retried", async () => {
    const write = vi.fn(async () => {
      throw new Error("database is gone");
    });
    const onFailure = vi.fn();
    const plan = planTwoFactorBackfill(
      [{ id: "u1", twoFactorSecret: SEED }],
      ops(),
    );

    const result = await applyBackfillPlan(plan, write, onFailure);

    // The write was attempted exactly once: a second attempt could only
    // produce a second envelope for the same row.
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.written).toBe(0);
    expect(result.failed).toEqual([
      { id: "u1", email: null, reason: "write-failed" },
    ]);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("keeps going after a failed write — the other rows are still sealed", async () => {
    const write = vi.fn(async (id) => {
      if (id === "bad") throw new Error("nope");
    });
    const plan = {
      toSeal: [
        { id: "bad", email: null, envelope: `${ENVELOPE_PREFIX}iv:tag:one` },
        { id: "good", email: null, envelope: `${ENVELOPE_PREFIX}iv:tag:two` },
      ],
    };

    const result = await applyBackfillPlan(plan, write, () => {});

    expect(result.written).toBe(1);
    expect(result.failed).toEqual([
      { id: "bad", email: null, reason: "write-failed" },
    ]);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe("the state of a run", () => {
  it("does not grow with the number of rows in the table", () => {
    const state = createBackfillState();
    const batch = Array.from({ length: BATCH_SIZE }, (_, index) => ({
      id: `u${index}`,
      email: `u${index}@noema.local`,
      twoFactorSecret: SEED,
    }));

    for (let round = 0; round < 40; round += 1) {
      const plan = planTwoFactorBackfill(batch, ops());
      foldBatchIntoState(state, plan, { written: plan.toSeal.length, failed: [] });
    }

    // 40 batches of 250 rows went through the run …
    expect(state.scanned).toBe(BATCH_SIZE * 40);
    expect(state.planned).toBe(BATCH_SIZE * 40);
    expect(state.sealed).toBe(BATCH_SIZE * 40);
    // … and the state holds counters and an empty problem list: no plan, no
    // envelope, no e-mail address of a row that went well.
    expect(state.unreadable).toEqual([]);
    expect(state.failed).toEqual([]);
    expect(Object.keys(state).sort()).toEqual([
      "alreadySealed",
      "failed",
      "failedCount",
      "planned",
      "scanned",
      "sealed",
      "unreadable",
      "unreadableCount",
    ]);
    expect(JSON.stringify(state).length).toBeLessThan(200);
  });

  it("keeps only the rows that need a human", () => {
    const state = createBackfillState();
    const plan = planTwoFactorBackfill(
      [
        { id: "ok", email: "ok@noema.local", twoFactorSecret: SEED },
        { id: "broken", email: "broken@noema.local", twoFactorSecret: OTHER_SEED },
      ],
      ops({
        seal: (seed) => (seed === SEED ? `${ENVELOPE_SHAPE}${seed}` : "not-an-envelope"),
      }),
    );
    foldBatchIntoState(state, plan, { written: 0, failed: [] });

    expect(state.failed).toEqual([
      {
        id: "broken",
        email: "broken@noema.local",
        reason: "invalid-envelope",
        kind: "failed",
      },
    ]);
    expect(state.failedCount).toBe(1);
  });

  it("keeps at most PROBLEM_LIMIT rows of each kind and counts the rest", () => {
    // A table with a problem on EVERY row must not make the state (and with
    // it the report) grow with the number of accounts.
    const state = createBackfillState();
    const rows = Array.from({ length: PROBLEM_LIMIT * 3 }, (_, index) => ({
      id: `u${index}`,
      email: `u${index}@noema.local`,
      twoFactorSecret: `${ENVELOPE_PREFIX}iv:tag:payload`,
    }));
    const plan = planTwoFactorBackfill(
      rows,
      ops({ open: () => ({ kind: "unreadable", secret: null }) }),
    );
    foldBatchIntoState(state, plan, { written: 0, failed: [] });

    expect(state.unreadable).toHaveLength(PROBLEM_LIMIT);
    expect(state.unreadableCount).toBe(PROBLEM_LIMIT * 3);
    expect(state.failed).toHaveLength(0);
    expect(state.failedCount).toBe(0);
  });
});

describe("runBackfill — the key must be proven before a row is written", () => {
  const APP_KEY = "app-key";
  const ROTATED_KEY = "rotated-key";

  it("refuses to seal when the table holds only legacy rows and no other envelope exists", async () => {
    const db = fakeDatabase({
      users: [
        { id: "u1", email: "a@noema.local", twoFactorSecret: SEED },
        { id: "u2", email: "b@noema.local", twoFactorSecret: OTHER_SEED },
      ],
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps(ROTATED_KEY).seal,
      open: keyedOps(ROTATED_KEY).open,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(1);
    // Nothing was written — not one row.
    expect(db.writes).toHaveLength(0);
    expect(db.rows[0].twoFactorSecret).toBe(SEED);
    expect(db.rows[1].twoFactorSecret).toBe(OTHER_SEED);
    // The operator is told what was checked and that nothing was written.
    expect(io.printed()).toContain("NOTHING WAS WRITTEN");
    expect(io.printed()).toContain("User.twoFactorSecret");
    expect(io.printed()).toContain("AiProviderConfig.apiKeyEncrypted");
    expect(io.printed()).toContain("EmailConfig.passwordEncrypted");
    expect(io.printed()).toContain(KEY_CONFIRMATION_FLAG);
  });

  it("seals the legacy rows when the operator confirms the key by hand", async () => {
    const db = fakeDatabase({
      users: [
        { id: "u1", email: "a@noema.local", twoFactorSecret: SEED },
        { id: "u2", email: "b@noema.local", twoFactorSecret: OTHER_SEED },
      ],
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps(APP_KEY).seal,
      open: keyedOps(APP_KEY).open,
      confirmKey: true,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(0);
    expect(db.writes).toHaveLength(2);
    expect(db.rows[0].twoFactorSecret).toContain(SEED);
    expect(db.rows[1].twoFactorSecret).toContain(OTHER_SEED);
  });

  it("seals without the confirmation flag when another envelope proves the key", async () => {
    const db = fakeDatabase({
      users: [{ id: "u1", email: "a@noema.local", twoFactorSecret: SEED }],
      other: {
        "AiProviderConfig.apiKeyEncrypted": [
          keyedOps(APP_KEY).seal("sk-the-ai-provider-key"),
        ],
      },
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps(APP_KEY).seal,
      open: keyedOps(APP_KEY).open,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(0);
    expect(db.writes).toHaveLength(1);
    expect(io.printed()).toContain("sealed   1 row(s)");
  });

  it("refuses when the other envelope does not open — the key is rotated", async () => {
    const db = fakeDatabase({
      users: [{ id: "u1", email: "a@noema.local", twoFactorSecret: SEED }],
      other: {
        "AiProviderConfig.apiKeyEncrypted": [
          keyedOps(APP_KEY).seal("sk-the-ai-provider-key"),
        ],
      },
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps(ROTATED_KEY).seal,
      open: keyedOps(ROTATED_KEY).open,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(1);
    expect(db.writes).toHaveLength(0);
    expect(db.rows[0].twoFactorSecret).toBe(SEED);
  });

  it("seals without the confirmation flag when a sealed two-factor row proves the key", async () => {
    const db = fakeDatabase({
      users: [
        {
          id: "u0",
          email: "sealed@noema.local",
          twoFactorSecret: keyedOps(APP_KEY).seal(SEED),
        },
        { id: "u1", email: "a@noema.local", twoFactorSecret: OTHER_SEED },
      ],
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps(APP_KEY).seal,
      open: keyedOps(APP_KEY).open,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(0);
    expect(db.writes).toHaveLength(1);
    expect(io.printed()).toContain("skipped  1 row(s) already sealed");
  });
});

describe("runBackfill — the report", () => {
  it("says that nothing was written in a dry run", async () => {
    const db = fakeDatabase({
      users: [{ id: "u1", email: "a@noema.local", twoFactorSecret: SEED }],
      other: {
        "EmailConfig.passwordEncrypted": [keyedOps("k").seal("smtp-password")],
      },
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps("k").seal,
      open: keyedOps("k").open,
      dryRun: true,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(0);
    expect(db.writes).toHaveLength(0);
    expect(io.printed()).toContain("would seal 1 row(s)");
    expect(io.printed()).toContain("Nothing was written (dry run).");
    expect(io.printed()).not.toContain("Every stored TOTP seed is sealed.");
  });

  it("reports a row that cannot be opened and leaves it untouched", async () => {
    const db = fakeDatabase({
      users: [
        { id: "u0", email: "sealed@noema.local", twoFactorSecret: keyedOps("k").seal(SEED) },
      ],
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps("k").seal,
      // The key of this environment does not open the stored envelope.
      open: keyedOps("other").open,
      confirmKey: true,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(1);
    expect(db.writes).toHaveLength(0);
    expect(io.printed()).toContain("UNREADABLE 1 row(s)");
    expect(io.printed()).toContain("sealed@noema.local");
  });

  it("lists the first problems and the total — not one line per account", async () => {
    const db = fakeDatabase({
      users: Array.from({ length: PROBLEM_LIMIT + 5 }, (_, index) => ({
        id: `u${index}`,
        email: `u${index}@noema.local`,
        twoFactorSecret: keyedOps("k").seal(SEED),
      })),
    });
    const io = recorder();

    const result = await runBackfill({
      ...db,
      seal: keyedOps("k").seal,
      // The key of this environment does not open the stored envelopes.
      open: keyedOps("other").open,
      confirmKey: true,
      log: io.log,
      error: io.error,
    });

    expect(result.exitCode).toBe(1);
    expect(db.writes).toHaveLength(0);
    // The TOTAL is reported …
    expect(io.printed()).toContain(`UNREADABLE ${PROBLEM_LIMIT + 5} row(s)`);
    // … the first rows are listed …
    expect(io.out.filter((line) => line.includes("@noema.local"))).toHaveLength(
      PROBLEM_LIMIT,
    );
    // … and the rest is a single line.
    expect(io.printed()).toContain("… and 5 more");
  });
});
