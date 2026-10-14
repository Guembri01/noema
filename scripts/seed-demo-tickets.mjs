// Opt-in demo data for the ticket tracker: workspace labels, a realistic
// backlog with estimates + timeline dates, relations, comments and activity.
// Idempotent: it skips entirely if the workspace already has tickets.
//
//   node --env-file=.env scripts/seed-demo-tickets.mjs
//
import { PrismaClient } from "@prisma/client";
import { keyPrefix, ticketKey } from "../src/lib/tickets.ts";

const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
if (!user) {
  console.error("Run `npm run db:seed` first (no demo user found).");
  process.exit(1);
}
const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
if (!workspace) {
  console.error("Demo workspace not found. Run `npm run db:seed` first.");
  process.exit(1);
}

const existing = await prisma.ticket.count({ where: { workspaceId: workspace.id } });
if (existing > 0) {
  console.log(`Skipped: ${existing} ticket(s) already exist in ${workspace.slug}.`);
  await prisma.$disconnect();
  process.exit(0);
}

// --- labels -----------------------------------------------------------------
const labelSpec = [
  { name: "bug", color: "red", description: "Something is broken" },
  { name: "feature", color: "purple", description: "New capability" },
  { name: "docs", color: "blue", description: "Documentation work" },
  { name: "editor", color: "green", description: "Blocks & editing surface" },
  { name: "performance", color: "orange", description: "Speed and memory" },
  { name: "auth", color: "yellow", description: "Sign-in, sessions, roles" },
  { name: "chore", color: "gray", description: "Maintenance" },
];
const labels = {};
for (const spec of labelSpec) {
  const label = await prisma.label.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: spec.name } },
    update: { color: spec.color, description: spec.description },
    create: { workspaceId: workspace.id, ...spec },
    select: { id: true },
  });
  labels[spec.name] = label.id;
}

// --- where the work lives ---------------------------------------------------
const project = await prisma.project.findFirst({
  where: { workspaceId: workspace.id },
  orderBy: { createdAt: "asc" },
  select: { id: true, milestones: { orderBy: { position: "asc" }, select: { id: true } } },
});
const milestoneId = project?.milestones[0]?.id ?? null;

// --- tickets ----------------------------------------------------------------
const doc = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const backlog = [
  {
    title: "Login redirect loops on expired sessions",
    type: "bug",
    status: "in_progress",
    priority: "urgent",
    estimate: 3,
    estimateUnit: "points",
    startDate: "2026-03-02",
    dueDate: "2026-03-06",
    labels: ["bug", "auth"],
    description: "Refreshing with a stale cookie bounces between /login and /w/demo-workspace. Trace the middleware.",
  },
  {
    title: "Inline databases on any page",
    type: "feature",
    status: "in_review",
    priority: "high",
    estimate: 8,
    estimateUnit: "points",
    startDate: "2026-03-01",
    dueDate: "2026-03-20",
    labels: ["feature", "editor"],
    description: "A linked database view that renders inside a normal page, with its own view switcher.",
  },
  {
    title: "Write the onboarding tour",
    type: "task",
    status: "todo",
    priority: "medium",
    estimate: 5,
    estimateUnit: "points",
    startDate: "2026-03-05",
    dueDate: "2026-03-15",
    labels: ["docs"],
    description: "Five steps that take a new workspace from empty to a page with a database.",
  },
  {
    title: "Bookmark previews fail on paywalled sites",
    type: "bug",
    status: "todo",
    priority: "low",
    estimate: 2,
    estimateUnit: "points",
    startDate: "2026-03-10",
    dueDate: "2026-03-12",
    labels: ["bug"],
    description: "Falling back to the page title when metadata is blocked would be enough.",
  },
  {
    title: "Virtualise long page lists",
    type: "task",
    status: "backlog",
    priority: "low",
    estimate: 13,
    estimateUnit: "points",
    startDate: null,
    dueDate: null,
    labels: ["performance", "editor"],
    description: "Render only the visible blocks in the sidebar and long documents.",
  },
  {
    title: "Public page analytics opt-in",
    type: "feature",
    status: "backlog",
    priority: "none",
    estimate: null,
    estimateUnit: "points",
    startDate: null,
    dueDate: null,
    labels: ["feature"],
    description: "Off by default — the instance owner can enable aggregate view counts per shared page.",
  },
  {
    title: "Rotate the demo SMTP credentials",
    type: "chore",
    status: "done",
    priority: "medium",
    estimate: 1,
    estimateUnit: "hours",
    startDate: "2026-02-25",
    dueDate: "2026-02-26",
    labels: ["chore"],
    description: "Done as part of the mail hardening pass.",
  },
  {
    title: "Document the tickets API",
    type: "task",
    status: "done",
    priority: "low",
    estimate: 2,
    estimateUnit: "points",
    startDate: "2026-02-20",
    dueDate: "2026-02-24",
    labels: ["docs"],
    description: "Every action on GET/POST /api/tickets with an example payload.",
  },
];

const prefix = keyPrefix(workspace.name);
let counter = workspace.ticketCounter;
const created = [];
let position = 1000;

for (const item of backlog) {
  counter += 1;
  const ticket = await prisma.ticket.create({
    data: {
      workspaceId: workspace.id,
      number: counter,
      key: ticketKey(prefix, counter),
      title: item.title,
      description: doc(item.description),
      type: item.type,
      status: item.status,
      priority: item.priority,
      estimate: item.estimate,
      estimateUnit: item.estimateUnit,
      startDate: item.startDate ? new Date(item.startDate) : null,
      dueDate: item.dueDate ? new Date(item.dueDate) : null,
      completedAt: item.status === "done" ? new Date(`${item.dueDate ?? "2026-03-01"}T12:00:00Z`) : null,
      projectId: project?.id ?? null,
      milestoneId: milestoneId,
      assigneeId: counter % 3 === 0 ? null : user.id,
      reporterId: user.id,
      position,
      labels: { create: item.labels.map((name) => ({ labelId: labels[name] })) },
    },
    select: { id: true, key: true, title: true },
  });
  position += 1000;
  created.push(ticket);
  await prisma.ticketActivity.create({
    data: { ticketId: ticket.id, actorId: user.id, kind: "created", detail: { seeded: true } },
  });
}

await prisma.workspace.update({
  where: { id: workspace.id },
  data: { ticketCounter: counter },
});

// --- relations, comments, activity -----------------------------------------
const byTitle = Object.fromEntries(created.map((ticket) => [ticket.title, ticket]));

const relationPairs = [
  ["Inline databases on any page", "Login redirect loops on expired sessions", "blocked_by"],
  ["Write the onboarding tour", "Document the tickets API", "relates"],
  ["Virtualise long page lists", "Bookmark previews fail on paywalled sites", "relates"],
];
for (const [from, to, type] of relationPairs) {
  if (!byTitle[from] || !byTitle[to]) continue;
  await prisma.ticketRelation.create({ data: { fromId: byTitle[from].id, toId: byTitle[to].id, type } });
}

const login = byTitle["Login redirect loops on expired sessions"];
if (login) {
  await prisma.ticketComment.createMany({
    data: [
      { ticketId: login.id, authorId: user.id, body: "Reproduced locally: the cookie is refreshed but the redirect target is stale." },
      { ticketId: login.id, authorId: user.id, body: "Fix is in review — let's add a regression test for the loop before closing." },
    ],
  });
  await prisma.ticketActivity.createMany({
    data: [
      { ticketId: login.id, actorId: user.id, kind: "status_changed", detail: { from: "todo", to: "in_progress" } },
      { ticketId: login.id, actorId: user.id, kind: "commented" },
    ],
  });
}

console.log(`Seeded ${created.length} tickets and ${labelSpec.length} labels in ${workspace.slug}.`);
console.log(created.map((ticket) => `  ${ticket.key}  ${ticket.title}`).join("\n"));
await prisma.$disconnect();
