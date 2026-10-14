"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Plug, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createOAuthAppAction,
  deleteOAuthAppAction,
} from "@/server/actions/oauth-apps";
import { t } from "@/lib/i18n";


export type OAuthAppRow = {
  id: string;
  name: string;
  clientId: string;
  redirectUris: string[];
};

export function OAuthAppManager({ apps, locale }: { apps: OAuthAppRow[]; locale: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [uris, setUris] = useState("");
  const [created, setCreated] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const create = () =>
    startTransition(async () => {
      const result = await createOAuthAppAction(name, uris);
      if ("clientId" in result) {
        setCreated(result);
        setName("");
        setUris("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <Plug className="h-4 w-4" />
        {t(locale, "oauthApps")}
      </h2>
      <p className="mb-3 text-sm text-muted">
        {t(locale, "oauthIntroA")}{" "}
        <code className="rounded bg-surface px-1">/oauth/authorize</code> →{" "}
        <code className="rounded bg-surface px-1">/oauth/token</code>.
      </p>

      <div className="mb-4 space-y-2 rounded-lg border border-border p-3">
        <input
          aria-label={t(locale, "appName")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t(locale, "appName")}
          className="h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <input
          aria-label={t(locale, "redirectUrisLabel")}
          value={uris}
          onChange={(event) => setUris(event.target.value)}
          placeholder={t(locale, "redirectUrisPlaceholder")}
          className="h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={pending || !name.trim() || !uris.trim()}
          onClick={create}
          className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> {t(locale, "createApp")}
        </button>
      </div>

      {created && (
        <div className="mb-4 space-y-1 rounded-lg border border-border bg-surface p-3 text-xs">
          <p className="text-muted">{t(locale, "copySecretOnce")}</p>
          <div className="flex items-center gap-2">
            <span className="text-muted">client_id</span>
            <code className="flex-1 truncate rounded bg-bg px-2 py-1">{created.clientId}</code>
            <button
              type="button"
              aria-label={t(locale, "copyClientId")}
              onClick={() => navigator.clipboard.writeText(created.clientId).then(() => toast.success(t(locale, "copiedWord"))).catch(() => {})}
              className="rounded border border-border p-1.5 text-muted hover:bg-surface-2"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted">secret&nbsp;&nbsp;&nbsp;</span>
            <code className="flex-1 truncate rounded bg-bg px-2 py-1">{created.clientSecret}</code>
            <button
              type="button"
              aria-label={t(locale, "copyClientSecret")}
              onClick={() => navigator.clipboard.writeText(created.clientSecret).then(() => toast.success(t(locale, "copiedWord"))).catch(() => {})}
              className="rounded border border-border p-1.5 text-muted hover:bg-surface-2"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {apps.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noOauthApps")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {apps.map((app) => (
            <li key={app.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex-1 truncate font-medium">{app.name}</span>
              <span className="truncate font-mono text-xs text-muted">{app.clientId}</span>
              <span className="truncate text-xs text-muted">{app.redirectUris.join(", ")}</span>
              <button
                type="button"
                aria-label={t(locale, "deleteApp")}
                onClick={() =>
                  startTransition(async () => {
                    const result = await deleteOAuthAppAction(app.id);
                    if ("ok" in result) {
                      toast.success(t(locale, "appRemoved"));
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
