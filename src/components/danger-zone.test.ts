import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Danger zone — node tests.
 *
 * The pure confirm-phrase match plus `renderToStaticMarkup` of the danger
 * section and the gated action dialog (idle, wrong phrase, matched phrase and
 * the pending double-submit guard). No DOM.
 */

vi.mock("@/server/actions/workspaces", () => ({
  deleteWorkspaceAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  DangerAction,
  DangerZone,
  confirmPhraseMatches,
  type DangerActionProps,
} from "./danger-zone";

const h = createElement;

const actionProps = (
  overrides: Partial<DangerActionProps> = {},
): DangerActionProps => ({
  title: "Delete this workspace.",
  description: "This cannot be undone.",
  triggerLabel: "Delete this workspace.",
  confirmLabel: "Delete workspace",
  cancelLabel: "Cancel",
  typedLabel: "Type the workspace name to confirm",
  phrase: "Acme",
  open: true,
  onOpenChange: () => {},
  typed: "",
  onTypedChange: () => {},
  onConfirm: () => {},
  ...overrides,
});

describe("confirmPhraseMatches", () => {
  it("requires the exact name (case-sensitive), trimming only the typed input", () => {
    expect(confirmPhraseMatches("Acme", "Acme")).toBe(true);
    expect(confirmPhraseMatches("  Acme  ", "Acme")).toBe(true);
    expect(confirmPhraseMatches("acme", "Acme")).toBe(false);
    expect(confirmPhraseMatches("", "Acme")).toBe(false);
    expect(confirmPhraseMatches("Acme Inc", "Acme")).toBe(false);
  });
});

describe("DangerAction dialog", () => {
  it("renders a danger confirm dialog gated by the typed phrase", () => {
    const html = renderToStaticMarkup(h(DangerAction, actionProps()));
    expect(html).toContain('data-testid="confirm-dialog"');
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('data-testid="confirm-phrase-input"');
    expect(html).toContain("Acme");
    // Phrase not matched yet → confirm stays disabled.
    expect(html).toContain('disabled=""');
  });

  it("keeps confirm disabled for a wrong phrase", () => {
    const html = renderToStaticMarkup(
      h(DangerAction, actionProps({ typed: "acme" })),
    );
    expect(html).toContain('disabled=""');
  });

  it("enables confirm once the exact phrase is typed", () => {
    const html = renderToStaticMarkup(
      h(DangerAction, actionProps({ typed: "Acme" })),
    );
    expect(html).not.toContain('disabled=""');
  });

  it("cannot be double-submitted while pending", () => {
    const html = renderToStaticMarkup(
      h(DangerAction, actionProps({ typed: "Acme", pending: true })),
    );
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("animate-spin");
  });

  it("renders nothing while the dialog is closed", () => {
    const html = renderToStaticMarkup(
      h(DangerAction, actionProps({ open: false })),
    );
    expect(html).not.toContain('data-testid="confirm-dialog"');
    // The trigger and the neutral row are still there.
    expect(html).toContain('data-testid="danger-action"');
    expect(html).toContain("Delete this workspace.");
  });
});

describe("DangerZone", () => {
  it("renders a danger-toned Section on a neutral surface", () => {
    const html = renderToStaticMarkup(
      h(DangerZone, {
        workspaceId: "ws_1",
        workspaceName: "Acme",
        canDelete: true,
        locale: "en",
      }),
    );
    expect(html).toContain("<section");
    // Heading carries the danger ink; the surface does not.
    expect(html).toContain("text-danger");
    expect(html).toContain('data-testid="danger-action"');
    expect(html).toContain("border-border");
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("renders nothing when the viewer may not delete", () => {
    const html = renderToStaticMarkup(
      h(DangerZone, {
        workspaceId: "ws_1",
        workspaceName: "Acme",
        canDelete: false,
        locale: "en",
      }),
    );
    expect(html).toBe("");
  });
});
