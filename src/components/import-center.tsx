"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createPageAction } from "@/server/actions/pages";
import { safeAction } from "@/lib/actions-client";
import { ImportSection } from "@/components/sidebar/importers";
import { NotionImportDialog } from "@/components/notion-import-dialog";

/**
 * The import center, moved out of the page tree and into Settings.
 *
 * The source pickers and their dialogs are unchanged; only the host moved, so
 * importing no longer competes with page navigation for space in the sidebar.
 */
export function ImportCenter({
  workspace,
  locale,
}: {
  workspace: { id: string; slug: string };
  locale: string;
}) {
  const router = useRouter();
  const [notionOpen, setNotionOpen] = useState(false);
  const [, startTransition] = useTransition();

  const addPage = (parentId: string | null, type: "PAGE" | "DATABASE") => {
    startTransition(async () => {
      const outcome = await safeAction(() =>
        createPageAction({ workspaceId: workspace.id, parentId, type }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) router.push(`/w/${workspace.slug}/${result.id}`);
      else toast.error(result.error);
    });
  };

  return (
    <div className="rounded-lg border border-border p-4">
      <ImportSection
        workspace={workspace}
        addPage={addPage}
        locale={locale}
        startTransition={(callback) => startTransition(callback)}
        onOpenNotion={() => setNotionOpen(true)}
      />
      <NotionImportDialog
        locale={locale}
        open={notionOpen}
        onOpenChange={setNotionOpen}
        workspaceId={workspace.id}
        slug={workspace.slug}
      />
    </div>
  );
}
