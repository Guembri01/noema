import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_METHOD,
  WEBHOOK_METHODS,
  describeButton,
  isValidButtonBlock,
  parseButtonBlock,
  parseTemplateButton,
  planButtonClick,
  planTemplateButtonClick,
  resolveTemplateInsert,
  validateButtonBlock,
  type ButtonBlock,
  type TemplateButtonBlock,
  type TemplateInsertSource,
} from "@/lib/template-blocks";

/*
 * Template button + Button block engine (docs/MISSING_FEATURES.md §1 "Template
 * button block" / "Button block", §6 "Template button"). These tests pin the
 * strict parsers, the semantic validator (unknown template/action, missing
 * action args, the webhook URL allowlist), the side-effect-free click plans and
 * the pure template-insert resolver that mints fresh block ids.
 */

const meetingSource: TemplateInsertSource = {
  id: "meeting",
  label: "Meeting notes",
  blocks: [
    { id: "src-h", index: 3, type: "heading", text: "Meeting notes" },
    { id: "src-p", index: 4, type: "paragraph", text: "Attendees" },
    { id: "src-l", index: 5, type: "bulletList", text: "Agenda" },
  ],
};

const knownContext = {
  templates: [meetingSource.id, "tasks"],
  properties: [{ id: "status" }, { id: "owner" }],
};

describe("parseTemplateButton", () => {
  it("parses a well-formed template button", () => {
    expect(parseTemplateButton({ id: "tb1", templateId: "meeting", label: "Insert" })).toEqual({
      id: "tb1",
      templateId: "meeting",
      label: "Insert",
    });
  });

  it("keeps an optional icon", () => {
    const parsed = parseTemplateButton({
      id: "tb1",
      templateId: "meeting",
      label: "Insert",
      icon: "📄",
    });
    expect(parsed?.icon).toBe("📄");
  });

  it("rejects non-objects and wrong field types", () => {
    expect(parseTemplateButton(null)).toBeNull();
    expect(parseTemplateButton("nope")).toBeNull();
    expect(parseTemplateButton({ id: "tb1", templateId: 3, label: "Insert" })).toBeNull();
    expect(parseTemplateButton({ id: "tb1", templateId: "meeting", icon: 7 })).toBeNull();
  });

  it("rejects blank required fields", () => {
    expect(parseTemplateButton({ id: "", templateId: "meeting", label: "Insert" })).toBeNull();
    expect(parseTemplateButton({ id: "tb1", templateId: "  ", label: "Insert" })).toBeNull();
    expect(parseTemplateButton({ id: "tb1", templateId: "meeting", label: "" })).toBeNull();
  });
});

describe("parseButtonBlock", () => {
  it("parses every action type", () => {
    expect(
      parseButtonBlock({
        id: "b1",
        label: "Insert",
        action: { type: "insertTemplate", templateId: "meeting" },
      }),
    ).toEqual({ id: "b1", label: "Insert", action: { type: "insertTemplate", templateId: "meeting" } });

    expect(
      parseButtonBlock({ id: "b2", label: "Go", action: { type: "openPage", pageId: "p9" } }),
    ).toEqual({ id: "b2", label: "Go", action: { type: "openPage", pageId: "p9" } });

    expect(
      parseButtonBlock({
        id: "b3",
        label: "Set",
        action: { type: "setProps", props: { status: "done" } },
      })?.action,
    ).toEqual({ type: "setProps", props: { status: "done" } });

    expect(
      parseButtonBlock({
        id: "b4",
        label: "Ping",
        action: { type: "webhook", url: "https://example.com/hook" },
      })?.action,
    ).toEqual({ type: "webhook", url: "https://example.com/hook" });

    expect(
      parseButtonBlock({
        id: "b5",
        label: "Copy",
        action: { type: "duplicate", sourceIds: ["x", "y"] },
      })?.action,
    ).toEqual({ type: "duplicate", sourceIds: ["x", "y"] });
  });

  it("preserves the confirm flag and icon", () => {
    const parsed = parseButtonBlock({
      id: "b1",
      label: "⚠️ Delete",
      icon: "🗑",
      confirm: true,
      action: { type: "openPage", pageId: "p1" },
    });
    expect(parsed?.confirm).toBe(true);
    expect(parsed?.icon).toBe("🗑");
  });

  it("rejects an unknown action type", () => {
    expect(parseButtonBlock({ id: "b", label: "x", action: { type: "explode" } })).toBeNull();
  });

  it("rejects missing ids/labels and malformed actions", () => {
    expect(parseButtonBlock({ label: "x", action: { type: "openPage", pageId: "p" } })).toBeNull();
    expect(parseButtonBlock({ id: "b", action: { type: "openPage", pageId: "p" } })).toBeNull();
    expect(parseButtonBlock({ id: "b", label: "x" })).toBeNull();
    expect(parseButtonBlock({ id: "b", label: "x", action: { type: "webhook" } })).toBeNull();
    expect(
      parseButtonBlock({ id: "b", label: "x", action: { type: "duplicate", sourceIds: "x" } }),
    ).toBeNull();
    expect(
      parseButtonBlock({ id: "b", label: "x", action: { type: "webhook", url: "https://e.com", method: "DELETE" } }),
    ).toBeNull();
  });

  it("rejects a non-boolean confirm", () => {
    expect(
      parseButtonBlock({
        id: "b",
        label: "x",
        confirm: "yes",
        action: { type: "openPage", pageId: "p" },
      }),
    ).toBeNull();
  });
});

describe("validateButtonBlock", () => {
  it("passes a well-formed block of every action type", () => {
    const blocks: ButtonBlock[] = [
      { id: "b1", label: "Insert", action: { type: "insertTemplate", templateId: "meeting" } },
      { id: "b2", label: "Go", action: { type: "openPage", pageId: "p9" } },
      { id: "b3", label: "Set", action: { type: "setProps", props: { status: "done" } } },
      { id: "b4", label: "Ping", action: { type: "webhook", url: "https://example.com/hook" } },
      { id: "b5", label: "Copy", action: { type: "duplicate", sourceIds: ["x"] } },
    ];
    for (const block of blocks) expect(validateButtonBlock(block, knownContext)).toEqual([]);
    expect(isValidButtonBlock(blocks[0], knownContext)).toBe(true);
  });

  it("flags a non-object block", () => {
    const issues = validateButtonBlock(null, knownContext);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("not_an_object");
  });

  it("flags missing id and label", () => {
    const issues = validateButtonBlock(
      { action: { type: "openPage", pageId: "p" } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "missing_field" && i.path === "id")).toBe(true);
    expect(issues.some((i) => i.code === "missing_field" && i.path === "label")).toBe(true);
  });

  it("flags an unknown action type", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { type: "explode" } },
      knownContext,
    );
    expect(issues[0].code).toBe("unknown_action");
    expect(issues[0].path).toBe("action.type");
  });

  it("flags an unknown template against the known set", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { type: "insertTemplate", templateId: "ghost" } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "unknown_template" && i.path === "action.templateId")).toBe(
      true,
    );
  });

  it("flags a missing templateId", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { type: "insertTemplate" } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "missing_field" && i.path === "action.templateId")).toBe(
      true,
    );
  });

  it("flags a missing pageId", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { type: "openPage" } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "missing_field" && i.path === "action.pageId")).toBe(true);
  });

  it("flags an unknown property and an empty patch", () => {
    const unknown = validateButtonBlock(
      { id: "b", label: "x", action: { type: "setProps", props: { ghost: 1 } } },
      knownContext,
    );
    expect(unknown.some((i) => i.code === "unknown_property" && i.path === "action.props.ghost")).toBe(
      true,
    );

    const empty = validateButtonBlock(
      { id: "b", label: "x", action: { type: "setProps", props: {} } },
      knownContext,
    );
    expect(empty.some((i) => i.code === "missing_field" && i.path === "action.props")).toBe(true);
  });

  it("flags an unsafe webhook url and an invalid method", () => {
    const unsafe = validateButtonBlock(
      { id: "b", label: "x", action: { type: "webhook", url: "javascript:alert(1)" } },
      knownContext,
    );
    expect(unsafe.some((i) => i.code === "unsafe_url" && i.path === "action.url")).toBe(true);

    const badMethod = validateButtonBlock(
      { id: "b", label: "x", action: { type: "webhook", url: "https://e.com", method: "DELETE" } },
      knownContext,
    );
    expect(badMethod.some((i) => i.code === "invalid_method" && i.path === "action.method")).toBe(
      true,
    );
  });

  it("flags an empty duplicate source list", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { type: "duplicate", sourceIds: [] } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "missing_field" && i.path === "action.sourceIds")).toBe(
      true,
    );
  });
});

describe("resolveTemplateInsert", () => {
  it("mints fresh ids that differ from the source ids", () => {
    const result = resolveTemplateInsert(meetingSource, { now: "2026-01-01T00:00:00.000Z", actorId: "u1" });
    const ids = result.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const block of result.blocks) expect(ids).not.toContain(block.sourceId);
  });

  it("preserves block order and type/text content", () => {
    const result = resolveTemplateInsert(meetingSource, { now: "n", actorId: "u1" });
    expect(result.blocks.map((block) => block.sourceId)).toEqual(["src-h", "src-p", "src-l"]);
    expect(result.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
    ]);
    expect(result.blocks[1].text).toBe("Attendees");
  });

  it("shifts indices so the first block lands at zero", () => {
    const result = resolveTemplateInsert(meetingSource, { now: "n", actorId: "u1" });
    expect(result.blocks.map((block) => block.index)).toEqual([0, 1, 2]);
  });

  it("stamps the template id, timestamp and actor", () => {
    const result = resolveTemplateInsert(meetingSource, {
      now: "2026-02-02T00:00:00.000Z",
      actorId: "u7",
    });
    expect(result.templateId).toBe("meeting");
    expect(result.insertedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(result.actorId).toBe("u7");
  });

  it("honours an injected id factory and does not mutate the source", () => {
    const snapshot = JSON.stringify(meetingSource);
    const result = resolveTemplateInsert(meetingSource, {
      now: "n",
      actorId: "u1",
      idFactory: (sourceId, index) => `fresh:${index}:${sourceId}`,
    });
    expect(result.blocks.map((block) => block.id)).toEqual([
      "fresh:0:src-h",
      "fresh:1:src-p",
      "fresh:2:src-l",
    ]);
    expect(JSON.stringify(meetingSource)).toBe(snapshot);
  });

  it("returns an empty block list for an empty template", () => {
    const result = resolveTemplateInsert(
      { id: "empty", blocks: [] },
      { now: "n", actorId: "u1" },
    );
    expect(result.blocks).toEqual([]);
  });
});

describe("planButtonClick", () => {
  it("resolves an insertTemplate plan with fresh blocks", () => {
    const block: ButtonBlock = {
      id: "b1",
      label: "Insert notes",
      action: { type: "insertTemplate", templateId: "meeting" },
    };
    const plan = planButtonClick(block, { templates: [meetingSource], now: "n", actorId: "u1" });
    expect(plan.kind).toBe("insertTemplate");
    if (plan.kind !== "insertTemplate") throw new Error("wrong kind");
    expect(plan.blockId).toBe("b1");
    expect(plan.label).toBe("Insert notes");
    expect(plan.templateId).toBe("meeting");
    expect(plan.insert.blocks).toHaveLength(3);
    expect(plan.insert.blocks.map((b) => b.index)).toEqual([0, 1, 2]);
  });

  it("carries the confirm flag onto the plan", () => {
    const block: ButtonBlock = {
      id: "b1",
      label: "Danger",
      confirm: true,
      action: { type: "openPage", pageId: "p1" },
    };
    const plan = planButtonClick(block, {});
    expect(plan.kind).toBe("openPage");
    expect(plan.confirm).toBe(true);
  });

  it("plans an openPage navigation", () => {
    const plan = planButtonClick(
      { id: "b2", label: "Go", action: { type: "openPage", pageId: "p9" } },
      {},
    );
    expect(plan.kind).toBe("openPage");
    if (plan.kind !== "openPage") throw new Error("wrong kind");
    expect(plan.pageId).toBe("p9");
  });

  it("plans a setProps patch", () => {
    const plan = planButtonClick(
      { id: "b3", label: "Set", action: { type: "setProps", props: { status: "done", owner: "u1" } } },
      {},
    );
    expect(plan.kind).toBe("setProps");
    if (plan.kind !== "setProps") throw new Error("wrong kind");
    expect(plan.patch).toEqual({ status: "done", owner: "u1" });
  });

  it("plans a webhook with a defaulted method", () => {
    const plan = planButtonClick(
      { id: "b4", label: "Ping", action: { type: "webhook", url: "https://example.com/hook" } },
      {},
    );
    expect(plan.kind).toBe("webhook");
    if (plan.kind !== "webhook") throw new Error("wrong kind");
    expect(plan.url).toBe("https://example.com/hook");
    expect(plan.method).toBe(DEFAULT_WEBHOOK_METHOD);
  });

  it("plans a duplicate that returns the source ids", () => {
    const plan = planButtonClick(
      { id: "b5", label: "Copy", action: { type: "duplicate", sourceIds: ["x", "y"] } },
      {},
    );
    expect(plan.kind).toBe("duplicate");
    if (plan.kind !== "duplicate") throw new Error("wrong kind");
    expect(plan.sourceIds).toEqual(["x", "y"]);
  });

  it("returns an invalid plan for an unknown template", () => {
    const plan = planButtonClick(
      { id: "b1", label: "Insert", action: { type: "insertTemplate", templateId: "ghost" } },
      { templates: [meetingSource] },
    );
    expect(plan.kind).toBe("invalid");
    if (plan.kind !== "invalid") throw new Error("wrong kind");
    expect(plan.issues.some((issue) => issue.code === "unknown_template")).toBe(true);
  });

  it("returns an invalid plan for an unsafe webhook url", () => {
    const plan = planButtonClick(
      { id: "b4", label: "Ping", action: { type: "webhook", url: "javascript:alert(1)" } },
      {},
    );
    expect(plan.kind).toBe("invalid");
  });

  it("does not mutate the block it plans", () => {
    const block: ButtonBlock = {
      id: "b4",
      label: "Ping",
      action: { type: "webhook", url: "https://example.com/hook" },
    };
    const snapshot = JSON.stringify(block);
    planButtonClick(block, {});
    expect(JSON.stringify(block)).toBe(snapshot);
  });
});

describe("planTemplateButtonClick", () => {
  it("plans the template button's insert as an insertTemplate plan", () => {
    const button: TemplateButtonBlock = { id: "tb1", templateId: "meeting", label: "Insert" };
    const plan = planTemplateButtonClick(button, { templates: [meetingSource], now: "n", actorId: "u1" });
    expect(plan.kind).toBe("insertTemplate");
    if (plan.kind !== "insertTemplate") throw new Error("wrong kind");
    expect(plan.blockId).toBe("tb1");
    expect(plan.insert.blocks).toHaveLength(3);
  });

  it("returns an invalid plan when the template is unknown", () => {
    const button: TemplateButtonBlock = { id: "tb1", templateId: "ghost", label: "Insert" };
    const plan = planTemplateButtonClick(button, { templates: [meetingSource] });
    expect(plan.kind).toBe("invalid");
  });
});

describe("describeButton", () => {
  it("describes a template button", () => {
    expect(describeButton({ id: "tb1", templateId: "meeting", label: "Insert" })).toBe(
      'Insert template "meeting"',
    );
  });

  it("describes an insertTemplate block", () => {
    expect(
      describeButton({ id: "b", label: "x", action: { type: "insertTemplate", templateId: "tasks" } }),
    ).toBe('Insert template "tasks"');
  });

  it("describes openPage, webhook and duplicate", () => {
    expect(describeButton({ id: "b", label: "x", action: { type: "openPage", pageId: "p9" } })).toBe(
      'Open page "p9"',
    );
    expect(
      describeButton({ id: "b", label: "x", action: { type: "webhook", url: "https://example.com/hook" } }),
    ).toBe("POST https://example.com/hook");
    expect(
      describeButton({ id: "b", label: "x", action: { type: "duplicate", sourceIds: ["a", "b"] } }),
    ).toBe("Duplicate 2 blocks");
  });

  it("counts setProps properties with correct singular/plural", () => {
    expect(
      describeButton({ id: "b", label: "x", action: { type: "setProps", props: { a: 1 } } }),
    ).toBe("Set 1 property");
    expect(
      describeButton({ id: "b", label: "x", action: { type: "setProps", props: { a: 1, b: 2 } } }),
    ).toBe("Set 2 properties");
  });

  it("appends a confirm suffix when confirmation is required", () => {
    expect(
      describeButton({
        id: "b",
        label: "x",
        confirm: true,
        action: { type: "openPage", pageId: "p9" },
      }),
    ).toBe('Open page "p9" (confirm)');
  });
});

describe("webhook method catalogue", () => {
  it("exposes POST/PUT/PATCH with POST as the default", () => {
    expect(WEBHOOK_METHODS).toEqual(["POST", "PUT", "PATCH"]);
    expect(DEFAULT_WEBHOOK_METHOD).toBe("POST");
  });
});
