/**
 * Single source of truth for the code block language picker.
 *
 * Shared by the editor (Notion-style selector on the code block node view),
 * the lowlight wiring and the unit tests. Every entry maps to a grammar name
 * that is part of highlight.js' *common* set (what `lowlight` registers via
 * `createLowlight(common)`), so any value picked in the UI highlights without
 * pulling the full language zoo into the bundle.
 *
 * `value` is what lands in the TipTap codeBlock `language` attribute (and in
 * markdown fences on export); it must stay lowercase so it round-trips.
 */

export type CodeLanguage = {
  /** Stored in the codeBlock `language` attribute (lowercase slug). */
  value: string;
  /** Human label shown on the picker trigger. */
  label: string;
  /** Registered lowlight / highlight.js grammar name used for highlighting. */
  lowlight: string;
  /** Common aliases (fence languages like "ts", "sh", "html" resolve through these). */
  aliases?: readonly string[];
};

export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { value: "plaintext", label: "Plain text", lowlight: "plaintext", aliases: ["txt", "text"] },
  { value: "javascript", label: "JavaScript", lowlight: "javascript", aliases: ["js", "jsx", "mjs", "cjs", "node"] },
  { value: "typescript", label: "TypeScript", lowlight: "typescript", aliases: ["ts", "tsx"] },
  { value: "python", label: "Python", lowlight: "python", aliases: ["py", "python3", "ipython"] },
  { value: "java", label: "Java", lowlight: "java" },
  { value: "c", label: "C", lowlight: "c", aliases: ["h"] },
  { value: "cpp", label: "C++", lowlight: "cpp", aliases: ["c++", "cxx", "cc", "hpp"] },
  { value: "csharp", label: "C#", lowlight: "csharp", aliases: ["cs"] },
  { value: "go", label: "Go", lowlight: "go", aliases: ["golang"] },
  { value: "rust", label: "Rust", lowlight: "rust", aliases: ["rs"] },
  { value: "ruby", label: "Ruby", lowlight: "ruby", aliases: ["rb"] },
  { value: "php", label: "PHP", lowlight: "php" },
  { value: "kotlin", label: "Kotlin", lowlight: "kotlin", aliases: ["kt"] },
  { value: "swift", label: "Swift", lowlight: "swift" },
  { value: "sql", label: "SQL", lowlight: "sql" },
  { value: "shell", label: "Shell", lowlight: "shell", aliases: ["sh"] },
  { value: "bash", label: "Bash", lowlight: "bash", aliases: ["zsh"] },
  { value: "html", label: "HTML", lowlight: "xml", aliases: ["htm", "xhtml"] },
  { value: "xml", label: "XML", lowlight: "xml" },
  { value: "css", label: "CSS", lowlight: "css" },
  { value: "scss", label: "SCSS", lowlight: "scss", aliases: ["sass"] },
  { value: "json", label: "JSON", lowlight: "json" },
  { value: "yaml", label: "YAML", lowlight: "yaml", aliases: ["yml"] },
  { value: "markdown", label: "Markdown", lowlight: "markdown", aliases: ["md", "mkdn"] },
  { value: "graphql", label: "GraphQL", lowlight: "graphql", aliases: ["gql"] },
  { value: "toml", label: "TOML", lowlight: "ini", aliases: ["ini", "cfg", "conf"] },
  { value: "lua", label: "Lua", lowlight: "lua" },
  { value: "perl", label: "Perl", lowlight: "perl", aliases: ["pl"] },
  { value: "r", label: "R", lowlight: "r" },
  { value: "makefile", label: "Makefile", lowlight: "makefile", aliases: ["make", "mk"] },
  { value: "diff", label: "Diff", lowlight: "diff", aliases: ["patch"] },
  { value: "arduino", label: "Arduino", lowlight: "arduino" },
  { value: "objectivec", label: "Objective-C", lowlight: "objectivec", aliases: ["objc"] },
  { value: "vbnet", label: "VB.NET", lowlight: "vbnet", aliases: ["vb"] },
  { value: "wasm", label: "WebAssembly", lowlight: "wasm" },
  { value: "less", label: "Less", lowlight: "less" },
];

/** Label used when a block carries no language at all. */
export const PLAIN_TEXT_LABEL = "Plain text";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Look up an entry by value or alias (case-insensitive). */
export function findCodeLanguage(
  value: string | null | undefined,
): CodeLanguage | undefined {
  const needle = normalize(value);
  if (!needle) return undefined;
  return (
    CODE_LANGUAGES.find((lang) => lang.value === needle) ??
    CODE_LANGUAGES.find((lang) => lang.aliases?.includes(needle))
  );
}

/**
 * Grammar name for highlighting: the registered lowlight grammar for a stored
 * value (resolving aliases such as "ts" or "html"), or null when unknown.
 */
export function lowlightNameFor(
  value: string | null | undefined,
): string | null {
  return findCodeLanguage(value)?.lowlight ?? null;
}

/**
 * Picker trigger label: the registered label when known, the raw value for
 * fence languages outside the registry, and "Plain text" when empty.
 */
export function codeLanguageLabel(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return PLAIN_TEXT_LABEL;
  return findCodeLanguage(raw)?.label ?? raw;
}

/**
 * Searchable label list for the picker: case-insensitive substring match over
 * label, value and aliases. An empty/whitespace query returns the full list.
 */
export function searchCodeLanguages(query: string): CodeLanguage[] {
  const needle = normalize(query);
  if (!needle) return [...CODE_LANGUAGES];
  return CODE_LANGUAGES.filter(
    (lang) =>
      lang.label.toLowerCase().includes(needle) ||
      lang.value.includes(needle) ||
      lang.aliases?.some((alias) => alias.includes(needle)) === true,
  );
}
