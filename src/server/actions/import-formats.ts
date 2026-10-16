"use server";

import { constants as zlibConstants, inflateSync } from "node:zlib";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { markdownToDoc } from "@/lib/serialize";
import type { RichNode } from "@/lib/blocks";
import { parseGoogleDoc } from "@/lib/import-gdocs";
import { parseConfluenceExport, type ConfluencePage } from "@/lib/import-confluence";
import type { ImportCounts } from "@/lib/importers";

/**
 * Additional import formats wired into `POST /api/import/notion`
 * (`src/app/api/import/notion/route.ts`, `format` = `"html"` / `"pdf"`).
 *
 * The route itself stays a thin dispatcher; the two new importers live here so
 * the Notion path (`importNotionPageAction`) is untouched. Both reuse the pure
 * parsers the library already ships:
 *   - HTML: `parseConfluenceExport` for a Confluence export, else
 *     `parseGoogleDoc` (Google Docs "Download → Web page", Mammoth HTML, or any
 *     plain HTML document) — both hardened by `html-sanitize.ts`.
 *   - PDF: a small, dependency-free text-layer extractor (no PDF parser is in
 *     the dependency set, so scanned/image-only PDFs are rejected with a clear
 *     error instead of importing an empty page).
 *
 * R23.6 / "Import rollback": every page this file creates is registered in a
 * `created` list; on any failure the list is deleted again (compensation), so a
 * partial import never leaves a half-built page tree behind. Deleting a parent
 * cascades to its children, so the child-first order of creation is safe.
 */

export type FormatImportResult =
  | {
      ok: true;
      id: string;
      slug: string;
      format: "html" | "pdf";
      pages: number;
      counts: ImportCounts;
      /** Honest, human-readable loss notes (dropped elements, unsupported macros). */
      warnings: string[];
    }
  | { error: string };

/** Matches the sibling import actions' error-message extraction. */
const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** Upper bound on the decoded HTML we will parse (5 MB of characters). */
const MAX_HTML_CHARS = 5_000_000;
/** Upper bound on a decoded PDF (10 MB). */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

type Authorized = { user: { id: string }; slug: string };

/**
 * Shared authorization preamble: authenticated user, edit permission on the
 * target workspace, and the workspace slug the result needs.
 */
async function authorize(workspaceId: string): Promise<Authorized | { error: string }> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };
  return { user: { id: user.id }, slug: workspace.slug };
}

/** Filename stem → page title (the same rule the other import actions use). */
function titleFromFilename(filename: string | null | undefined): string | null {
  if (typeof filename !== "string") return null;
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  return stem ? stem.slice(0, 200) : null;
}

/** First non-empty line of extracted text, for a PDF with no filename. */
function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 200);
  }
  return null;
}

/**
 * Create one page and register its id for compensation. Content is stored in
 * the same `{ type: "doc", content }` shape every importer writes.
 */
async function createPage(input: {
  workspaceId: string;
  parentId: string | null;
  userId: string;
  position: number;
  title: string;
  icon: string;
  content?: readonly RichNode[];
  created: string[];
}): Promise<string> {
  const title = input.title.trim().slice(0, 200) || "Imported page";
  const hasContent = Array.isArray(input.content) && input.content.length > 0;
  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      title,
      icon: input.icon,
      createdById: input.userId,
      position: input.position,
      ...(hasContent
        ? { content: { type: "doc", content: input.content } as unknown as Prisma.InputJsonValue }
        : {}),
    },
    select: { id: true },
  });
  input.created.push(page.id);
  return page.id;
}

/**
 * R23.6 compensation: delete every page a failed import created. A parent
 * delete cascades to its children, so removing all recorded ids is sufficient.
 * Best-effort by design — the caller already has an error to return.
 */
async function compensate(created: readonly string[]): Promise<void> {
  if (created.length === 0) return;
  await prisma.page
    .deleteMany({ where: { id: { in: [...created] } } })
    .catch(() => undefined);
}

/** A Confluence export carries these markers; a plain HTML document does not. */
function looksLikeConfluence(html: string): boolean {
  return /data-page-id|data-page-title|pageSection|ac:structured-macro|ri:page|ac:link/i.test(html);
}

/** Import an HTML document (Google Docs export, Confluence export, or plain HTML). */
export async function importHtmlAction(input: {
  workspaceId: string;
  parentId?: string | null;
  html: string;
  filename?: string | null;
  spaceKey?: string | null;
}): Promise<FormatImportResult> {
  const html = typeof input.html === "string" ? input.html : "";
  if (!html.trim()) return { error: "No HTML content to import." };
  if (html.length > MAX_HTML_CHARS) {
    return { error: "That HTML document is too large to import (max 5 MB)." };
  }

  const workspaceId = String(input.workspaceId ?? "");
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;

  const userId = auth.user.id;
  const parentId = input.parentId ?? null;
  const created: string[] = [];

  // Positions start after the current last sibling and increment per parent,
  // mirroring the other import actions.
  const positions = new Map<string, number>();
  const last = await prisma.page.findFirst({
    where: { workspaceId, parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  positions.set(parentId ?? "root", last?.position ?? 0);
  const nextPosition = (parent: string | null): number => {
    const key = parent ?? "root";
    const value = (positions.get(key) ?? 0) + 1000;
    positions.set(key, value);
    return value;
  };

  try {
    if (looksLikeConfluence(html)) {
      const parsed = parseConfluenceExport({
        html,
        ...(input.spaceKey ? { spaceKey: input.spaceKey } : {}),
      });
      if (parsed.pages.length === 0) {
        return { error: "That HTML export contained no pages." };
      }
      const createTree = async (page: ConfluencePage, parent: string | null): Promise<void> => {
        const id = await createPage({
          workspaceId,
          parentId: parent,
          userId,
          position: nextPosition(parent),
          title: page.props.title,
          icon: page.props.icon ?? "📄",
          content: page.blocks,
          created,
        });
        for (const child of page.children) await createTree(child, id);
      };
      for (const page of parsed.pages) await createTree(page, parentId);

      revalidatePath("/w", "layout");
      return {
        ok: true,
        id: created[0] ?? "",
        slug: auth.slug,
        format: "html",
        pages: created.length,
        counts: { imported: created.length, skippedColumns: 0, skippedCells: 0, failed: 0 },
        warnings: parsed.meta.warnings,
      };
    }

    const parsed = parseGoogleDoc({ html });
    if (parsed.blocks.length === 0) {
      return { error: "That HTML document contained no importable content." };
    }
    const title = (parsed.meta.title ?? titleFromFilename(input.filename) ?? "Imported HTML").slice(
      0,
      200,
    );
    const id = await createPage({
      workspaceId,
      parentId,
      userId,
      position: nextPosition(parentId),
      title,
      icon: "📄",
      content: parsed.blocks,
      created,
    });

    revalidatePath("/w", "layout");
    return {
      ok: true,
      id,
      slug: auth.slug,
      format: "html",
      pages: 1,
      counts: { imported: 1, skippedColumns: 0, skippedCells: 0, failed: 0 },
      warnings: parsed.meta.dropped.map((tag) => `Unsupported element <${tag}> was dropped.`),
    };
  } catch (error) {
    await compensate(created);
    return { error: errorMessage(error, "HTML import failed.") };
  }
}

/* --------------------------------------------------------------- PDF text */

/**
 * Collect the raw payload of every `stream … endstream` block. The PDF is read
 * as latin1 so byte-for-byte round-tripping through `Buffer.from(_, "latin1")`
 * is lossless (needed to inflate the compressed streams).
 */
function pdfStreams(latin: string): string[] {
  const streams: string[] = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin))) streams.push(match[1]);
  return streams;
}

/** Inflate a FlateDecode stream, falling back to the raw bytes when it is not. */
function decodeStream(raw: string): string {
  const body = raw.replace(/\r?\n$/, "");
  const bytes = Buffer.from(body, "latin1");
  try {
    return inflateSync(bytes, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("latin1");
  } catch {
    return raw;
  }
}

/** PDF literal-string escape decoding (`\(`, `\n`, `\ddd`, line continuations). */
function decodePdfLiteral(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1] ?? "";
    i += 1;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && body[i + 1] >= "0" && body[i + 1] <= "7") {
        octal += body[i + 1];
        i += 1;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else if (next === "\r") {
      if (body[i + 1] === "\n") i += 1;
    } else if (next !== "\n") {
      out += next;
    }
  }
  return out;
}

/** Read a balanced `( … )` literal starting at `start`; returns text + resume index. */
function readLiteral(content: string, start: number): { text: string; next: number } {
  let i = start + 1;
  let depth = 1;
  let body = "";
  while (i < content.length && depth > 0) {
    const c = content[i];
    if (c === "\\") {
      body += c + (content[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    body += c;
    i += 1;
  }
  return { text: decodePdfLiteral(body), next: i };
}

/** Hex string `<…>` → best-effort text (one byte per two hex digits). */
function hexToText(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = Number.parseInt(clean.slice(i, i + 2), 16);
    if (Number.isFinite(code)) out += String.fromCharCode(code);
  }
  return out;
}

/** Index of the `]` closing the `[` at `start`, or -1 (literal strings skipped). */
function findArrayEnd(content: string, start: number): number {
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const c = content[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "(") {
      i = readLiteral(content, i).next - 1;
      continue;
    }
    if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * A `[…]TJ` array → text. Gaps of at least 100/1000 em (the usual threshold
 * between kerning and a word space) become spaces.
 */
function textFromArray(inner: string): string {
  let out = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "(") {
      const literal = readLiteral(inner, i);
      out += literal.text;
      i = literal.next;
      continue;
    }
    if (ch === "<" && inner[i + 1] !== "<") {
      const end = inner.indexOf(">", i + 1);
      if (end !== -1) {
        out += hexToText(inner.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    const number = /^-?\d*\.?\d+/.exec(inner.slice(i));
    if (number && (ch === "-" || ch === "." || (ch >= "0" && ch <= "9"))) {
      const value = Number(number[0]);
      if (Number.isFinite(value) && value <= -100) out += " ";
      i += number[0].length;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Extract the shown text (`Tj` / `TJ` / `'` / `"`) from one content stream. */
function scanContent(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "(") {
      const literal = readLiteral(content, i);
      out += literal.text;
      i = literal.next;
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i + 1);
      if (end !== -1) {
        out += hexToText(content.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const end = findArrayEnd(content, i);
      if (end !== -1 && content.slice(end + 1, end + 3) === "TJ") {
        out += textFromArray(content.slice(i + 1, end));
        i = end + 3;
        continue;
      }
    }
    if (content.startsWith("Td", i) || content.startsWith("TD", i) || content.startsWith("T*", i)) {
      out += "\n";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      out += "\n";
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Best-effort text-layer extraction. Only streams that contain a `BT` text
 * object are scanned, so embedded fonts/images contribute no junk. Returns the
 * joined text plus a `/Type /Page` count (0 when the PDF uses object streams).
 */
function extractPdfText(pdf: Buffer): { text: string; pages: number } {
  const latin = pdf.toString("latin1");
  const chunks: string[] = [];
  for (const raw of pdfStreams(latin)) {
    const decoded = decodeStream(raw);
    if (!/\bBT\b/.test(decoded)) continue;
    const text = scanContent(decoded);
    if (text.trim()) chunks.push(text);
  }
  const text = chunks
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const pages = (latin.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return { text, pages };
}

/** Import a PDF's text layer as a page (base64 payload from the route). */
export async function importPdfAction(input: {
  workspaceId: string;
  parentId?: string | null;
  data: string;
  filename?: string | null;
}): Promise<FormatImportResult> {
  const data = typeof input.data === "string" ? input.data : "";
  if (!data.trim()) return { error: "No PDF data provided." };

  const workspaceId = String(input.workspaceId ?? "");
  const auth = await authorize(workspaceId);
  if ("error" in auth) return auth;

  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) return { error: "That PDF payload decoded to zero bytes." };
  if (bytes.length > MAX_PDF_BYTES) {
    return { error: "That PDF is too large to import (max 10 MB)." };
  }
  if (bytes.toString("latin1", 0, 5) !== "%PDF-") {
    return { error: "That file is not a PDF document." };
  }

  const extracted = extractPdfText(bytes);
  if (!extracted.text) {
    return {
      error: "No selectable text layer found in that PDF (scanned/image PDFs are not supported).",
    };
  }

  const userId = auth.user.id;
  const parentId = input.parentId ?? null;
  const created: string[] = [];
  try {
    const last = await prisma.page.findFirst({
      where: { workspaceId, parentId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const title = (
      titleFromFilename(input.filename) ??
      firstLine(extracted.text) ??
      "Imported PDF"
    ).slice(0, 200);
    const id = await createPage({
      workspaceId,
      parentId,
      userId,
      position: (last?.position ?? 0) + 1000,
      title,
      icon: "📄",
      content: markdownToDoc(extracted.text).content,
      created,
    });

    revalidatePath("/w", "layout");
    return {
      ok: true,
      id,
      slug: auth.slug,
      format: "pdf",
      pages: 1,
      counts: { imported: 1, skippedColumns: 0, skippedCells: 0, failed: 0 },
      warnings: extracted.pages > 0 ? [] : ["The PDF page count could not be determined."],
    };
  } catch (error) {
    await compensate(created);
    return { error: errorMessage(error, "PDF import failed.") };
  }
}
