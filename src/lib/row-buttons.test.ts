import { describe, expect, it } from "vitest";
import {
  BUTTON_ACTION_CATALOG,
  BUTTON_ACTION_KINDS,
  buttonActionSpec,
  buttonScope,
  interpolateButtonText,
  isSafeButtonUrl,
  isValidButton,
  resolveButtonAction,
  validateButton,
  type ButtonConfig,
} from "@/lib/row-buttons";

/*
 * Row buttons — the pure model behind the Button block (docs/MISSING_FEATURES.md
 * §1 "Button block") and the database Button property (§3 "Buttons in
 * databases"), spec R89.26. These tests pin the catalogue, the validator and
 * the side-effect-free action plan a renderer would execute.
 */

const openConfig: ButtonConfig = {
  id: "btn_1",
  label: "Open docs",
  icon: "🔗",
  action: { kind: "open_url", url: "https://example.com/docs" },
};

const setConfig: ButtonConfig = {
  id: "btn_2",
  label: "Mark done",
  action: { kind: "set_property", propertyId: "status", value: { optionId: "done" } },
};

const templateConfig: ButtonConfig = {
  id: "btn_3",
  label: "Insert",
  action: { kind: "insert_template", templateId: "tpl_9" },
};

const notifyConfig: ButtonConfig = {
  id: "btn_4",
  label: "Ping",
  action: { kind: "notify", message: "Pinged {{title}}" },
};

describe("button action catalogue", () => {
  it("lists the four supported kinds with required fields", () => {
    expect(BUTTON_ACTION_CATALOG).toHaveLength(4);
    expect(BUTTON_ACTION_KINDS).toEqual([
      "open_url",
      "set_property",
      "insert_template",
      "notify",
    ]);
    expect(buttonActionSpec("open_url")?.requiredFields).toContain("url");
    expect(buttonActionSpec("set_property")?.requiredFields).toContain("propertyId");
    expect(buttonActionSpec("insert_template")?.requiredFields).toContain("templateId");
    expect(buttonActionSpec("notify")?.requiredFields).toContain("message");
    expect(buttonActionSpec("does_not_exist")).toBeUndefined();
  });

  it("keeps every required field within the declared field list", () => {
    for (const spec of BUTTON_ACTION_CATALOG) {
      const names = spec.fields.map((field) => field.name);
      for (const required of spec.requiredFields) expect(names).toContain(required);
    }
  });
});

describe("isSafeButtonUrl", () => {
  it("accepts http, https, mailto and same-app paths", () => {
    expect(isSafeButtonUrl("https://example.com/x")).toBe(true);
    expect(isSafeButtonUrl("http://example.com")).toBe(true);
    expect(isSafeButtonUrl("mailto:a@b.co")).toBe(true);
    expect(isSafeButtonUrl("/w/demo/page")).toBe(true);
  });

  it("rejects script schemes and their encoding tricks", () => {
    expect(isSafeButtonUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeButtonUrl(" javascript:alert(1)")).toBe(false);
    expect(isSafeButtonUrl("data:text/html,<script>x</script>")).toBe(false);
    expect(isSafeButtonUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects empty and non-string input", () => {
    expect(isSafeButtonUrl("")).toBe(false);
    expect(isSafeButtonUrl("   ")).toBe(false);
    expect(isSafeButtonUrl(42 as unknown)).toBe(false);
  });
});

describe("validateButton", () => {
  it("passes a well-formed config of every kind", () => {
    expect(validateButton(openConfig)).toEqual([]);
    expect(validateButton(setConfig)).toEqual([]);
    expect(validateButton(templateConfig)).toEqual([]);
    expect(validateButton(notifyConfig)).toEqual([]);
    expect(isValidButton(openConfig)).toBe(true);
  });

  it("flags a non-object config", () => {
    const issues = validateButton(null);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("not_an_object");
  });

  it("flags an unknown action kind", () => {
    const issues = validateButton({ ...openConfig, action: { kind: "delete_row" } });
    expect(issues.map((issue) => issue.code)).toContain("unknown_kind");
    expect(issues[0].path).toBe("action.kind");
  });

  it("flags a missing required field per kind", () => {
    const open = validateButton({ ...openConfig, action: { kind: "open_url" } });
    expect(open.some((i) => i.code === "missing_field" && i.path === "action.url")).toBe(true);

    const set = validateButton({ ...setConfig, action: { kind: "set_property", value: 1 } });
    expect(set.some((i) => i.path === "action.propertyId")).toBe(true);

    const template = validateButton({ ...templateConfig, action: { kind: "insert_template" } });
    expect(template.some((i) => i.path === "action.templateId")).toBe(true);

    const notify = validateButton({ ...notifyConfig, action: { kind: "notify" } });
    expect(notify.some((i) => i.path === "action.message")).toBe(true);
  });

  it("flags an unsafe scheme on an otherwise complete open_url action", () => {
    const issues = validateButton({
      ...openConfig,
      action: { kind: "open_url", url: "javascript:alert(1)" },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("unsafe_url");
    expect(issues[0].path).toBe("action.url");
  });

  it("flags a missing label and a wrongly typed icon", () => {
    expect(validateButton({ ...openConfig, label: "  " }).map((i) => i.path)).toContain("label");
    expect(validateButton({ ...openConfig, icon: 7 }).map((i) => i.path)).toContain("icon");
  });

  it("flags an unknown notify level", () => {
    const issues = validateButton({
      ...notifyConfig,
      action: { kind: "notify", message: "hi", level: "loud" },
    });
    expect(issues.some((i) => i.code === "wrong_type" && i.path === "action.level")).toBe(true);
    expect(isValidButton(notifyConfig)).toBe(true);
  });
});

describe("buttonScope + interpolateButtonText", () => {
  const row = { id: "row_1", title: "Hello", values: { status: "Done", estimate: 3 } };

  it("exposes row id, title and primitive values as strings", () => {
    expect(buttonScope(row)).toEqual({
      id: "row_1",
      title: "Hello",
      status: "Done",
      estimate: "3",
    });
    expect(interpolateButtonText("{{title}} → {{estimate}}", buttonScope(row))).toBe(
      "Hello → 3",
    );
  });

  it("merges context variables over row scope and keeps unknown tokens", () => {
    const scope = buttonScope(row, { variables: { title: "Override" } });
    expect(scope.title).toBe("Override");
    expect(interpolateButtonText("{{missing}} stays", scope)).toBe("{{missing}} stays");
  });
});

describe("resolveButtonAction", () => {
  const row = { id: "row_1", title: "Hello", values: { status: "Todo" } };

  it("resolves an open_url plan with an interpolated href", () => {
    const plan = resolveButtonAction(
      { ...openConfig, action: { kind: "open_url", url: "https://example.com/{{title}}" } },
      row,
    );
    expect(plan.kind).toBe("open_url");
    expect(plan.enabled).toBe(true);
    expect(plan.label).toBe("Open docs");
    if (plan.kind === "open_url") {
      expect(plan.href).toBe("https://example.com/Hello");
      expect(plan.openInNewTab).toBe(true);
    }
  });

  it("honours an explicit openInNewTab: false", () => {
    const plan = resolveButtonAction(
      { ...openConfig, action: { kind: "open_url", url: "/x", openInNewTab: false } },
      row,
    );
    if (plan.kind === "open_url") expect(plan.openInNewTab).toBe(false);
  });

  it("resolves a set_property plan against the row", () => {
    const plan = resolveButtonAction(setConfig, row);
    expect(plan.kind).toBe("set_property");
    if (plan.kind === "set_property") {
      expect(plan.rowId).toBe("row_1");
      expect(plan.propertyId).toBe("status");
      expect(plan.value).toEqual({ optionId: "done" });
    }
  });

  it("resolves an insert_template plan against the row", () => {
    const plan = resolveButtonAction(templateConfig, row);
    expect(plan.kind).toBe("insert_template");
    if (plan.kind === "insert_template") {
      expect(plan.templateId).toBe("tpl_9");
      expect(plan.rowId).toBe("row_1");
    }
  });

  it("resolves a notify plan, defaulting the level to info", () => {
    const plan = resolveButtonAction(notifyConfig, row);
    expect(plan.kind).toBe("notify");
    if (plan.kind === "notify") {
      expect(plan.message).toBe("Pinged Hello");
      expect(plan.level).toBe("info");
    }

    const custom = resolveButtonAction(
      { ...notifyConfig, action: { kind: "notify", message: "Done", level: "success" } },
      row,
    );
    if (custom.kind === "notify") expect(custom.level).toBe("success");
  });

  it("returns a disabled invalid plan carrying every issue, never throwing", () => {
    const plan = resolveButtonAction({ id: "btn_x", label: "Broken", action: { kind: "nope" } }, row);
    expect(plan.kind).toBe("invalid");
    expect(plan.enabled).toBe(false);
    if (plan.kind === "invalid") {
      expect(plan.issues.length).toBeGreaterThan(0);
      expect(plan.disabledReason).toBe(plan.issues[0].message);
    }
  });

  it("never emits writes for an unsafe url", () => {
    const plan = resolveButtonAction(
      { ...openConfig, action: { kind: "open_url", url: "data:text/html,x" } },
      row,
    );
    expect(plan.enabled).toBe(false);
    expect(plan.kind).toBe("invalid");
  });
});
