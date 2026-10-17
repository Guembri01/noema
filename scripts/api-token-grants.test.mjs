// Every API token this repository mints must carry a grant the catalogue in
// `src/lib/api-token-scope.ts` knows. The API enforces that grant: a token
// without the scope a route needs is refused with `403 insufficient_scope`.
//
// Two kinds of token rows are created outside the settings UI:
//
//   * the live checker scripts (`scripts/check-*.mjs`) mint a token, call the
//     v1 API with it and assert the answer — a token without a grant makes
//     every one of them fail;
//   * the demo seed creates a "Reporting script" token whose scopes are shown
//     in the token list — a scope the catalogue does not know grants nothing,
//     so the demo would show a token that looks capable and is not.
//
// The checkers are the repository's own proof that the public API path works,
// so the grant they need is read from the route sources here instead of being
// asserted from a copy of the expectation.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_SCOPE_IDS, hasScope } from "../src/lib/api-token-scope.ts";
import { DEMO_TOKEN_SCOPES } from "../prisma/demo-token.ts";

/** Read a repository file relative to the project root. */
function read(file) {
  return readFileSync(path.resolve(process.cwd(), file), "utf8");
}

/**
 * The scope lists a script stores on the API tokens it mints, one entry per
 * `prisma.apiToken.create({ … })` call. `null` means the call stores no
 * `scopes` key at all — the token then gets the empty default grant.
 */
function mintedGrants(script) {
  const source = read(script);
  const grants = [];
  const pattern = /apiToken\.create\(([\s\S]*?)\n\s*\}\);/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const block = match[1];
    const scopes = /scopes:\s*\[([^\]]*)\]/.exec(block);
    grants.push(
      scopes === null
        ? null
        : [...scopes[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((entry) => entry[1]),
    );
    match = pattern.exec(source);
  }
  return grants;
}

/**
 * The scope a route requires, read from the route source: the `hasScope()`
 * call inside the named handler.
 */
function requiredScope(routeFile, method) {
  const source = read(routeFile);
  const start = source.indexOf(`export async function ${method}(`);
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(/export async function [A-Z]+\(/);
  const body = next === -1 ? rest : rest.slice(0, next);
  return /hasScope\(auth\.scopes,\s*"([^"]+)"\)/.exec(body)?.[1] ?? null;
}

/** The v1 routes each checker calls, with the method it calls them with. */
const SCRIPT_ROUTES = {
  "scripts/check-search.mjs": [{ file: "src/app/api/v1/search/route.ts", method: "GET" }],
  "scripts/check-webhooks.mjs": [{ file: "src/app/api/v1/pages/route.ts", method: "POST" }],
  "scripts/check-api.mjs": [
    { file: "src/app/api/v1/workspaces/route.ts", method: "GET" },
    { file: "src/app/api/v1/pages/route.ts", method: "GET" },
    { file: "src/app/api/v1/pages/[pageId]/route.ts", method: "GET" },
    { file: "src/app/api/v1/search/route.ts", method: "GET" },
    { file: "src/app/api/v1/pages/route.ts", method: "POST" },
  ],
};

describe("the live checker scripts mint API tokens with a usable grant", () => {
  for (const [script, routes] of Object.entries(SCRIPT_ROUTES)) {
    it(`${script} stores an explicit scope list on every token it mints`, () => {
      const grants = mintedGrants(script);
      expect(grants.length, `${script} must mint at least one API token`).toBeGreaterThan(0);
      for (const grant of grants) {
        expect(grant, `${script} must store an explicit scope list`).not.toBeNull();
        for (const scope of grant ?? []) {
          expect(API_SCOPE_IDS, `${script} grants the unknown scope "${scope}"`).toContain(scope);
        }
      }
    });

    it(`${script} grants what the routes it calls require`, () => {
      const grants = mintedGrants(script).filter((grant) => grant !== null);
      for (const route of routes) {
        const needed = requiredScope(route.file, route.method);
        expect(needed, `${route.file} must enforce a scope`).not.toBeNull();
        const covered = grants.some((grant) => hasScope(grant, needed));
        expect(
          covered,
          `${script} must mint a token that grants ${needed} for ${route.file} ${route.method}`,
        ).toBe(true);
      }
    });
  }

  it("check-api.mjs proves the refusal instead of only working around it", () => {
    const source = read("scripts/check-api.mjs");
    const grants = mintedGrants("scripts/check-api.mjs");
    expect(
      grants.some((grant) => grant !== null && grant.length === 0),
      "check-api.mjs must mint a token without a grant",
    ).toBe(true);
    expect(source).toContain("insufficient_scope");
    expect(source).toContain("403");
  });
});

describe("the demo seed's API token carries a grant the catalogue knows", () => {
  it("grants only catalogue ids", () => {
    expect(DEMO_TOKEN_SCOPES.length).toBeGreaterThan(0);
    for (const scope of DEMO_TOKEN_SCOPES) {
      expect(API_SCOPE_IDS, `the seed grants the unknown scope "${scope}"`).toContain(scope);
    }
  });

  it("grants the read scopes the demo token is meant to have", () => {
    expect(hasScope(DEMO_TOKEN_SCOPES, "read:pages")).toBe(true);
    expect(hasScope(DEMO_TOKEN_SCOPES, "read:databases")).toBe(true);
    expect(hasScope(DEMO_TOKEN_SCOPES, "read:tickets")).toBe(true);
  });

  it("cannot write", () => {
    expect(hasScope(DEMO_TOKEN_SCOPES, "write:pages")).toBe(false);
  });

  it("is the grant the seed stores on the token", () => {
    const source = read("prisma/seed.ts");
    // The seed takes its grant from the constant, so the two cannot drift.
    expect(source).toContain("DEMO_TOKEN_SCOPES");
    expect(source).not.toMatch(/scopes:\s*\[\s*"[a-z]+:[a-z]+"/);
  });
});
