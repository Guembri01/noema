# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Public issues are
indexed within minutes, and a report that is already public cannot be fixed
quietly.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/Guembri01/noema/security/advisories/new)
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
- The importers that fetch remote content, the link-preview fetcher and the
  outbound webhook deliveries (SSRF, size and scheme handling).
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
- Serve over **HTTPS**, and keep `secure` cookies on. The app sends
  `Strict-Transport-Security: max-age=31536000` by default, so the browser
  pins HTTPS after the first request; `HSTS_MAX_AGE=0` switches that header
  off for an installation that is deliberately served over plain HTTP.
- Keep `DATABASE_URL` on a private network. The database is not designed to be
  internet-facing.
- Set `APP_ORIGINS` when the app is reached through a hostname it does not
  already allow (a proxy or a tunnel). Server Actions refuse a mismatched
  `Origin`, and that is deliberate.
- Set `CRON_SECRET` if you expose the cron route.
- **Turn the local password sign-in off for an SSO-only deployment** — set
  `AUTH_PASSWORD=disabled`, or drop `password` from the `AUTH_STRATEGIES`
  allow-list. Both switches are enforced by the sign-in and sign-up actions
  themselves, not by the sign-in page alone, so a direct POST cannot bypass
  them.
- Keep dependencies current — Dependabot opens grouped weekly updates.

The sign-in, the sign-up and the 2FA check carry their own budgets (per client
address and per account), and five consecutive failures lock the account for a
while. The lock belongs to the account and not to the client address, so a
deliberate run of failed sign-ins can lock a legitimate user out — that is a
property of the model, not a misconfiguration. The reply stays the neutral
"Incorrect email or password." text, so the lockout cannot be used to confirm
that an address exists.

A single sign-on only links an account that proved its own address
(`User.emailVerified`): a local sign-up never proves one, and an account
created by the SSO callback is stored as verified only when the id_token says
`email_verified: true`. The identity provider is therefore the trust root for
the addresses it hands out — an IdP that lets users type an arbitrary,
unverified address weakens the guarantee. A sign-in that meets an account
whose address was never proven is refused (`?error=sso_email_taken`) instead
of taking the account over; an id_token without `email_verified: true` is
refused (`?error=sso_email_unverified`).

### `NOEMA_ALLOW_LOOPBACK_TARGETS`

### `NOEMA_ALLOW_LOOPBACK_TARGETS`

Outbound webhooks may not point at the machine the server runs on: the
production guard refuses the loopback range (`127.0.0.0/8`, `::1`,
`localhost`) along with every other private range, so a webhook cannot be
used to probe the internal network.

If a receiver really runs on the same machine, set
`NOEMA_ALLOW_LOOPBACK_TARGETS=1` and the loopback range is accepted again.
The opt-in is **off by default** — without it the production guard refuses a
loopback target — and it never opens more than the loopback range: RFC1918
(`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`), the cloud
metadata addresses and every `.internal`/`.local` name stay refused. It
applies to the webhook path only; calendar feeds keep refusing a loopback
feed in production.

## Hardening the desktop app

The Windows/macOS/Linux app is the same server behind a Tauri shell. Its extra
surface is hardened as follows:

- **Loopback only.** The bundled server binds `127.0.0.1` (or `::1` only when
  explicitly requested) on the install's port. An inherited `HOSTNAME`,
  `APP_ORIGINS` or LAN address cannot widen the desktop binding; the boot wrapper
  ignores `HOSTNAME` and recomputes the Server Action origin list as loopback-only
  and port-exact.
- **Navigation guard.** The webview may only show the shell's own page or exactly
  the server origin this run started. Other HTTP(S) links open in the system
  browser; `javascript:`, `data:` and `file:` navigations are denied. The dev
  server is allowed only in debug builds.
- **Narrow IPC.** The served app can call five shell commands and listen to
  events. The shell's own first-run page can call five commands. The process,
  filesystem, dialog, `os`, store and opener plugins are not granted to any
  document; several are not linked at all. The broad `desktop-everything`
  capability has been removed.
- **Secrets at rest.** The Postgres URL and the session signing secret live in
  `secrets.bin`, encrypted with Windows DPAPI in the current user's scope. The old
  plain-text `preferences.json` key and `auth-secret` file are migrated and
  removed. A corrupt store fails closed; it never silently becomes a new secret or
  a new database. On non-Windows builds the file is `0600` and the data directory
  is owner-only.
- **No secret in diagnostics.** `desktop_info` and the clipboard report receive a
  password-redacted connection string, logs redact any `postgres(ql)://user:…@`
  credential before they are stored or shown, and `get_pref` refuses the
  connection-string key.
- **Strict local CSP.** The shell page's CSS and JavaScript are external files;
  its CSP has no `unsafe-inline`, no remote hosts, no frames, no objects and
  `frame-ancestors 'none'`.
- **Supply chain.** GitHub Actions are pinned by commit SHA, the container base
  is digest-pinned, and release builds use a locked Rust CLI version.

**Signed installers are not available yet.** The release workflow already reads
`WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`, but no certificate is
configured, so the current Windows installers are unsigned and SmartScreen may
warn. Verify the SHA-256 in `SHA256SUMS` beside the release; do **not** disable
SmartScreen or add a blanket exclusion. Auto-update is deliberately absent until
a signing key pair and a release endpoint exist.

**Threat boundary.** DPAPI and the per-user `%APPDATA%` ACL stop other users, the
network and a copied profile. They do not stop malware already running as the
same signed-in user — that process can read the user's DPAPI secrets and
environment, as it can read any file the user can. The app is not claiming an
OS sandbox/AppContainer.

## Secrets in the repository

No credential belongs in the tree. `npm run check:secrets` fails the build on
any key-shaped value in a tracked file, and on any tracked `.env`. `.env` is
git-ignored; `.env.example` documents every variable with placeholder values.
The test files are scanned like every other file: a live key pasted into a
fixture is published like any other file. The fake values the fixtures need
are named one by one in `scripts/check-secrets.mjs`, so a real key is never
released by them.

`npm run check:secrets:history` (CI runs it on every push) walks the history
as well: a credential that was committed and later removed is still public —
the commit is the publication, not the current tree.

If you ever commit a real credential, treat it as public the moment it lands:
remove it, then **rotate it at the provider**. Rewriting git history does not
un-leak a key.
