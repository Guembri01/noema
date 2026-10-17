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
    // The desktop boot wrapper must be CommonJS: it is copied into the Next
    // standalone output and has to `require("./server.js")` — that server is CJS
    // and there is no bundler at that point, so ESM is not an option there.
    files: ["scripts/desktop/boot-wrapper.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Staged desktop payload (bundled runtime + standalone server): build
      // output, never linted as source.
      "src-tauri/server/**",
      "src-tauri/target/**",
      // gitignored local-only parity-loop evidence logs (never shipped)
      "scripts/_logs/**",
    ],
  },
];

export default eslintConfig;
