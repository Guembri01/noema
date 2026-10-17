import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Node version of the workflows.
 *
 * The repository asks for a major version in `package.json` (`engines.node`)
 * and pins it in `.nvmrc` — the workflows must build with **that** version.
 * A workflow that names another one builds against a runtime the project does
 * not support: the type check, the lint and the suite then run on a Node the
 * deployment never uses.
 */
describe("the workflows", () => {
  it("every workflow that sets up Node uses the version of .nvmrc", () => {
    const pinned = readFileSync(".nvmrc", "utf8").trim();
    expect(pinned).not.toBe("");

    for (const name of readdirSync(".github/workflows")) {
      const source = readFileSync(`.github/workflows/${name}`, "utf8");
      // The commented-out steps are not steps.
      const steps = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      for (const match of steps.matchAll(/node-version(-file)?:\s*"?([^",\s}]+)"?/g)) {
        const [, isFile, value] = match;
        if (isFile) {
          // The file has to be the one of the repository.
          expect(value, `${name} must read the version of .nvmrc`).toBe(".nvmrc");
        } else {
          expect(value, `${name} must use the version of .nvmrc`).toBe(pinned);
        }
      }
    }
  });

  it("the version of .nvmrc is the major version engines.node asks for", () => {
    const pinned = Number(readFileSync(".nvmrc", "utf8").trim());
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const engines = String(pkg.engines?.node ?? "");
    expect(engines).not.toBe("");
    // `>=24` asks for the major 24.
    const asked = Number(engines.replace(/[^\d.]/g, ""));
    expect(pinned).toBe(asked);
  });
});
