import { describe, expect, it } from "vitest";
import { templateContent } from "@/lib/templates";
import {
  BUTTON_SETPROPS_REASON,
  builtinButtonContext,
  builtinTemplateSources,
  buttonBlockFromAttrs,
  buttonPlanExecutability,
  planButtonNodeClick,
  planTemplateButtonAttrs,
  templateButtonBlockFromAttrs,
  templateButtonIssues,
  templateInsertContent,
} from "./template-button";

/*
 * The engine→renderer seam for the template-button and button nodes: stored
 * node attributes → `template-blocks.ts` (`parseButtonBlock` /
 * `validateButtonBlock` / `planButtonClick` / `resolveTemplateInsert`) → the
 * click plan and the TipTap content the node view inserts.
 */

const now = "2026-01-02T03:04:05.000Z";

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
});

describe("button wiring (parseButtonBlock + planButtonClick + executability)", () => {
  it("plans each client-executable action", () => {
    const open = planButtonNodeClick(
      { id: "b1", label: "Open", action: { type: "openPage", pageId: "p2" } },
      builtinButtonContext(),
    );
    expect(open?.kind).toBe("openPage");
    expect(open && buttonPlanExecutability(open).executable).toBe(true);

    const duplicate = planButtonNodeClick(
      { id: "b2", label: "Copy", action: { type: "duplicate", sourceIds: ["a", "b"] } },
      builtinButtonContext(),
    );
    expect(duplicate?.kind).toBe("duplicate");
    expect(duplicate && buttonPlanExecutability(duplicate).executable).toBe(true);

    const webhook = planButtonNodeClick(
      { id: "b3", label: "Ping", action: { type: "webhook", url: "https://example.com/hook", method: "PATCH" } },
      builtinButtonContext(),
    );
    expect(webhook?.kind).toBe("webhook");
    expect(webhook && buttonPlanExecutability(webhook).executable).toBe(true);
  });

  it("reports setProps as not executable by the editor", () => {
    const plan = planButtonNodeClick(
      { id: "b4", label: "Set", action: { type: "setProps", props: { status: "Done" } } },
      builtinButtonContext(),
    );
    expect(plan?.kind).toBe("setProps");
    if (!plan) throw new Error("expected a plan");
    const executability = buttonPlanExecutability(plan);
    expect(executability.executable).toBe(false);
    expect(executability.reason).toBe(BUTTON_SETPROPS_REASON);
  });

  it("returns null for an unparseable button", () => {
    expect(buttonBlockFromAttrs({ id: "b5", label: "Bad", action: { type: "nope" } })).toBeNull();
    expect(planButtonNodeClick({ id: "b5", label: "Bad", action: { type: "nope" } })).toBeNull();
  });

  it("surfaces validator issues through an invalid plan", () => {
    const plan = planButtonNodeClick({
      id: "b6",
      label: "Unsafe",
      action: { type: "webhook", url: "javascript:alert(1)" },
    });
    expect(plan?.kind).toBe("invalid");
    if (!plan) throw new Error("expected a plan");
    expect(buttonPlanExecutability(plan).executable).toBe(false);
  });
});
