import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/editor/page-editor.tsx", "utf8");

describe("editor tool boundaries", () => {
  it("does not statically import the optional tool modules", () => {
    for (const moduleName of [
      "bubble-toolbar",
      "slash-menu",
      "mention-menu",
      "equation-editor",
      "history-controls",
      "suggestions-controls",
    ]) {
      expect(source).not.toMatch(
        new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*"@/components/editor/${moduleName}"`),
      );
    }
  });

  it("loads the tool modules through next/dynamic", () => {
    expect(source).toMatch(/dynamic\(/);
    expect(source).toMatch(/import\("@\/components\/editor\/bubble-toolbar"\)/);
    expect(source).toMatch(/import\("@\/components\/editor\/slash-menu"\)/);
    expect(source).toMatch(/import\("@\/components\/editor\/equation-editor"\)/);
  });
});
