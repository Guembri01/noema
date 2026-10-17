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
| FILES | `{ files: { name, url, mimeType? }[] }` |
| RELATION | `{ pageIds: string[] }` |

## Authentication

- Passwords: bcrypt, cost 12 (`src/lib/auth.ts`).
- Sessions: HS256 JWT (`jose`) in an httpOnly, SameSite=Lax cookie, 30-day expiry.
- `requireUser()` redirects unauthenticated users; every server action then
  re-derives authorization — the JWT only carries the user id.

## Authorization

`getWorkspaceAccess(userId, workspaceId)` returns the caller's role (owner or
membership). Policy helpers:

- `canEditContent(role)` — everyone except GUEST.
- `canManageMembers(role)` — OWNER or ADMIN.
- `canDeleteWorkspace(role)` — OWNER only.

This is intentionally centralized so a future public API can reuse it.

A second, separate guard covers the page *tree*: `assertScopedParent()`
([`src/lib/page-parent.ts`](../src/lib/page-parent.ts)) loads a parent
**tenant-scoped** (`{ id, workspaceId }`) and refuses a parent that lives in
another workspace — the foreign page is never read and the error never names
it. A page therefore never hangs under a page of a different workspace, which
keeps it out of the foreign workspace's database view and CSV/JSON export, and
keeps Postgres' `onDelete: Cascade` from deleting it together with a foreign
parent. Every write path that stores a `Page.parentId` goes through that
helper; the read side filters a database's rows by the database's workspace.

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
