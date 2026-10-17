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

  it("keeps the repository URL in the placeholder form the README documents", () => {
    // `your-org` is deliberate: the tree ships with a placeholder rather than an
    // invented organisation, and the README says to replace it. A test cannot
    // know the real URL, but it can insist this stays a well-formed repo link.
    expect(PROJECT_REPOSITORY).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  });
});
