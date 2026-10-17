import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B71 — import integrity M1 (spec `docs/specs/import-export.md` §4/§10):
 *
 *  - R23.6  every multi-record import is atomic: a mid-import failure must
 *    leave the workspace with exactly the rows it had before (no partial
 *    pages). Failure-injection: a fake prisma whose `$transaction` stages
 *    writes and restores the snapshot when the callback throws — creates
 *    issued *outside* the transaction land in the committed state and are
 *    NOT restored, so the residue assertions fail red against the old code
 *    (which had no `$transaction` and no catch: the action itself rejected).
 *  - D23.1  CSV honesty: unmatched header columns and uncoercible cells are
 *    counted in the result instead of being dropped silently.
 *  - D23.4  `ImportResult`/`NotionImportResult` carry counts
 *    `{ imported, skippedColumns, skippedCells, failed }`.
 *
 * Auth/permissions/db are mocked the B19 way; only the Notion network edge
 * is stubbed (`global.fetch`), mammoth is stubbed, and JSZip is real.
 */

const mock = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const state = {
    pages: [] as Row[],
    properties: [] as Row[],
    views: [] as Row[],
    propertyValues: [] as Row[],
  };
  /** 1-based index of the `page.create` call that throws (-1 = never). */
  const fault = { failPageCreateAt: -1 };
  let pageCreates = 0;
  let seq = 0;
  let txCalls = 0;

  const reset = () => {
    state.pages.length = 0;
    state.properties.length = 0;
    state.views.length = 0;
    state.propertyValues.length = 0;
    fault.failPageCreateAt = -1;
    pageCreates = 0;
    txCalls = 0;
  };

  const snapshot = () => ({
    pages: [...state.pages],
    properties: [...state.properties],
    views: [...state.views],
    propertyValues: [...state.propertyValues],
    pageCreates,
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    state.pages.splice(0, state.pages.length, ...snap.pages);
    state.properties.splice(0, state.properties.length, ...snap.properties);
    state.views.splice(0, state.views.length, ...snap.views);
    state.propertyValues.splice(0, state.propertyValues.length, ...snap.propertyValues);
    pageCreates = snap.pageCreates;
  };

  const matches = (row: Row, where?: Row) =>
    !where || Object.entries(where).every(([key, value]) => row[key] === value);

  const projected = (row: Row, select?: Record<string, unknown>) => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, keep] of Object.entries(select)) if (keep) out[key] = row[key];
    return out;
  };

  const sorted = (rows: Row[], orderBy?: Record<string, string>) => {
    if (!orderBy) return rows;
    const [key, dir] = Object.entries(orderBy)[0] as [string, string];
    return [...rows].sort((a, b) => {
      const av = (a[key] as number | undefined) ?? 0;
      const bv = (b[key] as number | undefined) ?? 0;
      return dir === "desc" ? bv - av : av - bv;
    });
  };

  const model = (name: string, rows: Row[]) => ({
    findFirst: async (
      args: { where?: Row; orderBy?: Record<string, string>; select?: Record<string, unknown> } = {},
    ) => {
      const found = sorted(rows.filter((row) => matches(row, args.where)), args.orderBy)[0];
      return found ? projected(found, args.select) : null;
    },
    findUnique: async (args: { where?: Row; select?: Record<string, unknown> } = {}) => {
      const found = rows.find((row) => matches(row, args.where));
      return found ? projected(found, args.select) : null;
    },
    findMany: async (args: { where?: Row; orderBy?: Record<string, string> } = {}) =>
      sorted(rows.filter((row) => matches(row, args.where)), args.orderBy).map((row) => ({
        ...row,
      })),
    create: async (args: { data: Row; select?: Record<string, unknown> }) => {
      if (name === "page") {
        pageCreates += 1;
        if (fault.failPageCreateAt > 0 && pageCreates === fault.failPageCreateAt) {
          throw new Error(`injected mid-import failure (page create #${pageCreates})`);
        }
      }
      const row: Row = { id: `${name}-${(seq += 1)}`, ...args.data };
      rows.push(row);
      return projected(row, args.select);
    },
    createMany: async (args: { data: Row | Row[] }) => {
      const list = Array.isArray(args.data) ? args.data : [args.data];
      for (const data of list) rows.push({ id: `${name}-${(seq += 1)}`, ...data });
      return { count: list.length };
    },
  });

  const workspace = {
    findUnique: async (args: { where?: { id?: string }; select?: Record<string, unknown> } = {}) =>
      args.where?.id === "ws-1" ? projected({ id: "ws-1", slug: "demo" }, args.select) : null,
  };

  const prisma: Record<string, unknown> = {
    page: model("page", state.pages),
    property: model("property", state.properties),
    databaseView: model("databaseView", state.views),
    propertyValue: model("propertyValue", state.propertyValues),
    workspace,
    // Transactional semantics: stage all writes, restore the snapshot when
    // the callback throws. Writes issued outside $transaction hit the
    // committed arrays directly and survive the restore — that is exactly
    // the residue the rollback tests assert away.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      txCalls += 1;
      const snap = snapshot();
      try {
        return await fn(prisma);
      } catch (error) {
        restore(snap);
        throw error;
      }
    },
  };

  return {
    prisma,
    state,
    fault,
    reset,
    txCount: () => txCalls,
  };
});

vi.mock("@/lib/db", () => ({ prisma: mock.prisma }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("mammoth", () => ({
  convertToMarkdown: vi.fn(async () => ({ value: "# Imported document" })),
}));

import { importDocxAction, importTrelloAction, importZipAction } from "./import";
import { importNotionPageAction } from "./notion-import";
import { importCsvAction } from "./database";

const ZERO_COUNTS = { skippedColumns: 0, skippedCells: 0, failed: 0 };

beforeEach(() => mock.reset());
afterEach(() => vi.unstubAllGlobals());

const TRELLO_JSON = JSON.stringify({
  name: "Roadmap",
  lists: [
    { id: "l1", name: "Todo" },
    { id: "l2", name: "Done" },
  ],
  cards: [
    { idList: "l1", name: "Card A", desc: "first" },
    { idList: "l1", name: "Card B", desc: "second" },
    { idList: "l2", name: "Card C", desc: "third" },
  ],
});

/** Stub the Notion API: page metadata + child_page children per block id. */
function stubNotion(options: {
  pages: Record<string, string>;
  children: Record<string, string[]>;
  /** block ids whose `GET /pages/:id` fails */
  failingPages?: string[];
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      const pageMatch = url.match(/\/pages\/([^/?]+)/);
      if (pageMatch) {
        const id = pageMatch[1];
        if (options.failingPages?.includes(id)) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        const title = options.pages[id];
        if (!title) return { ok: false, status: 404, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            properties: { Title: { type: "title", title: [{ plain_text: title }] } },
          }),
        };
      }
      const childMatch = url.match(/\/blocks\/([^/?]+)\/children/);
      if (childMatch) {
        const id = childMatch[1];
        const kids = (options.children[id] ?? []).map((kid) => ({
          id: kid,
          type: "child_page",
          child_page: { title: options.pages[kid] ?? kid },
        }));
        return { ok: true, status: 200, json: async () => ({ results: kids, has_more: false }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const ROOT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function makeZipFile(): Promise<File> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("alpha.md", "# Alpha");
  zip.file("beta.md", "# Beta");
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  return new File([buffer], "archive.zip", { type: "application/zip" });
}

function docxForm(): FormData {
  const form = new FormData();
  form.append("workspaceId", "ws-1");
  form.append("file", new File([new Uint8Array([1, 2, 3])], "notes.docx"));
  return form;
}

/** Seed a DATABASE page + properties for the CSV importer. */
function seedCsvDb() {
  mock.state.pages.push({ id: "db-1", type: "DATABASE", workspaceId: "ws-1", title: "Tracker" });
  mock.state.properties.push(
    { id: "p-name", databasePageId: "db-1", name: "Name", type: "TEXT", position: 1000, config: { primary: true } },
    { id: "p-score", databasePageId: "db-1", name: "Score", type: "NUMBER", position: 2000, config: null },
    {
      id: "p-tag",
      databasePageId: "db-1",
      name: "Tag",
      type: "STATUS",
      position: 3000,
      config: { options: [{ id: "o1", name: "Doing" }] },
    },
  );
}

describe("R23.6 — mid-import failure rolls back every write", () => {
  it("importTrelloAction leaves zero pages/properties/views/rows when a card create fails mid-import", async () => {
    mock.fault.failPageCreateAt = 3; // database page + card A staged, card B dies
    const result = await importTrelloAction({ workspaceId: "ws-1", json: TRELLO_JSON });

    expect(result).toEqual({ error: expect.any(String) });
    expect(mock.state.pages).toHaveLength(0);
    expect(mock.state.properties).toHaveLength(0);
    expect(mock.state.views).toHaveLength(0);
    expect(mock.state.propertyValues).toHaveLength(0);
  });

  it("importNotionPageAction writes the tree inside one transaction — a failing child create leaves zero residue", async () => {
    stubNotion({
      pages: { [ROOT_ID]: "Root", c1: "Child one", c2: "Child two" },
      children: { [ROOT_ID]: ["c1", "c2"], c1: [], c2: [] },
    });
    mock.fault.failPageCreateAt = 3; // root + child1 staged, child2 dies

    const result = await importNotionPageAction({
      workspaceId: "ws-1",
      token: "secret_test_token",
      pageId: ROOT_ID,
    });

    expect(result).toEqual({ error: expect.any(String) });
    expect(mock.state.pages).toHaveLength(0);
  });

  it("importZipAction leaves zero pages when a create fails mid-archive", async () => {
    const form = new FormData();
    form.append("workspaceId", "ws-1");
    form.append("file", await makeZipFile());
    mock.fault.failPageCreateAt = 2; // alpha staged, beta dies

    const result = await importZipAction(form);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mock.state.pages).toHaveLength(0);
  });

  it("importDocxAction reports a failed create as an error instead of rejecting, with no residue", async () => {
    mock.fault.failPageCreateAt = 1;

    const result = await importDocxAction(docxForm());

    expect(result).toEqual({ error: expect.any(String) });
    expect(mock.state.pages).toHaveLength(0);
  });

  it("importCsvAction writes rows inside a transaction — mid-import failure leaves the database untouched", async () => {
    seedCsvDb();
    mock.fault.failPageCreateAt = 2; // row 1 staged, row 2 dies
    const csv = ["Name,Score", "Alice,10", "Bob,20"].join("\r\n");

    const result = await importCsvAction("db-1", csv);

    expect(result).toEqual({ error: expect.any(String) });
    expect(mock.state.pages.filter((row) => row.parentId === "db-1")).toHaveLength(0);
    expect(mock.state.propertyValues).toHaveLength(0);
    // the pre-existing database page must survive
    expect(mock.state.pages.some((row) => row.id === "db-1")).toBe(true);
  });
});

describe("ImportResult counts (D23.4)", () => {
  it("importTrelloAction reports counts and runs through $transaction", async () => {
    const result = await importTrelloAction({ workspaceId: "ws-1", json: TRELLO_JSON });

    expect(result).toMatchObject({
      ok: true,
      counts: { imported: 4, ...ZERO_COUNTS },
    });
    expect(mock.txCount()).toBeGreaterThan(0);
    expect(mock.state.pages).toHaveLength(4);
  });

  it("importDocxAction reports counts", async () => {
    const result = await importDocxAction(docxForm());

    expect(result).toMatchObject({ ok: true, counts: { imported: 1, ...ZERO_COUNTS } });
  });

  it("importZipAction reports counts for every page written", async () => {
    const form = new FormData();
    form.append("workspaceId", "ws-1");
    form.append("file", await makeZipFile());

    const result = await importZipAction(form);

    expect(result).toMatchObject({ ok: true, counts: { imported: 2, ...ZERO_COUNTS } });
    expect(mock.state.pages).toHaveLength(2);
  });

  it("importNotionPageAction counts imported pages and failed subtrees instead of swallowing them", async () => {
    stubNotion({
      pages: { [ROOT_ID]: "Root", c1: "Child one" },
      children: { [ROOT_ID]: ["c1", "c2"], c1: [] },
      failingPages: ["c2"], // child subtree fetch fails → counted, not silent
    });

    const result = await importNotionPageAction({
      workspaceId: "ws-1",
      token: "secret_test_token",
      pageId: ROOT_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      pages: 2,
      counts: { imported: 2, ...ZERO_COUNTS, failed: 1 },
    });
    expect(mock.txCount()).toBeGreaterThan(0);
  });
});

describe("CSV honesty (D23.1)", () => {
  it("importCsvAction surfaces skipped columns and uncoercible cells", async () => {
    seedCsvDb();
    const csv = ["Name,Score,Tag,Extra", "Alice,10,Doing,x", "Bob,abc,Unknown,y"].join("\r\n");

    const result = await importCsvAction("db-1", csv);

    // Extra matches no property → 1 skipped column (counted once, not per
    // cell). "abc" fails NUMBER coercion and "Unknown" matches no STATUS
    // option → 2 skipped cells. Both were silent drops before this change.
    expect(result).toEqual({
      ok: true,
      created: 2,
      counts: { imported: 2, skippedColumns: 1, skippedCells: 2, failed: 0 },
    });
    expect(mock.txCount()).toBeGreaterThan(0);
  });
});
