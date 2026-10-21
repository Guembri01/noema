import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Two-factor manager — node tests.
 *
 * Two halves: the pure mappings (the setup step machine and code
 * completeness) and a `renderToStaticMarkup` pass over each step of the flow
 * plus the pieces it is built from. No DOM.
 *
 * The flow issues **no recovery codes**: the server checks a TOTP code and
 * nothing else, so the dialog says so instead of offering a list of codes it
 * could not accept.
 */

vi.mock("@/server/actions/two-factor", () => ({
  startTwoFactorAction: vi.fn(async () => ({
    secret: "JBSWY3DPEHPK3PXP",
    otpauth: "otpauth://totp/Noema:me?secret=JBSWY3DPEHPK3PXP",
  })),
  enableTwoFactorAction: vi.fn(async () => ({ ok: true })),
  disableTwoFactorAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  CopyButton,
  NoRecoveryCodesNotice,
  SecretBlock,
  StepIndicator,
  TWO_FACTOR_CODE_LENGTH,
  TWO_FACTOR_SETUP_LABELS,
  TWO_FACTOR_STEPS,
  TwoFactorSetup,
  isCodeComplete,
  nextSetupStep,
  sanitizeCode,
  setupStepIndex,
  stepVisualState,
  type TwoFactorSetupProps,
  type TwoFactorStep,
} from "./two-factor-manager";

const h = createElement;

const SECRET = "JBSWY3DPEHPK3PXP";
const OTPAUTH = "otpauth://totp/Noema:me?secret=JBSWY3DPEHPK3PXP";

const setupProps = (
  overrides: Partial<TwoFactorSetupProps> & { step: TwoFactorStep },
): TwoFactorSetupProps => ({
  code: "",
  onBegin: () => {},
  onCodeChange: () => {},
  onVerify: () => {},
  onBack: () => {},
  onCopy: () => {},
  ...overrides,
});

const render = (props: TwoFactorSetupProps) =>
  renderToStaticMarkup(h(TwoFactorSetup, props));

describe("setup step machine", () => {
  it("advances start → scan → verify → done", () => {
    expect(nextSetupStep("start", "begin")).toBe("scan");
    expect(nextSetupStep("scan", "submit")).toBe("verify");
    expect(nextSetupStep("verify", "succeed")).toBe("done");
  });

  it("sends a failed verify back to scan for a retry", () => {
    expect(nextSetupStep("verify", "fail")).toBe("scan");
  });

  it("walks back one step at a time", () => {
    expect(nextSetupStep("scan", "back")).toBe("start");
    expect(nextSetupStep("verify", "back")).toBe("scan");
    expect(nextSetupStep("start", "back")).toBe("start");
  });

  it("resets to start from any step", () => {
    for (const step of ["start", "scan", "verify", "done"] as const) {
      expect(nextSetupStep(step, "reset")).toBe("start");
    }
  });

  it("ignores events that do not apply to the current step", () => {
    expect(nextSetupStep("start", "submit")).toBe("start");
    expect(nextSetupStep("start", "succeed")).toBe("start");
    expect(nextSetupStep("scan", "begin")).toBe("scan");
    expect(nextSetupStep("done", "fail")).toBe("done");
  });
});

describe("step index + visual state", () => {
  it("maps every step to its marker index, treating done as complete", () => {
    expect(setupStepIndex("start")).toBe(0);
    expect(setupStepIndex("scan")).toBe(1);
    expect(setupStepIndex("verify")).toBe(2);
    expect(setupStepIndex("done")).toBe(TWO_FACTOR_STEPS.length);
  });

  it("marks earlier steps done, the active one current and the rest upcoming", () => {
    expect(stepVisualState(0, 1)).toBe("done");
    expect(stepVisualState(1, 1)).toBe("current");
    expect(stepVisualState(2, 1)).toBe("upcoming");
    // A complete flow marks all three as done.
    expect(stepVisualState(2, 3)).toBe("done");
  });
});

describe("code completeness", () => {
  it("strips non-digits and clamps to the code length", () => {
    expect(sanitizeCode("1 2-3a4b5c6")).toBe("123456");
    expect(sanitizeCode("12345678")).toBe("123456");
    expect(sanitizeCode("abc")).toBe("");
    expect(sanitizeCode("12345", 6)).toBe("12345");
  });

  it("is complete only for exactly six digits", () => {
    expect(isCodeComplete("123456")).toBe(true);
    expect(isCodeComplete("12345")).toBe(false);
    expect(isCodeComplete("1234567")).toBe(false);
    expect(isCodeComplete("12345a")).toBe(false);
    expect(isCodeComplete("")).toBe(false);
    expect(TWO_FACTOR_CODE_LENGTH).toBe(6);
  });
});

describe("StepIndicator", () => {
  const labels = { start: "Start", scan: "Scan", verify: "Verify" };

  it("renders one marker per step with the active one announced", () => {
    const html = renderToStaticMarkup(
      h(StepIndicator, { current: "scan", labels, ariaLabel: "Progress" }),
    );
    expect(html).toContain('data-testid="setup-steps"');
    expect(html).toContain('aria-label="Progress"');
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-state="current"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('data-state="upcoming"');
  });

  it("marks every step done once the flow is complete", () => {
    const html = renderToStaticMarkup(
      h(StepIndicator, { current: "done", labels }),
    );
    expect((html.match(/data-state="done"/g) ?? []).length).toBe(3);
    expect(html).not.toContain('data-state="current"');
  });
});

describe("CopyButton", () => {
  it("flips to a checkmark and swaps its accessible label once copied", () => {
    const idle = renderToStaticMarkup(
      h(CopyButton, {
        value: SECRET,
        copied: false,
        label: "Copy",
        copiedLabel: "Copied",
        onCopy: () => {},
      }),
    );
    expect(idle).toContain('aria-label="Copy"');
    expect(idle).not.toContain('data-copied="true"');

    const done = renderToStaticMarkup(
      h(CopyButton, {
        value: SECRET,
        copied: true,
        label: "Copy",
        copiedLabel: "Copied",
        onCopy: () => {},
      }),
    );
    expect(done).toContain('aria-label="Copied"');
    expect(done).toContain('data-copied="true"');
  });
});

describe("SecretBlock", () => {
  it("renders the secret, the otpauth URI and a copy affordance on tokens", () => {
    const html = renderToStaticMarkup(
      h(SecretBlock, {
        secret: SECRET,
        otpauth: OTPAUTH,
        copied: false,
        onCopy: () => {},
        copyLabel: "Copy",
        copiedLabel: "Copied",
        secretLabel: "Secret key",
        otpauthLabel: "otpauth URI",
      }),
    );
    expect(html).toContain('data-testid="two-factor-secret"');
    expect(html).toContain(SECRET);
    expect(html).toContain(OTPAUTH);
    expect(html).toContain("border-border");
    expect(html).toContain("bg-surface-2");
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("renderToStaticMarkup — each step of the flow", () => {
  it("start: shows the intro and the primary enable action", () => {
    const html = render(setupProps({ step: "start" }));
    expect(html).toContain('data-testid="two-factor-start"');
    expect(html).toContain('data-testid="setup-steps"');
    expect(html).toContain("Enable two-factor");
    expect(html).toContain(">1<");
  });

  it("scan: shows the secret block, the six-digit field and the actions", () => {
    const html = render(
      setupProps({ step: "scan", secret: SECRET, otpauth: OTPAUTH }),
    );
    expect(html).toContain('data-testid="two-factor-scan"');
    expect(html).toContain('data-testid="two-factor-secret"');
    expect(html).toContain(SECRET);
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(html).toMatch(/maxlength="6"/i);
    // Verify stays disabled while the code is incomplete.
    expect(html).toContain('disabled=""');
  });

  it("scan: surfaces a wrong-code error as an alert on the field", () => {
    const html = render(
      setupProps({
        step: "scan",
        secret: SECRET,
        otpauth: OTPAUTH,
        code: "000000",
        error: "That code is not valid.",
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("That code is not valid.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-danger");
  });

  it("verify: locks the field and announces the in-flight state", () => {
    const html = render(
      setupProps({
        step: "verify",
        secret: SECRET,
        otpauth: OTPAUTH,
        code: "123456",
        pending: true,
      }),
    );
    expect(html).toContain('data-testid="two-factor-scan"');
    expect(html).toContain('role="status"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-current="step"');
  });

  it("done: states that no recovery codes are issued", () => {
    const html = render(setupProps({ step: "done" }));
    expect(html).toContain('data-testid="two-factor-done"');
    expect(html).toContain("No recovery codes are issued");
    // The dialog must not offer a code list the server would refuse:
    // `verifyTotp` accepts digits only, so there is nothing to save.
    expect(html).not.toContain('data-testid="recovery-codes"');
    expect(html).not.toContain("Save these somewhere safe");
  });
});

describe("NoRecoveryCodesNotice", () => {
  it("names the operator reset instead of a list of codes", () => {
    const html = renderToStaticMarkup(
      h(NoRecoveryCodesNotice, {
        title: TWO_FACTOR_SETUP_LABELS.noRecoveryTitle,
        body: TWO_FACTOR_SETUP_LABELS.noRecoveryBody,
      }),
    );
    expect(html).toContain('data-testid="no-recovery-codes"');
    expect(html).toContain(TWO_FACTOR_SETUP_LABELS.noRecoveryTitle);
    expect(html).toContain("No recovery codes are issued");
    expect(html).toContain("until an operator resets the account");
    // Nothing to copy, nothing to download, no promise of a later use.
    expect(html).not.toContain('data-testid="recovery-codes"');
    expect(html).not.toContain("Download");
    expect(html).not.toContain("each can be used once");
  });
});
