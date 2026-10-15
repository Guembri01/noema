"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createApiTokenAction,
  revokeApiTokenAction,
} from "@/server/actions/tokens";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";
import {
  API_SCOPES,
  describeScope,
  expandScopes,
  validateScopes,
} from "@/lib/api-token-scope";

export type ApiTokenRow = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export function ApiTokenManager({ tokens, locale }: { tokens: ApiTokenRow[]; locale: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  // The catalogue is the single source of truth for selectable scopes; the
  // picker below never hard-codes ids.
  const effectiveScopes = expandScopes(scopes);

  const toggleScope = (id: string) => {
    setScopes((current) =>
      current.includes(id) ? current.filter((scope) => scope !== id) : [...current, id],
    );
  };

  const create = () => {
    const validation = validateScopes(scopes);
    if (!validation.ok) {
      toast.error(t(locale, "somethingWentWrong"));
      return;
    }
    startTransition(async () => {
      const result = await createApiTokenAction(name);
      if ("token" in result) {
        setCreated(result.token);
        setName("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <KeyRound className="h-4 w-4" />
        {t(locale, "apiTokens")}
      </h2>
      <p className="mb-3 text-sm text-muted">
        {t(locale, "apiTokensIntroA")}{" "}
        <code className="rounded bg-surface px-1">Authorization: Bearer &lt;token&gt;</code>{" "}
        {t(locale, "apiTokensIntroB")} <code className="rounded bg-surface px-1">/api/v1/*</code>.
      </p>

      <div className="mb-4 flex items-center gap-2">
        <input
          aria-label={t(locale, "tokenName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t(locale, "tokenNamePlaceholder")}
          className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={pending}
          onClick={create}
          className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> {t(locale, "createToken")}
        </button>
      </div>

      <fieldset className="mb-4 rounded-lg border border-border p-3" data-testid="token-scope-picker">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "generalAccess")}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {API_SCOPES.map((scope) => (
            <label key={scope.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                value={scope.id}
                checked={scopes.includes(scope.id)}
                onChange={() => toggleScope(scope.id)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block truncate">{scope.id}</span>
                <span className="block text-xs text-muted">
                  {describeScope(scope.id) ?? scope.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        {effectiveScopes.length > 0 && (
          <p className="mt-2 text-xs text-muted" data-testid="token-effective-scopes">
            {effectiveScopes
              .map((id) => describeScope(id))
              .filter((label): label is string => Boolean(label))
              .join(" · ")}
          </p>
        )}
      </fieldset>

      {created && (
        <div className="mb-4 rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-muted">
            {t(locale, "copyTokenOnce")}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-bg px-2 py-1 text-xs">
              {created}
            </code>
            <button
              type="button"
              aria-label={t(locale, "copyToken")}
              onClick={() => {
                navigator.clipboard
                  .writeText(created)
                  .then(() => toast.success(t(locale, "tokenCopied")))
                  .catch(() => toast.error(t(locale, "couldNotCopy")));
              }}
              className="rounded border border-border p-1.5 text-muted hover:bg-surface-2"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noApiTokens")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex-1 truncate">{token.name}</span>
              <span className="text-xs text-muted">
                {t(locale, "createdPrefix")} <LocalTime value={token.createdAt} mode="date" />
              </span>
              <span className="text-xs text-muted">
                {token.lastUsedAt
                  ? `${t(locale, "lastUsedPrefix")} ${new Date(token.lastUsedAt).toLocaleDateString()}`
                  : t(locale, "neverUsed")}
              </span>
              <button
                type="button"
                aria-label={t(locale, "revokeToken")}
                onClick={() =>
                  startTransition(async () => {
                    const result = await revokeApiTokenAction(token.id);
                    if ("ok" in result) {
                      toast.success(t(locale, "tokenRevoked"));
                      router.refresh();
                    } else {
                      toast.error(result.error);
                    }
                  })
                }
                className="text-muted hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
