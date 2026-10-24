import { describe, expect, it } from "vitest";
import {
  BUTTON_NOTIFY_REASON,
  BUTTON_BLOCK_ACTIONS,
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
 * button block" / "Button block"). These tests pin the strict parsers, the
 * semantic validator (unknown template/action, missing action args, the shared
 * webhook/link allowlist), the side-effect-free click plans and the pure
 * template-insert resolver that mints fresh block ids. The action vocabulary is
 * the same `ButtonAction` automations execute.
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
  it("parses every shared ButtonAction kind", () => {
    expect(
      parseButtonBlock({
        id: "b1",
        label: "Insert",
        action: { kind: "insert_template", templateId: "meeting" },
      }),
    ).toEqual({ id: "b1", label: "Insert", action: { kind: "insert_template", templateId: "meeting" } });

    expect(
      parseButtonBlock({ id: "b2", label: "Go", action: { kind: "open_url", url: "https://example.com" } })
        ?.action,
    ).toEqual({ kind: "open_url", url: "https://example.com" });

    expect(
      parseButtonBlock({
        id: "b3",
        label: "Set",
        action: { kind: "set_property", propertyId: "status", value: "done" },
      })?.action,
    ).toEqual({ kind: "set_property", propertyId: "status", value: "done" });

    expect(
      parseButtonBlock({
        id: "b4",
        label: "Ping",
        action: { kind: "notify", message: "Ping", level: "warning" },
      })?.action,
    ).toEqual({ kind: "notify", message: "Ping", level: "warning" });
  });

  it("preserves the confirm flag, icon and style", () => {
    const parsed = parseButtonBlock({
      id: "b1",
      label: "⚠️ Delete",
      icon: "🗑",
      confirm: true,
      style: "danger",
      action: { kind: "open_url", url: "https://example.com" },
    });
    expect(parsed?.confirm).toBe(true);
    expect(parsed?.icon).toBe("🗑");
    expect(parsed?.style).toBe("danger");
  });

  it("rejects an unknown action kind", () => {
    expect(parseButtonBlock({ id: "b", label: "x", action: { kind: "explode" } })).toBeNull();
    // A legacy `type` discriminator is not a second language.
    expect(
      parseButtonBlock({ id: "b", label: "x", action: { type: "openPage", pageId: "p" } }),
    ).toBeNull();
  });

  it("rejects missing ids/labels and malformed actions", () => {
    expect(parseButtonBlock({ label: "x", action: { kind: "open_url", url: "https://e.com" } })).toBeNull();
    expect(parseButtonBlock({ id: "b", action: { kind: "open_url", url: "https://e.com" } })).toBeNull();
    expect(parseButtonBlock({ id: "b", label: "x" })).toBeNull();
    expect(parseButtonBlock({ id: "b", label: "x", action: { kind: "notify" } })).toBeNull();
    expect(
      parseButtonBlock({ id: "b", label: "x", action: { kind: "set_property", propertyId: "p" } }),
    ).toBeNull();
  });

  it("rejects a non-boolean confirm and an unknown style", () => {
    expect(
      parseButtonBlock({
        id: "b",
        label: "x",
        confirm: "yes",
        action: { kind: "open_url", url: "https://e.com" },
      }),
    ).toBeNull();
    expect(
      parseButtonBlock({
        id: "b",
        label: "x",
        style: "neon",
        action: { kind: "open_url", url: "https://e.com" },
      }),
    ).toBeNull();
  });
});

describe("validateButtonBlock", () => {
  it("passes a well-formed block of every action type", () => {
    const blocks: ButtonBlock[] = [
      { id: "b1", label: "Insert", action: { kind: "insert_template", templateId: "meeting" } },
      { id: "b2", label: "Go", action: { kind: "open_url", url: "https://example.com" } },
      { id: "b3", label: "Set", action: { kind: "set_property", propertyId: "status", value: "done" } },
      { id: "b4", label: "Ping", action: { kind: "notify", message: "Ping" } },
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
      { action: { kind: "open_url", url: "https://e.com" } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "missing_field" && i.path === "id")).toBe(true);
    expect(issues.some((i) => i.code === "missing_field" && i.path === "label")).toBe(true);
  });

  it("flags an unknown action kind", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { kind: "explode" } },
      knownContext,
    );
    expect(issues[0].code).toBe("unknown_action");
    expect(issues[0].path).toBe("action.kind");
  });

  it("flags an unknown template against the known set", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { kind: "insert_template", templateId: "ghost" } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "unknown_template" && i.path === "action.templateId")).toBe(
      true,
    );
  });

  it("flags a missing templateId", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { kind: "insert_template" } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "missing_field" && i.path === "action.templateId")).toBe(
      true,
    );
  });

  it("flags an unknown property", () => {
    const issues = validateButtonBlock(
      { id: "b", label: "x", action: { kind: "set_property", propertyId: "ghost", value: 1 } },
      knownContext,
    );
    expect(issues.some((i) => i.code === "unknown_property" && i.path === "action.propertyId")).toBe(
      true,
    );
  });

  it("flags an unsafe open_url and a missing notify message", () => {
    const unsafe = validateButtonBlock(
      { id: "b", label: "x", action: { kind: "open_url", url: "javascript:alert(1)" } },
      knownContext,
    );
    expect(unsafe.some((i) => i.code === "unsafe_url" && i.path === "action.url")).toBe(true);

    const notify = validateButtonBlock(
      { id: "b", label: "x", action: { kind: "notify", message: "" } },
      knownContext,
    );
    expect(notify.some((i) => i.code === "missing_field" && i.path === "action.message")).toBe(true);
  });

  it("flags an unknown style", () => {
    const issues = validateButtonBlock(
      {
        id: "b",
        label: "x",
        style: "neon",
        action: { kind: "open_url", url: "https://e.com" },
      },
      knownContext,
    );
    expect(issues.some((i) => i.code === "wrong_type" && i.path === "style")).toBe(true);
  });

  it("exposes exactly the shared ButtonAction vocabulary", () => {
    expect(BUTTON_BLOCK_ACTIONS).toEqual(["open_url", "set_property", "insert_template", "notify"]);
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
  it("resolves an insert_template plan with fresh blocks", () => {
    const block: ButtonBlock = {
      id: "b1",
      label: "Insert notes",
      action: { kind: "insert_template", templateId: "meeting" },
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
      action: { kind: "open_url", url: "https://example.com" },
    };
    const plan = planButtonClick(block, {});
    expect(plan.kind).toBe("openUrl");
    expect(plan.confirm).toBe(true);
  });

  it("plans the shared open_url, set_property and notify actions", () => {
    const open = planButtonClick(
      { id: "b2", label: "Go", action: { kind: "open_url", url: "https://example.com/x" } },
      {},
    );
    expect(open.kind).toBe("openUrl");
    if (open.kind !== "openUrl") throw new Error("wrong kind");
    expect(open.href).toBe("https://example.com/x");
    expect(open.openInNewTab).toBe(true);

    const set = planButtonClick(
      { id: "b3", label: "Set", action: { kind: "set_property", propertyId: "status", value: "done" } },
      {},
    );
    expect(set.kind).toBe("setProperty");
    if (set.kind !== "setProperty") throw new Error("wrong kind");
    expect(set.propertyId).toBe("status");
    expect(set.value).toBe("done");

    const notify = planButtonClick(
      { id: "b4", label: "Notify", action: { kind: "notify", message: "Ping" } },
      {},
    );
    expect(notify.kind).toBe("notify");
    if (notify.kind !== "notify") throw new Error("wrong kind");
    expect(notify.message).toBe("Ping");
    expect(notify.level).toBe("info");
  });

  it("interpolates the caller's variables into the plan", () => {
    const plan = planButtonClick(
      { id: "b", label: "Go", action: { kind: "open_url", url: "https://example.com/{{slug}}" } },
      { variables: { slug: "weekly" } },
    );
    expect(plan.kind).toBe("openUrl");
    if (plan.kind !== "openUrl") throw new Error("wrong kind");
    expect(plan.href).toBe("https://example.com/weekly");
  });

  it("returns an invalid plan for an unknown template", () => {
    const plan = planButtonClick(
      { id: "b1", label: "Insert", action: { kind: "insert_template", templateId: "ghost" } },
      { templates: [meetingSource] },
    );
    expect(plan.kind).toBe("invalid");
    if (plan.kind !== "invalid") throw new Error("wrong kind");
    expect(plan.issues.some((issue) => issue.code === "unknown_template")).toBe(true);
  });

  it("returns an invalid plan for an unsafe link", () => {
    const plan = planButtonClick(
      { id: "b4", label: "Ping", action: { kind: "open_url", url: "javascript:alert(1)" } },
      {},
    );
    expect(plan.kind).toBe("invalid");
  });

  it("re-checks a URL after variable interpolation", () => {
    const plan = planButtonClick(
      { id: "b5", label: "Ping", action: { kind: "open_url", url: "{{target}}" } },
      { variables: { target: "javascript:alert(1)" } },
    );
    expect(plan.kind).toBe("invalid");
    if (plan.kind !== "invalid") throw new Error("wrong kind");
    expect(plan.issues.some((issue) => issue.code === "unsafe_url")).toBe(true);
  });

  it("does not mutate the block it plans", () => {
    const block: ButtonBlock = {
      id: "b4",
      label: "Ping",
      action: { kind: "open_url", url: "https://example.com/hook" },
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

  it("describes each shared action kind", () => {
    expect(
      describeButton({ id: "b", label: "x", action: { kind: "open_url", url: "https://example.com/hook" } }),
    ).toBe('Open "https://example.com/hook"');
    expect(
      describeButton({ id: "b", label: "x", action: { kind: "set_property", propertyId: "status", value: 1 } }),
    ).toBe('Set property "status"');
    expect(
      describeButton({ id: "b", label: "x", action: { kind: "notify", message: "Ping" } }),
    ).toBe('Notify (info) "Ping"');
  });

  it("appends a confirm suffix when confirmation is required", () => {
    expect(
      describeButton({
        id: "b",
        label: "x",
        confirm: true,
        action: { kind: "open_url", url: "https://example.com" },
      }),
    ).toBe('Open "https://example.com" (confirm)');
  });
});

describe("notification executability", () => {
  it("explains why a notify action is disabled", () => {
    expect(BUTTON_NOTIFY_REASON).toContain("recipient");
  });
});
