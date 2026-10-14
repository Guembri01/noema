import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { acceptWorkspaceInviteAction } from "@/server/actions/email";
import { t } from "@/lib/i18n";

export const metadata = { title: "Workspace invitation" };

/** Accept an emailed workspace/client invitation, then land in the workspace. */
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

  const result = await acceptWorkspaceInviteAction(token);
  if ("ok" in result) {
    redirect(`/w/${result.slug}?joined=${encodeURIComponent(result.workspaceName)}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-xl border border-border bg-surface p-8">
        <h1 className="text-xl font-semibold tracking-tight">
          {t(locale, "inviteRejected")}
        </h1>
        <p className="mt-2 text-sm text-muted">{result.error}</p>
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
