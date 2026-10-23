declare module "@plantuml/core/plantuml.js" {
  export type PlantUmlOptions = { dark?: boolean; maxSvgSize?: number };
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
    options?: PlantUmlOptions,
  ): void;
  export function render(lines: string[], targetId: string, options?: PlantUmlOptions): void;
}
