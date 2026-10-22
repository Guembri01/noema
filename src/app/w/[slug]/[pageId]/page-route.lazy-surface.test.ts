import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "src/app/w/[slug]/[pageId]/page.tsx",
  "utf8",
);

describe("page route surface split", () => {
  it("does not statically import the editor or the database view", () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bPageEditor\b[^}]*\}\s*from\s*"@\/components\/editor\/page-editor"/,
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bDatabaseView\b[^}]*\}\s*from\s*"@\/components\/database\/database-view"/,
    );
  });

  it("imports both surfaces with dynamic import calls", () => {
    expect(source).toMatch(/await import\("@\/components\/editor\/page-editor"\)/);
    expect(source).toMatch(/await import\("@\/components\/database\/database-surface"\)/);
  });
});
