import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * B15 (round 2) — the settings screen's invitation picker must not offer a
 * role the server would refuse.
 *
 * The members screen already filtered its invite picker by the roles the actor
 * may grant (`caps.assignable`); the *settings → Email & invitations* picker
 * did not, so an admin was still offered "Admin" there — and the server
 * answered every such attempt with "Only the workspace owner can invite an
 * admin." The picker now asks the same engine the members screen and the
 * server ask, so an admin sees member and guest only, while the owner still
 * sees all three.
 *
 * The component is a client component, so the Next router, the toast layer and
 * the Server Actions it calls are mocked; the render runs through
 * `react-dom/server` (the node test environment has no DOM).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/actions/email", () => ({
  clearEmailConfigAction: vi.fn(),
  revokeWorkspaceInviteAction: vi.fn(),
  saveEmailConfigAction: vi.fn(),
  sendWorkspaceInviteAction: vi.fn(),
  testEmailAction: vi.fn(),
}));

import { EmailSettings } from "./email-settings";

const h = createElement;

const SUMMARY = {
  configured: false,
  source: "none" as const,
  host: "",
  port: 587,
  secure: false,
  username: null,
  fromName: "Noema",
  fromEmail: "",
  replyTo: null,
  hasPassword: false,
};

const render = (currentUserRole: string) =>
  renderToStaticMarkup(
    h(EmailSettings, {
      workspaceId: "w1",
      summary: SUMMARY,
      invites: [],
      deliveries: [],
      locale: "en",
      currentUserRole,
    }),
  );

describe("the settings invitation picker", () => {
  it("offers an admin only the roles an admin may grant", () => {
    const html = render("ADMIN");

    expect(html).toContain('value="GUEST"');
    expect(html).toContain('value="MEMBER"');
    expect(html).not.toContain('value="ADMIN"');
  });

  it("still offers the owner every role", () => {
    const html = render("OWNER");

    expect(html).toContain('value="GUEST"');
    expect(html).toContain('value="MEMBER"');
    expect(html).toContain('value="ADMIN"');
  });

  it("fails closed for an unknown role — no role is offered at all", () => {
    const html = render("SUPERUSER");

    expect(html).not.toContain('value="ADMIN"');
    expect(html).not.toContain('value="MEMBER"');
    expect(html).not.toContain('value="GUEST"');
  });
});
