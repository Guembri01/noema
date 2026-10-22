# Database surface ownership

This folder carries the database screen. It is intentionally being split in
small, test-backed slices; do not add a fifth 2,000-line file.

| File | Owns | May import |
|---|---|---|
| `database-view.tsx` | Screen orchestration, view state and data flow | every module below |
| `view-tabs.tsx` | View tabs, icons and tab-level actions | types, UI primitives |
| `view-toolbar.tsx` | Toolbar composition and the advanced-controls disclosure | `view-settings`, types |
| `view-settings.tsx` | View controls composition (filter, sort, group, colour, layout, saved views, chart) | `view-settings-model`, types |
| `view-settings-model.tsx` | Pure view-config transforms, colour-rule mapping and the nested filter builder | types, domain engines |
| `database-actions.tsx` | Row/schema action row, templates, deleted rows, CSV import/export | server actions, types |
| `database-peek.tsx` | Side peek panel, peek header/row and peek design layer | `view-parts`, types |
| `view-renderers.tsx` | Stable re-export barrel for the layout modules | all layout modules below |
| `view-renderers-helpers.ts` | Row presence/motion, ordering, heights, sort/footer and scroll anchoring | types, domain engines |
| `table-view.tsx` | Table layout, paste/selection chrome, column and row controls | helpers, `view-parts` |
| `list-view.tsx` | List layout, indentation and collapse state | helpers, `view-parts` |
| `board-view.tsx` | Board layout, grouping, swimlanes, WIP limits and aggregation | helpers, `view-parts` |
| `gallery-view.tsx` | Gallery layout and card/cover preview resolution | helpers, `view-parts` |
| `form-view.tsx` | Form layout and submission mapping | helpers, `view-parts` |
| `property-panel.tsx` | Read-only property grid for a row | helpers, types |
| `view-parts.tsx` | Shared cell renderers and cell-level interaction | cell modules, types, domain engines |
| `status-cell.tsx` | SELECT / STATUS cell only | `database-types` |
| `date-cell.tsx`, `people-cell.tsx`, `relation-cell.tsx`, `icon-cell.tsx`, `place-cell.tsx`, `button-cell.tsx` | One cell type each | types, domain engines |
| `database-types.ts` | Shared schema, option colours, option-hue mapping | design tokens, palette |

## Next extraction order

1. `status-cell` (done) — proves a cell can leave `view-parts` with its own test.
2. `people-cell`, `date-cell`, `relation-cell` (done) — each owns its local
   draft/query state and has a render test.
3. `icon-cell` (done).
4. `place-cell`, `button-cell` (done) — the button cell owns its destructive
   confirmation plan and render test.
5. `view-options` (done) — five common controls inline, advanced controls behind
   one disclosure owned by `view-toolbar`.
6. `view-tabs`, `view-toolbar`, `database-actions`, `database-peek` (done).
7. `database-view` (done) — it now owns orchestration and data flow only.

Every slice must keep the public props stable and land with its own test. The
database is the highest-churn area; a rewrite is the wrong move.
