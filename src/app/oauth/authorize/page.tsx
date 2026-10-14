import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { t } from "@/lib/i18n";

/** OAuth 2.0 authorization endpoint (consent screen). */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const locale = user.locale ?? "en";

  const clientId = params.client_id ?? "";
  const redirectUri = params.redirect_uri ?? "";
  const state = params.state ?? "";
  const app = clientId ? await prisma.oAuthApp.findUnique({ where: { clientId } }) : null;
  const valid = app !== null && app.redirectUris.includes(redirectUri);

  if (!valid) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-xl font-semibold">{t(locale, "invalidAuthRequest")}</h1>
        <p className="mt-2 text-sm text-muted">{t(locale, "unknownClientMsg")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-xl border border-border bg-surface p-8">
        <h1 className="text-xl font-semibold">
          {t(locale, "authorizeWord")} {app.name}
        </h1>
        <p className="mt-2 text-sm text-muted">
          <strong>{app.name}</strong> {t(locale, "consentSuffix")}
        </p>
        <form
          action="/oauth/authorize/complete"
          method="POST"
          className="mt-6 flex items-center gap-2"
        >
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="state" value={state} />
          <button
            type="submit"
            name="decision"
            value="allow"
            className="h-10 rounded bg-accent px-4 text-sm text-accent-fg"
          >
            {t(locale, "authorizeWord")}
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className="h-10 rounded border border-border px-4 text-sm"
          >
            {t(locale, "denyWord")}
          </button>
        </form>
      </div>
    </main>
  );
}
