/**
 * Live archive/restore check against the local database.
 *
 * Creates a throwaway ticket, then asserts the real board query
 * (`getTicketsPage`) drops it once archived while the real archive query
 * (`getArchivedTickets`) picks it up — and that restoring it puts it back on the
 * board. Cleans up after itself. Run with:
 *
 *   npx.cmd tsx scripts/check-ticket-archive.ts
 */
import { prisma } from "@/lib/db";
import { getArchivedTickets } from "@/server/ticket-archive";
import { getTicketsPage } from "@/server/queries";
import { keyPrefix, ticketKey } from "@/lib/tickets";

const results: boolean[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const BOARD_PAGE_SIZE = 200;

async function main(): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
  if (!user) throw new Error("demo@noema.local is missing; seed the database first.");

  const workspace = await prisma.workspace.findFirst({
    where: { ownerId: user.id },
    select: { id: true, name: true },
  });
  if (!workspace) throw new Error("demo user owns no workspace.");

  // Reserve a key the same way `createTicketAction` does, then create the row.
  const bumped = await prisma.workspace.update({
    where: { id: workspace.id },
    data: { ticketCounter: { increment: 1 } },
    select: { ticketCounter: true },
  });
  const ticket = await prisma.ticket.create({
    data: {
      workspaceId: workspace.id,
      number: bumped.ticketCounter,
      key: ticketKey(keyPrefix(workspace.name), bumped.ticketCounter),
      title: "check-archive live ticket",
      reporterId: user.id,
    },
    select: { id: true, key: true },
  });

  try {
    const board = await getTicketsPage(workspace.id, { take: BOARD_PAGE_SIZE });
    check("new ticket appears on the board query", board.tickets.some((t) => t.id === ticket.id));
    const archiveBefore = await getArchivedTickets(workspace.id);
    check(
      "new ticket is absent from the archive query",
      !archiveBefore.some((t) => t.id === ticket.id),
    );

    // Archive it (row + the activity row the archive action would write).
    await prisma.$transaction([
      prisma.ticket.update({ where: { id: ticket.id }, data: { archived: true } }),
      prisma.ticketActivity.create({
        data: { ticketId: ticket.id, actorId: user.id, kind: "archived" },
      }),
    ]);

    const boardAfter = await getTicketsPage(workspace.id, { take: BOARD_PAGE_SIZE });
    check(
      "archived ticket disappears from the board query",
      !boardAfter.tickets.some((t) => t.id === ticket.id),
    );

    const archiveAfter = await getArchivedTickets(workspace.id);
    const entry = archiveAfter.find((t) => t.id === ticket.id);
    check("archived ticket appears in the archive query", Boolean(entry), ticket.key);
    check("archive query reports who archived it", entry?.archivedByName === user.name);
    check(
      "archive query reports when it was archived",
      entry !== undefined && !Number.isNaN(entry.archivedAt.getTime()),
    );

    // Restore it (row + the activity row the restore action would write).
    await prisma.$transaction([
      prisma.ticket.update({ where: { id: ticket.id }, data: { archived: false } }),
      prisma.ticketActivity.create({
        data: { ticketId: ticket.id, actorId: user.id, kind: "restored" },
      }),
    ]);

    const boardRestored = await getTicketsPage(workspace.id, { take: BOARD_PAGE_SIZE });
    check(
      "restored ticket is back on the board query",
      boardRestored.tickets.some((t) => t.id === ticket.id),
    );
    const archiveRestored = await getArchivedTickets(workspace.id);
    check(
      "restored ticket is gone from the archive query",
      !archiveRestored.some((t) => t.id === ticket.id),
    );
  } finally {
    await prisma.ticket.delete({ where: { id: ticket.id } });
    await prisma.$disconnect();
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

void main();
