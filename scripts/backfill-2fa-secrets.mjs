#!/usr/bin/env node
/**
 * B05 — one-off backfill: re-seal the TOTP seeds that are still in cleartext.
 *
 * The two-factor seed is a bearer credential: whoever holds it can mint valid
 * codes for the account. Since B05 the column `User.twoFactorSecret` holds an
 * AES-256-GCM envelope (`v1:<iv>:<tag>:<payload>`) instead of the raw base32
 * seed, so a database dump no longer yields a usable 2FA seed.
 *
 * Rows written before that change still hold the raw seed. They are re-sealed
 * on the next successful sign-in or re-enrolment, but an account that has not
 * signed in since the upgrade keeps its cleartext seed — this script closes
 * that window once, for every account, in one pass.
 *
 * Usage:
 *   npm run backfill:2fa                    # seal every cleartext seed
 *   npm run backfill:2fa -- --dry-run       # report only, write nothing
 *   npm run backfill:2fa -- --confirm-key   # seal even without key evidence
 *   npm run backfill:2fa -- --help          # this text
 *
 * Rules (see `scripts/backfill-2fa-secrets-lib.mjs`):
 *   - idempotent: a row that already holds an envelope (`v1:`/`v2:` prefix)
 *     is skipped, so the script can be run as often as an operator likes;
 *   - fail-closed: a row that cannot be re-sealed is NEVER deleted and NEVER
 *     overwritten — it stays as it is and is reported for a human to look at;
 *   - bounded: the table is walked in batches and the plan of a batch is
 *     applied and dropped before the next batch is read, so the memory use
 *     does not depend on how many accounts carry a seed; the rows that need a
 *     human are capped at the first 100 of each kind and only counted beyond
 *     that, so neither the memory nor the report grows with them either;
 *   - pre-flight: before it writes anything, the run PROVES that the
 *     `AUTH_SECRET` of this environment is the key the app uses. It probes the
 *     envelopes in the two-factor table AND the other sealed columns
 *     (`AiProviderConfig.apiKeyEncrypted`, `EmailConfig.passwordEncrypted` —
 *     the same `AUTH_SECRET` derives their key). If no envelope opens with
 *     the key, the run refuses and writes nothing; only `--confirm-key` (an
 *     operator who has verified the key by hand) lets it continue. Sealing the
 *     cleartext rows with a key the app does not use would lock those
 *     accounts out of their second factor for good.
 *
 * It needs the database (not the app server) and the app's `AUTH_SECRET` — the
 * very key the envelope key is derived from. `AUTH_SECRET` is read from the
 * ENVIRONMENT of this process and never from a file: a file is exactly how
 * the wrong value gets in (Next.js reads four of them).
 */
import { PrismaClient } from "@prisma/client";
import { envMode, loadEnvFiles } from "../src/lib/env-files.ts";
import {
  encryptTwoFactorSecret,
  openTwoFactorSecret,
} from "../src/lib/secrets.ts";
import {
  BATCH_SIZE,
  ENVELOPE_KEY_PROBE_ROWS,
  ENVELOPE_PREFIX,
  KEY_CONFIRMATION_FLAG,
  OTHER_ENVELOPE_COLUMNS,
  runBackfill,
} from "./backfill-2fa-secrets-lib.mjs";

const USAGE = `Usage: npm run backfill:2fa [-- --dry-run] [-- --confirm-key] [-- --help]

Re-seals the TOTP seeds that are still stored in cleartext in
User.twoFactorSecret (AES-256-GCM envelope: v1:<iv>:<tag>:<payload>).

  --dry-run       report what would change, write nothing
  --confirm-key   seal even though no envelope in the database confirms the
                  AUTH_SECRET of this environment (the operator has verified
                  the key by hand)
  --help          print this text

Needs DATABASE_URL and the app's AUTH_SECRET — in the ENVIRONMENT of this
process, not in a file. A row that cannot be re-sealed is left exactly as it
is (never deleted, never overwritten) and reported; the run then exits 1.`;
/** The options this script understands. Anything else is a mistake. */
const OPTIONS = new Set(["--dry-run", "--help", "-h", KEY_CONFIRMATION_FLAG]);

/** Read the sealed values of the other envelope columns of the database. */
async function readOtherEnvelopes(prisma) {
  const columns = [];
  for (const column of OTHER_ENVELOPE_COLUMNS) {
    const rows = await prisma[column.model].findMany({
      where: { [column.field]: { not: null } },
      select: { [column.field]: true },
      take: ENVELOPE_KEY_PROBE_ROWS,
    });
    columns.push({
      label: column.label,
      values: rows.map((row) => row[column.field]),
    });
  }
  return columns;
}

/** The whole run — the decisions live in the library, the I/O lives here. */
async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((argument) => !OPTIONS.has(argument));
  if (unknown.length > 0) {
    // An unknown flag must never fall through to a writing run.
    console.error(`Unknown option(s): ${unknown.join(", ")}\n\n${USAGE}`);
    return 1;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const dryRun = argv.includes("--dry-run");
  const confirmKey = argv.includes(KEY_CONFIRMATION_FLAG);

  // The app's AUTH_SECRET has to come from the environment of THIS process.
  // It is deliberately NOT taken from a file: Next.js reads four env files
  // (`.env.<NODE_ENV>.local`, `.env.local`, `.env.<NODE_ENV>`, `.env`) and a
  // deployment that keeps a different secret in one of them is exactly how a
  // backfill seals rows with a key the app cannot open.
  const authSecret = process.env.AUTH_SECRET;
  // The OTHER variables (DATABASE_URL above all) come from those files — in
  // the order Next.js resolves them: `.env.<NODE_ENV>.local` > `.env.local` >
  // `.env.<NODE_ENV>` > `.env`, the first file that sets a variable wins.
  // `src/lib/env-files.ts` owns that order: the files are loaded in DESCENDING
  // priority, because a loader that never overrides an already-set variable
  // lets the FIRST file it loads win. (The other way round `.env` — the
  // LOWEST-priority file — would win, and the script would seal a different
  // database than the app.) The 2FA e2e fixture loads the same files through
  // the same module, so the two cannot drift apart.
  loadEnvFiles(process.cwd(), envMode(), (reason) => {
    console.error(`env file: ${reason}`);
  });
  if (!authSecret) {
    console.error(
      "AUTH_SECRET is not set in the environment of this process — the envelope key\n" +
        "cannot be derived, so no row can be sealed. Export the app's AUTH_SECRET and\n" +
        "run this again; it is deliberately not read from an env file, because a file\n" +
        "is how the wrong value gets in.",
    );
    return 1;
  }
  process.env.AUTH_SECRET = authSecret;

  const prisma = new PrismaClient();
  try {
    const result = await runBackfill({
      // The sealed rows of the two-factor table: the probe that asks whether
      // the key of this environment opens what is already stored.
      readTwoFactorProbe: () =>
        prisma.user.findMany({
          where: { twoFactorSecret: { startsWith: ENVELOPE_PREFIX } },
          select: { id: true, twoFactorSecret: true },
          take: ENVELOPE_KEY_PROBE_ROWS,
        }),
      // The other sealed columns — the same AUTH_SECRET seals them, so they
      // are evidence about the key even when the two-factor table holds
      // nothing but legacy cleartext rows.
      readOtherEnvelopes: () => readOtherEnvelopes(prisma),
      // One batch of the table.
      readBatch: (cursor) =>
        prisma.user.findMany({
          where: { twoFactorSecret: { not: null } },
          select: { id: true, email: true, twoFactorSecret: true },
          orderBy: { id: "asc" },
          take: BATCH_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      // The write — one row at a time. A failure leaves the row as it was.
      write: async (id, envelope) => {
        await prisma.user.update({
          where: { id },
          data: { twoFactorSecret: envelope },
        });
      },
      seal: encryptTwoFactorSecret,
      open: openTwoFactorSecret,
      confirmKey,
      dryRun,
    });
    return result.exitCode;
  } catch (error) {
    console.error(
      `Could not read the users — is the database reachable (DATABASE_URL)?\n  ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

// `process.exitCode` and NOT `process.exit()`: on a pipe (npm, CI, a
// terminal capture) the writes of `console.log`/`console.error` are buffered,
// and `process.exit()` throws them away — the operator would read a
// truncated report. The process ends by itself once the event loop is empty.
process.exitCode = await main();
