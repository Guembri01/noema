# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Public issues are
indexed within minutes, and a report that is already public cannot be fixed
quietly.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/your-org/noema/security/advisories/new)
(Repository → Security → Report a vulnerability). If that is unavailable, open a
minimal issue asking for a private channel — with no details — and a maintainer
will follow up.

Please include:

- what the issue is, and the impact you believe it has;
- the exact steps to reproduce, or a proof of concept;
- the version or commit you tested, and how you deployed it (self-hosted site, or
  the desktop app);
- any suggested fix.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement | Within 3 working days |
| Initial assessment (severity, affected versions) | Within 7 working days |
| Fix or mitigation plan | Depends on severity; discussed with you |
| Public disclosure | Coordinated with you, after a fix is available |

We will credit you in the release notes unless you ask us not to. If you would
like to be named in [`AUTHORS.md`](./AUTHORS.md) as a security contributor, say
so in the report.

## Supported versions

Noema is pre-1.5 and ships from `main`. Security fixes land on `main` and, where
a release is affected, in a patch release. There are no long-term support
branches yet.

## Scope

In scope:

- Authentication, session handling and password storage.
- Authorization: workspace membership, roles, guests, page shares, teamspaces,
  API tokens and the public API.
- The importers that fetch remote content, and the link-preview fetcher (SSRF,
  size and scheme handling).
- Upload handling: type validation, path traversal, and the authorised file
  route.
- Anything that would leak one workspace's data into another.

Out of scope:

- Misconfiguration of a self-hosted deployment — a weak `AUTH_SECRET`, an
  exposed database port, or a reverse proxy that strips headers.
- Denial of service through sheer volume, without a specific bypass.
- Findings that require an already-compromised host or a malicious browser
  extension.
- The demo seed account (`demo@noema.local` / `password123`). It exists for
  local evaluation only and is documented as such.

## Hardening a deployment

- **Set a strong `AUTH_SECRET`** and never reuse the example value. It signs
  session cookies and derives the key that encrypts stored provider credentials.
- Serve over **HTTPS**, and keep `secure` cookies on.
- Keep `DATABASE_URL` on a private network. The database is not designed to be
  internet-facing.
- Set `APP_ORIGINS` when the app is reached through a hostname it does not
  already allow (a proxy or a tunnel). Server Actions refuse a mismatched
  `Origin`, and that is deliberate.
- Set `CRON_SECRET` if you expose the cron route.
- Keep dependencies current — Dependabot opens grouped weekly updates.

## Secrets in the repository

No credential belongs in the tree. `npm run check:secrets` fails the build on
any key-shaped value in a tracked file, and on any tracked `.env`. `.env` is
git-ignored; `.env.example` documents every variable with placeholder values.

If you ever commit a real credential, treat it as public the moment it lands:
remove it, then **rotate it at the provider**. Rewriting git history does not
un-leak a key.
