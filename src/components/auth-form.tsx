"use client";

import Link from "next/link";
import { useActionState, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { loginAction, signupAction, type AuthState } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  MAX_PASSWORD_LENGTH,
  PASSWORD_POLICY,
  scorePassword,
  validatePassword,
  type PasswordIssue,
  type PasswordScore,
} from "@/lib/password-policy";

/**
 * Auth form (login / signup) — the first-impression screen.
 *
 * Presentation lives in {@link AuthFormView} (pure: it takes the whole state as
 * props, so default / invalid / loading can be rendered and pinned without a
 * DOM); {@link AuthForm} is the thin client shell that owns the state and the
 * `useActionState` wiring.
 *
 * Design-system contract (docs/DESIGN_SYSTEM.md):
 * - colour/motion/shape only via tokens — no legacy palette, no ad-hoc
 *   `transition-all`;
 * - `Field` + `Input` + `Button` + `Checkbox` primitives throughout;
 * - per-field inline validation with the danger ring (`Field` → `invalid`);
 * - the visibility toggle is an icon button with `Tooltip` + `aria-pressed`;
 * - the submit `Button` carries `loading`, which disables it, so a form can
 *   never submit twice.
 */

/** Colour tone for the strength meter; maps the 0–4 score onto status tokens. */
export type StrengthTone = "danger" | "warning" | "success";

/** Meter fill per tone. Token-only — never a legacy palette class. */
export const STRENGTH_BAR_CLASS: Record<StrengthTone, string> = {
  danger: "bg-danger",
  warning: "bg-warning",
  success: "bg-success",
};

/** Meter label ink per tone. Token-only — never a legacy palette class. */
export const STRENGTH_TEXT_CLASS: Record<StrengthTone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
};

/**
 * Map a strength score to a status tone: `0–1` danger, `2` warning, `3–4`
 * success. Pure and total — pinned by the node test.
 */
export function strengthTone(score: PasswordScore["score"]): StrengthTone {
  if (score <= 1) return "danger";
  if (score === 2) return "warning";
  return "success";
}

/**
 * Wording for a rejected signup password. Mirrors the `PasswordIssue` codes
 * from `@/lib/password-policy`; the same text backs both the live checklist and
 * the inline field error, so the two can never disagree.
 */
export function passwordIssueMessage(issue: PasswordIssue): string {
  switch (issue) {
    case "too_short":
      return `Use at least ${PASSWORD_POLICY.minLength} characters.`;
    case "too_long":
      return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
    case "missing_lower":
      return "Add a lowercase letter.";
    case "missing_upper":
      return "Add an uppercase letter.";
    case "missing_digit":
      return "Add a number.";
    case "missing_symbol":
      return "Add a symbol.";
    case "common":
      return "Avoid common passwords.";
    case "empty":
    case "not_a_string":
      return "Enter a password.";
  }
}

/** The three fields this form validates inline. */
export type AuthFieldName = "name" | "email" | "password";

/** Live values of the inline-validated fields. */
export type AuthFormValues = Record<AuthFieldName, string>;

/** Which fields have been blurred or failed a submit, keyed by field. */
export type AuthFormTouched = Record<AuthFieldName, boolean>;

/** Pragmatic inline email shape; the server (`loginSchema`) is authoritative. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Copy shown by the password-visibility toggle. */
const SHOW_PASSWORD = "Show characters";
const HIDE_PASSWORD = "Hide characters";
/** Login-only "stay signed in" affordance. */
const REMEMBER_LABEL = "Remember me on this device";

/**
 * Inline validation copy for one field. `undefined` means "looks fine" — the
 * submit gate and the per-field error both read from this one mapping, so the
 * message under a field can never disagree with what blocks the form. Pure.
 */
export function authFieldError(
  field: AuthFieldName,
  value: string,
  mode: "login" | "signup",
): string | undefined {
  if (field === "name") {
    return value.trim().length > 0 ? undefined : "Enter your name.";
  }
  if (field === "email") {
    const trimmed = value.trim();
    if (!trimmed) return "Enter your email.";
    return EMAIL_PATTERN.test(trimmed) ? undefined : "Enter a valid email address.";
  }
  if (mode === "login") {
    return value.length > 0 ? undefined : "Enter your password.";
  }
  const issue = validatePassword(value).issues[0];
  return issue ? passwordIssueMessage(issue) : undefined;
}

/** Read a string field from a `FormData`, tolerating a missing/odd entry. */
function readField(form: FormData, key: string): string {
  const raw = form.get(key);
  return typeof raw === "string" ? raw : "";
}

/**
 * The strength meter + live policy checklist. Rendered as the password field's
 * `hint`, so `Field` wires it through `aria-describedby`; every part is a
 * phrasing element (spans/mark) so it nests legally inside the hint `<p>`.
 */
function PasswordStrength({
  strength,
  issues,
  locale,
}: {
  strength: PasswordScore;
  issues: readonly PasswordIssue[];
  locale: string;
}) {
  const tone = strengthTone(strength.score);
  return (
    <span className="flex flex-col gap-1 pt-1" data-slot="password-strength">
      <span className="flex items-center gap-2">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <span
            role="progressbar"
            aria-label={t(locale, "passwordStrength")}
            aria-valuemin={0}
            aria-valuemax={4}
            aria-valuenow={strength.score}
            aria-valuetext={strength.label}
            className={cn(
              "block h-full rounded-full u-colors",
              STRENGTH_BAR_CLASS[tone],
            )}
            style={{ width: `${((strength.score + 1) / 5) * 100}%` }}
          />
        </span>
        <span className={cn("text-xs font-medium", STRENGTH_TEXT_CLASS[tone])}>
          {strength.label}
        </span>
      </span>
      {issues.length > 0 && (
        <span className="flex flex-col gap-0.5 text-muted">
          {issues.map((issue) => (
            <span key={issue}>{passwordIssueMessage(issue)}</span>
          ))}
        </span>
      )}
    </span>
  );
}

export type AuthFormViewProps = {
  mode: "login" | "signup";
  locale: string;
  next?: string;
  values: AuthFormValues;
  touched: AuthFormTouched;
  onValueChange: (field: AuthFieldName, value: string) => void;
  onBlur: (field: AuthFieldName) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
  remember: boolean;
  onRememberChange: (checked: boolean) => void;
  error?: string;
  requiresTwoFactor: boolean;
  pending: boolean;
  /** The signup password fails the policy → the submit button is disabled. */
  blocked: boolean;
  formAction: (formData: FormData) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

/**
 * Pure presentation for the auth form. Calm and centred (`max-w-[380px]`) with
 * a generous field rhythm; every state is a function of the props.
 */
export function AuthFormView({
  mode,
  locale,
  next,
  values,
  touched,
  onValueChange,
  onBlur,
  showPassword,
  onTogglePassword,
  remember,
  onRememberChange,
  error,
  requiresTwoFactor,
  pending,
  blocked,
  formAction,
  onSubmit,
}: AuthFormViewProps) {
  const isSignup = mode === "signup";
  const strength = scorePassword(values.password);
  const validation = validatePassword(values.password);
  const fieldError = (field: AuthFieldName): string | undefined =>
    touched[field] ? authFieldError(field, values[field], mode) : undefined;

  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      noValidate
      className="mx-auto flex w-full max-w-[380px] flex-col gap-5"
    >
      {mode === "login" && next && <input type="hidden" name="next" value={next} />}

      {isSignup && (
        <Field
          id="name"
          label={t(locale, "nameLabel")}
          required
          error={fieldError("name")}
        >
          <Input
            name="name"
            autoComplete="name"
            placeholder={t(locale, "namePlaceholder")}
            required
            value={values.name}
            onChange={(event) => onValueChange("name", event.target.value)}
            onBlur={() => onBlur("name")}
          />
        </Field>
      )}

      <Field
        id="email"
        label={t(locale, "emailLabel")}
        required
        error={fieldError("email")}
      >
        <Input
          name="email"
          type="email"
          autoComplete="email"
          placeholder={t(locale, "emailPlaceholder")}
          required
          value={values.email}
          onChange={(event) => onValueChange("email", event.target.value)}
          onBlur={() => onBlur("email")}
        />
      </Field>

      <Field
        id="password"
        label={t(locale, "passwordLabel")}
        required
        error={fieldError("password")}
        hint={
          isSignup && values.password.length > 0 ? (
            <PasswordStrength strength={strength} issues={validation.issues} locale={locale} />
          ) : undefined
        }
      >
        <Input
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete={isSignup ? "new-password" : "current-password"}
          placeholder="••••••••"
          required
          value={values.password}
          onChange={(event) => onValueChange("password", event.target.value)}
          onBlur={() => onBlur("password")}
          trailing={
            <Tooltip label={showPassword ? HIDE_PASSWORD : SHOW_PASSWORD}>
              <button
                type="button"
                aria-pressed={showPassword}
                data-slot="password-toggle"
                onClick={onTogglePassword}
                className="focus-ring u-colors inline-flex h-6 w-6 items-center justify-center rounded-xs text-muted hover:bg-surface-2 hover:text-fg"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden />
                )}
              </button>
            </Tooltip>
          }
        />
      </Field>

      {!isSignup && (
        <Checkbox
          id="remember"
          name="remember"
          value="1"
          checked={remember}
          onCheckedChange={onRememberChange}
          label={REMEMBER_LABEL}
        />
      )}

      {requiresTwoFactor && (
        <Field
          id="code"
          label={t(locale, "twoFactorCode")}
          hint={t(locale, "twoFactorHint")}
          required
        >
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            required
            autoFocus
          />
        </Field>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <Button
        type="submit"
        loading={pending}
        disabled={blocked}
        className="w-full"
      >
        {pending
          ? t(locale, "pleaseWait")
          : mode === "login"
            ? t(locale, "signIn")
            : t(locale, "createAccount")}
      </Button>

      <p className="text-center text-sm text-muted">
        {mode === "login" ? (
          <>
            {t(locale, "noAccount")}{" "}
            <Link href="/signup" className="text-accent hover:underline">
              {t(locale, "signUp")}
            </Link>
          </>
        ) : (
          <>
            {t(locale, "alreadyHaveOne")}{" "}
            <Link href="/login" className="text-accent hover:underline">
              {t(locale, "signIn")}
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

export function AuthForm({
  mode,
  next,
  locale = "en",
}: {
  mode: "login" | "signup";
  next?: string;
  /** Pre-auth pages have no locale source yet — defaults to en. */
  locale?: string;
}) {
  const action = mode === "login" ? loginAction : signupAction;
  const isSignup = mode === "signup";
  const [values, setValues] = useState<AuthFormValues>({
    name: "",
    email: "",
    password: "",
  });
  const [touched, setTouched] = useState<AuthFormTouched>({
    name: false,
    email: false,
    password: false,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    action,
    {},
  );
  const needsCode = mode === "login" && Boolean(state.requiresTwoFactor);
  // Live policy feedback, computed from the same source of truth the server
  // enforces, so the meter and the submit gate can never drift apart.
  const signupBlocked =
    isSignup && values.password.length > 0 && !validatePassword(values.password).ok;

  const handleValueChange = (field: AuthFieldName, value: string) =>
    setValues((current) =>
      current[field] === value ? current : { ...current, [field]: value },
    );

  const handleBlur = (field: AuthFieldName) =>
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));

  /**
   * Pre-submit gate: re-read the live field values (a browser autofill can skip
   * `onChange`), sync them into state, then cancel the form's action when any
   * field fails {@link authFieldError} — surfacing every inline error at once
   * instead of a round-trip to the server.
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = new FormData(event.currentTarget);
    const live: AuthFormValues = {
      name: readField(form, "name"),
      email: readField(form, "email"),
      password: readField(form, "password"),
    };
    setValues((current) =>
      current.name === live.name &&
      current.email === live.email &&
      current.password === live.password
        ? current
        : live,
    );

    const failing =
      Boolean(authFieldError("email", live.email, mode)) ||
      Boolean(authFieldError("password", live.password, mode)) ||
      (isSignup && Boolean(authFieldError("name", live.name, mode)));
    if (failing) {
      event.preventDefault();
      setTouched({ name: true, email: true, password: true });
    }
  };

  return (
    <AuthFormView
      mode={mode}
      locale={locale}
      next={next}
      values={values}
      touched={touched}
      onValueChange={handleValueChange}
      onBlur={handleBlur}
      showPassword={showPassword}
      onTogglePassword={() => setShowPassword((value) => !value)}
      remember={remember}
      onRememberChange={setRemember}
      error={state.error}
      requiresTwoFactor={needsCode}
      pending={pending}
      blocked={signupBlocked}
      formAction={formAction}
      onSubmit={handleSubmit}
    />
  );
}
