import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import {
  acceptWorkspaceInviteAction,
  previewWorkspaceInviteAction,
} from "@/server/actions/email";
import { roleLabelKey } from "@/lib/workspace-role-map";
import { InviteAcceptButton } from "@/components/invite-accept-button";
import { t } from "@/lib/i18n";

export const metadata = { title: "Workspace invitation" };

/**
 * Redeem an emailed workspace/client invitation.
 *
 * Opening the link only *reads* the invitation — it shows who is invited, to
 * what, and as which role — and the acceptance is the POST the form below makes.
 * That split is the point: a GET of this URL is fetched by things the invitee
 * never clicked (mail scanners, link previews, a browser prefetch), and a
 * single-use invitation must not be spent by any of them.
 *
 * `accept` is a Server Action, so it still works as a plain form POST when
 * JavaScript is unavailable, and it lands the invitee in the workspace it joined.
 */
async function accept(token: string): Promise<void> {
  "use server";

  const result = await acceptWorkspaceInviteAction(token);
  if ("ok" in result) {
    redirect(`/w/${result.slug}?joined=${encodeURIComponent(result.workspaceName)}`);
  }
  // A refusal (used, expired, a different address) re-renders this page, and the
  // preview above is what explains it: the same rules decide both.
}

export default async function WorkspaceInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }
  const locale = user.locale ?? "en";

  const preview = await previewWorkspaceInviteAction(token);

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
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{preview.workspaceName}</h1>

        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">{t(locale, "inviteRoleLabel")}</dt>
            <dd>{t(locale, roleLabelKey(preview.role))}</dd>
          </div>
          {preview.projectName ? (
            <div className="flex gap-2">
              <dt className="text-muted">{t(locale, "clientInvitedTo")}</dt>
              <dd>{preview.projectName}</dd>
            </div>
          ) : null}
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
