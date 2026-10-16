/**
 * Wiring acceptance for the three previously un-wired view engines
 * (`@/lib/footer-calculations`, `@/lib/gallery-preview`, `@/lib/form-view`).
 *
 * These node tests exercise the exact pure seams `view-renderers.tsx` now
 * renders from — `tableFooterSpec`/`groupTableRows`, `galleryPreviewPlan`/
 * `resolveGalleryCard` and `resolveFormPlan` — so a persisted view config is
 * proven to reach `parseFooterSpec`/`computeFooter`/`forGroup`,
 * `resolveCardPreview` and `validateSubmission`/`toRowValues` respectively,
 * without needing a DOM.
 */
import { describe, expect, it, vi } from "vitest";

// The renderer imports server actions (`reorderRowsAction`, `createPropertyAction`)
// and `next/navigation`; stub them so the pure exports import cleanly in node.
vi.mock("@/server/actions/database", () => ({
  reorderRowsAction: vi.fn(),
  createPropertyAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { computeFooter, forGroup } from "@/lib/footer-calculations";
import { resolveCardPreview as resolveGalleryPreview } from "@/lib/gallery-preview";
import { toRowValues, validateSubmission } from "@/lib/form-view";
import {
  galleryPreviewPlan,
  groupTableRows,
  resolveFormPlan,
  resolveGalleryCard,
  tableFooterSpec,
  type TableFooterCalculation,
} from "./view-renderers";
import type { DBProperty, DBRow } from "./database-types";

const properties: DBProperty[] = [
  { id: "title", name: "Title", type: "TEXT", config: { primary: true } },
  { id: "est", name: "Estimate", type: "NUMBER", config: null },
  {
    id: "cost",
    name: "Cost",
    type: "NUMBER",
    config: { format: "currency", currency: "EUR" },
  },
  { id: "done", name: "Done", type: "CHECKBOX", config: null },
  {
    id: "status",
    name: "Status",
    type: "SELECT",
    config: {
      options: [
        { id: "todo", name: "To do", color: "gray" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
  },
  { id: "cover", name: "Cover", type: "FILES", config: null },
  { id: "body", name: "Body", type: "TEXT", config: null },
];

const rows: DBRow[] = [
  {
    id: "r1",
    title: "Alpha",
    icon: null,
    propertyValues: [
      { propertyId: "est", value: { number: 3 } },
      { propertyId: "cost", value: { number: 12.5 } },
      { propertyId: "done", value: { checked: true } },
      { propertyId: "status", value: { optionId: "todo" } },
      {
        propertyId: "cover",
        value: { files: [{ name: "a.png", url: "https://x.test/a.png" }] },
      },
      { propertyId: "body", value: { text: "Hello body" } },
    ],
  },
  {
    id: "r2",
    title: "Beta",
    icon: null,
    propertyValues: [
      { propertyId: "est", value: { number: 5 } },
      { propertyId: "cost", value: { number: 7.5 } },
      { propertyId: "done", value: { checked: false } },
      { propertyId: "status", value: { optionId: "done" } },
      {
        propertyId: "cover",
        value: { files: [{ name: "b.png", url: "https://x.test/b.png" }] },
      },
    ],
  },
];

const valueFor = (row: DBRow, propertyId: string): unknown =>
  row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value ?? null;

const galleryProperties = properties.map((property) => ({
  id: property.id,
  name: property.name,
  type: property.type.toLowerCase(),
}));

describe("table footer: persisted config → footer-calculations", () => {
  it("parses a persisted footer list straight into the engine spec", () => {
    const spec = tableFooterSpec(
      [
        { propertyId: "est", fn: "sum" },
        { propertyId: "done", fn: "percentChecked" },
      ],
      {},
      properties,
    );
    expect(spec).toEqual([
      { propertyId: "est", fn: "sum" },
      { propertyId: "done", fn: "percentChecked" },
    ]);
    const results = computeFooter(spec, rows, { valueFor, properties });
    expect(results.map((result) => result.display)).toEqual(["8", "50%"]);
  });

  it("drops unknown properties and malformed functions via parseFooterSpec", () => {
    const raw = [
      { propertyId: "est", fn: "sum" },
      { propertyId: "ghost", fn: "sum" },
      { propertyId: "est", fn: "bogus" },
    ] as unknown as TableFooterCalculation[];
    expect(tableFooterSpec(raw, {}, properties)).toEqual([
      { propertyId: "est", fn: "sum" },
    ]);
  });

  it("dedupes by property with later wins (parseFooterSpec contract)", () => {
    expect(
      tableFooterSpec(
        [
          { propertyId: "est", fn: "sum" },
          { propertyId: "est", fn: "average" },
        ],
        {},
        properties,
      ),
    ).toEqual([{ propertyId: "est", fn: "average" }]);
  });

  it("falls back to aggregationPropertyId when no footer is persisted", () => {
    expect(
      tableFooterSpec(undefined, { aggregationPropertyId: "est" }, properties),
    ).toEqual([{ propertyId: "est", fn: "sum" }]);
    expect(
      tableFooterSpec(undefined, { aggregationPropertyId: "title" }, properties),
    ).toEqual([{ propertyId: "title", fn: "count" }]);
    expect(
      tableFooterSpec(
        undefined,
        { aggregationPropertyId: "est", chartAggregate: "average" },
        properties,
      ),
    ).toEqual([{ propertyId: "est", fn: "average" }]);
  });

  it("yields no footer for an unconfigured view", () => {
    expect(tableFooterSpec(undefined, {}, properties)).toEqual([]);
  });

  it("groups rows and computes a per-group footer via forGroup", () => {
    const groups = groupTableRows(rows, properties, "status");
    expect(groups?.map((group) => group.key)).toEqual(["todo", "done", "__empty"]);
    const footers = forGroup(groups ?? [], [{ propertyId: "est", fn: "sum" }], {
      valueFor,
      properties,
    });
    expect(footers.map((group) => group.footers[0].display)).toEqual(["3", "5", "—"]);
  });

  it("groupTableRows is null without a resolvable group-by column", () => {
    expect(groupTableRows(rows, properties, undefined)).toBeNull();
    expect(groupTableRows(rows, properties, "ghost")).toBeNull();
  });
});

describe("gallery preview: persisted config → gallery-preview", () => {
  it("maps the persisted previewPropertyId onto the engine cover", () => {
    const plan = galleryPreviewPlan("cover", undefined);
    expect(plan.active).toBe(true);
    expect(plan.config.coverPropertyId).toBe("cover");
  });

  it("resolves a cover, excerpt and badges through resolveCardPreview", () => {
    const plan = galleryPreviewPlan(undefined, {
      contentPropertyId: "body",
      showProperties: ["est", "status"],
      fit: "contain",
      aspect: 1.5,
    });
    expect(plan.active).toBe(true);
    const card = resolveGalleryCard(rows[0], plan, galleryProperties);
    expect(card.cover).toMatchObject({ url: "https://x.test/a.png", fit: "contain" });
    expect(card.excerpt?.text).toBe("Hello body");
    expect(card.badges).toEqual([
      { propertyId: "est", value: "3" },
      { propertyId: "status", value: "todo" },
    ]);
  });

  it("is inactive without any persisted preview config", () => {
    const plan = galleryPreviewPlan(undefined, undefined);
    expect(plan.active).toBe(false);
    expect(plan.config).toEqual({ fit: "cover" });
  });

  it("keeps a valid cover even when richer stored JSON is malformed", () => {
    const plan = galleryPreviewPlan("cover", { fit: "diagonal" });
    expect(plan.active).toBe(true);
    expect(plan.config.coverPropertyId).toBe("cover");
    expect(plan.config.fit).toBe("cover");
  });

  it("resolves the same card the engine returns directly", () => {
    const plan = galleryPreviewPlan("cover", undefined);
    expect(resolveGalleryCard(rows[1], plan, galleryProperties)).toEqual(
      resolveGalleryPreview(rows[1], plan.config, { properties: galleryProperties }),
    );
  });
});

describe("form view: stored config → form-view engine", () => {
  const stored = {
    id: "form-1",
    databaseId: "db-1",
    title: "Contact us",
    description: "Say hi",
    submitLabel: "Send",
    successMessage: "Thanks!",
    accepting: true,
    fields: [
      { propertyId: "title", label: "Your name", required: true },
      { propertyId: "est", label: "Estimate", type: "NUMBER" },
    ],
  };

  it("builds the plan from a stored FormSchema, enriched with live property config", () => {
    const plan = resolveFormPlan(properties, stored);
    expect(plan.fields.map((field) => field.propertyId)).toEqual(["title", "est"]);
    expect(plan.fields[0]).toMatchObject({ label: "Your name", required: true, type: "TEXT" });
    expect(plan.fields[1]).toMatchObject({ type: "NUMBER" });
    expect(plan.meta).toMatchObject({
      title: "Contact us",
      description: "Say hi",
      submitLabel: "Send",
      successMessage: "Thanks!",
    });
  });

  it("validates a submission through validateSubmission (client gate)", () => {
    const plan = resolveFormPlan(properties, stored);
    expect(
      validateSubmission(plan.schema, { title: { text: "Hi" }, est: { number: 5 } }),
    ).toEqual({ ok: true });
    const missing = validateSubmission(plan.schema, { est: { number: 5 } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.map((issue) => issue.propertyId)).toEqual(["title"]);
    }
  });

  it("maps an accepted submission to row cells through toRowValues", () => {
    const plan = resolveFormPlan(properties, stored);
    expect(toRowValues(plan.schema, { title: { text: "Hi" }, est: { number: 5 } })).toEqual([
      { propertyId: "title", value: { text: "Hi" } },
      { propertyId: "est", value: { number: 5 } },
    ]);
  });

  it("uses stored field defaults as the missing-answer fallback", () => {
    const plan = resolveFormPlan(properties, {
      ...stored,
      fields: [{ propertyId: "status", label: "Status", default: "todo" }],
    });
    expect(toRowValues(plan.schema, {})).toEqual([{ propertyId: "status", value: "todo" }]);
  });

  it("falls back to the legacy fieldIds config shape", () => {
    const plan = resolveFormPlan(properties, {
      fieldIds: ["est", "title"],
      description: "Old",
      submitLabel: "Go",
    });
    expect(plan.fields.map((field) => field.propertyId)).toEqual(["est", "title"]);
    expect(plan.meta.description).toBe("Old");
    expect(plan.meta.submitLabel).toBe("Go");
  });

  it("offers every non-computed property when no config is stored", () => {
    const plan = resolveFormPlan(properties, undefined);
    expect(plan.fields.map((field) => field.propertyId)).toEqual([
      "title",
      "est",
      "cost",
      "done",
      "status",
      "cover",
      "body",
    ]);
    expect(plan.meta.submitLabel).toBe("Submit");
  });
});
