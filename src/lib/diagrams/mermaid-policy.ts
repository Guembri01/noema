/**
 * Mermaid diagram policy ? pure, no DOM, no React.
 *
 * The renderer is client-side (Mermaid needs a DOM), but the limits and the
 * security gate live here so the editor, read-only renderer, import path and
 * tests all enforce the same rules.
 */

export const MAX_MERMAID_SOURCE_CHARS = 50_000;
export const MAX_MERMAID_SOURCE_LINES = 2_000;

export type MermaidValidation =
  | { ok: true; source: string }
  | { ok: false; error: string };

const FORBIDDEN_DIRECTIVE = /^\s*%%\{\s*(?:init|config)/im;

/**
 * Keep diagrams boring: trim outer whitespace, cap the payload, and refuse
 * Mermaid init/config directives. Mermaid's `securityLevel: "strict"` disables
 * click handlers and HTML labels, but a page-authored init directive can try to
 * re-open them; refusing the directive keeps the renderer's security contract
 * independent of the diagram body.
 */
export function validateMermaidSource(input: unknown): MermaidValidation {
  if (typeof input !== "string") {
    return { ok: false, error: "Mermaid source must be text." };
  }
  const source = input.replace(/\r\n?/g, "\n").trim();
  if (source.length === 0) {
    return { ok: false, error: "Add Mermaid source to render a diagram." };
  }
  if (source.length > MAX_MERMAID_SOURCE_CHARS) {
    return {
      ok: false,
      error: `Mermaid source is too large (${source.length.toLocaleString()} of ${MAX_MERMAID_SOURCE_CHARS.toLocaleString()} characters).`,
    };
  }
  const lines = source.split("\n").length;
  if (lines > MAX_MERMAID_SOURCE_LINES) {
    return {
      ok: false,
      error: `Mermaid source has too many lines (${lines.toLocaleString()} of ${MAX_MERMAID_SOURCE_LINES.toLocaleString()}).`,
    };
  }
  if (FORBIDDEN_DIRECTIVE.test(source)) {
    return { ok: false, error: "Mermaid init/config directives are not allowed." };
  }
  return { ok: true, source };
}

export function isMermaidLanguage(value: string | null | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "mermaid";
}

/** Stable, filesystem-free id for Mermaid's render call. */
export function mermaidRenderId(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `mermaid-${(hash >>> 0).toString(36)}`;
}

export type MermaidTemplate = {
  id: string;
  label: string;
  description: string;
  source: string;
};

export const MERMAID_TEMPLATES: readonly MermaidTemplate[] = [
  {
    id: "flowchart",
    label: "Flowchart",
    description: "Process and decision flow",
    source: `flowchart TD
  A[Start] --> B{Ready?}
  B -->|Yes| C[Ship it]
  B -->|No| D[Revise]
  D --> B`,
  },
  {
    id: "sequence",
    label: "Sequence",
    description: "UML sequence diagram",
    source: `sequenceDiagram
  autonumber
  actor User
  participant UI
  participant API
  User->>UI: Open page
  UI->>API: Load note
  API-->>UI: Document
  UI-->>User: Render`,
  },
  {
    id: "class",
    label: "Class",
    description: "UML class diagram",
    source: `classDiagram
  class Page {
    +String id
    +String title
    +save()
  }
  class Database {
    +String schema
  }
  Page <|-- Database
  Page --> Page : parent`,
  },
  {
    id: "state",
    label: "State",
    description: "UML state machine",
    source: `stateDiagram-v2
  [*] --> Draft
  Draft --> Review : submit
  Review --> Published : approve
  Review --> Draft : request changes
  Published --> [*]`,
  },
  {
    id: "er",
    label: "ER diagram",
    description: "Entity relationships",
    source: `erDiagram
  WORKSPACE ||--o{ PAGE : contains
  PAGE ||--o{ COMMENT : has
  PAGE ||--o{ ASSET : stores`,
  },
  {
    id: "gantt",
    label: "Gantt",
    description: "Timeline plan",
    source: `gantt
  title Release plan
  dateFormat YYYY-MM-DD
  section Build
  Mermaid support :a1, 2026-10-24, 3d
  Tests             :a2, after a1, 2d
  section Ship
  Release           :a3, after a2, 1d`,
  },
];
