/** Pure PlantUML source policy. */

export const MAX_PLANTUML_SOURCE_CHARS = 50_000;
export const MAX_PLANTUML_SOURCE_LINES = 2_000;

export type PlantUmlValidation =
  | { ok: true; source: string }
  | { ok: false; error: string };

const FORBIDDEN_DIRECTIVE = /^\s*!(include|import|pragma|theme|procedure|function|unquoted)\b/im;

/** The browser WASM engine has no file system; reject resource-loading directives. */
export function validatePlantUmlSource(input: unknown): PlantUmlValidation {
  if (typeof input !== "string") return { ok: false, error: "PlantUML source must be text." };
  const source = input.replace(/\r\n?/g, "\n").trim();
  if (!source) return { ok: false, error: "Add PlantUML source to render a diagram." };
  if (source.length > MAX_PLANTUML_SOURCE_CHARS) {
    return { ok: false, error: `PlantUML source is too large (${source.length.toLocaleString()} of ${MAX_PLANTUML_SOURCE_CHARS.toLocaleString()} characters).` };
  }
  if (source.split("\n").length > MAX_PLANTUML_SOURCE_LINES) {
    return { ok: false, error: "PlantUML source has too many lines." };
  }
  if (FORBIDDEN_DIRECTIVE.test(source)) {
    return { ok: false, error: "PlantUML include/import/theme directives are not allowed." };
  }
  return { ok: true, source };
}

export function isPlantUmlLanguage(value: string | null | undefined): boolean {
  const slug = String(value ?? "").trim().toLowerCase();
  return slug === "plantuml" || slug === "puml" || slug === "uml";
}

export const PLANTUML_TEMPLATES = [
  { id: "class", label: "UML class", source: `@startuml
class Page {
  +String title
  +save()
}
class Database {
  +String schema
}
Page <|-- Database
@enduml` },
  { id: "sequence", label: "UML sequence", source: `@startuml
autonumber
actor User
participant UI
participant API
User -> UI : Open page
UI -> API : Load note
API --> UI : Document
UI --> User : Render
@enduml` },
  { id: "usecase", label: "UML use case", source: `@startuml
left to right direction
actor User
usecase "Edit page" as Edit
usecase "Share page" as Share
User --> Edit
User --> Share
@enduml` },
  { id: "component", label: "UML component", source: `@startuml
package "Noema" {
  [Web app] as Web
  [API] as API
  database "Postgres" as DB
}
Web --> API
API --> DB
@enduml` },
  { id: "activity", label: "UML activity", source: `@startuml
start
:Open note;
if (Can edit?) then (yes)
  :Edit content;
else (no)
  :Read only;
endif
stop
@enduml` },
] as const;
