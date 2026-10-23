"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge as addFlowEdge,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDiagramPresence } from "@/components/editor/diagram-presence";
import {
  MAX_UML_EDGES,
  MAX_UML_NODES,
  UML_NODE_KINDS,
  UML_RELATIONS,
  normalizeUmlDiagram,
  newUmlNode,
  type UmlDiagramData,
  type UmlNodeKind,
  type UmlRelation,
} from "@/lib/diagrams/uml";
import { cn } from "@/lib/utils";

type UmlFlowData = {
  kind: UmlNodeKind;
  label: string;
  stereotype?: string;
  fields: string[];
  methods: string[];
  remoteUsers?: { name: string; color: string }[];
};
type UmlFlowNode = Node<UmlFlowData>;
type UmlFlowEdgeData = { relation: UmlRelation; label?: string; markerPrefix: string };
type UmlFlowEdge = Edge<UmlFlowEdgeData>;
type RemoteSelection = { clientId: number; name: string; color: string; selectedId: string };

const KIND_LABEL: Record<UmlNodeKind, string> = {
  class: "Class",
  interface: "Interface",
  enum: "Enum",
  actor: "Actor",
  usecase: "Use case",
  component: "Component",
  note: "Note",
};

function markerPrefixFor(diagramId: string): string {
  return `uml-${diagramId.replace(/[^A-Za-z0-9_-]/g, "") || "diagram"}`;
}

function flowFromData(data: UmlDiagramData, diagramId: string): { nodes: UmlFlowNode[]; edges: UmlFlowEdge[] } {
  const prefix = markerPrefixFor(diagramId);
  return {
    nodes: data.nodes.map((node) => ({
      id: node.id,
      type: "uml",
      position: node.position,
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      data: { kind: node.kind, label: node.label, ...(node.stereotype ? { stereotype: node.stereotype } : {}), fields: node.fields, methods: node.methods },
    })),
    edges: data.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "uml",
      data: { relation: edge.relation, ...(edge.label ? { label: edge.label } : {}), markerPrefix: prefix },
    })),
  };
}

function dataFromFlow(nodes: UmlFlowNode[], edges: UmlFlowEdge[]): UmlDiagramData {
  return normalizeUmlDiagram({
    version: 1,
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      position: node.position,
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      label: node.data.label,
      ...(node.data.stereotype ? { stereotype: node.data.stereotype } : {}),
      fields: node.data.fields,
      methods: node.data.methods,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.data?.relation ?? "association",
      ...(edge.data?.label ? { label: edge.data.label } : {}),
    })),
  });
}

function UmlNode({ data, selected }: NodeProps<UmlFlowNode>) {
  const remote = data.remoteUsers ?? [];
  return (
    <div
      className={cn(
        "relative min-h-10 rounded-control border border-border bg-surface text-xs text-fg shadow-1",
        selected && "ring-2 ring-accent",
        remote.length > 0 && "outline outline-2 outline-offset-2",
      )}
      style={remote[0] ? { outlineColor: remote[0].color } : undefined}
      data-uml-node={data.kind}
    >
      {data.kind === "actor" ? (
        <div className="flex min-w-28 flex-col items-center px-3 py-3">
          <span aria-hidden className="mb-1 text-lg">?</span>
          <strong className="font-medium">{data.label}</strong>
        </div>
      ) : data.kind === "usecase" ? (
        <div className="min-w-32 rounded-full border border-border bg-surface px-4 py-3 text-center">
          <strong className="font-medium">{data.label}</strong>
        </div>
      ) : data.kind === "note" ? (
        <div className="min-w-40 whitespace-pre-wrap bg-warning-soft px-3 py-2">{data.label}</div>
      ) : (
        <div className={cn("min-w-44 overflow-hidden", data.kind === "component" && "border-t-4")}>
          <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-center font-semibold">
            {data.kind === "interface" && <div className="text-3xs text-muted">?interface?</div>}
            {data.kind === "enum" && <div className="text-3xs text-muted">?enumeration?</div>}
            {data.stereotype && <div className="text-3xs text-muted">{`?${data.stereotype}?`}</div>}
            {data.label}
          </div>
          {(data.fields.length > 0 || data.methods.length > 0) && (
            <div className="divide-y divide-border">
              {data.fields.length > 0 && <div className="whitespace-pre-wrap px-3 py-1.5 font-mono text-3xs">{data.fields.join("\n")}</div>}
              {data.methods.length > 0 && <div className="whitespace-pre-wrap px-3 py-1.5 font-mono text-3xs">{data.methods.join("\n")}</div>}
            </div>
          )}
        </div>
      )}
      {remote.length > 0 && (
        <div className="absolute -top-5 start-0 whitespace-nowrap text-3xs" style={{ color: remote[0].color }}>
          {remote.map((user) => user.name).join(", ")}
        </div>
      )}
      <Handle type="target" position={Position.Left} id="target" className="!bg-accent" />
      <Handle type="source" position={Position.Right} id="source" className="!bg-accent" />
    </div>
  );
}

function UmlEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<UmlFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const relation = data?.relation ?? "association";
  const prefix = data?.markerPrefix ?? "uml-diagram";
  const markerEnd =
    relation === "inheritance" ? `url(#${prefix}-inheritance)` :
    relation === "realization" ? `url(#${prefix}-realization)` :
    relation === "dependency" ? `url(#${prefix}-dependency)` :
    relation === "association" ? `url(#${prefix}-arrow)` : undefined;
  const markerStart = relation === "aggregation" ? `url(#${prefix}-aggregation)` : relation === "composition" ? `url(#${prefix}-composition)` : undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={{
          stroke: selected ? "var(--accent)" : "var(--fg-subtle)",
          strokeWidth: 1.5,
          strokeDasharray: relation === "dependency" || relation === "realization" ? "5 4" : undefined,
        }}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none rounded-chip bg-surface px-1 text-3xs text-muted"
            style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function UmlMarkers({ prefix }: { prefix: string }) {
  return (
    <svg className="pointer-events-none absolute h-0 w-0" aria-hidden>
      <defs>
        <marker id={`${prefix}-arrow`} markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L12,7 L0,14 z" fill="var(--fg-subtle)" />
        </marker>
        <marker id={`${prefix}-inheritance`} markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L12,7 L0,14 z" fill="var(--surface)" stroke="var(--fg-subtle)" strokeWidth="1.5" />
        </marker>
        <marker id={`${prefix}-realization`} markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L12,7 L0,14 z" fill="var(--surface)" stroke="var(--fg-subtle)" strokeWidth="1.5" />
        </marker>
        <marker id={`${prefix}-dependency`} markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L10,7 L0,14" fill="none" stroke="var(--fg-subtle)" strokeWidth="1.5" />
        </marker>
        <marker id={`${prefix}-aggregation`} markerWidth="14" markerHeight="14" refX="1" refY="7" orient="auto" markerUnits="strokeWidth">
          <path d="M0,7 L7,1 L14,7 L7,13 z" fill="var(--surface)" stroke="var(--fg-subtle)" strokeWidth="1.2" />
        </marker>
        <marker id={`${prefix}-composition`} markerWidth="14" markerHeight="14" refX="1" refY="7" orient="auto" markerUnits="strokeWidth">
          <path d="M0,7 L7,1 L14,7 L7,13 z" fill="var(--fg-subtle)" stroke="var(--fg-subtle)" strokeWidth="1.2" />
        </marker>
      </defs>
    </svg>
  );
}

const NODE_TYPES: NodeTypes = { uml: UmlNode };
const EDGE_TYPES: EdgeTypes = { uml: UmlEdge };

export type UmlDiagramViewProps = {
  data: unknown;
  diagramId?: string;
  readOnly?: boolean;
  onChange?: (data: UmlDiagramData) => void;
  className?: string;
};

export function UmlDiagramView({ data, diagramId = "diagram", readOnly = false, onChange, className }: UmlDiagramViewProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const normalized = useMemo(() => normalizeUmlDiagram(data), [data]);
  const initial = flowFromData(normalized, diagramId);
  const [nodes, setNodes] = useState<UmlFlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<UmlFlowEdge[]>(initial.edges);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteSelection[]>([]);
  const last = useRef(JSON.stringify(normalized));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefix = markerPrefixFor(diagramId);
  const awareness = useDiagramPresence();

  useEffect(() => {
    const next = normalizeUmlDiagram(data);
    const key = JSON.stringify(next);
    if (key === last.current) return;
    last.current = key;
    const flow = flowFromData(next, diagramId);
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [data, diagramId]);

  const commit = useCallback((nextNodes: UmlFlowNode[], nextEdges: UmlFlowEdge[], immediate = false) => {
    if (readOnly || !onChange) return;
    const payload = dataFromFlow(nextNodes, nextEdges);
    const key = JSON.stringify(payload);
    if (key === last.current) return;
    last.current = key;
    if (timer.current) clearTimeout(timer.current);
    const run = () => onChange(payload);
    if (immediate) run();
    else timer.current = setTimeout(run, 120);
  }, [onChange, readOnly]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!awareness || readOnly) return;
    awareness.setLocalStateField("diagram", { blockId: diagramId, selectedId: selectedNode });
    return () => awareness.setLocalStateField("diagram", { blockId: null, selectedId: null });
  }, [awareness, diagramId, readOnly, selectedNode]);

  useEffect(() => {
    if (!awareness) return;
    const updateRemote = () => {
      const next: RemoteSelection[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const pointer = state.diagram as { blockId?: unknown; selectedId?: unknown } | undefined;
        const user = state.user as { name?: unknown; color?: unknown } | undefined;
        if (pointer?.blockId === diagramId && typeof pointer.selectedId === "string") {
          next.push({
            clientId,
            name: typeof user?.name === "string" ? user.name : "Collaborator",
            color: typeof user?.color === "string" ? user.color : "var(--accent)",
            selectedId: pointer.selectedId,
          });
        }
      });
      setRemote(next);
    };
    updateRemote();
    awareness.on("change", updateRemote);
    return () => awareness.off("change", updateRemote);
  }, [awareness, diagramId]);

  const displayNodes = useMemo(
    () => nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        remoteUsers: remote.filter((entry) => entry.selectedId === node.id).map((entry) => ({ name: entry.name, color: entry.color })),
      },
    })),
    [nodes, remote],
  );
  const selected = selectedNode ? nodes.find((node) => node.id === selectedNode) : null;
  const selectedEdgeData = selectedEdge ? edges.find((edge) => edge.id === selectedEdge) : null;

  const addNode = (kind: UmlNodeKind) => {
    if (readOnly || nodes.length >= MAX_UML_NODES) return;
    const node = newUmlNode(kind, nodes.length);
    const flow = flowFromData({ version: 1, nodes: [node], edges: [] }, diagramId).nodes[0];
    const next = [...nodes, flow];
    setNodes(next);
    commit(next, edges, true);
  };

  const updateNode = (patch: Partial<UmlFlowData>) => {
    if (!selectedNode || readOnly) return;
    const next = nodes.map((node) => node.id === selectedNode ? { ...node, data: { ...node.data, ...patch } } : node);
    setNodes(next);
    commit(next, edges);
  };

  const updateEdge = (patch: Partial<UmlFlowEdgeData>) => {
    if (!selectedEdge || readOnly) return;
    const next = edges.map((edge) => edge.id === selectedEdge ? { ...edge, data: { ...edge.data!, ...patch } } : edge);
    setEdges(next);
    commit(nodes, next, true);
  };

  const deleteSelection = () => {
    if (readOnly) return;
    if (selectedEdge) {
      const next = edges.filter((edge) => edge.id !== selectedEdge);
      setEdges(next); setSelectedEdge(null); commit(nodes, next, true);
    } else if (selectedNode) {
      const nextNodes = nodes.filter((node) => node.id !== selectedNode);
      const nextEdges = edges.filter((edge) => edge.source !== selectedNode && edge.target !== selectedNode);
      setNodes(nextNodes); setEdges(nextEdges); setSelectedNode(null); commit(nextNodes, nextEdges, true);
    }
  };

  const onNodesChange = (changes: NodeChange<UmlFlowNode>[]) => {
    const next = applyNodeChanges(changes, nodes);
    setNodes(next);
    if (changes.some((change) => change.type !== "select" && change.type !== "dimensions")) commit(next, edges);
  };

  const onEdgesChange = (changes: EdgeChange<UmlFlowEdge>[]) => {
    const next = applyEdgeChanges(changes, edges);
    setEdges(next);
    if (changes.some((change) => change.type !== "select")) commit(nodes, next);
  };

  const onConnect = (connection: Connection) => {
    if (readOnly || edges.length >= MAX_UML_EDGES) return;
    const next = addFlowEdge<UmlFlowEdge>({
      ...connection,
      id: `e-${Date.now().toString(36)}-${edges.length}`,
      type: "uml",
      data: { relation: "association", markerPrefix: prefix },
    }, edges);
    setEdges(next);
    commit(nodes, next, true);
  };

  if (!mounted) {
    return <div className={cn("noema-uml flex min-h-80 items-center justify-center rounded-control border border-border bg-surface text-xs text-muted", className)} data-uml-diagram="loading">UML diagram</div>;
  }

  return (
    <div className={cn("noema-uml space-y-2", className)} data-uml-diagram={readOnly ? "readonly" : "editable"} data-diagram-id={diagramId}>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2" contentEditable={false}>
          <span className="me-1 text-2xs font-medium uppercase tracking-label text-muted">UML</span>
          {UML_NODE_KINDS.map((kind) => (
            <Button key={kind} type="button" variant="ghost" size="sm" onClick={() => addNode(kind)}>
              <Plus className="me-1 h-3 w-3" aria-hidden />{KIND_LABEL[kind]}
            </Button>
          ))}
          <span className="ms-auto text-3xs text-muted">Drag from the right dot to connect</span>
        </div>
      )}
      <div className="flex min-h-80 overflow-hidden rounded-control border border-border bg-surface" style={{ height: readOnly ? 360 : 440 }}>
        <div className="relative min-w-0 flex-1" contentEditable={false}>
          <UmlMarkers prefix={prefix} />
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => { setSelectedNode(node.id); setSelectedEdge(null); }}
            onEdgeClick={(_, edge) => { setSelectedEdge(edge.id); setSelectedNode(null); }}
            onPaneClick={() => { setSelectedNode(null); setSelectedEdge(null); }}
            fitView
            minZoom={0.3}
            maxZoom={2}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable={!readOnly}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            {!readOnly && <Controls showInteractive={false} />}
            {!readOnly && <MiniMap pannable zoomable />}
          </ReactFlow>
        </div>
        {!readOnly && (selected || selectedEdgeData) && (
          <aside className="w-56 shrink-0 overflow-y-auto border-s border-border bg-surface-2 p-2" contentEditable={false}>
            {selected && (
              <div className="space-y-2 text-xs">
                <label className="block font-medium">Label<input className="mt-1 w-full rounded-control border-control bg-bg px-2 py-1" value={selected.data.label} onChange={(event) => updateNode({ label: event.target.value })} /></label>
                <label className="block font-medium">Stereotype<input className="mt-1 w-full rounded-control border-control bg-bg px-2 py-1" value={selected.data.stereotype ?? ""} onChange={(event) => updateNode({ stereotype: event.target.value })} /></label>
                <label className="block font-medium">Fields<textarea className="mt-1 min-h-16 w-full rounded-control border-control bg-bg px-2 py-1 font-mono text-3xs" value={selected.data.fields.join("\n")} onChange={(event) => updateNode({ fields: event.target.value.split("\n") })} /></label>
                <label className="block font-medium">Methods<textarea className="mt-1 min-h-16 w-full rounded-control border-control bg-bg px-2 py-1 font-mono text-3xs" value={selected.data.methods.join("\n")} onChange={(event) => updateNode({ methods: event.target.value.split("\n") })} /></label>
                <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={deleteSelection}><Trash2 className="me-1 h-3 w-3" aria-hidden />Delete node</Button>
              </div>
            )}
            {selectedEdgeData && (
              <div className="space-y-2 text-xs">
                <label className="block font-medium">Relation<select className="mt-1 w-full rounded-control border-control bg-bg px-2 py-1" value={selectedEdgeData.data?.relation ?? "association"} onChange={(event) => updateEdge({ relation: event.target.value as UmlRelation })}>{UML_RELATIONS.map((relation) => <option key={relation} value={relation}>{relation}</option>)}</select></label>
                <label className="block font-medium">Label<input className="mt-1 w-full rounded-control border-control bg-bg px-2 py-1" value={selectedEdgeData.data?.label ?? ""} onChange={(event) => updateEdge({ label: event.target.value })} /></label>
                <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={deleteSelection}><Trash2 className="me-1 h-3 w-3" aria-hidden />Delete relation</Button>
              </div>
            )}
          </aside>
        )}
      </div>
      {remote.length > 0 && !readOnly && <p className="text-3xs text-muted">{remote.map((entry) => `${entry.name} is editing`).join(" ? ")}</p>}
    </div>
  );
}
