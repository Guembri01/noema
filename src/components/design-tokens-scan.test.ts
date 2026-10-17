import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Motion must come from the token layer, never from an arbitrary value.
 *
 * `page-title.tsx`, `sidebar/page-tree.tsx` and `email-settings.tsx` were the
 * last three components still carrying a design-system violation (an arbitrary
 * arbitrary bracket-duration utility in the first two, a legacy Tailwind palette class in
 * the third). This is a *source scan* — the same rules `scripts/check-design-system.mjs`
 * enforces — pinned as a test so the regression cannot come back silently.
 */

const FILES = [
  "./page-title.tsx",
  "./sidebar/page-tree.tsx",
  "./email-settings.tsx",
] as const;

/** Rules mirrored from `scripts/check-design-system.mjs`. */
const RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["arbitrary millisecond duration", /\bduration-\[\d/],
  ["arbitrary duration utility", /duration-\[/],
  ["raw hex colour", /#[0-9a-fA-F]{3,8}\b/],
  [
    "legacy palette class",
    /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|orange|yellow|purple|pink|teal|emerald|slate|gray|zinc|neutral)-\d{2,3}\b/,
  ],
];

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

const sources = FILES.map((file) => ({
  file,
  lines: readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8").split(/\r?\n/),
}));

describe("design-token source scan", () => {
  for (const { file, lines } of sources) {
    for (const [name, re] of RULES) {
      it(`${file} has no ${name}`, () => {
        const hits = lines
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => !isComment(line) && re.test(line));
        expect(
          hits.map((hit) => `  ${hit.number}: ${hit.line.trim()}`),
          `offending lines for "${name}":`,
        ).toEqual([]);
      });
    }
  }

  it("still uses the duration/easing tokens for the motion it does animate", () => {
    const pageTitle = sources.find((entry) => entry.file === "./page-title.tsx")!;
    const joined = pageTitle.lines.join("\n");
    expect(joined).toContain("var(--dur-1)");
    expect(joined).toContain("var(--ease-smooth)");
  });
});
