import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // The desktop scripts that run *inside the packaged payload* must be
    // CommonJS: `start.cjs` is copied into the Next standalone output and has to
    // `require("./server.js")` (CJS, no bundler at that point), and its helper is
    // required from there. ESM is not an option for them.
    files: ["scripts/desktop/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Agent-harness skills and local tooling are not application source;
      // their CommonJS helper scripts have their own runtime contract.
      ".agents/**",
      ".opencode/**",
      // Staged desktop payload (bundled runtime + standalone server): build
      // output, never linted as source.
      "src-tauri/server/**",
      "src-tauri/target/**",
      // gitignored local-only gate evidence logs (never shipped)
      "scripts/_logs/**",
      // The product film is a separate Remotion project with its own tsconfig,
      // its own React and its own build; it is excluded from the app's
      // toolchain for the same reason src-tauri/server is.
      "video/**",
      // Vendored browser WASM/layout asset for PlantUML; third-party build, not
      // application source.
      "public/vendor/**",
    ],
  },
];

export default eslintConfig;
