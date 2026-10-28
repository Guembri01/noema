import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ds08 — auth-form polish.
 *
 * Two proofs live here:
 *  1. the *pure* mappings the form leans on — strength tone (score → status
 *     token), the issue → copy table and the per-field inline validators; and
 *  2. `renderToStaticMarkup` of the form in its default / invalid / loading
 *     states (plus the strength meter and the password-visibility toggle), so
 *     the token-backed primitives actually reach the markup.
 *
 * The component is a client shell over a Server Action and `next/link`; both
 * are stubbed here (there is no Next/Radix runtime in node).
 */

vi.mock("@/server/actions/auth", () => ({
  loginAction: vi.fn(async () => ({})),
  signupAction: vi.fn(async () => ({})),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children?: unknown;
      className?: string;
    }) => h("a", { href, className }, children as never),
  };
});

const {
  AuthFormView,
  STRENGTH_BAR_CLASS,
  STRENGTH_TEXT_CLASS,
  authFieldError,
  passwordIssueMessage,
  strengthTone,
} = await import("./auth-form");
type AuthFormViewProps = import("./auth-form").AuthFormViewProps;

const { TooltipProvider } = await import("@/components/ui/tooltip");

const EMPTY_VALUES = { name: "", email: "", password: "" };
const EMPTY_TOUCHED = { name: false, email: false, password: false };

/** Render the view inside a tooltip provider (the visibility toggle uses one). */
const render = (over: Partial<AuthFormViewProps> = {}): string =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(AuthFormView, {
        mode: "login",
        locale: "en",
        values: EMPTY_VALUES,
        touched: EMPTY_TOUCHED,
        onValueChange: () => {},
        onBlur: () => {},
        showPassword: false,
        onTogglePassword: () => {},
        remember: false,
        onRememberChange: () => {},
        requiresTwoFactor: false,
        pending: false,
        blocked: false,
        formAction: () => {},
        onSubmit: () => {},
        ...over,
      } as AuthFormViewProps),
    ),
  );

/** Token discipline shared by every rendered snapshot. */
function expectTokensOnly(html: string): void {
  expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  expect(html).not.toMatch(
    /\b(?:red|green|amber|orange|yellow|purple|pink|teal|emerald|slate|zinc|neutral)-\d{2,3}\b/,
  );
  expect(html).not.toContain("transition-all");
}

/* -------------------------------------------------------------------------- */
/* 1. Pure mappings                                                           */
/* -------------------------------------------------------------------------- */

describe("strengthTone — score maps onto a status token", () => {
  it("keeps the weak end on danger", () => {
    expect(strengthTone(0)).toBe("danger");
    expect(strengthTone(1)).toBe("danger");
  });

  it("steps to warning at fair, success from good", () => {
    expect(strengthTone(2)).toBe("warning");
    expect(strengthTone(3)).toBe("success");
    expect(strengthTone(4)).toBe("success");
  });

  it("only ever returns a design-system tone backed by a token class", () => {
    for (const score of [0, 1, 2, 3, 4] as const) {
      const tone = strengthTone(score);
      expect(["danger", "warning", "success"]).toContain(tone);
      expect(STRENGTH_BAR_CLASS[tone]).toContain(`bg-${tone}`);
      expect(STRENGTH_TEXT_CLASS[tone]).toContain(`text-${tone}`);
    }
  });
});

describe("passwordIssueMessage — issue → copy", () => {
  it("names the length bounds from the shared policy", () => {
    expect(passwordIssueMessage("too_short")).toBe("Use at least 8 characters.");
    expect(passwordIssueMessage("too_long")).toBe("Use at most 200 characters.");
  });

  it("covers the composition, denylist and empty cases", () => {
    expect(passwordIssueMessage("missing_lower")).toBe("Add a lowercase letter.");
    expect(passwordIssueMessage("missing_upper")).toBe("Add an uppercase letter.");
    expect(passwordIssueMessage("missing_digit")).toBe("Add a number.");
    expect(passwordIssueMessage("missing_symbol")).toBe("Add a symbol.");
    expect(passwordIssueMessage("common")).toBe("Avoid common passwords.");
    expect(passwordIssueMessage("empty")).toBe("Enter a password.");
    expect(passwordIssueMessage("not_a_string")).toBe("Enter a password.");
  });
});

describe("authFieldError — inline validation", () => {
  it("requires a name only when it is empty", () => {
    expect(authFieldError("name", "  ", "signup")).toBe("Enter your name.");
    expect(authFieldError("name", "Ada", "signup")).toBeUndefined();
  });

  it("checks the email shape", () => {
    expect(authFieldError("email", "", "login")).toBe("Enter your email.");
    expect(authFieldError("email", "nope", "login")).toBe("Enter a valid email address.");
    expect(authFieldError("email", "ada@example.com", "login")).toBeUndefined();
  });

  it("uses the password policy for signup and a mere presence check for login", () => {
    expect(authFieldError("password", "", "login")).toBe("Enter your password.");
    expect(authFieldError("password", "x", "login")).toBeUndefined();
    // Signup defers to the shared policy (same wording as the checklist).
    expect(authFieldError("password", "", "signup")).toBe("Enter a password.");
    expect(authFieldError("password", "abc", "signup")).toBe("Use at least 8 characters.");
    expect(authFieldError("password", "Tr0ub4dor&3", "signup")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Rendered states                                                         */
/* -------------------------------------------------------------------------- */

describe("AuthFormView — default (login)", () => {
  it("is calm and centred, with the primitive controls and no name field", () => {
    const html = render();
    expect(html).toContain("max-w-[380px]");
    expect(html).toContain('data-slot="field"');
    expect(html).toContain('data-slot="password-toggle"');
    // Login has no name input; it does offer the remember affordance.
    expect(html).not.toContain('name="name"');
    expect(html).toContain("Remember me on this device");
    expect(html).toContain('data-state="unchecked"');
    // The submit is a real Button and the cross-links are present.
    expect(html).toMatch(/<button[^>]*type="submit"/);
    expect(html).toContain('href="/signup"');
    expect(html).toContain("focus-ring");
    expectTokensOnly(html);
  });

  it("renders the signup variant with the name field and no remember box", () => {
    const html = render({ mode: "signup" });
    expect(html).toContain('name="name"');
    expect(html).toContain("Create account");
    expect(html).not.toContain("Remember me on this device");
    expectTokensOnly(html);
  });

  it("labels the visibility toggle and reflects its pressed state", () => {
    const hidden = render({ showPassword: false });
    expect(hidden).toContain('aria-pressed="false"');
    expect(hidden).toContain('aria-label="Show characters"');
    expect(hidden).toContain('type="password"');

    const shown = render({ showPassword: true });
    expect(shown).toContain('aria-pressed="true"');
    expect(shown).toContain('aria-label="Hide characters"');
    expect(shown).toContain('type="text"');
    expectTokensOnly(shown);
  });
});

describe("AuthFormView — invalid", () => {
  it("surfaces per-field errors with the danger ring", () => {
    const html = render({
      mode: "signup",
      values: { name: "", email: "nope", password: "abc" },
      touched: { name: true, email: true, password: true },
    });
    expect(html).toContain("Enter your name.");
    expect(html).toContain("Enter a valid email address.");
    expect(html).toContain("Use at least 8 characters.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-danger");
    expect(html).toContain("text-danger");
    expect(html).toContain('role="alert"');
    expectTokensOnly(html);
  });

  it("hides inline errors until a field is touched", () => {
    const html = render({ touched: EMPTY_TOUCHED });
    expect(html).not.toContain("Enter your email.");
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("renders the server error as a danger alert", () => {
    const html = render({ error: "Incorrect email or password." });
    expect(html).toMatch(/role="alert"[^>]*>Incorrect email or password\./);
    expect(html).toContain("text-danger");
  });
});

describe("AuthFormView — loading", () => {
  it("marks the submit busy, disables it and keeps a spinner (no double submit)", () => {
    const html = render({ pending: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/<svg[^>]*animate-spin/);
    // The label stays mounted (hidden) so the width does not shift.
    expect(html).toContain("Please wait…");
    expect(html).toContain("invisible");
    expectTokensOnly(html);
  });

  it("disables the submit while a signup password fails the policy", () => {
    const html = render({ mode: "signup", blocked: true, values: { ...EMPTY_VALUES, password: "abc" } });
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});

describe("AuthFormView — strength meter", () => {
  it("renders the meter as a progressbar with token colours", () => {
    const html = render({
      mode: "signup",
      values: { ...EMPTY_VALUES, password: "Tr0ub4dor&3" },
    });
    expect(html).toContain('data-slot="password-strength"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain("bg-success");
    expect(html).toContain("text-success");
    expect(html).toContain("good");
    expectTokensOnly(html);
  });

  it("lists the failing requirements and tones weak passwords danger", () => {
    const html = render({
      mode: "signup",
      values: { ...EMPTY_VALUES, password: "abcdefgh" },
    });
    expect(html).toContain("bg-danger");
    expect(html).toContain("text-danger");
    expect(html).toContain("Add an uppercase letter.");
    expect(html).toContain("Add a number.");
    expectTokensOnly(html);
  });

  it("stays hidden until there is a password to score", () => {
    const html = render({ mode: "signup" });
    expect(html).not.toContain('data-slot="password-strength"');
  });
});
