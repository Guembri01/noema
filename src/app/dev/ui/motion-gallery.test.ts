import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GALLERY_SECTIONS } from "./gallery-manifest";

/**
 * Contract test for the animation-behaviour explorer (`/dev/ui` §10).
 *
 * Two audiences:
 *
 *  · the browser harness, which measures `getComputedStyle(el)
 *    .transitionDuration` on each `data-testid` — so every required id must be
 *    declared exactly once, on an element that really carries a token
 *    transition;
 *  · the motion rules, which this file re-checks locally so the gallery cannot
 *    drift into an ad-hoc duration, a literal easing keyword or
 *    `transition: all` while `npm run check:motion` only watches `src/app`.
 *
 * Node environment (no DOM, no testing-library): it reads the component source
 * and the manifest, the same way `gallery.test.ts` does.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "motion-gallery.tsx"), "utf8");
const gallery = readFileSync(join(here, "design-gallery.tsx"), "utf8");

/** Ids the harness measures on an element we can grep a region for. */
const REQUIRED_TESTIDS = [
  "motion-gallery",
  "motion-reduce-toggle",
  "motion-button-hover",
  "motion-button-press",
  "motion-button-loading",
  "motion-checkbox",
  "motion-switch",
  "motion-radio",
  "motion-sidebar-demo",
  "motion-sidebar-panel",
  "motion-tabs",
  "motion-context-menu",
  "motion-chevron",
  "motion-skeleton",
  "motion-drop-indicator",
  "motion-toast",
  "motion-tooltip",
] as const;

/** The four timing tiers: their ids are bound to tokens in a data table. */
const REQUIRED_DURATION_TIERS = [
  "motion-dur-1",
  "motion-dur-2",
  "motion-dur-3",
  "motion-dur-4",
] as const;

const ALL_REQUIRED: readonly string[] = [
  ...REQUIRED_TESTIDS,
  ...REQUIRED_DURATION_TIERS,
];

/** Occurrences of a testid as a JSX/id literal. */
function occurrences(testId: string): number {
  return source.split(`"${testId}"`).length - 1;
}

/**
 * The opening tag that carries the id, as an attribute region.
 *
 * Scans from the `<` before the id to the tag's closing `>`, skipping string
 * literals and `{…}` expressions, so an inline `onChange={(e) => …}` does not
 * terminate the region early.
 */
function elementFor(testId: string): string {
  const at = source.indexOf(`"${testId}"`);
  expect(at, `motion-gallery.tsx has no ${testId}`).toBeGreaterThan(-1);
  const open = source.lastIndexOf("<", at);
  let depth = 0;
  let quote: string | null = null;
  let index = open;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (char === ">" && depth === 0) break;
  }
  return source.slice(open, index + 1);
}

/** Non-comment source lines — comments explain the rules, they are not rules. */
function codeLines(): string[] {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

describe("motion gallery — required testids", () => {
  it("declares each required id, and only once", () => {
    for (const testId of ALL_REQUIRED) {
      expect({ testId, count: occurrences(testId) }).toEqual({
        testId,
        count: 1,
      });
    }
  });

  it("carries a token transition on every element the harness measures", () => {
    for (const testId of REQUIRED_TESTIDS) {
      const element = elementFor(testId);
      expect({
        testId,
        wired: /motion\(|u-colors|u-interactive|u-transform/.test(element),
      }).toEqual({ testId, wired: true });
    }
  });

  it("binds each duration tier to its own --dur token", () => {
    REQUIRED_DURATION_TIERS.forEach((testId, index) => {
      const tier = index + 1;
      expect(source).toContain(
        `testId: "${testId}", token: "var(--dur-${tier})"`,
      );
    });
  });

  it("uses the token vocabulary: durations, easings, and nothing ad-hoc", () => {
    for (const token of [
      "var(--dur-1)",
      "var(--dur-2)",
      "var(--dur-3)",
      "var(--dur-4)",
      "var(--ease-smooth)",
      "var(--ease-in-out-soft)",
      "var(--ease-spring)",
    ]) {
      expect(source).toContain(token);
    }

    const lines = codeLines();
    // Mirror of `scripts/check-motion.mjs`, scoped to this file: no Tailwind
    // `duration-<n>`, no raw ms/s inside a transition (the `0ms` sentinel the
    // reduce preview uses is the one exception), no `transition: all`.
    expect(lines.filter((line) => /\bduration-(?!\[)\d/.test(line))).toEqual([]);
    expect(
      lines.filter((line) => /\btransition-all\b|\btransition\s*:\s*all\b/.test(line)),
    ).toEqual([]);
    const rawDuration = lines.filter((line) =>
      /\b(?:transition|animation)\b/.test(line) &&
      [...line.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].some(
        (match) => match[1] !== "0" && match[1] !== "0.01",
      ),
    );
    expect(rawDuration).toEqual([]);
  });

  it("prints no raw colour and no arbitrary radius", () => {
    const lines = codeLines();
    expect(
      lines.filter((line) => /#[0-9a-fA-F]{3,8}\b/.test(line)),
    ).toEqual([]);
    expect(lines.filter((line) => /rounded-\[/.test(line))).toEqual([]);
  });
});

describe("motion gallery — reduce-motion preview", () => {
  it("collapses the preview to the shared 0ms sentinel, never a shortened token", () => {
    expect(source).toContain('reduced ? "0ms" : durToken');
  });

  it("drives data-reduced from the switch on the gallery root", () => {
    const root = elementFor("motion-gallery");
    expect(root).toContain('data-testid="motion-gallery"');
    expect(source).toContain('data-reduced={reduced ? "true" : undefined}');
  });

  it("keeps the switch itself usable while the demos are collapsed", () => {
    // The toggle renders its own transitions with `reduced` hard-coded false,
    // so flipping it on cannot freeze the control that flips it back.
    const toggle = source.slice(source.indexOf("function MotionReduceToggle"));
    expect(toggle).toContain('motion(false, "transform"');
  });
});

describe(
  "motion gallery — server render",
  // A real static render with dynamic imports of react/react-dom/server;
  // stretched past the 5 s default under full-suite contention (8.9 s,
  // P3-T09).
  { timeout: 60_000 },
  () => {
  it("renders every required id, and starts with the preview off", async () => {
    // A real render (no DOM needed for static markup) is the end-to-end proof
    // that the section cannot throw and that every id the harness queries is
    // actually in the markup.
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MotionGallery } = await import("./motion-gallery");
    // The root layout owns the provider (`app/layout.tsx`); mirror it so the
    // render matches what `/dev/ui` actually gets.
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const html = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(MotionGallery),
      ),
    );

    for (const testId of ALL_REQUIRED) {
      expect({ testId, rendered: html.includes(`data-testid="${testId}"`) }).toEqual(
        { testId, rendered: true },
      );
    }
    // The tiers must be measurable on first paint, so the reduce preview starts
    // off — the harness measures them before clicking the switch.
    expect(html).not.toContain('data-reduced="true"');
  });
});

describe("motion gallery — section wiring", () => {
  it("is registered as a manifest section with the animation-behavior id", () => {
    const section = GALLERY_SECTIONS.find(
      (entry) => entry.id === "animation-behavior",
    );
    expect(section).toBeDefined();
    // `files` must name a real primitive (the completeness test walks
    // `src/components/ui`); demo C is the context menu.
    expect(section?.files.length).toBeGreaterThan(0);
    expect(section?.tokens.length).toBeGreaterThan(0);
    for (const token of ["--dur-1", "--dur-2", "--dur-3", "--dur-4"]) {
      expect(section?.tokens).toContain(token);
    }
  });

  it("owns the context-menu primitive exactly once across the manifest", () => {
    const claims = GALLERY_SECTIONS.filter((entry) =>
      (entry.files as readonly string[]).includes("context-menu"),
    ).map((entry) => entry.id);
    expect(claims).toEqual(["animation-behavior"]);
  });

  it("is rendered by the design gallery", () => {
    expect(gallery).toContain('from "./motion-gallery"');
    expect(gallery).toContain('"animation-behavior": <MotionGallery />');
  });
});
