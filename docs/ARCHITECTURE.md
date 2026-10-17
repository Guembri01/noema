# Architecture

Noema is a server-first Next.js 15 application backed by PostgreSQL via Prisma.

## Layering

```
┌──────────────────────────────────────────────────────────────┐
│ Routes (src/app)                                             │
│  - Server Components read via src/server/queries.ts          │
│  - Client Components call Server Actions                     │
├──────────────────────────────────────────────────────────────┤
│ Server Actions (src/server/actions/*)                        │
│  - Authenticate (requireUser)                                │
│  - Authorize (getWorkspaceAccess + role checks)              │
│  - Mutate via Prisma, then revalidate paths                  │
├──────────────────────────────────────────────────────────────┤
│ Domain / policy (src/lib/*)                                  │
│  - auth, permissions, blocks, validation, utils, slug        │
├──────────────────────────────────────────────────────────────┤
│ Data (Prisma + PostgreSQL)                                   │
└──────────────────────────────────────────────────────────────┘
```

Rule: **client components never touch Prisma.** They import types from
`src/server/queries.ts` (types are erased) and call server actions for writes.

## Domain model

The central decision is **"everything is a page."**

- `Page` — a document, a folder, a database, or a database row.
  - `type = PAGE | DATABASE`
  - `parentId` builds the tree; `position` orders siblings (float, insert-between friendly)
  - **Tenant invariant:** a `parentId` always points inside the *same*
    workspace. `Page.parentId` is a plain self-foreign key — the schema has no
    composite `(parentId, workspaceId)` constraint — so the rule is enforced
    in the application, by `assertScopedParent()`
    ([`src/lib/page-parent.ts`](../src/lib/page-parent.ts)), the single gate
    every write path passes a parent through.
  - `content` holds the ProseMirror/TipTap JSON block document
  - `deletedAt` implements soft delete (Trash)
- `PageVersion` — immutable snapshots written before content overwrites (history).
- `Workspace` + `WorkspaceMember` — tenancy and roles (OWNER/ADMIN/MEMBER/GUEST).
- `Property` / `PropertyValue` — a database's schema and each row's values
  (JSON keyed by type; see the mapping below).
- `DatabaseView` — a saved view (`TABLE | BOARD | LIST | GALLERY | CALENDAR | TIMELINE | CHART`)
  with JSON `config` (filters, sorts, grouping, visible properties).
- `Template` — database templates.
- `Comment` — threaded page comments with `blockId` for future inline anchoring.
- `ShareLink` / `Invite` — public sharing and workspace invitations.
- `Notification`, `Activity`, `ApiToken`, `Asset`, `Favorite` — supporting surfaces.

### Property value shapes

| Type | Stored JSON |
| --- | --- |
| TEXT, URL, EMAIL, PHONE | `{ text: string }` |
| NUMBER | `{ number: number }` |
| SELECT, STATUS | `{ optionId: string }` |
| MULTI_SELECT | `{ optionIds: string[] }` |
| DATE | `{ start: ISO, end?: ISO, includeTime?: boolean }` |
| CHECKBOX | `{ checked: boolean }` |
| PEOPLE | `{ names: string[] }` (user-id linkage is a roadmap item) |
| FILES | `{ files: { name, url, mimeType? }[] }` — `url` is an app-owned `/api/files/...` path; every stored URL is scheme-checked before it is rendered as a link |
| RELATION | `{ pageIds: string[] }` |

## Authentication

- Passwords: bcrypt, cost 12 (`src/lib/auth.ts`).
- Sessions: HS256 JWT (`jose`) in an httpOnly, SameSite=Lax cookie, 30-day expiry.
- The session registry (`src/lib/session-store.ts`) is the authority on whether
  a session is still alive: the request path rejects a revoked session and one
  that saw no activity for the idle window (12 h), and activity slides the
  deadline — never past the 30-day ceiling.
- `requireUser()` redirects unauthenticated users; every server action then
  re-derives authorization — the JWT only carries the user id.
- The sign-in, the sign-up and the 2FA check are server actions, so they never
  reach the route-handler rate limit and carry their own budgets
  (`src/lib/rate-limit.ts`): one per client address, one per account (keyed on
  the submitted e-mail address) and one for the 2FA guesses. Five consecutive
  failures lock the account for a while; the counter and the lock live on the
  user row (`User.failedLoginCount`, `User.lockedUntil`).

## Authorization

`getWorkspaceAccess(userId, workspaceId)` returns the caller's role (owner or
membership). Policy helpers:

- `canEditContent(role)` — everyone except GUEST.
- `canManageMembers(role)` — OWNER or ADMIN.
- `canDeleteWorkspace(role)` — OWNER only.

This is intentionally centralized so a future public API can reuse it.

A second, separate guard covers the page *tree*: `assertScopedParent()`
([`src/lib/page-parent.ts`](../src/lib/page-parent.ts)) loads a parent
**tenant-scoped** (`{ id, workspaceId, deletedAt: null }`) and refuses a parent
that lives in another workspace or that is in the trash — the foreign page is
never read and the error never names it. A page therefore never hangs under a
page of a different workspace, which keeps it out of the foreign workspace's
database view and CSV/JSON export, and keeps Postgres' `onDelete: Cascade` from
deleting it together with a foreign parent. Every write path that stores a
`Page.parentId` goes through that helper — or holds the workspace equality by
construction and says so, with a reason **and with the proof it relies on**, in
the gate's allow-list; the read side filters a database's rows by the database's
workspace (eight read sites).
The rule is **checked mechanically where the
gate can see it** by
[`scripts/check-parent-scope.mjs`](../scripts/check-parent-scope.mjs): the gate
finds the `Page.parentId` writes in `src/` statically — 31 of them, the same
31 an independent TypeScript-parser inventory finds — and fails when one of
them stores a value the helper has not proved, without a reasoned allow-list
entry. The allow-list is **precise**: every entry names the value it releases
**and** the proof that makes that value safe (the authorization the entry
relies on), and the gate checks that the proof is still there — an entry whose
context is gone releases nothing. The taint of a raw request value is
transitive as well: a local that is derived from a tainted local is tainted
too, and a read of `.parentId` from a name whose origin the gate cannot see
— a parameter, a module-level name, or a local whose initializer the gate
cannot resolve (a spread it cannot follow, a call whose result it cannot see
into, an interpolation it cannot read) — is a raw value, whatever that
receiver is called. The gate follows the taint as far as it can see it: the
**unresolvability** is transitive as well (a local that takes the value of
an unresolved local is unresolved itself), the read of `.parentId` is seen in
every form that names the property directly (the plain read, the optional
chain, the non-null assertion, the computed member with the literal key, the
indexed member, the result of a call), and the compound assignments (`&&=`,
`||=`, `??=`, `+=`, …) are assignments it follows like every other. What it does **not** reach is a value that mixes
an unresolved local with the proved one (`const parentId = o ??
checked.parentId`): the gate cannot see into `o`, so the raw value may hide
in it — and the write is released all the same. A member whose key is not the
literal (`input["parent" + "Id"]`, `input[KEY]`) and a reflective read
(`Reflect.get(input, "parentId")`) are not reads the gate sees at all — the
write is released all the same. It is a safety net over the
tests, not a proof: a write it cannot recognise is not covered by it. The
holes that are known today are listed in the gate's own docstring — **eight** of
them there, **nine** with the write outside `src/` the gate cannot see: a raw
SQL write, a write outside `src/`, a member assignment
(`data.parentId = …`), a computed receiver (`prisma["page"]`), a payload that
arrives through a spread the gate cannot read, a value that mixes an
unresolved local with the proved one, a computed member whose key is not the
literal (`input["parent" + "Id"]`, `input[KEY]`), a reflective read, and a proof that is matched as text
(the gate sees that the named authorization is called, not that it still
checks the workspace). That list is
a safety net, not an enumeration: a new shape of write can open a new hole,
and the list only grows when somebody measures one. It is shorter than it
was: the precise allow-list closed the two holes of the name-based list — the
callers of an allow-listed helper (the gate checks that no caller hands in a
raw parent) and the payload whose parent a helper computes (a value the gate
cannot attribute is no longer mistaken for the checked one). The shapes that
*are* closed are pinned by the gate's own regression test
([`scripts/check-parent-scope.test.mjs`](../scripts/check-parent-scope.test.mjs)),
which holds every allow-list entry to the one path it describes.

## Editor

`PageEditor` (client) mounts TipTap with StarterKit (headings, lists, quote,
code, link, underline, history) plus task lists, placeholders and images. Changes
are debounced (~700 ms) and persisted through `updatePageAction`, which snapshots
the previous revision into `PageVersion`. A `/` menu offers block insertions.

Every stored URL that reaches an `href` — a link mark, a bookmark card — passes
the shared `http|https|mailto|tel` allowlist at render time, so a document
stored before the write-time gate existed, or written by a client that does not
run the document sanitiser (the MCP tool), can never turn into a live
`javascript:` link.

## Databases & views

`DatabaseView` (client) receives serialized properties, views and rows. It renders
Table and Board today, with cell editors switching on the property type. Writes
go through `setPropertyValueAction` / `createRowAction`, and the primary property
stays in sync with the row page title. Additional view types are scaffolded in the
enum and matrix.

## Search

`searchPages` scans a bounded set of the workspace's pages, extracts plaintext
from each block document (`docToPlainText`), and matches titles + bodies. This is
portable across Postgres setups; a `tsvector`/trigram index is a roadmap item.

## Failure modes & guarantees

- Server actions validate input with Zod and re-check permissions on every call.
- Soft delete keeps data recoverable; permanent delete cascades the subtree.
- Prisma `onDelete` rules keep referential integrity (cascade children, restrict
  page creators).

## Planned architecture (see ROADMAP)

- **Realtime collaboration:** Yjs CRDT documents per page + WebSocket server, with
  `Page.content` as the persisted snapshot.
- **Block-level storage:** promote the JSON document to individual `Block` rows
  for fine-grained permissions, inline comments and backlinks.
- **Public REST API + webhooks** over the existing authorization layer.
- **Object storage** for `Asset` uploads (S3-compatible / local disk).
