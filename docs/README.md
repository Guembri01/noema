# Noema documentation

Everything written about the project, in roughly the order people want it. The
[README](../README.md) is the front door; this is the rest of the house.

## Understand the product

| Document | What it answers |
| --- | --- |
| [`FEATURE_MATRIX.md`](./FEATURE_MATRIX.md) | The exhaustive inventory of the product surface — 563 rows, each with an implementation status and a note. The source of truth for "does it do X?" |
| [`GALLERY.md`](./GALLERY.md) | Every screen, captured from the seeded demo workspace by `npm run screenshots` — generated, so a surface that changes takes its screenshot with it. |
| [`Noema-features.pdf`](./Noema-features.pdf) | The feature sheet: every area as bullet points, illustrated with all 44 screenshots. Built by `npm run features:pdf` from the README's feature tables and the screenshot report. |
| [`Noema-demo.mp4`](./Noema-demo.mp4) | The two-minute product film — every area in one pass. Composed frame by frame from captured screenshots by the Remotion project in [`../video/`](../video/README.md). |
| [`MISSING_FEATURES.md`](./MISSING_FEATURES.md) | Generated from the matrix: every row that is partial or out of scope, with a priority shortlist. Regenerate with `npm run docs:gaps`. |
| [`ROADMAP.md`](./ROADMAP.md) | What comes next, ordered by dependency and impact, with every item mapped to matrix rows. |
| [`GLOSSARY.md`](./GLOSSARY.md) | One word per idea. The vocabulary shared by interface copy, code, schema, docs and tests. |

## Understand the system

| Document | What it answers |
| --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How it is built: server-first Next.js 15, Prisma and PostgreSQL, and pages all the way down. |
| [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md) | How it looks and moves: tokens, spacing, motion — and the rules the checks enforce. |
| [`api-reference.md`](./api-reference.md) | Every REST route: method, path, authentication, request and response, and errors. |
| [`DESKTOP.md`](./DESKTOP.md) | The installable build: packaging, the embedded database, the port model, and how an install is verified. |
| [`OPERATIONS.md`](./OPERATIONS.md) | Running it: migrations, backups, search setup, environment variables, troubleshooting. |
| [`PERFORMANCE.md`](./PERFORMANCE.md) | The service-level targets, and how each one is validated. |

## Understand the quality

| Document | What it answers |
| --- | --- |
| [`AUDIT.md`](./AUDIT.md) | What ships, what is good, what is bad — every finding with severity, evidence and the fix. |
| [`TEST_PLAN.md`](./TEST_PLAN.md) | The test matrix, and what has to be proven before a feature is called done. |
| [`FIX_PLAN.md`](./FIX_PLAN.md) | The ordered plan that keeps spec, backend, interface and tests in agreement. |
| [`FRONTEND_PLAN.md`](./FRONTEND_PLAN.md) | The interface work list: what is smooth, what needs polish, what is missing. |
| [`VELOCITY.md`](./VELOCITY.md) | Measured build times per work batch, against the playbook targets. |
| [`audits/`](./audits/) | The raw reports: security, performance, i18n QA, test coverage. |

## Design specs

[`specs/`](./specs/) holds the design documents for the large builds — realtime
collaboration, SSO, relations and rollups, the AI surface, automations, search,
navigation, version history, and the engineering hardening plan. Each states the
problem, numbered requirements, the data model, the contracts, the test strategy
and the open questions.

## Where the evidence lives

- `npm run check:matrix` recounts the scoreboard in `FEATURE_MATRIX.md`.
- `npm run docs:gaps` regenerates `MISSING_FEATURES.md` from the matrix.
- `npm run audit` writes the static coherence inventory to `_audit-raw.json`.
- [`scripts/LOOP_PLAYBOOK.md`](../scripts/LOOP_PLAYBOOK.md) documents the batch
  workflow those gates serve.
