import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { listApiTokensAction } from "@/server/actions/api-tokens";
import { ApiTokensPanel } from "@/components/api-tokens-panel";
import { t } from "@/lib/i18n";

export const metadata = { title: "API tokens" };

/**
 * Personal API tokens (settings → API tokens).
 *
 * The server component reads the caller's tokens *with their scopes* through
 * `listApiTokensAction` (the orphan action) and hands them to the client panel,
 * which creates and revokes tokens through the same scoped action module. Tokens
 * are owned by the signed-in user, so membership of the workspace is the only
 * gate.
 */
export default async function ApiTokensSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const tokens = await listApiTokensAction();

  return (
    <div className="mx-auto max-w-2xl px-10 py-12">
      <Link href={`/w/${workspace.slug}/settings`} className="text-xs text-muted hover:underline">
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">
        {t(locale, "apiTokens")}
      </h1>
      <p className="mb-6 text-sm text-muted">
        Tokens authenticate the REST API as you. Each token carries its own
        scopes; revoke it here the moment it is no longer needed.
      </p>

      <ApiTokensPanel initialTokens={tokens} locale={locale} />
    </div>
  );
}
