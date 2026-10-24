"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { matchSamlConnections, type SamlLoginChoice } from "@/lib/sso/login-choices";

/** Email-first SAML entry point rendered on `/login`. */
export function SamlLoginChooser({ choices }: { choices: SamlLoginChoice[] }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const go = () => {
    const matches = matchSamlConnections(choices, email);
    if (matches.length === 1) {
      window.location.assign(`/api/auth/saml/start?connection=${encodeURIComponent(matches[0].id)}`);
      return;
    }
    setMessage(
      matches.length === 0
        ? "No SAML connection matches that email domain."
        : "More than one connection matches; choose one below.",
    );
  };

  return (
    <div className="mt-4 rounded-lg border border-border p-3 text-left">
      <p className="text-sm font-medium">Sign in with SAML SSO</p>
      <div className="mt-2 flex gap-2">
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          aria-label="Work email for SAML SSO"
        />
        <Button type="button" size="sm" onClick={go}>
          Continue
        </Button>
      </div>
      {message && (
        <p role="status" className="mt-2 text-xs text-muted">
          {message}
        </p>
      )}
      <ul className="mt-2 space-y-1">
        {choices.map((choice) => (
          <li key={choice.id}>
            <a
              className="text-sm text-accent hover:underline"
              href={`/api/auth/saml/start?connection=${encodeURIComponent(choice.id)}`}
            >
              {choice.name} — {choice.workspaceName}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
