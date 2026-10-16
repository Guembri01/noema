import { describe, expect, it } from "vitest";
import {
  BUTTON_PROPERTY_ACTION_TYPES,
  BUTTON_ROLES,
  DESTRUCTIVE_ACTION_TYPES,
  canRun,
  describeButtonConfig,
  dryRun,
  isAllowedActionUrl,
  isValidButtonConfig,
  parseButtonConfig,
  planRowButton,
  validateButtonConfig,
  type ButtonConfigContext,
  type ButtonPropertyConfig,
} from "@/lib/button-property";

/*
 * Database Button property engine (§4 Button property — "Trigger actions from
 * a row"). These tests pin parsing, catalogue-wide validation (including the
 * http/https URL allowlist and ref lookups), the ordered pure action plan, the
 * destructive-action permission gate, the description and the dry-run diff.
 */

const propertyId = "status";
const templateId = "tpl_9";

const context: ButtonConfigContext = {
  properties: [{ id: propertyId, name: "Status" }],
  templates: [{ id: templateId, name: "Standup" }],
  members: [{ id: "u1", name: "Ada" }],
};

const notify = { type: "notify" as const, message: "Pinged {{title}}" };

const fullConfig: ButtonPropertyConfig = {
  showLabelInCell: true,
  confirmRequired: true,
  actions: [
    { type: "open_url", url: "https://example.com/{{title}}" },
    { type: "set_property", propertyId, value: "Done" },
    { type: "insert_template", templateId },
    { type: "notify", message: "Pinged {{title}}", level: "success", memberIds: ["u1"] },
    { type: "duplicate_row" },
    { type: "webhook", url: "https://hooks.example.com/x", method: "POST", body: { row: "{{id}}" } },
  ],
};

describe("button property catalogue", () => {
  it("extends the row-button action ids with the three database-only kinds", () => {
    expect(BUTTON_PROPERTY_ACTION_TYPES).toEqual([
      "open_url",
      "set_property",
      "insert_template",
      "notify",
      "duplicate_row",
      "delete_row",
      "webhook",
    ]);
  });

  it("exposes a role ladder from viewer to owner", () => {
    expect(BUTTON_ROLES).toEqual(["viewer", "commenter", "editor", "owner"]);
  });

  it("marks only delete_row as destructive", () => {
    expect(DESTRUCTIVE_ACTION_TYPES).toEqual(["delete_row"]);
  });
});

describe("isAllowedActionUrl", () => {
  it("accepts http and https links", () => {
    expect(isAllowedActionUrl("https://example.com/x")).toBe(true);
    expect(isAllowedActionUrl("http://example.com")).toBe(true);
    expect(isAllowedActionUrl("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("rejects non-http schemes and relative paths", () => {
    expect(isAllowedActionUrl("mailto:a@b.co")).toBe(false);
    expect(isAllowedActionUrl("tel:+15551234")).toBe(false);
    expect(isAllowedActionUrl("/w/demo/page")).toBe(false);
  });

  it("rejects script schemes and encoding tricks", () => {
    expect(isAllowedActionUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedActionUrl(" javascript:alert(1)")).toBe(false);
    expect(isAllowedActionUrl("data:text/html,<script>x</script>")).toBe(false);
    expect(isAllowedActionUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects empty and non-string input", () => {
    expect(isAllowedActionUrl("")).toBe(false);
    expect(isAllowedActionUrl("   ")).toBe(false);
    expect(isAllowedActionUrl(42 as unknown)).toBe(false);
  });
});

describe("validateButtonConfig", () => {
  it("passes a well-formed config of every kind", () => {
    expect(validateButtonConfig(fullConfig, context)).toEqual([]);
    expect(isValidButtonConfig(fullConfig, context)).toBe(true);
  });

  it("flags a non-object config", () => {
    const issues = validateButtonConfig(null);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("not_an_object");
  });

  it("flags a missing and an empty action list", () => {
    expect(validateButtonConfig({}, context).map((i) => i.code)).toContain("missing_field");
    const empty = validateButtonConfig({ actions: [] }, context);
    expect(empty.map((i) => i.code)).toContain("no_actions");
    expect(empty[0].path).toBe("actions");
  });

  it("flags an unknown action type", () => {
    const issues = validateButtonConfig({ actions: [{ type: "explode" }] }, context);
    expect(issues.map((i) => i.code)).toContain("unknown_action");
    expect(issues[0].path).toBe("actions.0.type");
  });

  it("flags a missing url and an unsafe url on open_url", () => {
    const missing = validateButtonConfig({ actions: [{ type: "open_url" }] }, context);
    expect(missing.some((i) => i.code === "missing_field" && i.path === "actions.0.url")).toBe(true);

    const unsafe = validateButtonConfig(
      { actions: [{ type: "open_url", url: "javascript:alert(1)" }] },
      context,
    );
    expect(unsafe.some((i) => i.code === "unsafe_url" && i.path === "actions.0.url")).toBe(true);
  });

  it("rejects a non-http scheme on open_url (http/https allowlist)", () => {
    const issues = validateButtonConfig(
      { actions: [{ type: "open_url", url: "mailto:a@b.co" }] },
      context,
    );
    expect(issues.some((i) => i.code === "unsafe_url")).toBe(true);
  });

  it("flags missing args on set_property and insert_template", () => {
    const set = validateButtonConfig({ actions: [{ type: "set_property" }] }, context);
    expect(set.some((i) => i.code === "missing_field" && i.path === "actions.0.propertyId")).toBe(true);
    expect(set.some((i) => i.code === "missing_field" && i.path === "actions.0.value")).toBe(true);

    const tpl = validateButtonConfig({ actions: [{ type: "insert_template" }] }, context);
    expect(tpl.some((i) => i.path === "actions.0.templateId")).toBe(true);
  });

  it("flags an unknown property and an unknown template", () => {
    const prop = validateButtonConfig(
      { actions: [{ type: "set_property", propertyId: "ghost", value: 1 }] },
      context,
    );
    expect(prop.some((i) => i.code === "unknown_property" && i.path === "actions.0.propertyId")).toBe(
      true,
    );

    const tpl = validateButtonConfig(
      { actions: [{ type: "insert_template", templateId: "ghost" }] },
      context,
    );
    expect(tpl.some((i) => i.code === "unknown_template")).toBe(true);
  });

  it("skips ref lookups when the catalog is not supplied", () => {
    expect(
      validateButtonConfig({
        actions: [
          { type: "set_property", propertyId: "anything", value: 1 },
          { type: "insert_template", templateId: "anything" },
        ],
      }),
    ).toEqual([]);
  });

  it("flags a missing message and an unknown notify level", () => {
    const missing = validateButtonConfig({ actions: [{ type: "notify" }] }, context);
    expect(missing.some((i) => i.path === "actions.0.message")).toBe(true);

    const level = validateButtonConfig(
      { actions: [{ type: "notify", message: "hi", level: "loud" }] },
      context,
    );
    expect(level.some((i) => i.code === "wrong_type" && i.path === "actions.0.level")).toBe(true);
  });

  it("flags an unknown member and a non-array memberIds", () => {
    const unknown = validateButtonConfig(
      { actions: [{ type: "notify", message: "hi", memberIds: ["ghost"] }] },
      context,
    );
    expect(unknown.some((i) => i.code === "unknown_member" && i.path === "actions.0.memberIds")).toBe(
      true,
    );

    const wrongType = validateButtonConfig(
      { actions: [{ type: "notify", message: "hi", memberIds: "u1" }] },
      context,
    );
    expect(wrongType.some((i) => i.code === "wrong_type")).toBe(true);
  });

  it("flags webhook url and method problems", () => {
    const missing = validateButtonConfig({ actions: [{ type: "webhook" }] }, context);
    expect(missing.some((i) => i.code === "missing_field" && i.path === "actions.0.url")).toBe(true);

    const unsafe = validateButtonConfig(
      { actions: [{ type: "webhook", url: "file:///etc/passwd" }] },
      context,
    );
    expect(unsafe.some((i) => i.code === "unsafe_url")).toBe(true);

    const method = validateButtonConfig(
      { actions: [{ type: "webhook", url: "https://x.co", method: "FETCH" }] },
      context,
    );
    expect(method.some((i) => i.code === "wrong_type" && i.path === "actions.0.method")).toBe(true);
  });

  it("accepts argument-free duplicate_row and delete_row", () => {
    expect(
      validateButtonConfig({ actions: [{ type: "duplicate_row" }, { type: "delete_row" }] }, context),
    ).toEqual([]);
  });

  it("flags wrongly typed config flags", () => {
    const issues = validateButtonConfig(
      { showLabelInCell: "yes", confirmRequired: 1, actions: [notify] },
      context,
    );
    expect(issues.some((i) => i.code === "wrong_type" && i.path === "showLabelInCell")).toBe(true);
    expect(issues.some((i) => i.code === "wrong_type" && i.path === "confirmRequired")).toBe(true);
  });

  it("never throws on a malformed nested action", () => {
    expect(() => validateButtonConfig({ actions: [null, 7, "x"] }, context)).not.toThrow();
    const issues = validateButtonConfig({ actions: [null] }, context);
    expect(issues.some((i) => i.code === "unknown_action")).toBe(true);
  });
});

describe("parseButtonConfig", () => {
  it("normalizes a valid config with stable defaults", () => {
    const parsed = parseButtonConfig({ actions: [notify] }, context);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.showLabelInCell).toBe(true);
      expect(parsed.config.confirmRequired).toBe(false);
      expect(parsed.issues).toEqual([]);
    }
  });

  it("preserves explicit false flags", () => {
    const parsed = parseButtonConfig(
      { actions: [notify], showLabelInCell: false, confirmRequired: true },
      context,
    );
    if (parsed.ok) {
      expect(parsed.config.showLabelInCell).toBe(false);
      expect(parsed.config.confirmRequired).toBe(true);
    }
  });

  it("returns the blocking issues and a null config on failure", () => {
    const parsed = parseButtonConfig({ actions: [{ type: "nope" }] }, context);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.config).toBeNull();
      expect(parsed.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("canRun", () => {
  it("blocks a viewer from a destructive action but allows editors and owners", () => {
    const config = { actions: [{ type: "delete_row" }] };
    expect(canRun(config, { role: "viewer" })).toBe(false);
    expect(canRun(config, { role: "commenter" })).toBe(false);
    expect(canRun(config, { role: "editor" })).toBe(true);
    expect(canRun(config, { role: "owner" })).toBe(true);
  });

  it("allows every role to run a non-destructive action", () => {
    expect(canRun({ actions: [notify] }, { role: "viewer" })).toBe(true);
    expect(canRun({ actions: [{ type: "duplicate_row" }] }, { role: "viewer" })).toBe(true);
  });

  it("refuses an invalid config and an unknown role", () => {
    expect(canRun({ actions: [] }, { role: "owner" })).toBe(false);
    expect(
      canRun({ actions: [{ type: "delete_row" }] }, { role: "superuser" as unknown as "owner" }),
    ).toBe(false);
  });
});

describe("planRowButton", () => {
  const row = { id: "row_1", title: "Hello", values: { status: "Todo" } };

  it("plans every action in authored order", () => {
    const plan = planRowButton(fullConfig, { row, now: "2026-01-01T00:00:00.000Z" });
    expect(plan.map((step) => step.kind)).toEqual([
      "open_url",
      "set_property",
      "insert_template",
      "notify",
      "duplicate_row",
      "webhook",
    ]);
  });

  it("interpolates row values and the supplied now", () => {
    const plan = planRowButton(
      {
        actions: [
          { type: "open_url", url: "https://example.com/{{title}}" },
          { type: "notify", message: "{{now}} on {{id}}" },
        ],
      },
      { row, now: "2026-01-01T00:00:00.000Z" },
    );
    const open = plan[0];
    if (open.kind === "open_url") expect(open.payload.url).toBe("https://example.com/Hello");
    const note = plan[1];
    if (note.kind === "notify") expect(note.payload.message).toBe("2026-01-01T00:00:00.000Z on row_1");
  });

  it("defaults openInNewTab, notify level and webhook method", () => {
    const plan = planRowButton(
      {
        actions: [
          { type: "open_url", url: "https://example.com" },
          { type: "notify", message: "hi" },
          { type: "webhook", url: "https://hooks.example.com" },
        ],
      },
      { row },
    );
    const [open, note, hook] = plan;
    if (open.kind === "open_url") expect(open.payload.openInNewTab).toBe(true);
    if (note.kind === "notify") expect(note.payload.level).toBe("info");
    if (hook.kind === "webhook") expect(hook.payload.method).toBe("POST");
  });

  it("carries the row id on row-scoped steps", () => {
    const plan = planRowButton(
      { actions: [{ type: "set_property", propertyId, value: "Done" }, { type: "delete_row" }] },
      { row },
    );
    const set = plan[0];
    if (set.kind === "set_property") expect(set.payload.rowId).toBe("row_1");
    const del = plan[1];
    if (del.kind === "delete_row") expect(del.payload.rowId).toBe("row_1");
  });

  it("returns an empty plan for an invalid config", () => {
    expect(planRowButton({ actions: [] }, { row })).toEqual([]);
    expect(planRowButton(null, { row })).toEqual([]);
  });
});

describe("dryRun", () => {
  const row = { id: "row_1", title: "Hello", values: { status: "Todo" } };

  it("reports the before/after of a set_property action", () => {
    const result = dryRun(
      { actions: [{ type: "set_property", propertyId, value: "{{title}}" }] },
      { row },
    );
    expect(result.ok).toBe(true);
    expect(result.changes).toEqual([{ propertyId, before: "Todo", after: "Hello" }]);
  });

  it("reports no changes for non-writing actions but keeps the steps", () => {
    const result = dryRun({ actions: [notify, { type: "delete_row" }] }, { row });
    expect(result.changes).toEqual([]);
    expect(result.steps.map((step) => step.kind)).toEqual(["notify", "delete_row"]);
    expect(result.destructive).toBe(true);
  });

  it("fails closed with issues and no steps on an invalid config", () => {
    const result = dryRun({ actions: [{ type: "set_property", propertyId }] }, { row });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("describeButtonConfig", () => {
  it("renders an ordered human summary with the property name", () => {
    const text = describeButtonConfig(fullConfig, { propertyName: "Status" });
    expect(text).toContain('Button on "Status"');
    expect(text).toContain("open https://example.com/{{title}}");
    expect(text).toContain('set "status"');
    expect(text).toContain("then");
  });

  it("renders a stable invalid string for a broken config", () => {
    expect(describeButtonConfig({ actions: [] })).toBe("Invalid button.");
  });
});
