import { prisma } from "@/lib/db";

/**
 * One archived ticket for the archive view.
 *
 * The ticket row itself only stores the `archived` boolean, so the "who / when"
 * comes from the most recent `archived` `TicketActivity` row when it exists
 * (`archivedByName` stays null for tickets archived without a trail, e.g. before
 * this view existed). `archivedAt` always has a value: it falls back to the
 * row's `updatedAt`, which is the archive write for a ticket that has not been
 * touched since.
 */
export type ArchivedTicket = {
  id: string;
  key: string;
  title: string;
  /** Status at the moment it was archived (archiving leaves status untouched). */
  status: string;
  /** Instant the ticket was archived. */
  archivedAt: Date;
  /** Who archived it, when an `archived` activity row recorded them. */
  archivedByName: string | null;
};

/**
 * The workspace's archived tickets, most-recently-archived first.
 *
 * The board, list, timeline and project rollups all read through
 * `getTicketsPage` / `getTickets`, which filter `archived: false`; this is the
 * one deliberate query over the soft-deleted set that backs the archive view.
 * Capped like the other board queries so an enormous archive cannot ship
 * unbounded rows to the client.
 */
export async function getArchivedTickets(workspaceId: string): Promise<ArchivedTicket[]> {
  const rows = await prisma.ticket.findMany({
    where: { workspaceId, archived: true },
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: {
      id: true,
      key: true,
      title: true,
      status: true,
      updatedAt: true,
      activity: {
        where: { kind: "archived" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true, actor: { select: { name: true } } },
      },
    },
  });

  return rows.map((row) => {
    const event = row.activity[0];
    return {
      id: row.id,
      key: row.key,
      title: row.title,
      status: row.status,
      archivedAt: event?.createdAt ?? row.updatedAt,
      archivedByName: event?.actor?.name ?? null,
    };
  });
}
