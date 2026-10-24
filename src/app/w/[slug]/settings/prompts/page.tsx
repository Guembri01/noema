import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { listPromptsAction } from "@/server/actions/prompts";
import { SettingsNav } from "../settings-nav";
import { PromptLibraryClient } from "./prompt-library-client";

export const metadata = { title: "Prompt library" };

/**
 * Workspace prompt library (settings → Prompt library).
 *
 * A reusable-prompt manager built on the pure `@/lib/ai-prompt-library` engine.
 * The server component resolves the workspace from the slug, gates on
 * membership, and seeds the client editor with the caller's visible rows
 * (`listPromptsAction`). The editor's create/update/delete/clone controls then
 * persist through `@/server/actions/prompts`, so the library survives a reload
 * and is shared with the rest of the workspace instead of living in local
 * state.
 */
export default async function PromptLibraryPage({
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

  const result = await listPromptsAction({ workspaceId: workspace.id });

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Link href={`/w/${workspace.slug}/settings`} className="text-xs text-muted hover:underline">
        ← Settings
      </Link>
      <h1 className="mb-2 mt-3 text-title font-semibold tracking-title">Prompt library</h1>
      <p className="mb-8 text-sm text-muted">
        Save reusable prompts with <code>{"{{variable}}"}</code> placeholders and insert them from
        the chat composer. Workspace prompts are shared; personal prompts are private.
      </p>

      <SettingsNav slug={workspace.slug} locale={locale} className="mb-8" />

      <PromptLibraryClient
        workspaceId={workspace.id}
        locale={locale}
        initialPrompts={result.ok ? result.prompts : []}
        initialCanEdit={result.ok ? result.canEdit : canEditContent(access.role)}
        initialError={result.ok ? null : result.error}
      />
    </div>
  );
}
