import { describe, expect, it } from "vitest";
import {
  MAX_PLANTUML_SOURCE_CHARS,
  PLANTUML_TEMPLATES,
  isPlantUmlLanguage,
  validatePlantUmlSource,
} from "./plantuml-policy";

describe("PlantUML source policy", () => {
  it("accepts normal source", () => {
    expect(validatePlantUmlSource("@startuml\nAlice -> Bob\n@enduml")).toEqual({
      ok: true,
      source: "@startuml\nAlice -> Bob\n@enduml",
    });
  });

  it("refuses empty and oversized source", () => {
    expect(validatePlantUmlSource("").ok).toBe(false);
    expect(validatePlantUmlSource("x".repeat(MAX_PLANTUML_SOURCE_CHARS + 1)).ok).toBe(false);
  });

  it("refuses resource-loading directives", () => {
    for (const source of ["!include https://example.com/x", "!pragma layout smetana", "!theme plain", "!import foo"]) {
      expect(validatePlantUmlSource(source).ok).toBe(false);
    }
  });

  it("recognises aliases and ships UML templates", () => {
    expect(isPlantUmlLanguage("plantuml")).toBe(true);
    expect(isPlantUmlLanguage("puml")).toBe(true);
    expect(isPlantUmlLanguage("mermaid")).toBe(false);
    expect(PLANTUML_TEMPLATES.map((template) => template.id)).toEqual(
      expect.arrayContaining(["class", "sequence", "usecase", "component", "activity"]),
    );
    for (const template of PLANTUML_TEMPLATES) {
      expect(validatePlantUmlSource(template.source).ok).toBe(true);
    }
  });
});
