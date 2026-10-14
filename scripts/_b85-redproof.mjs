/**
 * B85 red-proof harness — proves `src/lib/secrets.test.ts` can fail.
 *
 * `src/lib/secrets.ts` is READ-ONLY for B85, so discrimination is proven with
 * MUTANT COPIES: for each mutation a broken `secrets.b85mut.ts` is generated
 * from the pristine source, the committed test file is pointed at it (import
 * rewrite only, assertions untouched), and vitest must go RED on the tests
 * that encode the mutated behaviour. A mutation that leaves the suite green
 * means the test does not discriminate -> exit 1.
 *
 * Also runs one proof against the REAL module: empty-plaintext round-trip
 * (`decryptSecret(encryptSecret(""))` should be "") which is expected RED and
 * reported as a finding, not fixed (secrets.ts is read-only).
 *
 * Temp files are always cleaned up in `finally` so tsc/eslint gates stay clean.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src", "lib", "secrets.ts");
const TEST = path.join(ROOT, "src", "lib", "secrets.test.ts");
const MUT_SRC = path.join(ROOT, "src", "lib", "secrets.b85mut.ts");
const MUT_TEST = path.join(ROOT, "src", "lib", "secrets.b85mut.test.ts");
const PROOF_TEST = path.join(ROOT, "src", "lib", "secrets.b85proof.test.ts");
const LOG_DIR = path.join(ROOT, "scripts", "_logs");
const JSON_OUT = path.join(LOG_DIR, "b85-redproof.json");
const REPORT = path.join(LOG_DIR, "b85-redproof.md");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

/** @type {{id: string, intent: string, from: string, to: string}[]} */
const MUTATIONS = [
  {
    id: "M1-key-ignores-secret",
    intent: "key derivation no longer mixes in AUTH_SECRET -> wrong-secret tests must fail",
    from: "return createHash(\"sha256\").update(`noema:ai-provider:v1:${secret}`).digest();",
    to: "return createHash(\"sha256\").update(`noema:ai-provider:v1:hardcoded`).digest();",
  },
  {
    id: "M2-auth-failure-leaks-payload",
    intent: "GCM auth failure falls back to returning ciphertext -> tamper/wrong-secret tests must fail",
    from: "  } catch {\n    return null;\n  }",
    to: "  } catch {\n    return Buffer.from(payload, \"base64\").toString(\"utf8\");\n  }",
  },
  {
    id: "M3-version-not-enforced",
    intent: "`v1:` prefix check dropped -> v2-rejection test must fail",
    from: "if (version !== \"v1\" || !iv || !tag || !payload) return null;",
    to: "if (!iv || !tag || !payload) return null;",
  },
  {
    id: "M4-error-leaks-plaintext",
    intent: "missing-secret error embeds the plaintext -> no-leak test must fail",
    from: "  const iv = randomBytes(12);",
    to: "  const iv = randomBytes(12);\n  if (!process.env.AUTH_SECRET) throw new Error(\"encrypt failed for \" + plaintext);",
  },
  {
    id: "M5-empty-secret-accepted",
    intent: "empty/missing AUTH_SECRET silently accepted -> throws-on-missing tests must fail",
    from: "  if (!secret) {",
    to: "  if (false) {",
  },
  {
    id: "M6-no-version-prefix",
    intent: "encryptor drops the `v1:` prefix -> envelope-format + round-trip tests must fail",
    from: "  return `v1:${iv.toString(\"base64\")}:${tag.toString(\"base64\")}:${payload.toString(\"base64\")}`;",
    to: "  return `${iv.toString(\"base64\")}:${tag.toString(\"base64\")}:${payload.toString(\"base64\")}`;",
  },
  {
    id: "M7-fixed-iv",
    intent: "IV hardcoded -> per-call randomness test must fail",
    from: "  const iv = randomBytes(12);",
    to: "  const iv = Buffer.alloc(12);",
  },
];

const EMPTY_PROOF = `
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

describe("B85 finding: empty-plaintext round-trip", () => {
  it("round-trips an empty string", () => {
    process.env.AUTH_SECRET = "b85-proof-secret";
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });
});
`;

function cleanup() {
  for (const f of [MUT_SRC, MUT_TEST, PROOF_TEST]) {
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      /* best effort */
    }
  }
}

function runVitest(file) {
  let stdout = "";
  try {
    execFileSync(
      process.execPath,
      [VITEST, "run", path.relative(ROOT, file), "--reporter=json", `--outputFile=${JSON_OUT}`],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 },
    );
  } catch (error) {
    stdout = error.stdout ?? "";
  }
  const parse = (text) => {
    const data = JSON.parse(text);
    const assertions = (data.testResults ?? []).flatMap((r) => r.assertionResults ?? []);
    return {
      failed: assertions.filter((a) => a.status === "failed").map((a) => a.fullName),
      passed: assertions.filter((a) => a.status === "passed").length,
      total: assertions.length,
      success: data.success,
    };
  };
  if (existsSync(JSON_OUT)) {
    try {
      const parsed = parse(readFileSync(JSON_OUT, "utf8"));
      rmSync(JSON_OUT, { force: true });
      return parsed;
    } catch {
      /* fall through to stdout */
    }
  }
  return parse(stdout);
}

const pristine = readFileSync(SRC, "utf8");
const testSource = readFileSync(TEST, "utf8");
const mutTestSource = testSource.replaceAll('from "@/lib/secrets"', 'from "@/lib/secrets.b85mut"');
if (mutTestSource === testSource) throw new Error("import rewrite failed — test file changed?");

mkdirSync(LOG_DIR, { recursive: true });

const lines = [
  "# B85 red-proof — secrets.test.ts discrimination",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Mutation | Intent | Red | Green | Failed tests |",
  "|---|---|---|---|---|",
];

let broken = false;
try {
  for (const mutation of MUTATIONS) {
    if (!pristine.includes(mutation.from)) {
      broken = true;
      lines.push(`| ${mutation.id} | ANCHOR NOT FOUND | - | - | ${mutation.from.slice(0, 40)}… |`);
      continue;
    }
    writeFileSync(MUT_SRC, pristine.replace(mutation.from, mutation.to));
    writeFileSync(MUT_TEST, mutTestSource);
    let result;
    try {
      result = runVitest(MUT_TEST);
    } finally {
      cleanup();
    }
    const red = result.failed.length;
    const green = result.passed;
    const ok = red > 0;
    if (!ok) broken = true;
    lines.push(
      `| ${mutation.id} | ${mutation.intent} | ${red} | ${green} | ${red ? result.failed.map((f) => `\`${f}\``).join("<br>") : "**NONE — DOES NOT DISCRIMINATE**"} |`,
    );
    console.log(`${ok ? "RED  " : "GREEN"} ${mutation.id}: ${red} failed / ${result.total}`);
    for (const failure of result.failed) console.log(`       - ${failure}`);
  }

  // Finding proof against the REAL (read-only) module: expected RED.
  writeFileSync(PROOF_TEST, EMPTY_PROOF);
  let proof;
  try {
    proof = runVitest(PROOF_TEST);
  } finally {
    cleanup();
  }
  const findingRed = proof.failed.length > 0;
  lines.push(
    "",
    "## Finding proof (real module, secrets.ts untouched)",
    "",
    `- \`decryptSecret(encryptSecret(""))\` expected \`""\`: **${findingRed ? "RED (finding confirmed)" : "GREEN (no finding)"}**`,
    ...(proof.failed.length ? [`- Failing: \`${proof.failed[0]}\``] : []),
    "",
    findingRed
      ? "Report-only per brief (secrets.ts READ-ONLY); committed suite documents it as a CHARACTERIZATION test."
      : "Round-trip of empty string already works — nothing to report.",
  );
} finally {
  cleanup();
}

writeFileSync(REPORT, lines.join("\n"));
console.log(`\nEvidence: ${path.relative(ROOT, REPORT)}`);
if (broken) {
  console.error("RED-PROOF FAILED: a mutation left the suite green (no discrimination).");
  process.exit(1);
}
console.log("RED-PROOF OK: every mutation turned at least one committed test red.");
