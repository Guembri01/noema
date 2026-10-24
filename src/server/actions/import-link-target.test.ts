import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B110 — the import writes a link target into the page without the allowlist
 * the save path applies.
 *
 * The save path (`updatePageAction` → `parsePageContent`) runs every
 * href-shaped attribute of a document through the scheme allowlist
 * (`sanitizeHref`): a target that is not on the list loses its `href`
 * attribute before the document is stored. The import paths wrote the parsed
 * document straight into the page, so a Markdown link (`[x](javascript:…)`)
 * or a Notion rich-text link landed in the database unchecked — and the
 * Markdown export then wrote it out verbatim (B109).
 *
 * The real actions and the real allowlist run; only the transport edges
 * (prisma, auth, permissions, cache, mammoth) are mocked.
 */

const WORKSPACE = "ws-1";

/** The target of a Markdown link the allowlist has to refuse. */
const HOSTILE_TARGET = vi.hoisted(() => "javascript:alert(1");
/** The Markdown a hostile import carries. */
const HOSTILE_MARKDOWN = vi.hoisted(() => "[click](javascript:alert(1))");

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  pageDeleteMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    page: {
      findFirst: db.pageFindFirst,
      create: db.pageCreate,
      deleteMany: db.pageDeleteMany,
    },
  };
  return {
    prisma: {
      ...tx,
      workspace: { findUnique: db.workspaceFindUnique },
      $transaction: db.transaction,
    },
  };
});

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("mammoth", () => ({
  // The Word importer hands the converter's Markdown to `markdownToDoc`, so
  // the converter is the place where a hostile link enters this path.
  convertToMarkdown: vi.fn(async () => ({ value: HOSTILE_MARKDOWN })),
}));

import { importDocxAction, importMarkdownAction, importZipAction } from "./import";
import { importPdfAction } from "./import-formats";
import { importNotionPageAction } from "./notion-import";
import { parsePageContent } from "@/lib/validation";
import { markdownToDoc } from "@/lib/serialize";

/**
 * Every href-shaped attribute value a stored document carries — the same
 * traversal the allowlist applies (`attrs.href` of a link mark, `attrs.url`
 * of a bookmark/embed node).
 */
function hrefValues(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const attrs = record.attrs;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      for (const key of ["href", "url"]) {
        const value = (attrs as Record<string, unknown>)[key];
        if (typeof value === "string") out.push(value);
      }
    }
    if (Array.isArray(record.marks)) walk(record.marks);
    if (Array.isArray(record.content)) walk(record.content);
  };
  walk(doc);
  return out;
}

/** The document the last `page.create` stored. */
function storedContent(): unknown {
  const calls = db.pageCreate.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].data.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindFirst.mockResolvedValue({ position: 0 });
  db.pageCreate.mockResolvedValue({ id: "page-new" });
  db.pageDeleteMany.mockResolvedValue({ count: 0 });
  db.workspaceFindUnique.mockResolvedValue({ slug: "workspace-a" });
  db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      page: {
        findFirst: db.pageFindFirst,
        create: db.pageCreate,
        deleteMany: db.pageDeleteMany,
      },
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A .zip upload with the given Markdown files. */
async function zipForm(files: Record<string, string>): Promise<FormData> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const form = new FormData();
  form.set("workspaceId", WORKSPACE);
  form.set("file", new File([buffer], "archive.zip", { type: "application/zip" }));
  return form;
}

/** A .docx upload (the converter itself is mocked). */
async function docxForm(): Promise<FormData> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("word/document.xml", "<w:document></w:document>");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const form = new FormData();
  form.set("workspaceId", WORKSPACE);
  form.set("file", new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], "notes.docx"));
  return form;
}

/** A minimal PDF whose text layer holds the given text. */
function pdfWithText(text: string): string {
  const body = `BT (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
  return Buffer.concat([
    Buffer.from("%PDF-1.4\nstream\n", "latin1"),
    Buffer.from(body, "latin1"),
    Buffer.from("\nendstream\n", "latin1"),
  ]).toString("base64");
}

describe("B110 — the Markdown import applies the href allowlist", () => {
  it("importMarkdownAction drops a target the allowlist refuses", async () => {
    const result = await importMarkdownAction({
      workspaceId: WORKSPACE,
      filename: "notes.md",
      markdown: HOSTILE_MARKDOWN,
    });

    expect(result).toMatchObject({ ok: true });
    expect(hrefValues(storedContent())).toEqual([]);
    // Only the target is dropped — the text of the link stays in the page.
    expect(JSON.stringify(storedContent())).toContain('"text":"click"');
  });

  it("importMarkdownAction stores the document the save path would store", async () => {
    const result = await importMarkdownAction({
      workspaceId: WORKSPACE,
      filename: "notes.md",
      markdown: HOSTILE_MARKDOWN,
    });

    expect(result).toMatchObject({ ok: true });
    // The save path (`parsePageContent`) applies the same allowlist — the
    // import must store the very same document.
    const saved = parsePageContent(JSON.stringify(markdownToDoc(HOSTILE_MARKDOWN)));
    expect(saved.ok).toBe(true);
    expect(storedContent()).toEqual(saved.ok ? saved.doc : null);
  });

  it("importMarkdownAction keeps the targets the allowlist accepts", async () => {
    const result = await importMarkdownAction({
      workspaceId: WORKSPACE,
      filename: "notes.md",
      markdown: [
        "[web](https://example.com/a)",
        "[mail](mailto:a@b.co)",
        "[phone](tel:+1234)",
        "[page](/w/demo/page)",
        "[anchor](#section)",
      ].join("\n\n"),
    });

    expect(result).toMatchObject({ ok: true });
    expect(hrefValues(storedContent())).toEqual([
      "https://example.com/a",
      "mailto:a@b.co",
      "tel:+1234",
      "/w/demo/page",
      "#section",
    ]);
  });

  it("importZipAction drops a target the allowlist refuses", async () => {
    const result = await importZipAction(
      await zipForm({ "notes.md": HOSTILE_MARKDOWN, "ok.md": "[ok](https://example.com/a)" }),
    );

    expect(result).toMatchObject({ ok: true });
    const stored = db.pageCreate.mock.calls.map((call) => call[0].data.content);
    expect(stored.flatMap((doc) => hrefValues(doc))).toEqual(["https://example.com/a"]);
  });

  it("importDocxAction drops a target the allowlist refuses", async () => {
    const result = await importDocxAction(await docxForm());

    expect(result).toMatchObject({ ok: true });
    // The mocked converter returns a plain heading — the point of this case is
    // that the gate runs on the document the importer writes.
    expect(hrefValues(storedContent())).toEqual([]);
  });

  it("importPdfAction drops a target the allowlist refuses", async () => {
    const result = await importPdfAction({
      workspaceId: WORKSPACE,
      data: pdfWithText("[click](javascript:alert)"),
      filename: "notes.pdf",
    });

    expect(result).toMatchObject({ ok: true });
    expect(hrefValues(storedContent())).toEqual([]);
  });
});

describe("B110 — the Notion import applies the href allowlist", () => {
  /** Stub the Notion API with one page whose children carry the given blocks. */
  function stubNotion(blocks: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/pages/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              properties: { Title: { type: "title", title: [{ plain_text: "Root" }] } },
            }),
          };
        }
        if (url.includes("/blocks/")) {
          return { ok: true, status: 200, json: async () => ({ results: [blocks], has_more: false }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("drops a Notion link target the allowlist refuses", async () => {
    stubNotion({
      id: "b1",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { plain_text: "click", href: HOSTILE_TARGET },
          { plain_text: " " },
          { plain_text: "ok", href: "https://example.com/a" },
        ],
      },
    });

    const result = await importNotionPageAction({
      workspaceId: WORKSPACE,
      token: "secret_test_token",
      pageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });

    expect(result).toMatchObject({ ok: true });
    expect(hrefValues(storedContent())).toEqual(["https://example.com/a"]);
  });

  it("drops a Notion bookmark target the allowlist refuses", async () => {
    stubNotion({ id: "b1", type: "bookmark", bookmark: { url: HOSTILE_TARGET } });

    const result = await importNotionPageAction({
      workspaceId: WORKSPACE,
      token: "secret_test_token",
      pageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });

    expect(result).toMatchObject({ ok: true });
    expect(hrefValues(storedContent())).toEqual([]);
  });
});
