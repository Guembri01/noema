"use client";

import Link from "next/link";
import { useActionState, useState, type FormEvent } from "react";
import { loginAction, signupAction, type AuthState } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import {
  MAX_PASSWORD_LENGTH,
  PASSWORD_POLICY,
  scorePassword,
  validatePassword,
  type PasswordIssue,
} from "@/lib/password-policy";

/** Meter fill colour per score 0..4 (`PasswordScore.score` is the index). */
const STRENGTH_BAR_CLASS: readonly string[] = [
  "bg-red-500",
  "bg-red-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-emerald-500",
];

/** Meter label colour per score 0..4. */
const STRENGTH_TEXT_CLASS: readonly string[] = [
  "text-red-500",
  "text-red-500",
  "text-amber-600 dark:text-amber-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-emerald-600 dark:text-emerald-400",
];

/**
 * Wording for a rejected signup password. Mirrors the `PasswordIssue` codes
 * from `@/lib/password-policy`; the same text backs both the live checklist and
 * the submit gate, so the two can never disagree.
 */
function passwordIssueMessage(issue: PasswordIssue): string {
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
  const [password, setPassword] = useState("");
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    action,
    {},
  );
  const needsCode = mode === "login" && Boolean(state.requiresTwoFactor);
  // Live strength + policy feedback, computed from the same source of truth the
  // server enforces, so the meter and the submit gate can never drift apart.
  const strength = scorePassword(password);
  const validation = validatePassword(password);
  const signupBlocked = isSignup && password.length > 0 && !validation.ok;

  /**
   * Pre-submit gate for the signup path: if the typed password fails
   * `validatePassword`, cancel the form's action before it reaches the server.
   * Reads the field's live value (not just React state) so a browser autofill
   * that skipped `onChange` is still validated, and syncs the meter to it.
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!isSignup) return;
    const raw = new FormData(event.currentTarget).get("password");
    const value = typeof raw === "string" ? raw : "";
    if (value !== password) setPassword(value);
    if (!validatePassword(value).ok) event.preventDefault();
  };

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-4">
      {mode === "login" && next && <input type="hidden" name="next" value={next} />}
      {mode === "signup" && (
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium">
            {t(locale, "nameLabel")}
          </label>
          <Input id="name" name="name" placeholder="Ada Lovelace" required />
        </div>
      )}
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          {t(locale, "emailLabel")}
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          {t(locale, "passwordLabel")}
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          placeholder="••••••••"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={
            isSignup && password.length > 0 ? "password-strength" : undefined
          }
          required
        />
        {isSignup && password.length > 0 && (
          <div id="password-strength" className="space-y-1 pt-1">
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  role="progressbar"
                  aria-label="Password strength"
                  aria-valuemin={0}
                  aria-valuemax={4}
                  aria-valuenow={strength.score}
                  aria-valuetext={strength.label}
                  className={`h-full rounded-full transition-all ${STRENGTH_BAR_CLASS[strength.score]}`}
                  style={{ width: `${((strength.score + 1) / 5) * 100}%` }}
                />
              </div>
              <span
                className={`text-xs font-medium ${STRENGTH_TEXT_CLASS[strength.score]}`}
              >
                {strength.label}
              </span>
            </div>
            {validation.issues.length > 0 && (
              <ul className="space-y-0.5 text-xs text-muted">
                {validation.issues.map((issue) => (
                  <li key={issue}>{passwordIssueMessage(issue)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {needsCode && (
        <div className="space-y-1.5">
          <label htmlFor="code" className="text-sm font-medium">
            {t(locale, "twoFactorCode")}
          </label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            autoFocus
            required
          />
          <p className="text-xs text-muted">
            {t(locale, "twoFactorHint")}
          </p>
        </div>
      )}

      {state.error && (
        <p role="alert" className="text-sm text-red-500">
          {state.error}
        </p>
      )}

      <Button
        type="submit"
        disabled={pending || signupBlocked}
        className="w-full"
      >
        {pending
          ? t(locale, "pleaseWait")
          : mode === "login"
            ? t(locale, "signIn")
            : t(locale, "createAccount")}
      </Button>

      <p className="pt-1 text-center text-sm text-muted">
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
