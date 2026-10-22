import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("src/app/w/[slug]/[pageId]/page.tsx", "utf8");
const surface = readFileSync("src/components/database/database-surface.tsx", "utf8");

describe("database surface boundary", () => {
  it("keeps the heavy database view out of the route module graph", () => {
    expect(route).toMatch(/import\("@\/components\/database\/database-surface"\)/);
    expect(route).not.toMatch(/import\("@\/components\/database\/database-view"\)/);
  });

  it("loads DatabaseView with next/dynamic inside the light surface", () => {
    expect(surface).not.toMatch(
      /import\s*\{[^}]*\bDatabaseView\b[^}]*\}\s*from\s*"@\/components\/database\/database-view"/,
    );
    expect(surface).toMatch(/dynamic\(/);
    expect(surface).toMatch(/import\("@\/components\/database\/database-view"\)/);
  });
});
