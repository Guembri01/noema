# SAML 2.0 SSO setup

Noema supports an **env-level SAML 2.0 connection** next to the existing
env-level OIDC connection. One deployment has one SAML IdP. Per-workspace
connections, group→role mapping, verified-domain auto-join and SCIM are not
implemented yet (see `docs/specs/saml-sso.md`).

## 1. Configure the service provider

Set these in the app environment (all values are documented in `.env.example`):

| Variable | Required | Meaning |
| --- | --- | --- |
| `AUTH_SAML_SSO_URL` | yes | The IdP's SSO endpoint for this app. |
| `AUTH_SAML_ENTITY_ID` | yes | The IdP's entity id / issuer. Assertions from another issuer are rejected. |
| `AUTH_SAML_CERT` | yes | The IdP signing certificate or public key (PEM). `\n` escapes are accepted. |
| `AUTH_SAML_SP_ENTITY_ID` | no | Our entity id. Default: `<origin>/api/auth/saml/metadata`. |
| `AUTH_SAML_CALLBACK_URL` | no | Our ACS URL. Default: `<origin>/api/auth/saml/acs`. |
| `AUTH_SAML_EMAIL_ATTRIBUTE` | no | Attribute carrying the email. Default: Azure's `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`. |
| `AUTH_SAML_NAME_ATTRIBUTE` | no | Attribute carrying the display name. Default: `name`. |
| `AUTH_SAML_GROUPS_ATTRIBUTE` | no | Group attribute. Default: `groups`. |
| `AUTH_SAML_WORKSPACE_ID` | no | Every successful SAML login joins this workspace. Unset = no auto-join. |
| `AUTH_SAML_ROLE_RULES` | no | `group:ROLE` shorthand or a JSON array; `ADMIN` wins over `MEMBER`, `OWNER` is clamped to `ADMIN`. |
| `AUTH_SAML_NAME_ID_FORMAT` | no | Default: `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`. |
| `AUTH_SAML_PRIVATE_KEY` / `AUTH_SAML_SP_CERT` | no | Both together enable SP-signed AuthnRequests and a signing certificate in metadata. |
| `AUTH_SAML_DECRYPTION_KEY` / `AUTH_SAML_DECRYPTION_CERT` | no | Both together enable encrypted assertions. |
| `AUTH_SAML_LOGOUT_URL` | no | IdP SLO endpoint. |

The SP metadata URL is:

```
https://<your-host>/api/auth/saml/metadata
```

Give that URL to the IdP, or paste its XML into the IdP's "metadata" field.
Behind a reverse proxy set `AUTH_SAML_SP_ENTITY_ID` and
`AUTH_SAML_CALLBACK_URL` to the public URLs, because the route derives them
from the request origin.

`AUTH_STRATEGIES` can disable SAML (`AUTH_STRATEGIES=password`), and
`AUTH_PASSWORD=disabled` gives a SAML-only deployment.

### Per-workspace connections (backend)

The `SsoConnection` table now stores an optional SAML connection per
workspace (`name`, IdP entity id, SSO URL, certificate, SP/ACS overrides,
attribute names, role rules and enabled). Admin server actions
`listSsoConnectionsAction`, `createSsoConnectionAction`,
`updateSsoConnectionAction` and `deleteSsoConnectionAction` validate the row,
require `manageSettings`, and write `sso.connection_*` activity records.

A workspace login starts at:

```
/api/auth/saml/start?connection=<connectionId>
```

The same `?connection=` selects the connection's SP metadata at
`/api/auth/saml/metadata`. The RelayState is signed with the connection id, so
the ACS loads the same row; an unknown/disabled row fails closed. The settings
UI and verified-domain records are not shipped yet, so the actions are currently
an admin/back-office seam, not a rendered settings section.

## 2. Provider notes

### Okta

1. Create a **SAML 2.0** app integration.
2. Single sign-on URL: the ACS URL (`https://<host>/api/auth/saml/acs`).
3. Audience URI / SP entity ID: `https://<host>/api/auth/saml/metadata`.
4. NameID format: **EmailAddress**.
5. Attribute statements: `email` → `user.email`, `name` → `user.displayName`.
6. Group attribute statements (if used): `groups` → a group filter; the value
   is captured as an array for the future role mapper.
7. Copy the IdP metadata: entity id, SSO URL and signing certificate into
   `AUTH_SAML_ENTITY_ID`, `AUTH_SAML_SSO_URL`, `AUTH_SAML_CERT`.
8. Set `AUTH_SAML_EMAIL_ATTRIBUTE=email` if you used the `email` attribute
   name above.

### Azure AD / Entra ID

1. **Enterprise applications → New application → Create your own application**
   (non-gallery), then **Set up single sign on → SAML**.
2. Basic SAML configuration:
   - Identifier (Entity ID): `https://<host>/api/auth/saml/metadata`
   - Reply URL (ACS): `https://<host>/api/auth/saml/acs`
3. Attributes & Claims: keep the default `emailaddress` claim, or add a
   `email` claim and set `AUTH_SAML_EMAIL_ATTRIBUTE=email`.
4. Copy **App Federation Metadata URL** values (entity id, login URL,
   certificate) into the three required variables.
5. Optional group claims require an Entra group configuration; the current
   release captures the groups but does not yet map them to workspace roles.

### Google Workspace

1. **Admin console → Apps → Web and mobile apps → Add app → Custom SAML app**.
2. ACS URL and Entity ID as above.
3. Add an `email` and `name` mapping; set `AUTH_SAML_EMAIL_ATTRIBUTE=email`.
4. Download the IdP metadata and copy its entity id, SSO URL and certificate.
5. Google group membership can be mapped to the `groups` attribute in the
   Google app configuration; role mapping is not implemented yet.

## 3. Sign-in behavior

- `GET /api/auth/saml/start` builds the AuthnRequest and redirects.
- `POST /api/auth/saml/acs` validates the response exclusively through
  `@node-saml/node-saml`: signed assertion, issuer, audience, destination,
  `NotBefore`/`NotOnOrAfter` with 120 s clock skew.
- A **signed RelayState** (HS256, derived from `AUTH_SECRET`, 10 min) carries
  the same-origin return path. This is deliberately not a cookie: SAML returns
  by cross-site POST, where a `SameSite=Lax` cookie is not sent.
- The assertion id (falling back to the exact `SAMLResponse` digest when the
  library exposes none) is inserted into `SamlAssertionSeen` before any user
  write; a replay — including a re-encoded copy of the same signed assertion —
  is rejected across restarts and instances.
- JIT users are created with `emailVerified: true` and a non-password sentinel.
  An existing account is linked only when it already proved its address
  (`User.emailVerified`); an unverified local account is refused with
  `?error=sso_email_taken` (the same B07 rule as OIDC).
- When `AUTH_SAML_WORKSPACE_ID` is set, each login joins that workspace with the
  role mapped from the group attribute (highest rule wins, default `MEMBER`).
  `OWNER` cannot be granted by a rule and an existing owner is never demoted.
- `GET|POST /api/auth/saml/slo` always destroys the local session and returns
  to `/login`. Full SLO request validation is not implemented.

## 4. Failure behavior

Every validation failure redirects to `/login?error=sso` and issues no session.
The ACS never falls back to an unvalidated profile. Missing SAML configuration
returns `404` from the start/metadata routes.

## 5. Tests

```bash
npm run check:saml
```

The first suite builds a real signed SAML response with a fresh RSA key pair
and proves valid/tampered/audience/expiry behavior through `node-saml`; the
second covers start/metadata/ACS/JIT/linking/replay/RelayState/SLO wiring.
`npm run check:sso` remains the OIDC regression suite.
