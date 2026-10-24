import { describe, expect, it } from "vitest";
import { VIEW_TYPES as CANONICAL_VIEW_TYPES } from "@/lib/view-config-schema";
import { VIEW_TYPES } from "./view-tabs";

describe("view-tabs menu", () => {
  it("offers exactly the canonical view types in schema order", () => {
    expect(VIEW_TYPES.map((entry) => entry.type)).toEqual([...CANONICAL_VIEW_TYPES]);
  });

  it("includes the form view with a label", () => {
    expect(VIEW_TYPES).toContainEqual({ type: "FORM", label: "Form" });
  });
});
