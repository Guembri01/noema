import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DS11 — email settings adoption.
 *
 * Pure mappings (encryption ⇄ `secure`, delivery status → badge tone, invite
 * role options, form validation) are pinned here, then the real `EmailForm` is
 * rendered with `react-dom/server` in its default and invalid states so the
 * field wiring, error surface and tokens are proven without a DOM.
 */

vi.mock("@/server/actions/email", () => ({
  clearEmailConfigAction: vi.fn(),
  saveEmailConfigAction: vi.fn(),
  sendWorkspaceInviteAction: vi.fn(),
  testEmailAction: vi.fn(),
  revokeWorkspaceInviteAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import {
  EMAIL_MESSAGES,
  ENCRYPTION_OPTIONS,
  EmailForm,
  deliveryStatusTone,
  encryptionOptions,
  encryptionToSecure,
  hasEmailFormErrors,
  inviteRoleOptions,
  portForEncryption,
  secureToEncryption,
  validateEmailForm,
  type EmailFormValue,
} from "./email-settings";

describe("encryption ⇄ secure/port options", () => {
  it("exposes the three transport-security modes with their flags", () => {
    expect(ENCRYPTION_OPTIONS.map((option) => option.value)).toEqual([
      "implicit",
      "starttls",
      "none",
    ]);
    expect(encryptionToSecure("implicit")).toBe(true);
    expect(encryptionToSecure("starttls")).toBe(false);
    expect(encryptionToSecure("none")).toBe(false);
    expect(encryptionToSecure("bogus")).toBe(false);
  });

  it("pre-fills the conventional port per mode", () => {
    expect(portForEncryption("implicit")).toBe(465);
    expect(portForEncryption("starttls")).toBe(587);
    expect(portForEncryption("none")).toBe(25);
    expect(portForEncryption("bogus")).toBe(587);
  });

  it("derives the mode from a stored config", () => {
    expect(secureToEncryption(true, 465)).toBe("implicit");
    expect(secureToEncryption(false, 587)).toBe("starttls");
    expect(secureToEncryption(false, 25)).toBe("none");
    expect(secureToEncryption(false, "2525")).toBe("starttls");
  });

  it("builds locale Select options", () => {
    const options = encryptionOptions("en");
    expect(options).toHaveLength(3);
    expect(options[0].value).toBe("implicit");
    expect(options[0].label).toBe("Implicit TLS (port 465)");
  });
});

describe("delivery status → badge tone", () => {
  it("maps known statuses", () => {
    expect(deliveryStatusTone("sent")).toBe("success");
    expect(deliveryStatusTone("delivered")).toBe("success");
    expect(deliveryStatusTone("failed")).toBe("danger");
    expect(deliveryStatusTone("bounced")).toBe("danger");
    expect(deliveryStatusTone("queued")).toBe("warning");
    expect(deliveryStatusTone("sending")).toBe("warning");
    expect(deliveryStatusTone("something-else")).toBe("neutral");
  });
});

describe("invite role options", () => {
  it("lists the three roles in order", () => {
    expect(inviteRoleOptions("en").map((option) => option.value)).toEqual([
      "GUEST",
      "MEMBER",
      "ADMIN",
    ]);
  });
});

describe("form validation", () => {
  it("accepts a well-formed form", () => {
    const errors = validateEmailForm({
      host: "smtp.example.com",
      port: "587",
      fromEmail: "noema@example.com",
      replyTo: "",
    });
    expect(errors).toEqual({});
    expect(hasEmailFormErrors(errors)).toBe(false);
  });

  it("requires a host and a sender address", () => {
    const errors = validateEmailForm({
      host: "  ",
      port: "587",
      fromEmail: "",
      replyTo: "",
    });
    expect(errors.host).toBe(EMAIL_MESSAGES.hostRequired);
    expect(errors.fromEmail).toBe(EMAIL_MESSAGES.fromRequired);
    expect(hasEmailFormErrors(errors)).toBe(true);
  });

  it("rejects a bad port and a bad sender/reply-to address", () => {
    const errors = validateEmailForm({
      host: "smtp.example.com",
      port: "70000",
      fromEmail: "not-an-email",
      replyTo: "also bad",
    });
    expect(errors.port).toBe(EMAIL_MESSAGES.portRange);
    expect(errors.fromEmail).toBe(EMAIL_MESSAGES.fromInvalid);
    expect(errors.replyTo).toBe(EMAIL_MESSAGES.replyToInvalid);
  });

  it("rejects a non-numeric port", () => {
    const errors = validateEmailForm({
      host: "smtp.example.com",
      port: "abc",
      fromEmail: "noema@example.com",
      replyTo: "",
    });
    expect(errors.port).toBe(EMAIL_MESSAGES.portRange);
  });
});

describe("EmailForm (renderToStaticMarkup)", () => {
  const value: EmailFormValue = {
    host: "smtp.example.com",
    port: "587",
    encryption: "starttls",
    username: "mailer",
    password: "",
    fromName: "Noema",
    fromEmail: "noema@example.com",
    replyTo: "",
  };

  const noop = () => {};

  const render = (overrides: Partial<Parameters<typeof EmailForm>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(EmailForm, {
        locale: "en",
        value,
        hasPassword: false,
        testTo: "",
        onChange: noop,
        onSave: noop,
        onTest: noop,
        onTestToChange: noop,
        ...overrides,
      }),
    );

  it("renders the labelled SMTP fields, the encryption Select and the actions", () => {
    const html = render();
    expect(html).toContain('data-testid="email-form"');
    expect(html).toContain('data-slot="field"');
    expect(html).toContain("SMTP host");
    expect(html).toContain('value="smtp.example.com"');
    expect(html).toContain("Encryption");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("Save SMTP");
    expect(html).toContain("Verify &amp; send test");
    // Default state: nothing is marked invalid.
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("renders invalid fields with a danger message and aria-invalid", () => {
    const html = render({
      errors: {
        host: EMAIL_MESSAGES.hostRequired,
        fromEmail: EMAIL_MESSAGES.fromInvalid,
      },
      saveFeedback: { kind: "error", message: EMAIL_MESSAGES.fixFields },
    });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(EMAIL_MESSAGES.hostRequired);
    expect(html).toContain(EMAIL_MESSAGES.fromInvalid);
    expect(html).toContain(EMAIL_MESSAGES.fixFields);
    expect(html).toContain("text-danger");
  });

  it("shows the clear affordance only when the workspace owns the config", () => {
    expect(render()).not.toContain("Remove");
    expect(render({ showClear: true })).toContain("Remove");
  });
});
