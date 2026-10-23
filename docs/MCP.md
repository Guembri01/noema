# MCP server

Noema exposes a workspace over the Model Context Protocol at **`/api/mcp`**.
The server is read-first: read tools are available by default, write tools appear
with `allowWrite=true`, and the destructive/admin surface is hidden until the
caller opts in with `allowAdmin=true`.

## Connect

```text
POST http://127.0.0.1:53021/api/mcp?workspaceId=<workspace-id>
Authorization: Bearer noema_<token>
Content-Type: application/json
```

Flags:

| Flag | Effect |
|---|---|
| `allowWrite=true` | Lists and accepts non-admin write tools |
| `allowAdmin=true` | Lists and accepts admin/destructive tools |

The token is created in **Workspace settings ? API tokens**. The endpoint
supports JSON-RPC 2.0 over HTTP (protocol `2024-11-05`):
`initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
`resources/list`, and `resources/read`. `GET` returns a discovery descriptor.

Token scopes are expanded through the shared catalogue: `write:pages` implies
`read:pages`, and `admin:workspace` implies every scope. A token never widens
the workspace role that owns it, and per-page restrictions still apply.

## Read tools

| Tool | Capability | Scope |
|---|---|---|
| `search_pages` | Search pages. Supports `limit`, `cursor`, and `sort=relevance|last_edited`; returns `next_cursor`. | `read:pages` |
| `get_page` | Page and block content. | `read:pages` |
| `get_page_tree` | Root/descendant page tree with depth limit. | `read:pages` |
| `get_backlinks` | Pages linking to a page. | `read:pages` |
| `list_page_versions` | Page revision history. | `read:pages` |
| `get_page_version` | One revision and its content. | `read:pages` |
| `export_page` | Markdown, HTML, or JSON export. | `read:pages` |
| `list_databases` | Databases in the workspace. | `read:databases` |
| `query_database_rows` | Rows with `filter`, `pageSize`, and `offset`; returns `next_offset`. | `read:databases` |
| `get_database_schema` | Properties and views. | `read:databases` |
| `export_database` | CSV export. | `read:databases` |
| `get_comments` | Page comments, optionally filtered by resolved state. | `read:comments` |
| `list_templates` | Database templates. | `read:databases` |
| `list_tickets` | Tickets with status/priority/project/assignee/archive filters. | `read:tickets` |
| `get_ticket` | Ticket, labels, relations, and comments. | `read:tickets` |
| `list_labels` | Workspace ticket labels. | `read:tickets` |
| `list_projects` / `get_project` | Projects and milestones. | `read:pages` |
| `list_cycles` | Cycles and ticket counts. | `read:tickets` |
| `get_workspace_info` | Workspace identity, role, and counts. | `read:pages` |
| `list_members` | Member directory. | `read:members` |
| `list_page_permissions` | Page-level access overrides. | `read:members` |
| `list_attachments` | Uploaded assets, optionally for one page. | `read:files` |
| `list_notifications` | The caller?s notifications. | `read:pages` |

`query_database_rows.filter` accepts a leaf
`{ propertyId, operator, value }` or an AND/OR tree. Filtering is bounded to a
1,000-row window because cell values are stored as Postgres JSON.

## Write tools

Write tools require `allowWrite=true`.

| Tool | Actions |
|---|---|
| `create_page` | Create a page or database row by parent. |
| `append_blocks` | Append validated block JSON. |
| `update_page` | Title, icon, cover, layout, lock, or full content; snapshots the previous revision. |
| `block_manage` | `insert`, `update`, `delete`, `replace` blocks. New blocks get stable `attrs.id` values. |
| `page_lifecycle` | `move`, `archive`, `restore`, `duplicate`. |
| `database_manage` | `create`, `create_row`, `delete_row`, `batch_values`, `add_property`, `update_property`, `delete_property`, `reorder_properties`, `reorder_rows`, `create_view`, `update_view`, `duplicate_view`. |
| `update_property_value` | Set one cell; scalar values are encoded for TEXT/NUMBER/CHECKBOX/SELECT/STATUS/MULTI_SELECT/DATE/PEOPLE/FILES. |
| `comment_manage` | `create`, `edit`, `resolve`, `delete`, `react`. |
| `ticket_manage` | `create`, `update`, `archive`, `restore`, `delete`, `comment`, `link`, `unlink`, `bulk_update`, `toggle_label`, `create_label`, `update_label`, `delete_label`. |
| `project_manage` | `create`, `update`, `delete`, `add_milestone`, `update_milestone`, `delete_milestone`. |
| `cycle_manage` | `create`, `update`, `delete`, `assign`. |
| `template_manage` | `save_row`, `create_row`, `delete`. |
| `favorite_manage` | `favorite`, `follow`. |
| `notification_manage` | `mark_read`, `mark_all_read`. |
| `import_markdown` | Import Markdown as a page. |

`delete_*` actions require `confirm: true`. `delete_property`,
`delete_comment`, ticket/project/cycle/template deletes use the same rule.
Pages must be archived before the admin permanent-delete action removes them.

## Admin tools

Admin tools require both `allowAdmin=true` and an `admin:workspace` token.

| Tool | Actions |
|---|---|
| `share_manage` | `create_link`, `revoke_link`, `set_permission` |
| `workspace_manage` | `invite_member`, `set_member_role`, `remove_member`, `delete_page`, `empty_trash` |
| `teamspace_manage` | `list`, `create`, `delete`, `add_member`, `remove_member` |
| `webhook_manage` | `list`, `create`, `delete` |

`delete_page`, `empty_trash`, teamspace/webhook deletes require `confirm: true`.

## Diagrams

Code blocks with `language: "mermaid"` render as Mermaid diagrams in the app. The MCP block tools can create/update them without a separate diagram tool; the source remains a normal code block and round-trips through Markdown.

## Resources

- `notion://pages/{pageId}`
- `notion://pages/{pageId}/comments`
- `notion://databases/{databaseId}`
- `notion://databases/{databaseId}/rows`

## Client configuration

OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "noema": {
        "type": "remote",
        "url": "http://127.0.0.1:53021/api/mcp?workspaceId=<id>&allowWrite=true",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:NOEMA_MCP_TOKEN}" }
      }
    }
  }
}
```

Claude Code:

```powershell
claude mcp add --transport http --scope local noema `
  "http://127.0.0.1:53021/api/mcp?workspaceId=<id>&allowWrite=true" `
  --header "Authorization: Bearer $env:NOEMA_MCP_TOKEN"
```

Add `&allowAdmin=true` only when the client should see the admin surface.

## Safety notes

- Prefer a read-only token for research agents.
- Use separate tokens for write and admin access; rotate/revoke after use.
- Every write still passes the normal workspace role, page-permission, lock,
  tenant, activity-log, and snapshot checks through the server-action layer.
- Destructive actions are two-step (`confirm: true`) and hidden behind
  `allowAdmin`.
- Do not expose the endpoint outside localhost without TLS and a trusted proxy.
