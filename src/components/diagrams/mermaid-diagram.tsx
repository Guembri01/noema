"use client";

import { useEffect, useId, useState } from "react";
import type { MermaidConfig } from "mermaid";
import { cn } from "@/lib/utils";
import {
  isMermaidLanguage,
  mermaidRenderId,
  validateMermaidSource,
} from "@/lib/diagrams/mermaid-policy";

/**
 * Client-only Mermaid renderer.
 *
 * Mermaid needs a DOM, so this component starts with a source fallback and
 * renders after mount. The module is imported lazily: a page with no diagram
 * never downloads the engine. The SVG is treated as untrusted output and passes
 * through a small DOM sanitizer before it reaches React.
 */

type MermaidApi = typeof import("mermaid").default;

let mermaidLoader: Promise<MermaidApi> | null = null;
const svgCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 40;

async function loadMermaid(): Promise<MermaidApi> {
  mermaidLoader ??= import("mermaid").then((module) => module.default);
  return mermaidLoader;
}

function remember(key: string, svg: string): void {
  if (svgCache.size >= MAX_CACHE_ENTRIES) {
    const first = svgCache.keys().next().value;
    if (first) svgCache.delete(first);
  }
  svgCache.set(key, svg);
}

/** Drop executable SVG content and indefinite network references. */
export function sanitizeMermaidSvg(raw: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    return null;
  }
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

function currentDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    suppressErrorRendering: true,
    theme: dark ? "dark" : "base",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
    flowchart: { htmlLabels: false, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    class: { useMaxWidth: true },
    er: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
  };
}

export type MermaidDiagramProps = {
  source: string;
  caption?: string;
  className?: string;
};

export function MermaidDiagram({ source, caption = "", className }: MermaidDiagramProps) {
  const reactId = useId();
  const [dark, setDark] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setDark(currentDarkMode());
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => setDark(currentDarkMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const validation = validateMermaidSource(source);
    if (!validation.ok) {
      setSvg(null);
      setError(validation.error);
      setLoading(false);
      return;
    }

    const cacheKey = `${dark ? "dark" : "light"}:${validation.source}`;
    const cached = svgCache.get(cacheKey);
    if (cached) {
      setSvg(cached);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const id = mermaidRenderId(`${reactId}:${cacheKey}`);
    void loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize(mermaidConfig(dark));
        const rendered = await mermaid.render(id, validation.source);
        if (cancelled) return;
        const clean = sanitizeMermaidSvg(rendered.svg);
        if (!clean) throw new Error("Mermaid returned an unsafe SVG.");
        remember(cacheKey, clean);
        setSvg(clean);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(reason instanceof Error ? reason.message : "Could not render this diagram.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dark, reactId, source]);

  if (error) {
    return (
      <div className={cn("noema-mermaid my-2 space-y-1", className)} data-mermaid-diagram="error">
        <pre className="overflow-x-auto rounded-control border border-danger/30 bg-surface-2 p-3 font-mono text-xs text-fg">
          <code>{source}</code>
        </pre>
        <p role="alert" className="px-1 text-xs text-danger">
          {error}
        </p>
        {caption && <p className="noema-image-caption-view">{caption}</p>}
      </div>
    );
  }

  return (
    <div className={cn("noema-mermaid my-2 print:break-inside-avoid", className)} data-mermaid-diagram="ready">
      {loading ? (
        <div
          className="flex min-h-24 items-center justify-center rounded-control border border-border bg-surface-2 p-4 text-xs text-muted"
          aria-busy="true"
        >
          Rendering diagram?
        </div>
      ) : (
        svg && (
          <div
            role="img"
            aria-label={caption || "Mermaid diagram"}
            className="overflow-x-auto rounded-control border border-border bg-surface p-3"
            // Sanitised above: scripts, event handlers and non-fragment links removed.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )
      )}
      {caption && <p className="noema-image-caption-view">{caption}</p>}
    </div>
  );
}

/** True when a code-block language should use the diagram renderer. */
export function isMermaidBlock(language: string | null | undefined): boolean {
  return isMermaidLanguage(language);
}
