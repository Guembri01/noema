/**
 * B55 — pure `?format=` contract for the export routes (spec R23.16).
 *
 * An unknown format must be a 400, never a silent fallback: the page export
 * used to fall through to Markdown for anything it did not recognise.
 * Framework-free on purpose so it is unit-testable in the lib sandbox.
 *
 * The export-zip slice (MISSING_FEATURES §12) adds the export building
 * blocks on top: the `?includeSubpages=` toggle, the page-tree walk behind
 * it, attachment path mapping, and `buildWorkspaceZip` — the pure assembler
 * that bundles pages, databases, attachments and a structure manifest into
 * a single archive.
 */

import JSZip from "jszip";

/** Formats the page export accepts (default: `md`). */
export const PAGE_EXPORT_FORMATS = ["md", "json", "html", "pdf"] as const;

/**
 * Formats the database export accepts (default: `csv`; B91/R23.16 adds
 * `json`).
 */
export const DATABASE_EXPORT_FORMATS = ["csv", "json"] as const;

/** Formats the workspace export accepts (default: `zip`). */
export const WORKSPACE_EXPORT_FORMATS = ["zip"] as const;

export type ExportFormatResult =
  | { ok: true; format: string }
  | { ok: false; error: string; valid: readonly string[] };

/**
 * Validate a raw `?format=` value against a route's allowlist.
 *
 * - absent (`null`) or empty (`""`) → the route's default `fallback`
 * - a value in `allowed` → `{ ok: true, format }`
 * - anything else → `{ ok: false, error, valid }` (route answers 400 with
 *   `{ error, valid }` so the caller sees the valid formats)
 *
 * Matching is exact: `MD` is not `md` (documented in export-format.test.ts).
 */
export function parseExportFormat(
  raw: string | null,
  allowed: readonly string[],
  fallback: string,
): ExportFormatResult {
  if (raw === null || raw === "") return { ok: true, format: fallback };
  if (allowed.includes(raw)) return { ok: true, format: raw };
  return {
    ok: false,
    error: `Unknown export format "${raw}". Valid formats: ${allowed.join(", ")}.`,
    valid: allowed,
  };
}

// ---------------------------------------------------------------------------
// Export depth: subpages toggle (MISSING_FEATURES §12)
// ---------------------------------------------------------------------------

/**
 * Parse `?includeSubpages=` for the export routes. Absent or empty keeps the
 * default — subpages included, so today's behaviour is unchanged — and only
 * the exact lowercase `false` excludes children, matching the exact-match
 * rule `parseExportFormat` documents.
 */
export function parseIncludeSubpages(raw: string | null): boolean {
  return raw !== "false";
}

/** A page as seen by the export tree walk. */
export type ExportPageNode = { id: string; parentId: string | null };

/**
 * The page ids an export should include, in depth-first pre-order.
 *
 * Roots are pages with no parent *or* a parent outside the export set (a
 * live page under a trashed parent still exports, as it does today). With
 * `includeSubpages: false` only the roots are exported — "export without
 * subpages". `rootIds` pins the walk to explicit roots, which is how a
 * single-page export recurses into its subtree (or refuses to).
 *
 * Cycles terminate instead of hanging: a page is visited at most once.
 */
export function collectExportPageIds(
  pages: readonly ExportPageNode[],
  options: { includeSubpages: boolean; rootIds?: readonly string[] },
): string[] {
  const present = new Set(pages.map((page) => page.id));
  const children = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = children.get(page.parentId) ?? [];
    list.push(page.id);
    children.set(page.parentId, list);
  }

  const roots =
    options.rootIds ??
    pages
      .filter((page) => !page.parentId || !present.has(page.parentId))
      .map((page) => page.id);

  const seen = new Set<string>();
  const order: string[] = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      if (!options.includeSubpages) continue;
      const kids = children.get(id) ?? [];
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Zip paths + attachments
// ---------------------------------------------------------------------------

/** Folder inside the archive where uploaded attachments are bundled. */
export const ATTACHMENT_DIR = "attachments";

const UPLOAD_URL = /\/api\/files\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]*[A-Za-z0-9]/g;

/**
 * Map a `/api/files/<workspace>/<name>` upload URL onto the relative path
 * where the archive bundles it, refusing traversal and malformed URLs.
 */
export function attachmentZipPath(url: string): string | null {
  const match = /^\/api\/files\/[A-Za-z0-9_-]+\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!match || match[1].includes("..")) return null;
  return `${ATTACHMENT_DIR}/${match[1]}`;
}

/**
 * Rewrite upload URLs in exported markdown to the relative paths where the
 * archive bundles the files, so the export is self-contained. `data:` URLs
 * and foreign hosts are untouched; a trailing sentence dot is not consumed.
 */
export function rewriteAttachments(markdown: string): string {
  return markdown.replace(UPLOAD_URL, (url) => attachmentZipPath(url) ?? url);
}

/**
 * Deduplicate a zip entry path against `used` by appending ` (1)`, ` (2)`…
 * before the extension. The set is mutated so the caller can keep stacking
 * collisions; dots inside a directory segment are never touched.
 */
export function uniqueZipPath(path: string, used: Set<string>): string {
  let candidate = path;
  let n = 1;
  while (used.has(candidate)) {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const hasExtension = dot > slash + 1;
    const base = hasExtension ? path.slice(0, dot) : path;
    const extension = hasExtension ? path.slice(dot) : "";
    candidate = `${base} (${n++})${extension}`;
  }
  used.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Zip assembly (MISSING_FEATURES §12: export as zip)
// ---------------------------------------------------------------------------

/** What an archive entry represents, recorded in the structure manifest. */
export type WorkspaceZipKind = "page" | "database" | "attachment";

/** One file to bundle: Markdown/CSV text, or raw bytes for attachments. */
export type WorkspaceZipFile = {
  path: string;
  kind: WorkspaceZipKind;
  content: string | Uint8Array;
  pageId?: string;
  mimeType?: string;
};

export type WorkspaceZipOptions = {
  workspaceName: string;
  includeSubpages: boolean;
  files: readonly WorkspaceZipFile[];
  /** Injectable for deterministic tests; defaults to now. */
  exportedAt?: Date;
};

type ManifestEntry = { path: string; kind: WorkspaceZipKind; pageId?: string; mimeType?: string };

/**
 * Assemble a workspace export archive: one entry per file (colliding paths
 * deduplicated), plus a `README.md` and a machine-readable `manifest.json`
 * recording the export options and every file it contains. The README and
 * manifest names are reserved first, so a page called "README" is renamed
 * rather than clobbering them. Pure apart from jszip's own deflate, so it
 * unit-tests without a database or network.
 */
export async function buildWorkspaceZip(options: WorkspaceZipOptions): Promise<Buffer> {
  const zip = new JSZip();
  const used = new Set<string>(["README.md", "manifest.json"]);
  const exportedAt = (options.exportedAt ?? new Date()).toISOString();
  const manifest: ManifestEntry[] = [];

  for (const file of options.files) {
    const path = uniqueZipPath(file.path, used);
    zip.file(path, file.content);
    manifest.push({
      path,
      kind: file.kind,
      ...(file.pageId ? { pageId: file.pageId } : {}),
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    });
  }

  zip.file("README.md", `# ${options.workspaceName}\n\nExported from Noema on ${exportedAt}.\n`);
  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        workspace: options.workspaceName,
        exportedAt,
        includeSubpages: options.includeSubpages,
        files: manifest,
      },
      null,
      2,
    ),
  );

  return zip.generateAsync({ type: "nodebuffer" });
}
