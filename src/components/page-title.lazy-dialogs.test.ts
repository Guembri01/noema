import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/page-title.tsx", "utf8");

describe("PageTitle dialog boundaries", () => {
  it("does not statically import dialogs", () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bShareDialog\b[^}]*\}\s*from\s*"@\/components\/share-dialog"/,
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bNotionImportDialog\b[^}]*\}\s*from\s*"@\/components\/notion-import-dialog"/,
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bWhoHasAccess\b[^}]*\}\s*from\s*"@\/components\/who-has-access"/,
    );
  });

  it("loads each dialog through next/dynamic", () => {
    expect(source).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/share-dialog"\)/);
    expect(source).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/notion-import-dialog"\)/);
    expect(source).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/who-has-access"\)/);
  });
});
