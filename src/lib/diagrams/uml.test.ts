import { describe, expect, it } from "vitest";
import {
  MAX_UML_NODES,
  diagramSearchText,
  diagramToMermaid,
  emptyUmlDiagram,
  normalizeUmlDiagram,
  starterUmlDiagram,
} from "./uml";

describe("UML diagram model", () => {
  it("normalizes a starter diagram", () => {
    const data = normalizeUmlDiagram(starterUmlDiagram());
    expect(data.version).toBe(1);
    expect(data.nodes).toHaveLength(2);
    expect(data.edges[0]).toMatchObject({ relation: "inheritance" });
  });

  it("drops unknown kinds and dangling edges", () => {
    const data = normalizeUmlDiagram({
      nodes: [
        { id: "a", kind: "class", label: "A", position: { x: 0, y: 0 } },
        { id: "b", kind: "not-real", label: "B" },
      ],
      edges: [
        { id: "e1", source: "a", target: "missing", relation: "association" },
        { id: "e2", source: "a", target: "b", relation: "association" },
      ],
    });
    expect(data.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(data.edges).toEqual([]);
  });

  it("caps labels and compartment lines", () => {
    const data = normalizeUmlDiagram({
      nodes: [{ id: "a", kind: "class", label: "x".repeat(900), fields: Array.from({ length: 40 }, () => "field"), methods: ["m"] }],
      edges: [],
    });
    expect(data.nodes[0]?.label.length).toBe(240);
    expect(data.nodes[0]?.fields.length).toBe(30);
  });

  it("caps the number of nodes", () => {
    const nodes = Array.from({ length: MAX_UML_NODES + 5 }, (_, index) => ({
      id: `n${index}`, kind: "class", label: `N${index}`,
    }));
    expect(normalizeUmlDiagram({ nodes, edges: [] }).nodes).toHaveLength(MAX_UML_NODES);
  });

  it("returns searchable labels and fields", () => {
    const text = diagramSearchText(starterUmlDiagram());
    expect(text).toContain("Page");
    expect(text).toContain("schema");
  });

  it("exports class diagrams as Mermaid", () => {
    const markdown = diagramToMermaid(starterUmlDiagram());
    expect(markdown).toContain("classDiagram");
    expect(markdown).toContain("Page <|-- Database");
  });

  it("has a safe empty fallback", () => {
    expect(normalizeUmlDiagram(null)).toEqual(emptyUmlDiagram());
    expect(normalizeUmlDiagram({ nodes: "no" })).toEqual(emptyUmlDiagram());
  });
});
