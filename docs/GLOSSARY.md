# Glossary

One word per idea, everywhere: UI copy, code, schema, docs and tests. When a term
changes here, it changes in all five (this file is part of the coherence
contract in `docs/AUDIT.md` §5).

| Term | Means | Not |
| --- | --- | --- |
| **Workspace** | The top-level container a team shares. Owns pages, databases, tickets, members, labels, settings. | "project", "team" (a *teamspace* is a slice of a workspace) |
| **Teamspace** | A named section inside a workspace that scopes access to its pages. | A workspace |
| **Page** | A container users open: it has a title, icon, cover and a document. Databases are pages with `type = DATABASE`. | "note", "doc", "file" |
| **Document** | The content inside a page (the ProseMirror JSON). | "page" |
| **Note** | Informal word for *a page someone wrote prose in*. Fine in marketing copy and the AI's voice; never in the schema or a type name. | A page in an API |
| **Block** | One node in a document (paragraph, heading, list, code, image, synced view…). | A page |
| **Database** | A page holding structured rows with properties and views. | A spreadsheet file |
| **Property** | A typed column of a database (text, select, status, number, date, relation, rollup, formula, button…). | "field", "column" (say "column" only when talking about the rendered table) |
| **Row** | One entry inside a database (itself a page). | "record", "item" |
| **View** | A saved way of looking at a database: table, board, list, calendar, gallery, timeline. | A page |
| **Template** | A reusable starting point for a row, optionally recurring. | A page template (page templates are "page templates") |
| **Ticket** | A tracked unit of work with a key (`DW-1`), status, priority, estimate and dates. | "issue", "task" (tasks are the `task` *type* of a ticket) |
| **Label** | A workspace-wide tag (name, colour) attachable to tickets. | A status |
| **Estimate** | The effort on a ticket, in points, hours or days. | A duration (dates are "start"/"due") |
| **Milestone** | A dated checkpoint inside a project. | A ticket |
| **Project** | A group of work with milestones, members and attached pages. | A workspace |
| **Conversation** (a.k.a. **Discussion**) | A chat thread, addressable at `?chat=<id>`. | A comment thread |
| **Answer** | One AI reply inside a conversation; it can be *saved as a new note*. | A comment |
| **Comment** | A human annotation on a page (optionally anchored to a text range) or on a ticket. | An AI answer |
| **Share link** | A public, optionally password-protected, optionally expiring URL for one page. | A workspace invite |
| **Invite** | A pending, emailed membership offer of a workspace or teamspace. | A share link |
| **Trash** | Where archived pages wait before *restore* or *delete forever*. | An archive of tickets (tickets are "archived") |

## Naming rules in code

| Kind | Convention | Example |
| --- | --- | --- |
| Server action | `<verb><Thing>Action`, returns `Result<T>` = `{ ok: true, … } \| { error }` | `restorePageAction` |
| Query | `get<Thing>` / `list<Thing>`, read-only, no permission side effects | `getTrash`, `listWorkspaceInvites` |
| Route | `/api/<area>` for the app, `/api/v1/<resource>` for the public API | `/api/tickets`, `/api/v1/pages` |
| Pure helper | `verbThing` describing the data it takes | `markdownToText`, `prosemirrorToText` |
| Client component | `ThingThing` (PascalCase), one purpose per file | `TrashList`, `WhoHasAccess` |

## The two "plain text" helpers (renamed in P2.2)

| Helper | Input | Lives in |
| --- | --- | --- |
| `prosemirrorToText` | A ProseMirror/TipTap JSON document | `src/lib/blocks.ts` |
| `markdownToText` | A Markdown **string** (AI answers, imports) | `src/lib/markdown.ts` |

They used to be `docToPlainText` and `markdownToPlainText`, which read as synonyms.
