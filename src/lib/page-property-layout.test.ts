import { describe, expect, it } from "vitest";
import {
  isEnginePropertyLayout,
  pagePropertyPlan,
  propertyPanelLayout,
} from "@/lib/page-property-layout";
import type { PropertyLayout } from "@/lib/property-layout-engine";

/**
 * Page property layout adapter — the persisted two-column layout must survive a
 * JSON round-trip, reconcile with the live schema without dropping properties,
 * and collapse (not truncate) when the panel is narrow.
 */

const properties = [
  { id: "title", name: "Title" },
  { id: "status", name: "Status" },
  { id: "owner", name: "Owner" },
  { id: "due", name: "Due" },
];

const twoColumn: PropertyLayout = {
  columns: 2,
  order: ["status", "title"],
  spans: { title: 2 },
  dividers: true,
};

describe("propertyPanelLayout — persisted shapes", () => {
  it("round-trips the flat engine layout through JSON", () => {
    const parsed = propertyPanelLayout(JSON.stringify(twoColumn), properties);
    expect(parsed.columns).toBe(2);
    expect(parsed.spans).toEqual({ title: 2 });
    expect(parsed.dividers).toBe(true);
    expect(parsed.order).toEqual(["status", "title", "owner", "due"]);
  });

  it("keeps the saved order and appends new schema properties", () => {
    const parsed = propertyPanelLayout(
      { columns: 2, order: ["owner", "deleted-property"] },
      properties,
    );
    expect(parsed.order).toEqual(["owner", "title", "status", "due"]);
    expect(parsed.order).not.toContain("deleted-property");
  });

  it("adapts the legacy array-of-columns shape", () => {
    const parsed = propertyPanelLayout(
      { columns: [["status"], ["title", "owner"]] },
      properties,
    );
    expect(parsed.columns).toBe(2);
    expect(parsed.order).toEqual(["status", "title", "owner", "due"]);
  });

  it("degrades malformed input to every property in one column", () => {
    const parsed = propertyPanelLayout("{not json", properties);
    expect(parsed.columns).toBe(1);
    expect(parsed.order).toEqual(["title", "status", "owner", "due"]);
  });

  it("detects only the flat engine shape", () => {
    expect(isEnginePropertyLayout({ columns: 2, order: [] })).toBe(true);
    expect(isEnginePropertyLayout({ columns: [["title"]] })).toBe(false);
    expect(isEnginePropertyLayout("{not json")).toBe(false);
  });
});

describe("pagePropertyPlan — responsive grouping", () => {
  it("groups a two-column layout row-major", () => {
    const plan = pagePropertyPlan(
      { columns: 2, order: ["title", "status", "owner"] },
      properties,
      { widthBucket: "wide" },
    );
    expect(plan.plan.columns).toBe(2);
    expect(
      plan.placements.map((placement) => [placement.propertyId, placement.column, placement.row]),
    ).toEqual([
      ["title", 0, 0],
      ["status", 1, 0],
      ["owner", 0, 1],
      ["due", 1, 1],
    ]);
  });

  it("collapses to one column when narrow without dropping or reordering", () => {
    const plan = pagePropertyPlan(twoColumn, properties, {
      widthBucket: "narrow",
      availableWidth: 320,
    });
    expect(plan.plan.collapsed).toBe(true);
    expect(plan.plan.columns).toBe(1);
    expect(plan.layout.order).toEqual(["status", "title", "owner", "due"]);
    expect(plan.placements.map((placement) => placement.propertyId)).toEqual([
      "status",
      "title",
      "owner",
      "due",
    ]);
    expect(plan.placements.every((placement) => placement.column === 0)).toBe(true);
  });

  it("never expands a one-column layout on a wide surface", () => {
    const plan = pagePropertyPlan(
      { columns: 1, order: ["title"] },
      properties,
      { widthBucket: "wide", availableWidth: 1200 },
    );
    expect(plan.plan.columns).toBe(1);
    expect(plan.placements.map((placement) => placement.propertyId)).toEqual([
      "title",
      "status",
      "owner",
      "due",
    ]);
  });
});
