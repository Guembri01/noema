"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, signupAction, type AuthState } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

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
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    action,
    {},
  );
  const needsCode = mode === "login" && Boolean(state.requiresTwoFactor);

  return (
    <form action={formAction} className="space-y-4">
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
          required
        />
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

      <Button type="submit" disabled={pending} className="w-full">
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
