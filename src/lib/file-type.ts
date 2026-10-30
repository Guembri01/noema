/**
 * File types — one pure, dependency-free home for the extension ↔ MIME table
 * and the small predicates the editor/database file blocks need (glyph pick,
 * image detection, upload allow-lists).
 *
 * Everything here is total: unknown extensions/MIME types never throw, they
 * degrade to `DEFAULT_MIME`, `""` or `"other"`, and all inputs are matched
 * case-insensitively (a leading "." on an extension is optional).
 */

/** The category a file falls into — drives the glyph and allow-list matching. */
export type FileCategory =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "sheet"
  | "archive"
  | "code"
  | "other";

/** Returned by `mimeForExt` when the extension is unknown. */
export const DEFAULT_MIME = "application/octet-stream";

/**
 * `accept` value for attachment/file pickers: pictures plus every document,
 * spreadsheet, presentation and archive the upload route stores. Keep this as
 * the single source of truth so page, ticket and comment pickers cannot drift.
 */
export const DOCUMENT_ATTACHMENT_ACCEPT =
  "image/*,.pdf,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.md,.csv,.json,.zip,.rar,.7z,.gz,.tar";

/**
 * Extension → MIME pairs. Ordered: the first extension listed for a MIME type
 * is the canonical one `extForMime` returns (so `jpg` wins over `jpeg`).
 */
const EXT_MIME: ReadonlyArray<readonly [string, string]> = [
  // image
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["heic", "image/heic"],
  // video
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
  ["avi", "video/x-msvideo"],
  ["mkv", "video/x-matroska"],
  // audio
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["m4a", "audio/mp4"],
  ["flac", "audio/flac"],
  ["aac", "audio/aac"],
  // documents
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["odt", "application/vnd.oasis.opendocument.text"],
  ["rtf", "application/rtf"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["odp", "application/vnd.oasis.opendocument.presentation"],
  // spreadsheets
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ["csv", "text/csv"],
  // archives
  ["zip", "application/zip"],
  ["rar", "application/vnd.rar"],
  ["7z", "application/x-7z-compressed"],
  ["gz", "application/gzip"],
  ["tar", "application/x-tar"],
  // code / data
  ["json", "application/json"],
  ["xml", "application/xml"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["css", "text/css"],
  ["js", "application/javascript"],
  ["mjs", "application/javascript"],
  ["cjs", "application/javascript"],
  ["ts", "application/typescript"],
  ["tsx", "application/typescript"],
  ["toml", "application/toml"],
  ["dart", "application/dart"],
  ["py", "text/x-python"],
  ["rb", "text/x-ruby"],
  ["go", "text/x-go"],
  ["rs", "text/x-rust"],
  ["java", "text/x-java-source"],
  ["c", "text/x-c"],
  ["h", "text/x-c"],
  ["cpp", "text/x-c++"],
  ["hpp", "text/x-c++"],
  ["cc", "text/x-c++"],
  ["cs", "text/x-csharp"],
  ["php", "text/x-php"],
  ["sh", "text/x-shellscript"],
  ["bash", "text/x-shellscript"],
  ["sql", "text/x-sql"],
  ["yml", "text/x-yaml"],
  ["yaml", "text/x-yaml"],
  ["kt", "text/x-kotlin"],
  ["swift", "text/x-swift"],
  ["r", "text/x-r"],
  ["lua", "text/x-lua"],
  ["scss", "text/x-scss"],
  ["less", "text/x-less"],
];

/** Public extension → MIME lookup (keys are lower-case, without a dot). */
export const MIME_BY_EXT: Readonly<Record<string, string>> = Object.fromEntries(EXT_MIME);

/** Canonical MIME → extension, first entry wins. */
const EXT_BY_MIME: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const [ext, mime] of EXT_MIME) {
    if (!(mime in map)) map[mime] = ext;
  }
  return map;
})();

/** MIME types whose category is not implied by their prefix. */
const CATEGORY_BY_MIME: Readonly<Record<string, FileCategory>> = {
  "application/pdf": "pdf",
  "text/plain": "doc",
  "text/markdown": "doc",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
  "application/vnd.oasis.opendocument.text": "doc",
  "application/rtf": "doc",
  "application/vnd.ms-powerpoint": "doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "doc",
  "application/vnd.oasis.opendocument.presentation": "doc",
  "application/vnd.ms-excel": "sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "sheet",
  "application/vnd.oasis.opendocument.spreadsheet": "sheet",
  "text/csv": "sheet",
  "application/zip": "archive",
  "application/vnd.rar": "archive",
  "application/x-7z-compressed": "archive",
  "application/gzip": "archive",
  "application/x-tar": "archive",
  "application/json": "code",
  "application/xml": "code",
  "application/javascript": "code",
  "application/typescript": "code",
  "application/toml": "code",
  "application/dart": "code",
  "text/html": "code",
  "text/css": "code",
  "text/javascript": "code",
};

/** Glyph shown for each category (emoji, so no icon dependency is needed). */
export const ICON_BY_CATEGORY: Readonly<Record<FileCategory, string>> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  pdf: "📄",
  doc: "📝",
  sheet: "📊",
  archive: "🗜️",
  code: "💻",
  other: "📎",
};

/** Lower-case a MIME and drop any `; charset=…` parameters. */
function normalizeMime(mime: string): string {
  return (mime ?? "").split(";", 1)[0].trim().toLowerCase();
}

/** The extension portion of a file name/path, lower-cased and without the dot. */
export function fileNameExt(name: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // `<= 0` covers both "no dot" and a leading-dot dotfile (".gitignore").
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** MIME type for an extension ("png", ".JPG"); unknown → `DEFAULT_MIME`. */
export function mimeForExt(ext: string): string {
  const normalized = (ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
  return MIME_BY_EXT[normalized] ?? DEFAULT_MIME;
}

/** Canonical extension for a MIME type ("image/png" → "png"); unknown → `""`. */
export function extForMime(mime: string): string {
  return EXT_BY_MIME[normalizeMime(mime)] ?? "";
}

/** Resolve a MIME, extension or file name down to a lower-case extension. */
function resolveExt(value: string): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (trimmed === "") return "";
  if (trimmed.includes("/")) return extForMime(trimmed);
  if (trimmed.includes(".")) {
    const fromName = fileNameExt(trimmed);
    if (fromName !== "") return fromName;
  }
  return trimmed.replace(/^\.+/, "");
}

/** Category for a normalized MIME type (prefix rules first, then the table). */
function categoryOfMime(mime: string): FileCategory {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/x-")) return "code";
  return CATEGORY_BY_MIME[mime] ?? "other";
}

/**
 * Category of a file described by a MIME type ("image/png"), a bare extension
 * ("png") or a file name ("cover.png"). Unknown input → `"other"`.
 */
export function fileCategory(input: string): FileCategory {
  const value = (input ?? "").trim().toLowerCase();
  if (value.includes("/")) return categoryOfMime(normalizeMime(value));
  return categoryOfMime(mimeForExt(resolveExt(value)));
}

/** Whether a MIME, extension or file name points at an image. */
export function isImage(input: string): boolean {
  return fileCategory(input) === "image";
}

/** Emoji glyph for a file name's category (unknown names get the generic 📎). */
export function iconForFile(name: string): string {
  return ICON_BY_CATEGORY[fileCategory(fileNameExt(name) || name)];
}

/** Options for {@link isAllowedType}. */
export type AllowedTypeOptions = {
  /** Allowed rules: MIME ("image/png"), wildcard ("image/*"), category
   *  ("image"), extension ("png" / ".png"), or allow-all ("*"). */
  allow: readonly string[];};

/**
 * Whether a file type is permitted by an allow-list. Matching is
 * case-insensitive and supports exact MIME types, MIME wildcards
 * (`image/*`), category names (`pdf`), extensions (`png` / `.png`) and the
 * allow-all rule `*` (also `*` + slash + `*`). An empty list fails closed.
 */
export function isAllowedType(mime: string, options: AllowedTypeOptions): boolean {
  const target = normalizeMime(mime) || DEFAULT_MIME;
  const category = categoryOfMime(target);
  const extension = extForMime(target);
  for (const raw of options.allow) {
    const rule = (raw ?? "").trim().toLowerCase();
    if (rule === "") continue;
    if (rule === "*" || rule === "*/*") return true;
    if (rule.endsWith("/*")) {
      if (target.startsWith(rule.slice(0, -1))) return true;
      continue;
    }
    if (rule.includes("/")) {
      if (rule === target) return true;
      continue;
    }
    if (rule === category) return true;
    if (extension !== "" && rule.replace(/^\.+/, "") === extension) return true;
  }
  return false;
}
