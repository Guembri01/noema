import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getUserWorkspaces } from "@/server/queries";
import { CreateWorkspaceButton } from "@/components/workspace-dialog";
import { t } from "@/lib/i18n";

export default async function AppIndex() {
  const user = await requireUser();
  const workspaces = await getUserWorkspaces(user.id);
  const locale = user.locale ?? "en";
  if (workspaces.length > 0) redirect(`/w/${workspaces[0].slug}`);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-lg border border-border bg-surface p-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t(locale, "createWorkspace")}
        </h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          {t(locale, "workspaceHoldsPages")}
        </p>
        <CreateWorkspaceButton />
      </div>
    </main>
  );
}
