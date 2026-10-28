import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The sidebar importers own the server actions, so they are mocked before the
 * module loads; everything exercised here is either pure or a static render
 * (no action is ever invoked).
 */
vi.mock("@/server/actions/import", () => ({
  importCsvDatabaseAction: vi.fn(),
  importDocxAction: vi.fn(),
  importMarkdownAction: vi.fn(),
  importTrelloAction: vi.fn(),
  importZipAction: vi.fn(),
}));
vi.mock("@/server/actions/import-formats", () => ({
  importHtmlAction: vi.fn(),
  importPdfAction: vi.fn(),
}));
vi.mock("@/server/actions/import-pdf", () => ({ importPdfTextAction: vi.fn() }));

import {
  IMPORT_SOURCES,
  IMPORT_STEPS,
  REQUIRED_SOURCE_IDS,
  canAdvanceStep,
  detectCandidateDuplicates,
  importSourceById,
  importStepLabel,
  importStepState,
  applyMappingChoice,
  destinationOptions,
  mappingChoiceValue,
  nextImportStep,
  prevImportStep,
  previewItems,
  previewMatrix,
  stepIndex,
  suggestImportColumns,
  summarizeImport,
  validateImportDraft,
  ImportPanel,
  ImportSourceGrid,
  ImportSteps,
  type ImportDraft,
  type ImportPanelProps,
} from "./importers";

/* ------------------------------------------------------------- source list */

describe("import source catalogue", () => {
  it("offers the required ten sources first, in order", () => {
    expect(IMPORT_SOURCES.slice(0, REQUIRED_SOURCE_IDS.length).map((source) => source.id)).toEqual([
      ...REQUIRED_SOURCE_IDS,
    ]);
  });

  it("gives every source an icon, a one-line description and an id that is unique", () => {
    const ids = new Set<string>();
    for (const source of IMPORT_SOURCES) {
      expect(source.icon).toBeTruthy();
      expect(source.description.trim().length).toBeGreaterThan(0);
      expect(source.description).not.toContain("\n");
      // Tabular / api sources are validated against their own allow-list.
      if (source.kind === "document") expect(source.allow.length).toBeGreaterThan(0);
      ids.add(source.id);
    }
    expect(ids.size).toBe(IMPORT_SOURCES.length);
  });

  it("offers real Excel, Word and PDF file inputs", () => {
    expect(importSourceById("xlsx")?.accept).toContain(".xlsx");
    expect(importSourceById("docx")?.accept).toContain(".docx");
    expect(importSourceById("pdf")?.accept).toContain(".pdf");
    expect(importSourceById("pdf")?.acceptHint).toContain("text layer");
  });

  it("resolves known ids and degrades unknown ids to null", () => {
    expect(importSourceById("csv")?.label).toBe("CSV");
    expect(importSourceById(null)).toBeNull();
    expect(importSourceById("nope")).toBeNull();
  });
});

/* --------------------------------------------------------------- step flow */

describe("import step transitions", () => {
  it("orders the four steps", () => {
    expect(IMPORT_STEPS).toEqual(["choose", "map", "preview", "import"]);
    expect(stepIndex("import")).toBe(3);
  });

  it("advances and retreats, clamping at both ends", () => {
    expect(nextImportStep("choose")).toBe("map");
    expect(nextImportStep("preview")).toBe("import");
    expect(nextImportStep("import")).toBe("import");
    expect(prevImportStep("import")).toBe("preview");
    expect(prevImportStep("choose")).toBe("choose");
  });

  it("labels every step", () => {
    expect(IMPORT_STEPS.map(importStepLabel)).toEqual([
      "Choose file",
      "Map fields",
      "Preview",
      "Import",
    ]);
  });

  it("marks done / current / upcoming relative to the active step", () => {
    expect(importStepState("choose", "preview")).toBe("done");
    expect(importStepState("preview", "preview")).toBe("current");
    expect(importStepState("import", "preview")).toBe("upcoming");
  });

  it("gates advancing on a parsed draft and, for tabular sources, a mapped column", () => {
    expect(canAdvanceStep("choose", { hasDraft: false, kind: "tabular", includedColumns: 0 })).toBe(
      false,
    );
    expect(canAdvanceStep("choose", { hasDraft: true, kind: "tabular", includedColumns: 0 })).toBe(
      true,
    );
    expect(canAdvanceStep("map", { hasDraft: true, kind: "tabular", includedColumns: 0 })).toBe(
      false,
    );
    expect(canAdvanceStep("map", { hasDraft: true, kind: "tabular", includedColumns: 2 })).toBe(
      true,
    );
    expect(canAdvanceStep("map", { hasDraft: true, kind: "document", includedColumns: 0 })).toBe(
      true,
    );
    // The terminal step never advances (it holds the summary).
    expect(canAdvanceStep("import", { hasDraft: true, kind: "tabular", includedColumns: 3 })).toBe(
      false,
    );
  });
});

/* ---------------------------------------------- detected column → property */

describe("column → property suggestions", () => {
  const headers = ["Email", "Amount", "Due", "Notes"];
  const rows = [
    ["a@b.com", "12.50", "2024-01-02", "first"],
    ["c@d.com", "3", "2024-02-03", "second"],
  ];

  it("infers a type per column and pins a name match to an existing property", () => {
    const columns = suggestImportColumns(headers, rows, [
      { id: "p1", name: "amount", type: "NUMBER" },
    ]);
    expect(columns[0]).toMatchObject({ suggestedType: "email" });
    expect(columns[1]).toMatchObject({ suggestedType: "number", matchesExistingId: "p1", confidence: 1 });
    expect(columns[2]).toMatchObject({ suggestedType: "date" });
    expect(columns[3]).toMatchObject({ suggestedType: "text" });
    expect(columns[0].sample).toEqual(["a@b.com", "c@d.com"]);
  });

  it("encodes the select value for skip / existing / create", () => {
    const [column] = suggestImportColumns(["Name"], [["a"]]);
    expect(mappingChoiceValue(column, false, "text")).toBe("skip");
    expect(mappingChoiceValue({ ...column, matchesExistingId: "p1" }, true, "text")).toBe("map:p1");
    expect(mappingChoiceValue(column, true, "number")).toBe("number");
  });

  it("offers skip, the matched property and every creatable type", () => {
    const [column] = suggestImportColumns(["Name"], [["a"]]);
    expect(destinationOptions(column).map((option) => option.value)).toEqual([
      "skip",
      "text",
      "number",
      "date",
      "checkbox",
      "select",
      "url",
      "email",
    ]);
    expect(
      destinationOptions({ ...column, matchesExistingId: "p1" }).map((option) => option.value),
    ).toContain("map:p1");
  });

  it("applies a mapping choice immutably", () => {
    const draft: ImportDraft = {
      sourceId: "csv",
      kind: "tabular",
      fileName: "x.csv",
      title: "X",
      columns: [{ header: "Name", suggestedType: "text", confidence: 0.3, sample: ["a"] }],
      rows: [["a"]],
      include: [true],
      types: ["text"],
      items: [],
      itemCount: 1,
      note: "",
      warnings: [],
      payload: {},
    };
    const skipped = applyMappingChoice(draft, 0, "skip");
    expect(skipped.include).toEqual([false]);
    expect(draft.include).toEqual([true]); // original untouched
    const typed = applyMappingChoice(draft, 0, "date");
    expect(typed.types).toEqual(["date"]);
    expect(typed.include).toEqual([true]);
  });
});

/* ---------------------------------------------------------------- previews */

describe("preview truncation", () => {
  it("shows the first N rows and reports what was hidden", () => {
    const rows = Array.from({ length: 12 }, (_, index) => [String(index)]);
    const preview = previewMatrix(rows, 5);
    expect(preview.rows).toHaveLength(5);
    expect(preview.total).toBe(12);
    expect(preview.truncated).toBe(true);
    expect(previewMatrix(rows, 99).truncated).toBe(false);
    expect(previewMatrix(rows, 0).rows).toEqual([]);
  });

  it("truncates document item lists the same way", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ id: `i-${index}`, label: `Item ${index}` }));
    const preview = previewItems(items, 3);
    expect(preview.items).toHaveLength(3);
    expect(preview.total).toBe(10);
    expect(preview.truncated).toBe(true);
  });
});

/* ------------------------------------------------- duplicates + validation */

describe("candidate duplicates + validation", () => {
  it("counts repeated rows and ignores all-blank rows", () => {
    expect(
      detectCandidateDuplicates([
        ["a", "b"],
        ["a", "b"],
        [" ", ""],
        ["c"],
      ]),
    ).toBe(1);
  });

  it("flags blocking errors and non-blocking warnings per field", () => {
    const draft: ImportDraft = {
      sourceId: "csv",
      kind: "tabular",
      fileName: "x.csv",
      title: "   ",
      columns: [{ header: "Name", suggestedType: "text", confidence: 0.3, sample: ["a"] }],
      rows: [["a"]],
      include: [false],
      types: ["text"],
      items: [],
      itemCount: 1,
      note: "",
      warnings: ["Duplicate column names: Name."],
      payload: {},
    };
    const issues = validateImportDraft(draft, 2);
    expect(issues.filter((issue) => issue.severity === "error").map((issue) => issue.field)).toEqual([
      "title",
      "mapping",
    ]);
    expect(issues.filter((issue) => issue.severity === "warning").map((issue) => issue.field)).toEqual([
      "rows",
      "warning-0",
    ]);
  });

  it("passes a clean draft", () => {
    const clean: ImportDraft = {
      sourceId: "csv",
      kind: "tabular",
      fileName: "x.csv",
      title: "People",
      columns: [{ header: "Name", suggestedType: "text", confidence: 0.3, sample: ["a"] }],
      rows: [["a"]],
      include: [true],
      types: ["text"],
      items: [],
      itemCount: 1,
      note: "",
      warnings: [],
      payload: {},
    };
    expect(validateImportDraft(clean, 0)).toEqual([]);
  });
});

/* ----------------------------------------------------------------- summary */

describe("summary counts", () => {
  it("folds counts into success / warning / danger badges", () => {
    const summary = summarizeImport(
      { imported: 10, skippedColumns: 1, skippedCells: 2, failed: 3 },
      "page-1",
    );
    expect(summary).toMatchObject({ id: "page-1", imported: 10, skipped: 3, failed: 3, total: 16 });
    expect(summary.badges.map((badge) => badge.label)).toEqual(["Imported", "Skipped", "Failed"]);
    expect(summary.badges.map((badge) => badge.tone)).toEqual(["success", "warning", "danger"]);
  });

  it("omits zeroed badges and clamps negatives", () => {
    const summary = summarizeImport(
      { imported: 4, skippedColumns: 0, skippedCells: 0, failed: 0 },
      "page-2",
    );
    expect(summary.badges).toEqual([{ label: "Imported", tone: "success", count: 4 }]);
    const clamped = summarizeImport(
      { imported: -1, skippedColumns: -2, skippedCells: 0, failed: 0 },
      "page-3",
    );
    expect(clamped).toMatchObject({ imported: 0, skipped: 0, total: 0 });
  });
});

/* ----------------------------------------------------- static markup renders */

const renderGrid = () =>
  renderToStaticMarkup(createElement(ImportSourceGrid, { onSelect: () => {} }));

const basePanelProps: ImportPanelProps = {
  open: true,
  onOpenChange: () => {},
  source: importSourceById("csv"),
  step: "choose",
  draft: null,
  locale: "en",
  onPickFile: () => {},
  onRemoveFile: () => {},
  onTitleChange: () => {},
  onBack: () => {},
  onPrimary: () => {},
  onMappingChange: () => {},
  onGoToPage: () => {},
};

const csvDraft: ImportDraft = {
  sourceId: "csv",
  kind: "tabular",
  fileName: "people.csv",
  title: "People",
  columns: [
    { header: "Email", suggestedType: "email", confidence: 0.9, sample: ["a@b.com"] },
    { header: "Name", suggestedType: "text", confidence: 0.3, sample: ["Ada"] },
  ],
  rows: [["a@b.com", "Ada"]],
  include: [true, true],
  types: ["email", "text"],
  items: [],
  itemCount: 1,
  note: "1 row · 2 columns",
  warnings: [],
  payload: {},
};

describe("renderToStaticMarkup", () => {
  it("renders the picker grid with a card per source", () => {
    const html = renderGrid();
    expect(html).toContain("import-source-grid");
    for (const id of REQUIRED_SOURCE_IDS) {
      expect(html).toContain(`import-source-${id}`);
    }
  });

  it("renders the sheet's choose step with the dashed drop zone and step header", () => {
    const html = renderToStaticMarkup(createElement(ImportPanel, basePanelProps));
    expect(html).toContain('data-testid="import-panel"');
    expect(html).toContain("import-dropzone");
    expect(html).toContain("import-steps");
    expect(html).toContain("Choose file");
    expect(html).toContain("Drop a file here");
    // Panel chrome comes from the design-system Sheet.
    expect(html).toContain("surface-raised-strong");
    expect(html).toContain('role="dialog"');
  });

  it("renders the map step as a source-column → property table", () => {
    const html = renderToStaticMarkup(
      createElement(ImportPanel, { ...basePanelProps, step: "map", draft: csvDraft }),
    );
    expect(html).toContain("import-mapping");
    expect(html).toContain("Source column");
    expect(html).toContain("Destination");
    expect(html).toContain("Create as Text");
  });

  it("renders the shared step header accessibly", () => {
    const html = renderToStaticMarkup(createElement(ImportSteps, { step: "preview" }));
    expect(html).toContain("import-steps");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Preview");
  });
});

/* ------------------------------------------------------------------- guard */

describe("tokens-only guard", () => {
  it("keeps the importers free of raw hex, magic z-index and ad-hoc motion", () => {
    const src = readFileSync(new URL("./importers.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\bz-50\b|\bz-\[\d/);
    expect(src).not.toMatch(/transition[^;]*\d+ms/);
  });
});
