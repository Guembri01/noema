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

## Visual UML canvas

The visual UML block is a separate, drag-and-drop canvas built on React Flow:

- Class, interface, enum, actor, use-case, component and note shapes
- Association, inheritance, realization, dependency, aggregation and
  composition relations
- Move nodes, resize the viewport, connect handles, edit labels and
  compartments, and delete nodes/relations
- Read-only/shared-page rendering
- Markdown export as a Mermaid class diagram where possible
- Presence badges and a remote outline for the node another collaborator has
  selected

Insert it with `/visual uml canvas` or the **UML canvas** slash row.

### Collaboration semantics

The canvas lives in the `umlDiagram` block's node data. The existing Yjs
collaboration layer syncs that data and awareness between clients. Multiple
users can edit the same note and canvas; node/edge changes are committed to the
block as a JSON snapshot. This is live multi-user editing, but it is **not** a
full operation-based CRDT canvas: simultaneous edits to the same node use the
latest node snapshot, while awareness is used for selection presence.

## Current scope

This implementation covers:

- Mermaid text diagrams and UML templates
- A self-hosted visual UML canvas
- PlantUML diagrams through the bundled browser engine (`@plantuml/core` +
  local `viz-global.js`; no Java, server or CDN)
- Live source/canvas collaboration through the existing Yjs relay

PlantUML templates included: UML class, sequence, use case, component and
activity. PlantUML source is stored in a normal `codeBlock` with
`language="plantuml"` and the same preview/source, read-only, import/export and
collaboration paths as Mermaid.
