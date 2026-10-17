import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_AUTHORS,
  PROJECT_LICENCE,
  PROJECT_REPOSITORY,
  projectAuthorLine,
} from "./project-info";

/**
 * The About box and the landing footer read their credits from this module, and
 * the repository states them again in `LICENSE`, `AUTHORS.md`, `CITATION.cff`
 * and `package.json`. Two copies of a credit line is exactly how one of them
 * ends up missing a name, so the copies are compared here rather than trusted.
 */
function read(file: string): string {
  return readFileSync(path.resolve(process.cwd(), file), "utf8");
}

describe("project info", () => {
  it("names the authors in the files that credit them", () => {
    for (const file of ["AUTHORS.md", "LICENSE"]) {
      const source = read(file);
      for (const author of PROJECT_AUTHORS) {
        expect(source, `${file} must credit ${author}`).toContain(author);
      }
    }
  });

  it("credits both authors in the citation metadata", () => {
    // CFF splits a name into `family-names` and `given-names`, so "Bilel
    // Guembri" never appears as one string and cannot be searched for.
    const citation = read("CITATION.cff");
    for (const [given, family] of [
      ["Bilel", "Guembri"],
      ["Wissal", "Ben Othmen"],
    ]) {
      expect(citation).toContain(`given-names: ${given}`);
      expect(citation).toContain(`family-names: ${family}`);
    }
  });

  it("agrees with package.json on the author line and the licence", () => {
    const pkg = JSON.parse(read("package.json")) as { author?: string; license?: string };
    expect(pkg.author).toBe(projectAuthorLine());
    expect(pkg.license).toBe(PROJECT_LICENCE);
  });

  it("joins the authors into a readable phrase", () => {
    expect(projectAuthorLine()).toBe("Bilel Guembri and Wissal Ben Othmen");
  });

  it("keeps the repository URL a well-formed GitHub link", () => {
    // The URL is canonical (README, package.json, CITATION.cff and the Tauri
    // bundle all point at it), so this pins its shape rather than the account:
    // a fork may repoint it, but it must stay a real, mutable link.
    expect(PROJECT_REPOSITORY).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    expect(PROJECT_REPOSITORY).toBe("https://github.com/Guembri01/noema");
  });
});
