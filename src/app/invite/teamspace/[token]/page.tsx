import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import {
  acceptTeamspaceInviteAction,
  previewTeamspaceInviteAction,
} from "@/server/actions/teamspace-invites";
import { roleLabelKey } from "@/lib/workspace-role-map";
import { InviteAcceptButton } from "@/components/invite-accept-button";
import { t } from "@/lib/i18n";

export const metadata = { title: "Teamspace invitation" };

/**
 * Redeem an emailed teamspace invitation.
 *
 * The same shape as the workspace invite page, for the same reason: opening the
 * link reads the invitation and the form posts the acceptance, so a mail scanner
 * or a prefetch can never spend the single-use token.
 */
async function accept(token: string): Promise<void> {
  "use server";

  const result = await acceptTeamspaceInviteAction(token);
  if ("ok" in result) {
    redirect(`/w/${result.slug}?joined=${encodeURIComponent(result.teamspaceName)}`);
  }
}

export default async function TeamspaceInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/teamspace/${token}`)}`);
  }
  const locale = user.locale ?? "en";

  const preview = await previewTeamspaceInviteAction(token);

  if ("error" in preview) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <div className="rounded-lg border border-border bg-surface p-8">
          <h1 className="text-xl font-semibold tracking-tight">
            {t(locale, "inviteRejected")}
          </h1>
          <p className="mt-2 text-sm text-muted">{preview.error}</p>
          <p className="mt-4 text-xs text-muted">
            {t(locale, "signedInAs")} {user.email}
            {t(locale, "invitesTiedSuffix")}
          </p>
          <Link href="/app" className="mt-6 inline-block text-sm text-accent hover:underline">
            {t(locale, "backToWorkspaces")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-lg border border-border bg-surface p-8">
        <p className="text-sm text-muted">{t(locale, "inviteAcceptHeading")}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{preview.teamspaceName}</h1>

        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">{t(locale, "inviteRoleLabel")}</dt>
            <dd>{t(locale, roleLabelKey(preview.role))}</dd>
          </div>
        </dl>

        <p className="mt-4 text-xs text-muted">
          {t(locale, "signedInAs")} {user.email}
          {t(locale, "invitesTiedSuffix")}
        </p>

        <form action={accept.bind(null, token)} className="mt-6">
          <InviteAcceptButton locale={locale} />
        </form>

        <p className="mt-4 text-xs text-muted">{t(locale, "inviteAcceptNote")}</p>
      </div>
    </main>
  );
}
