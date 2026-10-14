import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Trash2 } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { getTrash, getWorkspaceBySlug } from "@/server/queries";
import { TrashList } from "@/components/trash-list";
import { t } from "@/lib/i18n";

export const metadata = { title: "Trash" };

/** Trash: everything the workspace archived, with restore and permanent delete. */
export default async function TrashPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const pages = await getTrash(workspace.id);

  return (
    <div className="mx-auto max-w-3xl px-12 py-12">
      <Link
        href={`/w/${workspace.slug}`}
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back to {workspace.name}
      </Link>
      <h1 className="mt-2 mb-1 flex items-center gap-2 text-[28px] font-semibold tracking-[-0.02em]">
        <Trash2 className="h-6 w-6 text-muted" aria-hidden />
        {t(locale, "trash")}
      </h1>
      <p className="mb-6 text-sm text-muted">
        {t(locale, "trashIntro")}
      </p>

      <TrashList
        workspaceId={workspace.id}
        locale={locale}
        canEdit={canEditContent(access.role)}
        pages={pages.map((page) => ({
          id: page.id,
          title: page.title,
          icon: page.icon,
          deletedAt: page.deletedAt ? page.deletedAt.toISOString() : null,
        }))}
      />
    </div>
  );
}
