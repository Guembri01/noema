import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONFIRM_ICON_CLASS,
  CONFIRM_TONE_CLASS,
  ConfirmDialog,
  canConfirm,
  confirmBlocked,
  confirmToneClass,
  nextPressAction,
  reduceTwoStep,
  type ConfirmDialogProps,
  type TwoStepState,
} from "./confirm-dialog";

/**
 * Node tests for ConfirmDialog's pure bits — the two-step arm→confirm machine,
 * the pending/type-to-confirm submit gate and the tone map — plus a
 * `renderToStaticMarkup` pass over every variant (default, danger, pending,
 * type-to-confirm, two-step idle/armed).
 */

const render = (props: Partial<ConfirmDialogProps> & { open: boolean }) =>
  renderToStaticMarkup(
    createElement(ConfirmDialog, {
      onOpenChange: () => {},
      title: "Delete page",
      onConfirm: () => {},
      ...props,
    }),
  );

describe("two-step arm → confirm machine", () => {
  it("arms on the first press and confirms on the second", () => {
    expect(nextPressAction("idle")).toBe("arm");
    expect(nextPressAction("armed")).toBe("confirm");
  });

  it("transitions exactly as documented", () => {
    expect(reduceTwoStep("idle", "press")).toBe("armed");
    expect(reduceTwoStep("armed", "press")).toBe("idle");
    expect(reduceTwoStep("armed", "cancel")).toBe("idle");
    expect(reduceTwoStep("armed", "reset")).toBe("idle");
    expect(reduceTwoStep("idle", "cancel")).toBe("idle");
  });

  it("never leaves `armed` on a non-press event", () => {
    const states: TwoStepState[] = ["idle", "armed"];
    for (const state of states) {
      expect(reduceTwoStep(reduceTwoStep(state, "cancel"), "reset")).toBe("idle");
    }
  });
});

describe("submit gate", () => {
  it("blocks while pending (no double submit)", () => {
    expect(confirmBlocked({ pending: true })).toBe(true);
    expect(canConfirm({ pending: true })).toBe(false);
  });

  it("requires arming in two-step mode", () => {
    expect(confirmBlocked({ armed: false })).toBe(true);
    expect(canConfirm({ armed: true })).toBe(true);
    // `armed` absent (modal mode) is not a block.
    expect(canConfirm({})).toBe(true);
  });

  it("enforces the type-to-confirm phrase", () => {
    expect(confirmBlocked({ phrase: "DELETE", typed: "delete" })).toBe(true);
    expect(confirmBlocked({ phrase: "DELETE", typed: "" })).toBe(true);
    expect(canConfirm({ phrase: "DELETE", typed: "DELETE" })).toBe(true);
    // Empty phrase means "no phrase required".
    expect(canConfirm({ phrase: "", typed: "" })).toBe(true);
  });

  it("stacks every guard", () => {
    expect(canConfirm({ pending: true, armed: true, phrase: "x", typed: "x" })).toBe(
      false,
    );
    expect(canConfirm({ armed: true, phrase: "x", typed: "x" })).toBe(true);
  });
});

describe("tone map", () => {
  it("sources the danger variant from the danger tokens", () => {
    expect(confirmToneClass("danger")).toBe(CONFIRM_TONE_CLASS.danger);
    expect(CONFIRM_TONE_CLASS.danger).toContain("bg-danger");
    expect(CONFIRM_TONE_CLASS.danger).toContain("text-danger-fg");
    expect(CONFIRM_ICON_CLASS.danger).toContain("bg-danger-soft");
    expect(CONFIRM_ICON_CLASS.default).toContain("bg-action-soft");
  });
});

describe("renderToStaticMarkup", () => {
  it("renders nothing while closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("renders a default confirm modal with token chrome and layering", () => {
    const html = render({
      open: true,
      title: "Duplicate page",
      description: "A copy will be created.",
      confirmLabel: "Duplicate",
      cancelLabel: "Keep as is",
    });
    expect(html).toContain('data-testid="confirm-dialog"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("surface-raised-strong");
    expect(html).toContain("z-index:60");
    // Scrim: Z.overlay (40) painted with --overlay.
    expect(html).toContain('data-testid="confirm-scrim"');
    expect(html).toContain("z-index:40");
    // Scrim carries `--overlay` through the `bg-overlay` token utility.
    expect(html).toContain("bg-overlay");
    expect(html).toContain("Duplicate");
    expect(html).toContain("Keep as is");
  });

  it("renders the danger variant", () => {
    const html = render({ open: true, tone: "danger", title: "Delete forever" });
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain("bg-danger");
    expect(html).toContain("bg-danger-soft");
  });

  it("disables the confirm button and shows a spinner while pending", () => {
    const html = render({ open: true, pending: true });
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("animate-spin");
  });

  it("gates a destructive bulk action behind the typed phrase", () => {
    const html = render({
      open: true,
      tone: "danger",
      confirmPhrase: "DELETE 12 PAGES",
      typed: "DELETE",
    });
    expect(html).toContain('data-testid="confirm-phrase-input"');
    expect(html).toContain("DELETE 12 PAGES");
    // Phrase not matched yet → confirm stays disabled.
    expect(html).toContain('disabled=""');
  });

  it("enables confirm once the typed phrase matches", () => {
    const html = render({
      open: true,
      tone: "danger",
      confirmPhrase: "DELETE",
      typed: "DELETE",
      pending: false,
    });
    expect(html).not.toContain('disabled=""');
  });

  it("renders the non-blocking two-step control (idle)", () => {
    const html = render({
      open: true,
      mode: "two-step",
      title: "Archive 3 items",
      armLabel: "Archive",
      confirmLabel: "Confirm archive",
      cancelLabel: "Never mind",
    });
    expect(html).toContain('data-testid="confirm-twostep"');
    expect(html).toContain('data-armed="false"');
    expect(html).toContain("Archive");
    expect(html).not.toContain('data-testid="confirm-twostep-cancel"');
    // Non-blocking: no scrim, no modal surface.
    expect(html).not.toContain('data-testid="confirm-scrim"');
  });

  it("shows the cancel escape once the two-step control is armed", () => {
    const html = render({
      open: true,
      mode: "two-step",
      armed: true,
      confirmLabel: "Confirm archive",
      cancelLabel: "Never mind",
      tone: "danger",
    });
    expect(html).toContain('data-armed="true"');
    expect(html).toContain('data-testid="confirm-twostep-cancel"');
    expect(html).toContain("Never mind");
    expect(html).toContain("bg-danger");
  });
});
