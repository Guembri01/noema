// Regression test for the dependency-advisory gate (B60).
//
// The hole: nothing in the tree looked at `npm audit`. The lockfile carried
// advisories that no gate could see, and an advisory that landed in it
// stayed there — the audit is a snapshot of the registry, not a state
// somebody maintains.
//
// The gate: `scripts/check-npm-audit.mjs` compares the report of
// `npm audit --audit-level=high --json` with the list of accepted advisories
// (`scripts/npm-audit-baseline.mjs`). An advisory that is not on the list is
// a finding and fails the build; a known one does not.
//
// The two fixtures below are the `vulnerabilities` section of two *measured*
// audit reports, taken on 2026-10-21 with npm 12.2.0:
//   · BEFORE_THE_FIX — the tree as it was: eight entries (five high, three
//     moderate) carrying two advisories, GHSA-vfj7-8cjw-p6xm (`braces`, high)
//     and GHSA-hp3w-g68c-fv3c (`sprintf-js`, moderate).
//   · AFTER_THE_FIX — the tree with the `argparse` pin: five entries (five
//     high, zero moderate) carrying the one advisory that has no patched
//     version upstream.
//
// The gate has to keep both: the advisory the fix removes has to be red
// (otherwise the pin could be dropped unnoticed), and the advisory that is
// left has to stay green (otherwise the step dies after the first week).
//
// The fixtures are a *snapshot*: they are compared against the accepted list
// they were measured against (`ACCEPTED_AT_THE_MEASUREMENT`), not against the
// live `ACCEPTED_ADVISORIES`, which is empty since GitHub withdrew
// GHSA-vfj7-8cjw-p6xm on 2026-10-23. Whether the live list matches the
// registry is the gate's own job (`npm run check:audit`); a test that ran the
// registry would only be as stable as the registry.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCEPTED_ADVISORIES } from "./npm-audit-baseline.mjs";
import { advisoryId, analyzeAuditReport, collectAdvisories } from "./check-npm-audit.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "check-npm-audit.mjs");

/**
 * The accepted list the two fixtures were measured against: on 2026-10-21 the
 * tree carried `braces` and no patched version existed upstream.
 */
const ACCEPTED_AT_THE_MEASUREMENT = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    package: "braces",
    severity: "high",
    reason: "no patched version upstream at the time of the measurement",
  },
];

const BEFORE_THE_FIX = JSON.parse(`{
  "vulnerabilities": {
    "@next/eslint-plugin-next": {
      "name": "@next/eslint-plugin-next",
      "severity": "high",
      "isDirect": false,
      "via": [
        "fast-glob"
      ],
      "effects": [
        "eslint-config-next"
      ],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/@next/eslint-plugin-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "argparse": {
      "name": "argparse",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        "sprintf-js"
      ],
      "effects": [
        "mammoth"
      ],
      "range": "1.0.0 - 1.0.10",
      "nodes": [
        "node_modules/mammoth/node_modules/argparse"
      ],
      "fixAvailable": {
        "name": "mammoth",
        "version": "0.3.29",
        "isSemVerMajor": true
      }
    },
    "braces": {
      "name": "braces",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1240992,
          "name": "braces",
          "dependency": "braces",
          "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
          "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
          "severity": "high",
          "cwe": [
            "CWE-674"
          ],
          "cvss": {
            "score": 7.5,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
          },
          "range": "<=3.0.3"
        }
      ],
      "effects": [
        "micromatch"
      ],
      "range": "*",
      "nodes": [
        "node_modules/braces"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "eslint-config-next": {
      "name": "eslint-config-next",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@next/eslint-plugin-next"
      ],
      "effects": [],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/eslint-config-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "fast-glob": {
      "name": "fast-glob",
      "severity": "high",
      "isDirect": false,
      "via": [
        "micromatch"
      ],
      "effects": [
        "@next/eslint-plugin-next"
      ],
      "range": "*",
      "nodes": [
        "node_modules/fast-glob"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "mammoth": {
      "name": "mammoth",
      "severity": "moderate",
      "isDirect": true,
      "via": [
        "argparse"
      ],
      "effects": [],
      "range": ">=0.3.30",
      "nodes": [
        "node_modules/mammoth"
      ],
      "fixAvailable": {
        "name": "mammoth",
        "version": "0.3.29",
        "isSemVerMajor": true
      }
    },
    "micromatch": {
      "name": "micromatch",
      "severity": "high",
      "isDirect": false,
      "via": [
        "braces"
      ],
      "effects": [
        "fast-glob"
      ],
      "range": ">=0.2.0",
      "nodes": [
        "node_modules/micromatch"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "sprintf-js": {
      "name": "sprintf-js",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        {
          "source": 1241202,
          "name": "sprintf-js",
          "dependency": "sprintf-js",
          "title": "sprintf-js vulnerable to denial of service through unbounded precision specifiers",
          "url": "https://github.com/advisories/GHSA-hp3w-g68c-fv3c",
          "severity": "moderate",
          "cwe": [
            "CWE-1284"
          ],
          "cvss": {
            "score": 5.3,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"
          },
          "range": "<=1.1.3"
        }
      ],
      "effects": [
        "argparse"
      ],
      "range": "*",
      "nodes": [
        "node_modules/sprintf-js"
      ],
      "fixAvailable": {
        "name": "mammoth",
        "version": "0.3.29",
        "isSemVerMajor": true
      }
    }
  }
}`);

const AFTER_THE_FIX = JSON.parse(`{
  "vulnerabilities": {
    "@next/eslint-plugin-next": {
      "name": "@next/eslint-plugin-next",
      "severity": "high",
      "isDirect": false,
      "via": [
        "fast-glob"
      ],
      "effects": [
        "eslint-config-next"
      ],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/@next/eslint-plugin-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "braces": {
      "name": "braces",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1240992,
          "name": "braces",
          "dependency": "braces",
          "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
          "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
          "severity": "high",
          "cwe": [
            "CWE-674"
          ],
          "cvss": {
            "score": 7.5,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
          },
          "range": "<=3.0.3"
        }
      ],
      "effects": [
        "micromatch"
      ],
      "range": "*",
      "nodes": [
        "node_modules/braces"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "eslint-config-next": {
      "name": "eslint-config-next",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@next/eslint-plugin-next"
      ],
      "effects": [],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/eslint-config-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "fast-glob": {
      "name": "fast-glob",
      "severity": "high",
      "isDirect": false,
      "via": [
        "micromatch"
      ],
      "effects": [
        "@next/eslint-plugin-next"
      ],
      "range": "*",
      "nodes": [
        "node_modules/fast-glob"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "micromatch": {
      "name": "micromatch",
      "severity": "high",
      "isDirect": false,
      "via": [
        "braces"
      ],
      "effects": [
        "fast-glob"
      ],
      "range": ">=0.2.0",
      "nodes": [
        "node_modules/micromatch"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    }
  }
}`);

describe("collectAdvisories", () => {
  it("reads the advisories out of the report, not the packages that carry them", () => {
    // Eight packages, two advisories: npm lists a package per entry and the
    // advisories it inherits in `via`. The advisory is what has to be on the
    // list, not the package.
    const advisories = collectAdvisories(BEFORE_THE_FIX);

    expect(advisories.map((advisory) => advisory.id)).toEqual([
      "GHSA-hp3w-g68c-fv3c",
      "GHSA-vfj7-8cjw-p6xm",
    ]);
    expect(advisories.map((advisory) => advisory.package)).toEqual(["sprintf-js", "braces"]);
    expect(advisories.map((advisory) => advisory.severity)).toEqual(["moderate", "high"]);
  });

  it("names the packages the advisory is carried by", () => {
    const advisories = collectAdvisories(BEFORE_THE_FIX);
    const braces = advisories.find((advisory) => advisory.package === "braces");

    // braces ← micromatch ← fast-glob ← @next/eslint-plugin-next ←
    // eslint-config-next: the whole chain is in the tree.
    expect(braces?.packages).toEqual([
      "braces",
      "micromatch",
      "fast-glob",
      "@next/eslint-plugin-next",
      "eslint-config-next",
    ]);
  });

  it("reads the id out of the advisory URL", () => {
    expect(
      advisoryId({ url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm", source: 1240992 }),
    ).toBe("GHSA-vfj7-8cjw-p6xm");
    expect(advisoryId({ source: 1240992 })).toBe("npm-1240992");
  });
});

describe("analyzeAuditReport", () => {
  it("flags the advisory the pin removes — the tree before the fix", () => {
    const findings = analyzeAuditReport(BEFORE_THE_FIX, ACCEPTED_AT_THE_MEASUREMENT);

    expect(findings.map((finding) => finding.rule)).toEqual(["unaccepted-advisory"]);
    expect(findings[0].message).toContain("GHSA-hp3w-g68c-fv3c");
    expect(findings[0].message).toContain("sprintf-js");
    expect(findings[0].message).toContain("moderate");
  });

  it("accepts the advisory the tree still carries", () => {
    // `braces` had no patched version upstream, so it stayed on the list with
    // its reason. The gate must not fail on it — otherwise the step is dead
    // after the first week.
    expect(analyzeAuditReport(AFTER_THE_FIX, ACCEPTED_AT_THE_MEASUREMENT)).toEqual([]);
  });

  it("flags a new advisory, whatever its severity", () => {
    const report = JSON.parse(JSON.stringify(AFTER_THE_FIX));
    report.vulnerabilities["new-package"] = {
      name: "new-package",
      severity: "high",
      isDirect: true,
      range: "<2.0.0",
      via: [
        {
          source: 9999999,
          name: "new-package",
          dependency: "new-package",
          title: "a new advisory",
          url: "https://github.com/advisories/GHSA-0000-0000-0000",
          severity: "high",
          range: "<2.0.0",
        },
      ],
      effects: [],
      nodes: ["node_modules/new-package"],
      fixAvailable: true,
    };

    const findings = analyzeAuditReport(report, ACCEPTED_AT_THE_MEASUREMENT);

    expect(findings.map((finding) => finding.rule)).toEqual(["unaccepted-advisory"]);
    expect(findings[0].message).toContain("GHSA-0000-0000-0000");
    expect(findings[0].message).toContain("high");
  });

  it("flags an accepted advisory that the tree no longer carries", () => {
    // The list may only shrink: when upstream ships the fix, the entry has to
    // be deleted — the gate says so instead of letting it rot.
    const report = JSON.parse(JSON.stringify(AFTER_THE_FIX));
    delete report.vulnerabilities.braces;
    delete report.vulnerabilities.micromatch;
    delete report.vulnerabilities["fast-glob"];
    delete report.vulnerabilities["@next/eslint-plugin-next"];
    delete report.vulnerabilities["eslint-config-next"];

    const findings = analyzeAuditReport(report, ACCEPTED_AT_THE_MEASUREMENT);

    expect(findings.map((finding) => finding.rule)).toEqual(["stale-baseline"]);
    expect(findings[0].message).toContain("GHSA-vfj7-8cjw-p6xm");
  });
});

describe("the gate as a command", () => {
  it("fails when the audit cannot be run", () => {
    // An unreachable registry is not an empty tree: the gate cannot know the
    // state of the dependencies, so it has to fail — not pass.
    let code = 0;
    let output = "";
    try {
      output = execFileSync("node", [GATE], {
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          npm_config_registry: "http://127.0.0.1:1",
          npm_config_fetch_retries: "0",
        },
      });
    } catch (error) {
      code = error.status ?? 1;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }

    expect(code).toBe(1);
    expect(output).toContain("the audit could not be run");
  });
});

describe("the accepted advisories", () => {
  it("carry a reason and a severity", () => {
    for (const entry of ACCEPTED_ADVISORIES) {
      expect(entry.id).toMatch(/^GHSA-/);
      expect(entry.package.length).toBeGreaterThan(0);
      expect(entry.severity.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("names every advisory at most once — the gate matches by id", () => {
    const ids = ACCEPTED_ADVISORIES.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
