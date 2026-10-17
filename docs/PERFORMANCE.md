# Performance budgets

The product spec (§22) asks for service-level targets. These are **engineering
goals to validate**, not measured Notion numbers — every figure below is something
this app should hold itself to, and the "how we'd check it" column is the
measurement that would prove or break it. Nothing here claims to have been met.

| Metric | Target | How it would be checked | Status |
|---|---|---|---|
| Local typing latency | < 50 ms | instrument `page-editor` input → paint with `performance.mark`; the editor is local-first (no round trip per keystroke) | **not measured** |
| Cached read (search, list, page payload) | p95 < 200 ms | `scripts/check-search.mjs` measures a warm query; extend it to sample p95 over N runs | **not measured** |
| Simple mutation (rename, move, toggle) | p95 < 400 ms | time `server/actions/*` round trips in the live route checks | **not measured** |
| Search response | p95 < 500 ms | `scripts/check-search.mjs` | **not measured** |
| Availability | 99.9 % monthly | `/api/health` + `/api/ready` are the probes; nothing scrapes them yet | **not measured** |
| Critical background-job recovery | defined per job | `src/lib/job-queue.ts` records `failed`/`retry` state; `/api/cron/jobs` reports it | **mechanism present, no budget recorded** |
| Editor input at 10k-block pages | no visible stall | windowed rendering + `React.memo` on blocks; needs a large-fixture test | **not measured** |

## Why the numbers are absent

Measuring them needs a harness that the repo does not have yet: a large seeded
workspace (thousands of pages/blocks), a repeatable request sampler, and a place to
record the results so a regression fails CI. The honest next step is:

1. `scripts/perf-baseline.mjs` — seed a large fixture workspace, warm it, then
   sample the four request paths above and print p50/p95 alongside the target.
2. Store the result next to the design report (`scripts/perf-baseline.json`) and
   fail when a target is exceeded by more than the noise floor.
3. Add the large-fixture editor timing as a component-level test (jsdom cannot
   answer paint latency, so this one needs the browser harness —
   `scripts/visual-check.mjs` already drives one).

Until then this file is the *contract*, and the table above is honest about the
gaps: the mechanisms exist (local-first editor, health probes, job queue with
retry, pagination, indexes, `pg_dump` backups), the measurements do not.

## What is already in place, so the targets are reachable

- **Local-first editing** — keystrokes update local state; the server round trip is
  debounced and batched, so typing does not wait on the network.
- **Indexes** — `@@index` on the hot lookups (`workspaceId`, `parentId`, `pageId`,
  `updatedAt`, ticket keys) and a GIN index over `Page.searchText`.
- **Bounded scans** — search falls back to a *capped* ordered scan rather than an
  unbounded one, and the typo tier scans a capped window.
- **Pagination** — search and list queries use `take`/cursor windows rather than
  loading everything.
- **Queues with retry** — `src/lib/job-queue.ts` (claim/drain, bounded retries) is
  what `/api/cron/*` drains.
- **Backups with verification** — `scripts/backup.mjs` writes a `pg_dump` plus a
  manifest of per-table row counts so a restore can be checked, and prunes by
  retention without ever deleting the newest dump.
- **Probes** — `/api/health` (`{ok, db}`) and `/api/ready` (env + Postgres) are the
  liveness/readiness pair an orchestrator or the desktop shell polls.
