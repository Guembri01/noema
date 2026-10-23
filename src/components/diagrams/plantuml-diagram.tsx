"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { validatePlantUmlSource } from "@/lib/diagrams/plantuml-policy";

/**
 * Browser-only PlantUML renderer backed by @plantuml/core (TeaVM) and the
 * locally hosted viz-global.js layout engine. No Java, no server, no CDN.
 */

type PlantUmlApi = typeof import("@plantuml/core/plantuml.js");

let vizLoader: Promise<void> | null = null;
let plantUmlLoader: Promise<PlantUmlApi> | null = null;
const svgCache = new Map<string, string>();
const MAX_CACHE = 32;

function loadViz(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const global = window as unknown as { Viz?: { instance?: () => Promise<unknown> } };
  if (global.Viz) return Promise.resolve();
  if (vizLoader) return vizLoader;
  vizLoader = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/plantuml/viz-global.js";
    script.async = true;
    script.dataset.plantumlViz = "true";
    script.onload = () => {
      const loaded = window as unknown as { Viz?: unknown; PLANTUML_VIZ?: unknown };
      if (loaded.Viz && !loaded.PLANTUML_VIZ) loaded.PLANTUML_VIZ = loaded.Viz;
      resolve();
    };
    script.onerror = () => reject(new Error("Could not load the PlantUML layout engine."));
    document.head.appendChild(script);
  });
  return vizLoader;
}

async function loadPlantUml(): Promise<PlantUmlApi> {
  await loadViz();
  plantUmlLoader ??= import("@plantuml/core/plantuml.js");
  return plantUmlLoader;
}

/** Strip executable SVG content after the engine returns its SVG. */
export function sanitizePlantUmlSvg(raw: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
  root.querySelectorAll("script, iframe, object, embed, link, meta").forEach((node) => node.remove());
  const walk = (element: Element): void => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href" || name === "src") {
        const value = attribute.value.trim();
        if (!value.startsWith("#")) element.removeAttribute(attribute.name);
      }
    }
    [...element.children].forEach(walk);
  };
  walk(root);
  return new XMLSerializer().serializeToString(root);
}

function isDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function renderPlantUml(source: string, dark: boolean): Promise<string> {
  return loadPlantUml().then((api) => new Promise<string>((resolve, reject) => {
    api.renderToString(
      source.split("\n"),
      (svg) => resolve(svg),
      (message) => reject(new Error(message)),
      { dark, maxSvgSize: 8192 },
    );
  }));
}

export function PlantUmlDiagram({ source, caption = "", className }: { source: string; caption?: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const validation = validatePlantUmlSource(source);
    if (!validation.ok) {
      setError(validation.error);
      setLoading(false);
      setSvg(null);
      return;
    }
    const dark = isDark();
    const key = `${dark ? "dark" : "light"}:${validation.source}`;
    const cached = svgCache.get(key);
    if (cached) {
      setSvg(cached);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void renderPlantUml(validation.source, dark)
      .then((raw) => {
        if (cancelled) return;
        const clean = sanitizePlantUmlSvg(raw);
        if (!clean) throw new Error("PlantUML returned an unsafe SVG.");
        if (svgCache.size >= MAX_CACHE) {
          const first = svgCache.keys().next().value;
          if (first) svgCache.delete(first);
        }
        svgCache.set(key, clean);
        setSvg(clean);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(reason instanceof Error ? reason.message : "Could not render this PlantUML diagram.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [source]);

  if (error) {
    return (
      <div className={cn("noema-plantuml my-2 space-y-1", className)} data-plantuml-diagram="error">
        <pre className="overflow-x-auto rounded-control border border-danger/30 bg-surface-2 p-3 font-mono text-xs text-fg"><code>{source}</code></pre>
        <p role="alert" className="px-1 text-xs text-danger">{error}</p>
        {caption && <p className="noema-image-caption-view">{caption}</p>}
      </div>
    );
  }

  return (
    <div className={cn("noema-plantuml my-2 print:break-inside-avoid", className)} data-plantuml-diagram="ready">
      {loading ? (
        <div className="flex min-h-24 items-center justify-center rounded-control border border-border bg-surface-2 p-4 text-xs text-muted" aria-busy="true">
          Rendering PlantUML diagram?
        </div>
      ) : svg ? (
        <div
          role="img"
          aria-label={caption || "PlantUML diagram"}
          className="overflow-x-auto rounded-control border border-border bg-surface p-3"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
      {caption && <p className="noema-image-caption-view">{caption}</p>}
    </div>
  );
}
