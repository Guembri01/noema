/**
 * Visual UML diagram domain ? pure data model shared by the editor node,
 * read-only renderer, Markdown export and tests.
 *
 * The block is atomically stored in a TipTap node's `data` attribute. That
 * keeps it on the same persistence/collaboration path as every other block:
 * the existing Yjs document syncs the attribute, page snapshots persist it,
 * and the normal permission/lock checks apply.
 */

export type UmlNodeKind =
  | "class"
  | "interface"
  | "enum"
  | "actor"
  | "usecase"
  | "component"
  | "note";

export type UmlRelation =
  | "association"
  | "inheritance"
  | "realization"
  | "dependency"
  | "aggregation"
  | "composition";

export type UmlDiagramNode = {
  id: string;
  kind: UmlNodeKind;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  label: string;
  stereotype?: string;
  fields: string[];
  methods: string[];
};

export type UmlDiagramEdge = {
  id: string;
  source: string;
  target: string;
  relation: UmlRelation;
  label?: string;
};

export type UmlDiagramData = {
  version: 1;
  nodes: UmlDiagramNode[];
  edges: UmlDiagramEdge[];
};

export const UML_NODE_KINDS: readonly UmlNodeKind[] = [
  "class",
  "interface",
  "enum",
  "actor",
  "usecase",
  "component",
  "note",
];

export const UML_RELATIONS: readonly UmlRelation[] = [
  "association",
  "inheritance",
  "realization",
  "dependency",
  "aggregation",
  "composition",
];

export const MAX_UML_NODES = 200;
export const MAX_UML_EDGES = 500;
export const MAX_UML_LABEL = 500;
export const MAX_UML_COMPARTMENT_LINES = 30;

const NODE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const EDGE_ID = /^[A-Za-z0-9_-]{1,120}$/;

function text(value: unknown, max = MAX_UML_LABEL): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function lines(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((line) => text(line, 200)).filter(Boolean).slice(0, MAX_UML_COMPARTMENT_LINES)
    : [];
}

function position(value: unknown): { x: number; y: number } {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const x = typeof raw.x === "number" && Number.isFinite(raw.x) ? raw.x : 0;
  const y = typeof raw.y === "number" && Number.isFinite(raw.y) ? raw.y : 0;
  return { x: Math.round(x), y: Math.round(y) };
}

function isKind(value: unknown): value is UmlNodeKind {
  return typeof value === "string" && (UML_NODE_KINDS as readonly string[]).includes(value);
}

export function isUmlRelation(value: unknown): value is UmlRelation {
  return typeof value === "string" && (UML_RELATIONS as readonly string[]).includes(value);
}

export function emptyUmlDiagram(): UmlDiagramData {
  return { version: 1, nodes: [], edges: [] };
}

export function starterUmlDiagram(): UmlDiagramData {
  return {
    version: 1,
    nodes: [
      {
        id: "class-page",
        kind: "class",
        position: { x: 80, y: 80 },
        label: "Page",
        fields: ["+id: string", "+title: string"],
        methods: ["+save()"],
      },
      {
        id: "class-database",
        kind: "class",
        position: { x: 360, y: 80 },
        label: "Database",
        fields: ["+schema: string"],
        methods: [],
      },
    ],
    edges: [
      { id: "edge-page-database", source: "class-page", target: "class-database", relation: "inheritance" },
    ],
  };
}

/**
 * Validate and reduce untrusted stored JSON to the supported shape. Unknown
 * node/edge kinds are dropped rather than guessed; labels are length-capped;
 * edges pointing at a dropped/missing node are dropped so the canvas cannot
 * have dangling handles.
 */
export function normalizeUmlDiagram(raw: unknown): UmlDiagramData {
  if (!raw || typeof raw !== "object") return emptyUmlDiagram();
  const record = raw as Record<string, unknown>;
  const rawNodes = Array.isArray(record.nodes) ? record.nodes : [];
  const nodes: UmlDiagramNode[] = [];
  const seen = new Set<string>();
  for (const value of rawNodes.slice(0, MAX_UML_NODES)) {
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    const id = typeof node.id === "string" && NODE_ID.test(node.id) ? node.id : null;
    if (!id || seen.has(id) || !isKind(node.kind)) continue;
    seen.add(id);
    nodes.push({
      id,
      kind: node.kind,
      position: position(node.position),
      ...(typeof node.width === "number" && Number.isFinite(node.width) ? { width: Math.max(80, Math.min(1000, node.width)) } : {}),
      ...(typeof node.height === "number" && Number.isFinite(node.height) ? { height: Math.max(40, Math.min(1000, node.height)) } : {}),
      label: text(node.label, 240) || node.kind,
      ...(text(node.stereotype, 80) ? { stereotype: text(node.stereotype, 80) } : {}),
      fields: lines(node.fields),
      methods: lines(node.methods),
    });
  }
  const ids = new Set(nodes.map((node) => node.id));
  const edges: UmlDiagramEdge[] = [];
  const edgeIds = new Set<string>();
  const rawEdges = Array.isArray(record.edges) ? record.edges : [];
  for (const value of rawEdges.slice(0, MAX_UML_EDGES)) {
    if (!value || typeof value !== "object") continue;
    const edge = value as Record<string, unknown>;
    const id = typeof edge.id === "string" && EDGE_ID.test(edge.id) ? edge.id : null;
    const source = typeof edge.source === "string" ? edge.source : "";
    const target = typeof edge.target === "string" ? edge.target : "";
    if (!id || edgeIds.has(id) || !ids.has(source) || !ids.has(target) || !isUmlRelation(edge.relation)) continue;
    edgeIds.add(id);
    edges.push({
      id,
      source,
      target,
      relation: edge.relation,
      ...(text(edge.label, 200) ? { label: text(edge.label, 200) } : {}),
    });
  }
  return { version: 1, nodes, edges };
}

export function newUmlNode(kind: UmlNodeKind, index = 0): UmlDiagramNode {
  const suffix = `${Date.now().toString(36)}-${index}`;
  const base: UmlDiagramNode = {
    id: `n-${suffix}`,
    kind,
    position: { x: 80 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 180 },
    label: kind === "usecase" ? "Use case" : kind === "note" ? "Note" : kind === "actor" ? "Actor" : kind,
    fields: kind === "class" || kind === "interface" ? ["+id: string"] : [],
    methods: kind === "class" ? ["+save()"] : [],
  };
  return base;
}

export function diagramSearchText(raw: unknown): string {
  const data = normalizeUmlDiagram(raw);
  return [
    ...data.nodes.map((node) => `${node.label} ${node.stereotype ?? ""} ${node.fields.join(" ")} ${node.methods.join(" ")}`),
    ...data.edges.map((edge) => edge.label ?? ""),
  ].join(" \n ");
}

/** Best-effort Markdown representation: Mermaid class syntax where possible. */
export function diagramToMermaid(raw: unknown): string {
  const data = normalizeUmlDiagram(raw);
  const classNodes = data.nodes.filter((node) => node.kind === "class" || node.kind === "interface" || node.kind === "enum");
  if (classNodes.length > 0) {
    const lines = ["classDiagram"];
    for (const node of classNodes) {
      lines.push(`  class ${node.label.replace(/\s+/g, "_")} {`);
      if (node.kind !== "class") lines.push(`    <<${node.kind}>>`);
      for (const field of node.fields) lines.push(`    ${field}`);
      for (const method of node.methods) lines.push(`    ${method}`);
      lines.push("  }");
    }
    for (const edge of data.edges) {
      const source = data.nodes.find((node) => node.id === edge.source);
      const target = data.nodes.find((node) => node.id === edge.target);
      if (!source || !target || !classNodes.includes(source) || !classNodes.includes(target)) continue;
      const a = source.label.replace(/\s+/g, "_");
      const b = target.label.replace(/\s+/g, "_");
      const op = edge.relation === "inheritance" ? "<|--" : edge.relation === "realization" ? "<|.." : edge.relation === "dependency" ? "..>" : edge.relation === "composition" ? "*--" : edge.relation === "aggregation" ? "o--" : "-->";
      lines.push(`  ${a} ${op} ${b}`);
    }
    return lines.join("\n");
  }
  const lines = ["flowchart LR"];
  for (const node of data.nodes) lines.push(`  ${node.id.replace(/-/g, "_")}["${node.label.replace(/"/g, "'")}"]`);
  for (const edge of data.edges) lines.push(`  ${edge.source.replace(/-/g, "_")} --> ${edge.target.replace(/-/g, "_")}`);
  return lines.join("\n");
}
