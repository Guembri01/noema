// Planning and run logic for the B05 one-off backfill of the TOTP seeds.
//
// The CLI (`scripts/backfill-2fa-secrets.mjs`) owns the process and the
// database: it reads the rows and it writes the envelopes. This module owns
// the RUN — it decides what happens to a row, whether the run may write at
// all, and what the report says — and it reaches the database only through
// the callbacks it is handed. Every rule below is therefore unit-tested
// without a database.
//
// Three rules drive everything here:
//
//   1. IDEMPOTENT — a row that already holds a sealed envelope (`v1:` or `v2:`
//      prefix) is never touched again, so the script can be run as often as an
//      operator likes.
//   2. FAIL-CLOSED — a row that cannot be re-sealed (no `AUTH_SECRET`, a
//      sealing error, an envelope that does not open back to the same seed) is
//      NEVER deleted and NEVER overwritten. It stays exactly as it is and is
//      reported instead, so a broken row can be inspected by a human.
//   3. BOUNDED — the state the run keeps never grows with the number of rows
//      in the table: the plan of a batch is applied and dropped before the next
//      batch is read, and the rows that need a human are capped at
//      MAX_REPORTED_PROBLEMS — the rest is only COUNTED.

/** Version prefix of an AES-256-GCM envelope (`v1:<iv>:<tag>:<payload>`). */
export const ENVELOPE_PREFIX = "v1:";

/**
 * Every prefix that marks a value as an envelope.
 *
 * A value that carries one of them is a SEALED seed and is untouchable — the
 * backfill never rewrites a row it did not write itself. `v2:` is the
 * keyring envelope (`src/lib/secrets.ts`), so a row that already holds one is
 * left alone even though this script cannot open it.
 */
export const ENVELOPE_PREFIXES = ["v1:", "v2:"];

/**
 * How many rows the runner reads (and holds in memory) at a time. The
 * backfill walks the table in batches of this size, so its memory use stays
 * bounded no matter how many accounts carry a seed.
 */
export const BATCH_SIZE = 250;

/**
 * How many rows that need a human the run keeps.
 *
 * A table can hold a problem on every single row (a rotated `AUTH_SECRET`,
 * say). The state keeps the FIRST `MAX_REPORTED_PROBLEMS` rows of each kind
 * and counts the rest, so neither the memory nor the printed report grows
 * with the number of problem rows.
 */
export const MAX_REPORTED_PROBLEMS = 100;

/**
 * How many already-sealed rows the runner probes before it starts writing.
 * The probe answers one question: does the `AUTH_SECRET` of THIS environment
 * open the envelopes that are already stored?
 */
export const ENVELOPE_KEY_PROBE_ROWS = 20;

/**
 * The flag that lets an operator confirm the key by hand.
 *
 * Without it the run refuses to write when it cannot prove that the
 * `AUTH_SECRET` of this environment is the key the app uses (see
 * `assessEnvelopeKey`). With it the run continues anyway — the operator has
 * verified the key outside the database.
 */
export const KEY_CONFIRMATION_FLAG = "--confirm-key";

/**
 * The other columns that hold an envelope sealed with the SAME key.
 *
 * `AUTH_SECRET` derives one envelope key for the whole project
 * (`src/lib/secrets.ts`: `sha256("noema:ai-provider:v1:" + AUTH_SECRET)`), so
 * every value in these columns is evidence about the key — evidence that does
 * NOT depend on the two-factor table. That matters: a table that holds nothing
 * but legacy cleartext rows (a fresh rollout, or a secret rotated before the
 * rollout) cannot prove anything about the key on its own.
 */
export const OTHER_ENVELOPE_COLUMNS = [
  {
    label: "AiProviderConfig.apiKeyEncrypted",
    model: "aiProviderConfig",
    field: "apiKeyEncrypted",
  },
  {
    label: "EmailConfig.passwordEncrypted",
    model: "emailConfig",
    field: "passwordEncrypted",
  },
];

/** True when the stored value is a sealed envelope rather than a raw seed. */
export function isSealedValue(stored) {
  return (
    typeof stored === "string" &&
    ENVELOPE_PREFIXES.some((prefix) => stored.startsWith(prefix))
  );
}

/**
 * True when the stored value is an envelope this environment's key can open.
 *
 * Only the `v1:` envelope is derived from `AUTH_SECRET`; the `v2:` keyring
 * envelope is not, so it is evidence of nothing either way.
 */
export function isV1Envelope(stored) {
  return typeof stored === "string" && stored.startsWith(ENVELOPE_PREFIX);
}

/**
 * Open a stored value without ever throwing.
 *
 * @param {(stored: string) => { kind: string, secret: string | null }} open
 * @param {string} stored
 */
function safeOpen(open, stored) {
  try {
    return open(stored);
  } catch {
    return { kind: "unreadable", secret: null };
  }
}

/**
 * Pre-flight: does the key of THIS environment open the envelopes that are
 * already in the two-factor table?
 *
 * @param {ReadonlyArray<{ id: string, twoFactorSecret?: string | null }>} rows
 * @param {(stored: string) => { kind: string, secret: string | null }} open
 * @returns {{ checked: number, opened: number }}
 */
export function checkExistingEnvelopes(rows, open) {
  let checked = 0;
  let opened = 0;
  for (const row of rows ?? []) {
    const stored = row?.twoFactorSecret;
    if (!isV1Envelope(stored)) continue;
    checked += 1;
    const result = safeOpen(open, stored);
    if (result?.kind === "sealed") opened += 1;
  }
  return { checked, opened };
}

/**
 * Pre-flight: does the key of THIS environment open the envelopes in the
 * OTHER sealed columns (the AI provider keys, the SMTP password)?
 *
 * Those columns are sealed with the same key, so they are evidence about the
 * key even when the two-factor table holds nothing but legacy cleartext rows.
 *
 * @param {ReadonlyArray<{ label: string, values: ReadonlyArray<string | null> }>} columns
 * @param {(stored: string) => { kind: string, secret: string | null }} open
 * @returns {ReadonlyArray<{ label: string, checked: number, opened: number }>}
 */
export function checkEnvelopeColumns(columns, open) {
  const results = [];
  for (const column of columns ?? []) {
    let checked = 0;
    let opened = 0;
    for (const value of column?.values ?? []) {
      if (!isV1Envelope(value)) continue;
      checked += 1;
      const result = safeOpen(open, value);
      if (result?.kind === "sealed") opened += 1;
    }
    results.push({
      label: column?.label ?? "unknown column",
      checked,
      opened,
    });
  }
  return results;
}

/**
 * Decide whether the envelope key of THIS environment is confirmed.
 *
 * The key is confirmed when at least ONE envelope in the database opens with
 * it — a sealed two-factor row, or a value in one of the other sealed
 * columns. Without that evidence the run would seal the cleartext rows with a
 * key the app cannot open, and those accounts would be locked out of their
 * second factor for good.
 *
 * @param {{
 *   twoFactor?: { checked: number, opened: number },
 *   other?: ReadonlyArray<{ label: string, checked: number, opened: number }>,
 * }} probes
 * @returns {{ confirmed: boolean, reason: string }}
 */
export function assessEnvelopeKey(probes) {
  const twoFactor = probes?.twoFactor ?? { checked: 0, opened: 0 };
  if ((twoFactor.opened ?? 0) > 0) {
    return {
      confirmed: true,
      reason: `${twoFactor.opened} of ${twoFactor.checked} sealed two-factor row(s) opened with this AUTH_SECRET`,
    };
  }
  const opened = (probes?.other ?? []).filter((column) => (column?.opened ?? 0) > 0);
  if (opened.length > 0) {
    return {
      confirmed: true,
      reason: `${opened.map((column) => column.label).join(", ")} opened with this AUTH_SECRET`,
    };
  }
  return {
    confirmed: false,
    reason: "no envelope in the database opened with this AUTH_SECRET",
  };
}

/**
 * The evidence the pre-flight collected — for the operator, when the run
 * refuses to write.
 *
 * @param {{
 *   twoFactor?: { checked: number, opened: number },
 *   other?: ReadonlyArray<{ label: string, checked: number, opened: number }>,
 * }} probes
 * @returns {string}
 */
export function describeKeyEvidence(probes) {
  const twoFactor = probes?.twoFactor ?? { checked: 0, opened: 0 };
  const lines = [
    `  ${"User.twoFactorSecret".padEnd(32)} ${twoFactor.checked} sealed row(s), ${twoFactor.opened} opened`,
  ];
  for (const column of probes?.other ?? []) {
    lines.push(
      `  ${String(column?.label ?? "unknown column").padEnd(32)} ${column?.checked ?? 0} sealed value(s), ${column?.opened ?? 0} opened`,
    );
  }
  return lines.join("\n");
}

/**
 * Classify the rows and decide which ones to re-seal.
 *
 * @param {ReadonlyArray<{ id: string, email?: string | null, twoFactorSecret?: string | null }>} rows
 * @param {{
 *   seal: (seed: string) => string,
 *   open: (stored: string) => { kind: string, secret: string | null },
 * }} ops
 * @returns {{
 *   scanned: number,
 *   toSeal: Array<{ id: string, email: string | null, envelope: string }>,
 *   alreadySealed: number,
 *   unreadable: Array<{ id: string, email: string | null, reason: string }>,
 *   failed: Array<{ id: string, email: string | null, reason: string }>,
 * }}
 */
export function planTwoFactorBackfill(rows, ops) {
  const toSeal = [];
  const unreadable = [];
  const failed = [];
  let scanned = 0;
  let alreadySealed = 0;

  for (const row of rows ?? []) {
    const stored = row?.twoFactorSecret;
    // Nothing stored — the account has no seed at all.
    if (!stored) continue;
    scanned += 1;

    // Already sealed: skip it (idempotence). A sealed value that does not
    // open (tampered ciphertext, or an `AUTH_SECRET` that was rotated) is
    // reported, never rewritten: the operator has to decide what to do. A
    // `v2:` envelope belongs to the keyring and is never touched at all.
    if (isSealedValue(stored)) {
      if (!isV1Envelope(stored)) {
        alreadySealed += 1;
        continue;
      }
      const opened = safeOpen(ops.open, stored);
      if (opened?.kind === "sealed") alreadySealed += 1;
      else unreadable.push({ id: row.id, email: row.email ?? null, reason: "not-openable" });
      continue;
    }

    // A pre-B05 cleartext seed. Seal it, then prove the envelope opens back
    // to exactly the same seed before it is allowed near the database.
    let envelope;
    try {
      envelope = ops.seal(stored);
    } catch {
      failed.push({ id: row.id, email: row.email ?? null, reason: "seal-failed" });
      continue;
    }
    if (!isV1Envelope(envelope)) {
      failed.push({ id: row.id, email: row.email ?? null, reason: "invalid-envelope" });
      continue;
    }
    const reopened = safeOpen(ops.open, envelope);
    if (reopened?.kind !== "sealed" || reopened.secret !== stored) {
      failed.push({ id: row.id, email: row.email ?? null, reason: "round-trip-failed" });
      continue;
    }
    toSeal.push({ id: row.id, email: row.email ?? null, envelope });
  }

  return { scanned, toSeal, alreadySealed, unreadable, failed };
}

/**
 * Write the planned envelopes — one row at a time, and never twice.
 *
 * Fail-closed: a write that fails leaves the row exactly as it was (the old
 * cleartext seed is still there — nothing is lost, nothing is overwritten with
 * a half-written value) and the row is reported as `write-failed`. The write
 * is NOT retried: a second attempt could only produce a second envelope for
 * the same row.
 *
 * @param {{ toSeal: ReadonlyArray<{ id: string, email?: string | null, envelope: string }> }} plan
 * @param {(id: string, envelope: string) => Promise<unknown>} write
 * @param {(item: { id: string, email?: string | null, reason: string }, error: unknown) => void} onFailure
 * @returns {Promise<{ written: number, failed: Array<{ id: string, email?: string | null, reason: string }> }>}
 */
export async function applyBackfillPlan(plan, write, onFailure) {
  const failed = [];
  let written = 0;
  for (const item of plan?.toSeal ?? []) {
    try {
      await write(item.id, item.envelope);
      written += 1;
    } catch (error) {
      failed.push({
        id: item.id,
        email: item.email ?? null,
        reason: "write-failed",
      });
      onFailure?.(item, error);
    }
  }
  return { written, failed };
}

/**
 * The state a run keeps while it walks the table.
 *
 * It holds COUNTERS and the first `MAX_REPORTED_PROBLEMS` rows that need a
 * human — never the plans, never the envelopes, never an e-mail address of a
 * row that went well. Its size therefore depends neither on the number of
 * rows in the table nor on the number of rows that need a human: those are
 * only counted.
 */
export function createBackfillState() {
  return {
    scanned: 0,
    planned: 0,
    sealed: 0,
    alreadySealed: 0,
    // The rows that need a human — the first MAX_REPORTED_PROBLEMS of each
    // kind …
    unreadable: [],
    failed: [],
    // … and how many there were in total.
    unreadableCount: 0,
    failedCount: 0,
  };
}

/**
 * Fold ONE batch into the state — and let the batch go.
 *
 * The plan of a batch is applied before the next batch is read, so nothing
 * that grows with the table is kept alive. The rows that need a human are
 * counted, but only the first `MAX_REPORTED_PROBLEMS` of each kind are kept.
 *
 * @param {ReturnType<typeof createBackfillState>} state
 * @param {ReturnType<typeof planTwoFactorBackfill>} plan
 * @param {{ written?: number, failed?: ReadonlyArray<{ id: string, email?: string | null, reason: string }> }} [applied]
 */
export function foldBatchIntoState(state, plan, applied = {}) {
  if (!state) return state;
  state.scanned += plan?.scanned ?? 0;
  state.planned += plan?.toSeal?.length ?? 0;
  state.alreadySealed += plan?.alreadySealed ?? 0;
  state.sealed += applied?.written ?? 0;
  for (const item of plan?.unreadable ?? []) {
    state.unreadableCount += 1;
    if (state.unreadable.length < MAX_REPORTED_PROBLEMS) {
      state.unreadable.push({ ...item, kind: "unreadable" });
    }
  }
  for (const item of plan?.failed ?? []) {
    state.failedCount += 1;
    if (state.failed.length < MAX_REPORTED_PROBLEMS) {
      state.failed.push({ ...item, kind: "failed" });
    }
  }
  for (const item of applied?.failed ?? []) {
    state.failedCount += 1;
    if (state.failed.length < MAX_REPORTED_PROBLEMS) {
      state.failed.push({ ...item, kind: "failed" });
    }
  }
  return state;
}

/**
 * Run the backfill.
 *
 * The order is the whole point of this function:
 *
 *   1. the key is PROVEN first — the run writes nothing at all when it cannot
 *      prove that the `AUTH_SECRET` of this environment is the key the app
 *      uses, unless the operator confirmed it by hand
 *      (`${KEY_CONFIRMATION_FLAG}`);
 *   2. the table is walked in batches, and the plan of a batch is applied and
 *      dropped before the next batch is read;
 *   3. the report says what happened — and, in a dry run, that nothing was
 *      written.
 *
 * @param {{
 *   readTwoFactorProbe: () => Promise<ReadonlyArray<{ id: string, twoFactorSecret?: string | null }>>,
 *   readOtherEnvelopes: () => Promise<ReadonlyArray<{ label: string, values: ReadonlyArray<string | null> }>>,
 *   readBatch: (cursor: string | undefined) => Promise<ReadonlyArray<{ id: string, email?: string | null, twoFactorSecret?: string | null }>>,
 *   write: (id: string, envelope: string) => Promise<unknown>,
 *   seal: (seed: string) => string,
 *   open: (stored: string) => { kind: string, secret: string | null },
 *   confirmKey?: boolean,
 *   dryRun?: boolean,
 *   log?: (message: string) => void,
 *   error?: (message: string) => void,
 * }} options
 * @returns {Promise<{ exitCode: number }>}
 */
export async function runBackfill(options) {
  const {
    readTwoFactorProbe,
    readOtherEnvelopes,
    readBatch,
    write,
    seal,
    open,
    confirmKey = false,
    dryRun = false,
    log = console.log,
    error = console.error,
  } = options ?? {};

  // ---------------------------------------------------------------------
  // 1. The key must be proven before a single row is touched.
  // ---------------------------------------------------------------------
  const twoFactor = checkExistingEnvelopes(await readTwoFactorProbe(), open);
  const other = checkEnvelopeColumns(await readOtherEnvelopes(), open);
  const probes = { twoFactor, other };
  const key = assessEnvelopeKey(probes);

  if (!key.confirmed) {
    if (!confirmKey) {
      error(
        "The AUTH_SECRET of this environment could not be confirmed: no envelope in the\n" +
          "database opens with it. Sealing the cleartext rows with it would lock those\n" +
          "accounts out of their second factor for good, so NOTHING WAS WRITTEN.\n\n" +
          "Checked:\n" +
          `${describeKeyEvidence(probes)}\n\n` +
          "Run the script with the AUTH_SECRET the app uses. If you have verified that\n" +
          `this is the right key, re-run it with ${KEY_CONFIRMATION_FLAG}.`,
      );
      return { exitCode: 1 };
    }
    error(
      `${KEY_CONFIRMATION_FLAG} was given and the operator confirmed the key, but no envelope\n` +
        "in the database opens with it:\n" +
        `${describeKeyEvidence(probes)}\n` +
        "The run continues — a wrong key here locks the accounts out for good.",
    );
  }

  // ---------------------------------------------------------------------
  // 2. The table, in batches. The plan of a batch does not outlive it.
  // ---------------------------------------------------------------------
  const state = createBackfillState();
  let cursor;
  for (;;) {
    const rows = await readBatch(cursor);
    if (!rows || rows.length === 0) break;
    const plan = planTwoFactorBackfill(rows, { seal, open });
    let applied = { written: 0, failed: [] };
    if (!dryRun) {
      applied = await applyBackfillPlan(plan, write, (item, failure) => {
        error(
          `  FAILED   ${item.email ?? item.id} — write failed: ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        );
      });
    }
    foldBatchIntoState(state, plan, applied);
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) break;
  }

  // ---------------------------------------------------------------------
  // 3. The report.
  // ---------------------------------------------------------------------
  const unreadable = state.unreadable;
  const failed = state.failed;

  log(`two-factor seed backfill${dryRun ? " (dry run — nothing was written)" : ""}`);
  log(`  scanned  ${state.scanned} row(s) with a stored seed`);
  log(
    dryRun
      ? `  would seal ${state.planned} row(s)`
      : `  sealed   ${state.sealed} row(s)`,
  );
  log(`  skipped  ${state.alreadySealed} row(s) already sealed`);

  // The report lists the first MAX_REPORTED_PROBLEMS rows of each kind and
  // then the total — a table with a problem on every row must not produce a
  // report with a line per account.
  if (state.unreadableCount > 0) {
    log(`  UNREADABLE ${state.unreadableCount} row(s) — left untouched:`);
    for (const item of unreadable) {
      log(
        `    ${item.email ?? item.id} — the envelope does not open (rotated AUTH_SECRET? tampered row?)`,
      );
    }
    const more = state.unreadableCount - unreadable.length;
    if (more > 0) log(`    … and ${more} more`);
  }

  if (state.failedCount > 0) {
    log(`  FAILED   ${state.failedCount} row(s) — left untouched (cleartext):`);
    for (const item of failed) {
      log(`    ${item.email ?? item.id} — ${item.reason}`);
    }
    const more = state.failedCount - failed.length;
    if (more > 0) log(`    … and ${more} more`);
  }

  // Anything left behind needs a human: the run is not a clean sweep.
  if (state.unreadableCount > 0 || state.failedCount > 0) {
    error(
      "\nSome rows still need a look. They were not deleted and not overwritten —\n" +
        "the account owner has to re-enrol two-factor authentication (or an\n" +
        "operator has to restore the matching AUTH_SECRET).",
    );
    return { exitCode: 1 };
  }

  log(dryRun ? "\nNothing was written (dry run)." : "\nEvery stored TOTP seed is sealed.");
  return { exitCode: 0 };
}
