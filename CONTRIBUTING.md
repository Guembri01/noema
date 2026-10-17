# Contributing to Noema

Thanks for taking the time. This document is deliberately short: setup, the
gates your change has to pass, and the handful of conventions the codebase
actually enforces. Everything else is in [`docs/`](./docs/README.md).

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Found a security problem? Follow [`SECURITY.md`](./SECURITY.md) instead of
opening a public issue.

## Setting up

Requirements: **Node.js 24** (see [`.nvmrc`](./.nvmrc)), **npm**, and
**Docker** for the development database.

```bash
docker compose up -d        # Postgres 16 in the `noema-db` container, on :5433
cp .env.example .env        # then set a real AUTH_SECRET (the file shows how)
npm install                 # postinstall runs `prisma generate`

npm run db:push             # create the schema
npm run db:seed             # demo workspace + demo account
npm run setup:search        # full-text index and the searchText backfill

npm run dev                 # http://localhost:3000
```

The seed creates `demo@noema.local` / `password123`. Never deploy with it.

The desktop build is separate: `npm run desktop:bundle` produces the installers
in `src-tauri/target/release/bundle/`. See [`docs/DESKTOP.md`](./docs/DESKTOP.md)
before touching anything under `src-tauri/`.

> **Dev and production share `.next/`.** Never run `npm run dev`, `npm run build`
> and the desktop payload build at the same time — they overwrite each other and
> the failure looks like unrelated breakage. Hard-reload (Ctrl+Shift+R) any tab
> left open across a rebuild.

## The gates

Run these before you open a pull request. CI runs the same set — the
workflow-permission gate runs there as part of `npm test`.

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` — no type errors |
| `npm run lint` | ESLint |
| `npm test` | The full Vitest unit suite |
| `npm run check:coherence` | No drift: orphan actions, native dialogs, unexpected injection sinks, shrinking i18n coverage |
| `npm run check:secrets` | No credential-shaped value is committed, and no `.env` is tracked |
| `npm run check:hsts` | The `Strict-Transport-Security` header follows the environment: one year by default, the declared `max-age` when it is set, no header when it is `0` or refused |
| `npm run check:workflow-permissions` | No workflow grants a publishing scope (`packages: write`, `id-token: write`) outside a job that no pull-request event can reach, every such job spells out its `permissions:`, and no pull-request checkout keeps its token on disk |
| `npm run check:design` | No raw colours or ad-hoc spacing — design tokens only |
| `npm run check:i18n` | Every `t(locale, "key")` exists in the catalogue |
| `npm run check:client` | No server-only module leaked into a client bundle |
| `npm run check:use-server` | Every server action file is marked correctly |

`npm run check:fast` is the inner loop: typecheck + lint + the unit tests that
touch your changed files. It is the one to run while you work.

Some checks need a running server and are not part of the static set:
`check:a11y`, `check:routes`, `check:storage`, `check:search`,
`check:chat-stream`, `check:tickets`, `check:mail`, `check:providers` and the
Playwright suite (`npm run e2e`, which expects the production server on `:3200`).

### Commit metadata

`npm run check:dates` (`scripts/check-commit-dates.mjs`) checks two things about
every commit of the ref under review: that the author and the committer date
fall into one of the authoring windows, and that the e-mail address belongs to
a project human — the `HUMANS` map in that script.

**Registering an identity is a maintainer decision, not a side effect of a
change.** The map is the only thing that lets a contributor's commits pass the
identity check, so a commit that adds its own address to it authorises itself
— that is why it has to be named in the commit message and reviewed like any
other governance change. The procedure:

1. a maintainer adds the address (the key) and the display name (the value) to
   `HUMANS` in `scripts/check-commit-dates.mjs`;
2. the commit that does it names the line in its message — e.g. *"the address
   `<mail>` is registered in the `HUMANS` map"* — and the pull request says the
   same, so the reviewer sees the second change in the diff;
3. the name is credited in [`AUTHORS.md`](./AUTHORS.md).

Nobody adds their own address to `HUMANS` in a pull request that is not about
that registration, and a feature commit never carries the registration along
unmentioned.

### Tests

- **Unit tests are the default.** Vitest, colocated as `*.test.ts` next to the
  code. Pure logic belongs here — block serialisation, the database query
  engine, permission checks, formatters.
- **Write the failing test first** for a bug fix. A test that was never red has
  not been shown to test anything.
- **Unit tests do not catch wiring bugs.** If your change is about what the
  browser does — a focus ring, a menu that fails to open, a layout — verify it in
  a real browser and say so in the pull request. "The unit test passes" is not
  evidence that the interface works.
- End-to-end specs are Playwright, under [`e2e/`](./e2e). They run serially
  against a shared demo workspace, so give new tests their own fixtures and
  clean up after them.

## Conventions

- **TypeScript, no `any`.** If a type is genuinely unknown, model it — `unknown`
  plus a narrowing function beats `any` every time.
- **Design tokens only.** Colours, spacing and radii come from the custom
  properties in `src/app/globals.css`. `npm run check:design` fails on raw hex
  values, and it is right to.
- **Strings go through `t()`.** The app ships five locales (en, fr, es, de, ar).
  Add keys to `src/lib/i18n.ts` for every locale, not just English.
- **Server-first.** Reads go through React Server Components and
  `src/server/queries.ts`; writes are server actions that re-derive access from
  the session. Never trust a client-supplied workspace or role.
- **Comments explain why.** The code says what it does. A comment earns its
  place by recording the constraint, the bug it prevents, or the reason the
  obvious approach was wrong.
- **Keep commits scoped.** One logical change per commit, and a message that
  says what changed and why.

## Pull requests

The [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) is the
checklist. In short: the gates pass, new logic has tests, interface changes were
seen working in a browser, no secrets are committed, and the docs match the
behaviour.

Small, focused pull requests get reviewed fastest. For anything large — a new
feature area, a schema change, a refactor across many files — open an issue
first so the design can be agreed before the code is written.

## Where to start

[`docs/MISSING_FEATURES.md`](./docs/MISSING_FEATURES.md) is generated from the
feature matrix, so it is the honest list of what is not built yet. That is where
to find something worth doing. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
explains how the pieces fit, and [`docs/DESIGN_SYSTEM.md`](./docs/DESIGN_SYSTEM.md)
covers the interface rules.
