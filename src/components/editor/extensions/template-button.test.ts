import { describe, expect, it } from "vitest";
import { templateContent } from "@/lib/templates";
import type { PageTemplate } from "@/lib/template-gallery";
import { BUTTON_NOTIFY_REASON, type ButtonClickPlan } from "@/lib/template-blocks";
import {
  builtinButtonContext,
  builtinTemplateSources,
  buttonBlockFromAttrs,
  buttonPlanExecutability,
  planButtonNodeClick,
  planTemplateButtonAttrs,
  savedTemplateSource,
  templateButtonBlockFromAttrs,
  templateButtonIssues,
  templateInsertContent,
  templateSourceFromBlocks,
} from "./template-button";

/*
 * The engine→renderer seam for the template-button and button nodes: stored
 * node attributes → `template-blocks.ts` (`parseButtonBlock` /
 * `validateButtonBlock` / `planButtonClick` / `resolveTemplateInsert`) → the
 * click plan and the TipTap content the node view inserts. The action
 * vocabulary itself is the shared `ButtonAction` from `@/lib/row-buttons`.
 */

const now = "2026-01-02T03:04:05.000Z";

const savedTemplate: PageTemplate = {
  id: "tpl-report",
  name: "Weekly report",
  scope: "workspace",
  sourcePageId: "db-1",
  blockCount: 2,
  createdAt: now,
  updatedAt: now,
  usageCount: 0,
  blocks: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Report" }] },
    { type: "paragraph", content: [{ type: "text", text: "Body" }] },
  ],
};

describe("template-button wiring (parseTemplateButton + validateButtonBlock + resolveTemplateInsert)", () => {
  it("parses a stored template button, rejecting malformed attrs", () => {
    expect(templateButtonBlockFromAttrs({ id: "tb1", templateId: "meeting", label: "Meeting notes" })).toEqual(
      { id: "tb1", templateId: "meeting", label: "Meeting notes" },
    );
    expect(templateButtonBlockFromAttrs({ templateId: "meeting" })).toBeNull();
  });

  it("validates against the built-in templates", () => {
    expect(templateButtonIssues({ id: "tb1", templateId: "meeting", label: "Meeting notes" })).toEqual([]);
    expect(
      templateButtonIssues({ id: "tb2", templateId: "nope", label: "Nope" }).map((issue) => issue.code),
    ).toContain("unknown_template");
  });

  it("plans a click through the shared button planner", () => {
    const plan = planTemplateButtonAttrs(
      { id: "tb1", templateId: "meeting", label: "Meeting notes" },
      builtinButtonContext({ now }),
    );
    expect(plan?.kind).toBe("insertTemplate");
    if (plan?.kind !== "insertTemplate") throw new Error("expected an insert plan");
    expect(plan.templateId).toBe("meeting");
    expect(plan.insert.blocks.length).toBe(templateContent("meeting").length);
    expect(plan.insert.blocks[0].id.startsWith("meeting-")).toBe(true);
    expect(plan.insert.blocks[0].sourceId).toBe("src-meeting-0");
  });

  it("mints fresh, ordered TipTap content from an insert plan", () => {
    const plan = planTemplateButtonAttrs(
      { id: "tb1", templateId: "tasks", label: "Task list" },
      builtinButtonContext({ now }),
    );
    if (plan?.kind !== "insertTemplate") throw new Error("expected an insert plan");
    const content = templateInsertContent(plan);
    expect(content?.length).toBe(templateContent("tasks").length);
    expect(content?.[0].attrs?.id).toBe(plan.insert.blocks[0].id);
  });

  it("exposes the built-in templates as insert sources", () => {
    const sources = builtinTemplateSources();
    expect(sources.map((source) => source.id)).toEqual(["meeting", "tasks", "decision", "weekly"]);
    expect(sources[0].blocks[0]).toMatchObject({ id: "src-meeting-0", index: 0, type: "heading" });
  });

  it("projects a saved workspace template and inserts its own blocks", () => {
    const source = savedTemplateSource(savedTemplate);
    const plan = planTemplateButtonAttrs(
      { id: "tb1", templateId: savedTemplate.id, label: savedTemplate.name },
      { templates: [...builtinTemplateSources(), source], now },
    );
    expect(plan?.kind).toBe("insertTemplate");
    if (plan?.kind !== "insertTemplate") throw new Error("expected an insert plan");
    const content = templateInsertContent(plan, savedTemplate.blocks);
    expect(content?.map((node) => node.type)).toEqual(["heading", "paragraph"]);
    expect(content?.[0].attrs?.id).toBe(plan.insert.blocks[0].id);
  });

  it("disables a deleted or foreign template instead of inserting nothing", () => {
    const plan = planTemplateButtonAttrs(
      { id: "tb1", templateId: "deleted-template", label: "Gone" },
      { templates: [savedTemplateSource(savedTemplate)] },
    );
    expect(plan?.kind).toBe("invalid");
    if (plan?.kind !== "invalid") throw new Error("expected an invalid plan");
    expect(plan.issues.some((issue) => issue.code === "unknown_template")).toBe(true);
  });

  it("falls back to a stable source id when a stored block has no id", () => {
    const source = templateSourceFromBlocks("tpl-x", [{ type: "paragraph" }]);
    expect(source.blocks[0]).toMatchObject({ id: "src-tpl-x-0", index: 0, type: "paragraph" });
  });
});

describe("button wiring (shared ButtonAction + planButtonClick + executability)", () => {
  it("plans each shared ButtonAction kind", () => {
    const open = planButtonNodeClick(
      { id: "b1", label: "Open", action: { kind: "open_url", url: "https://example.com/x" } },
      builtinButtonContext(),
    );
    expect(open?.kind).toBe("openUrl");
    if (open?.kind !== "openUrl") throw new Error("expected an open plan");
    expect(open.href).toBe("https://example.com/x");
    expect(buttonPlanExecutability(open).executable).toBe(true);

    const set = planButtonNodeClick(
      { id: "b2", label: "Set", action: { kind: "set_property", propertyId: "status", value: "Done" } },
      builtinButtonContext(),
    );
    expect(set?.kind).toBe("setProperty");
    if (set?.kind !== "setProperty") throw new Error("expected a set-property plan");
    expect(set.propertyId).toBe("status");
    expect(buttonPlanExecutability(set).executable).toBe(true);

    const insert = planButtonNodeClick(
      { id: "b3", label: "Insert", action: { kind: "insert_template", templateId: "meeting" } },
      builtinButtonContext({ now }),
    );
    expect(insert?.kind).toBe("insertTemplate");
    expect(insert && buttonPlanExecutability(insert).executable).toBe(true);
  });

  it("disables a notification explicitly instead of no-oping", () => {
    const plan = planButtonNodeClick(
      { id: "b4", label: "Notify", action: { kind: "notify", message: "Ping", level: "info" } },
      builtinButtonContext(),
    );
    expect(plan?.kind).toBe("notify");
    if (!plan) throw new Error("expected a plan");
    const executability = buttonPlanExecutability(plan);
    expect(executability.executable).toBe(false);
    expect(executability.reason).toBe(BUTTON_NOTIFY_REASON);
  });

  it("returns null for an unparseable button", () => {
    expect(buttonBlockFromAttrs({ id: "b5", label: "Bad", action: { kind: "nope" } })).toBeNull();
    expect(planButtonNodeClick({ id: "b5", label: "Bad", action: { kind: "nope" } })).toBeNull();
  });

  it("surfaces validator issues through an invalid plan", () => {
    const plan = planButtonNodeClick({
      id: "b6",
      label: "Unsafe",
      action: { kind: "open_url", url: "javascript:alert(1)" },
    });
    expect(plan?.kind).toBe("invalid");
    if (!plan) throw new Error("expected a plan");
    expect(buttonPlanExecutability(plan).executable).toBe(false);
  });

  it("keeps an insert_template plan invalid when the template is missing", () => {
    const plan = planButtonNodeClick(
      { id: "b7", label: "Insert", action: { kind: "insert_template", templateId: "gone" } },
      { templates: builtinTemplateSources() },
    );
    expect(plan?.kind).toBe("invalid");
    if (plan?.kind !== "invalid") throw new Error("expected an invalid plan");
    expect(plan.issues.some((issue) => issue.code === "unknown_template")).toBe(true);
  });
});

describe("templateInsertContent boundaries", () => {
  it("returns null for a non-insert plan", () => {
    const plan: ButtonClickPlan = {
      kind: "openUrl",
      blockId: "b",
      label: "Open",
      confirm: false,
      href: "https://example.com",
      openInNewTab: true,
    };
    expect(templateInsertContent(plan)).toBeNull();
  });
});
