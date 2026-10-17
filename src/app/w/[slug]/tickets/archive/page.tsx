import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { getArchivedTickets } from "@/server/ticket-archive";
import { TicketArchiveView } from "@/components/tickets/ticket-archive-view";

export const metadata = { title: "Archived tickets" };

/**
 * The archive view: every archived ticket a workspace holds, with search and a
 * Restore control, so an accidental archive is recoverable instead of looking
 * like data loss. Reads through `getArchivedTickets` (the one query that looks
 * at `archived: true`); the board/list/timeline never show these rows.
 */
export default async function TicketArchivePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  // The archive lists the workspace's tickets: not page-scoped, so a `GUEST` is
  // refused here exactly like on `GET /api/tickets`.
  if (!canEditContent(access.role)) notFound();

  const archived = await getArchivedTickets(workspace.id);
  const tickets = archived.map((ticket) => ({
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    status: ticket.status,
    archivedAt: ticket.archivedAt.toISOString(),
    archivedByName: ticket.archivedByName,
  }));

  return (
    <div className="mx-auto w-full max-w-[900px] px-8 py-12">
      <Link
        href={`/w/${workspace.slug}/tickets`}
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to tickets
      </Link>
      <h1 className="mt-3 flex items-center gap-2 text-3xl font-bold tracking-tight">
        <Archive className="h-6 w-6" aria-hidden /> Archived tickets
      </h1>
      <p className="mb-6 mt-2 text-sm text-muted">
        Archived tickets are hidden from the board, list and timeline. Restore one to put it back.
      </p>
      <TicketArchiveView tickets={tickets} locale={user.locale ?? "en"} />
    </div>
  );
}
