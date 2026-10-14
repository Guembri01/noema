// Tickets end-to-end: labels, estimates, timeline dates, board movement,
// relations, comments and bulk edits — through the public API.
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const auth = { cookie: `noema_session=${session}` };
const json = { ...auth, "content-type": "application/json" };
const post = (body) =>
  fetch(`${base}/api/tickets`, { method: "POST", headers: json, body: JSON.stringify(body) });

const createdTicketIds = [];

const cleanup = async () => {
  await prisma.ticket.deleteMany({ where: { id: { in: createdTicketIds } } });
  await prisma.ticket.deleteMany({ where: { workspaceId: workspace.id, title: { contains: "check-" } } });
  await prisma.label.deleteMany({ where: { workspaceId: workspace.id, name: { startsWith: "check-" } } });
};
await cleanup();

check("tickets API requires authentication", (await fetch(`${base}/api/tickets?workspaceId=${workspace.id}`)).status === 401);

// --- labels -----------------------------------------------------------------
const labelRes = await post({ action: "label-create", workspaceId: workspace.id, name: "check-bug", color: "red" });
const label = await labelRes.json();
check("workspace label is created", labelRes.status === 200 && Boolean(label.id));

const dup = await post({ action: "label-create", workspaceId: workspace.id, name: "check-bug" });
check("duplicate label names are rejected", dup.status === 400);

// --- tickets with estimates + dates ----------------------------------------
const first = await post({
  action: "create",
  workspaceId: workspace.id,
  title: "check-ticket one",
  type: "bug",
  priority: "urgent",
  status: "todo",
  estimate: 5,
  estimateUnit: "points",
  startDate: "2026-02-01",
  dueDate: "2026-02-10",
  labelIds: [label.id],
}).then((response) => response.json());
createdTicketIds.push(first.id);
check("ticket is created with a key", Boolean(first.key) && /-[0-9]+$/.test(first.key), first.key);

const second = await post({
  action: "create",
  workspaceId: workspace.id,
  title: "check-ticket two",
  priority: "low",
  estimate: 2,
  estimateUnit: "hours",
}).then((response) => response.json());
createdTicketIds.push(second.id);
check("second ticket gets the next number", second.key !== first.key);

const listed = await fetch(`${base}/api/tickets?workspaceId=${workspace.id}`, { headers: auth }).then((r) => r.json());
const created = listed.tickets.find((ticket) => ticket.id === first.id);
check(
  "tickets come back with labels, estimate and dates",
  created?.labels.length === 1 &&
    created.labels[0].label.name === "check-bug" &&
    created.estimate === 5 &&
    created.dueDate?.slice(0, 10) === "2026-02-10",
);
check(
  "label usage count is tracked",
  listed.labels.find((row) => row.id === label.id)?._count.tickets === 1,
);

// --- edits, labels, movement, relations, comments --------------------------
const patched = await post({ action: "update", ticketId: first.id, estimate: 8, priority: "high" });
check("estimate and priority can be updated", patched.status === 200);

const detached = await post({ action: "label", ticketId: first.id, labelId: label.id });
const reattached = await post({ action: "label", ticketId: first.id, labelId: label.id });
check("labels toggle on and off", detached.status === 200 && reattached.status === 200);

const moved = await post({ action: "move", ticketId: first.id, status: "in_progress" });
const movedTicket = await prisma.ticket.findUnique({ where: { id: first.id }, select: { status: true, completedAt: true } });
check("board movement changes status", moved.status === 200 && movedTicket?.status === "in_progress");

const done = await post({ action: "move", ticketId: second.id, status: "done" });
const doneTicket = await prisma.ticket.findUnique({ where: { id: second.id }, select: { completedAt: true } });
check("closing a ticket stamps completedAt", done.status === 200 && Boolean(doneTicket?.completedAt));

const relation = await post({ action: "relation", fromId: first.id, toId: second.id, type: "blocks" });
const relations = await prisma.ticketRelation.count({ where: { fromId: first.id } });
check("tickets can be linked", relation.status === 200 && relations === 1);

const comment = await post({ action: "comment", ticketId: first.id, body: "check-comment" });
check("comments are recorded", comment.status === 200);

const bulk = await post({ action: "bulk", ticketIds: [first.id, second.id], priority: "medium" });
const bulkCount = await prisma.ticket.count({ where: { id: { in: [first.id, second.id] }, priority: "medium" } });
check("bulk update applies to every selected ticket", bulk.status === 200 && bulkCount === 2);

const activity = await prisma.ticketActivity.count({ where: { ticketId: first.id } });
check("activity log captures the changes", activity >= 4, `${activity} entries`);

// --- from a page, and archiving -------------------------------------------
const page = await prisma.page.findFirst({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true } });
const fromPage = await post({ action: "from-page", pageId: page.id }).then((response) => response.json());
createdTicketIds.push(fromPage.id);
check("a ticket can be created from a page", Boolean(fromPage.key));

const archived = await post({ action: "archive", ticketId: fromPage.id });
const archivedRow = await prisma.ticket.findUnique({ where: { id: fromPage.id }, select: { archived: true } });
check("tickets can be archived", archived.status === 200 && archivedRow?.archived === true);

const labelDelete = await post({ action: "label-delete", labelId: label.id });
check("labels can be deleted", labelDelete.status === 200);

// ordered key format check
check(
  "keys are ordered and prefixed from the workspace name",
  /^[A-Z]{1,4}-\d+$/.test(first.key) && Number(second.key.split("-")[1]) > Number(first.key.split("-")[1]),
);

await cleanup();
await prisma.$disconnect();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
