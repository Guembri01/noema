/**
 * Project metadata, in one place.
 *
 * The About box names the project, its authors and its licence — and so do
 * `README.md`, `LICENSE`, `AUTHORS.md`, `package.json` and `CITATION.cff`.
 * Keeping the values here means the app cannot drift from what the repository
 * says, and a fork only has to edit one module to re-brand the UI.
 *
 * `PROJECT_REPOSITORY` is the canonical repository URL —
 * <https://github.com/Guembri01/noema>. The app's About box links to it, so a
 * fork only has to change this one module and `README.md`'s badge links.
 */

/** Display name, matching `package.json` and `tauri.conf.json`. */
export const PROJECT_NAME = "Noema";

/** Canonical repository URL — <https://github.com/Guembri01/noema>. */
export const PROJECT_REPOSITORY = "https://github.com/Guembri01/noema";

/** Where the long-form documentation lives (see `docs/README.md`). */
export const PROJECT_DOCS_URL = `${PROJECT_REPOSITORY}/tree/main/docs`;

/** SPDX identifier of the licence the project ships under. */
export const PROJECT_LICENCE = "MIT";

/**
 * The people who wrote Noema, in the order `AUTHORS.md` and `LICENSE` use.
 * Not a contributor list — that lives in the repository, where a pull request
 * can extend it.
 */
export const PROJECT_AUTHORS = ["Bilel Guembri", "Wissal Ben Othmen"] as const;

/** The authors as one readable phrase: `A`, `A and B`, `A, B and C`. */
export function projectAuthorLine(): string {
  const names = [...PROJECT_AUTHORS];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
