# Mermaid diagrams

Noema supports Mermaid diagrams inside ordinary code blocks. The source is the
source of truth: it lives in the page document, so it participates in the same
save, version-history, import/export, permission and real-time collaboration
paths as the rest of the note.

## Insert a diagram

1. Type `/mermaid` in a page and choose a template:
   - Mermaid diagram (flowchart)
   - UML class
   - UML sequence
   - UML state
   - ER diagram
   - Gantt
2. Edit the Mermaid source.
3. Use the **eye** button in the code-block toolbar to switch between source and
   preview.

Existing code blocks can also be switched to `Mermaid / UML` in the language
picker.

## Supported syntax

Mermaid itself decides which diagram types are renderable. The editor exposes
starter templates for:

- `flowchart` / `graph`
- `sequenceDiagram` (UML sequence)
- `classDiagram` (UML class)
- `stateDiagram-v2` (UML state)
- `erDiagram`
- `gantt`

Mermaid also supports other diagrams; use its normal syntax in a `mermaid`
code block.

## Real-time collaboration

Mermaid source is a normal `codeBlock` text node. With the existing Yjs
collaboration relay enabled, multiple users can edit the same diagram source in
the same note at the same time. Every collaborator receives the source update
and the preview re-renders locally.

This is **source-level live collaboration**, like multiple people editing the
same code block. It is not a Figma-style direct-manipulation canvas: there are
no draggable diagram nodes or per-element multiplayer selections yet.

To enable collaboration locally:

```powershell
npm run collab
```

Then point the app at the relay and restart it:

```dotenv
NEXT_PUBLIC_COLLAB_URL="ws://localhost:1234"
```

## Rendering and export

- The editor preview is rendered client-side with a local Mermaid bundle.
- Read-only shared pages render the same SVG after hydration.
- Invalid source falls back to the source text with an error message.
- Print/PDF uses the rendered SVG in the DOM.
- Markdown/HTML export preserves the Mermaid fence/source; it does not execute
  Mermaid in the exported file.

## Security and limits

- Mermaid is bundled locally; there is no CDN or external render service.
- `securityLevel: "strict"` and HTML labels are disabled.
- SVG scripts, event handlers and non-fragment links are removed before the SVG
  reaches React.
- Mermaid init/config directives are refused.
- Source is capped at **50,000 characters** and **2,000 lines**.
- A failed diagram never blocks the rest of the page.

## Current scope

This implementation covers Mermaid text diagrams and UML templates that Mermaid
can express. A visual UML canvas (drag/drop class or use-case shapes) and a
local PlantUML renderer are separate features and are not part of this change.
