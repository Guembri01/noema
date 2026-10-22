# Editor surface ownership

`page-editor.tsx` is the composition root. New behaviour belongs in an existing
module below (or a new one with its own test), not in the composition file.

| File | Owns |
|---|---|
| `page-editor.tsx` | Document lifecycle, collaboration, persistence, extension registration and layout |
| `page-editor-motion.tsx` | Block enter/leave and drag tokens, row-chrome presentation |
| `page-editor-clipboard.tsx` | Paste sanitising, source cleanup, clipboard-image planning, data-URL file creation |
| `page-editor-blockrefs.ts` | Block ids, reference projection and multi-block reorder/delete plans |
| `suggestions-controls.tsx` | Track-changes review chrome (toggle, pending list, accept/reject) |
| `bubble-toolbar.tsx` | Selection toolbar |
| `slash-menu.tsx` | Slash command menu |
| `block-context-menu.tsx` | Block action menu |
| `history-controls.tsx` | Undo/redo chrome |
| `find-bar.tsx` | In-document find |
| `extensions/*` | One TipTap node/extension per file |

Every pure editor seam must stay importable from `page-editor.tsx`; the existing
tests and other screens rely on that public surface. Motion stays token-only and
must stand down under `prefers-reduced-motion`.
