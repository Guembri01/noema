/**
 * Demo data for the ticket tracker: workspace labels, three cycles and a
 * realistic backlog with estimates, dates, relations, comments and activity.
 *
 * This lives in its own module because two callers need the same data: the
 * workspace seed (`prisma/seed.ts`, run by `npm run db:seed`) and the opt-in
 * top-up script (`scripts/seed-demo-tickets.mjs`, `npm run seed:tickets`) that
 * fills in the backlog for a workspace seeded before tickets existed.
 *
 * The function is a no-op when the workspace already has tickets, so both
 * callers are safe to run repeatedly.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { keyPrefix, ticketKey } from "../src/lib/tickets";
import { doc, p, text } from "./demo-blocks";

export type TicketLabelSpec = { name: string; color: string; description: string };

export const ticketLabelSpecs: TicketLabelSpec[] = [
  { name: "bug", color: "red", description: "Something is broken" },
  { name: "feature", color: "purple", description: "New capability" },
  { name: "docs", color: "blue", description: "Documentation and changelog work" },
  { name: "editor", color: "green", description: "Blocks and the editing surface" },
  { name: "performance", color: "orange", description: "Speed, memory and bundle size" },
  { name: "auth", color: "yellow", description: "Sign-in, sessions, roles" },
  { name: "api", color: "pink", description: "Public REST API and webhooks" },
  { name: "search", color: "blue", description: "Workspace search and indexing" },
  { name: "design", color: "purple", description: "Visual design and polish" },
  { name: "infra", color: "gray", description: "Build, deploy, database, operations" },
  { name: "chore", color: "gray", description: "Maintenance and housekeeping" },
];

export type TicketCycleSpec = {
  name: string;
  startDate: string;
  endDate: string;
  goal: string;
};

export const ticketCycleSpecs: TicketCycleSpec[] = [
  {
    name: "Sprint 21 — Editor performance",
    startDate: "2026-09-29",
    endDate: "2026-10-13",
    goal: "Keystroke latency under 20 ms on the 5,000-block test page.",
  },
  {
    name: "Sprint 22 — v2.0 launch",
    startDate: "2026-10-13",
    endDate: "2026-10-27",
    goal: "Ship inline databases, the changelog and the launch post.",
  },
  {
    name: "Sprint 23 — Public API",
    startDate: "2026-10-27",
    endDate: "2026-11-10",
    goal: "Read endpoints for pages, databases and tickets behind scoped tokens.",
  },
];

export type TicketSpec = {
  title: string;
  description: string;
  type: "task" | "bug" | "feature" | "epic" | "chore";
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";
  priority: "urgent" | "high" | "medium" | "low" | "none";
  estimate: number | null;
  unit?: "points" | "hours" | "days";
  start?: string;
  due?: string;
  labels: string[];
  /** User handle (`demo`, `amara`, …) or omitted for "unassigned". */
  assignee?: string;
  /** Project handle (`atlas`, `mobile`, `website`, `design-system`). */
  project?: string;
  /** Milestone name inside that project. */
  milestone?: string;
  /** Cycle name. */
  cycle?: string;
};

/** The backlog. Dates straddle "today" (16 Oct 2026) so the timeline reads live. */
export const ticketSpecs: TicketSpec[] = [
  {
    title: "Ship the inline-database block",
    description:
      "Land the linkedDatabase node behind the editor flag, with the source chip and a compact layout below 480px. Beta cohort is the design partners.",
    type: "feature",
    status: "in_progress",
    priority: "urgent",
    estimate: 8,
    start: "2026-10-13",
    due: "2026-10-23",
    labels: ["feature", "editor"],
    assignee: "louis",
    project: "atlas",
    milestone: "v2.0 launch",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Write the v2.0 changelog",
    description:
      "One entry per user-visible change, with a screenshot for inline databases and the chart views. Link the migration note.",
    type: "task",
    status: "in_progress",
    priority: "medium",
    estimate: 3,
    start: "2026-10-14",
    due: "2026-10-19",
    labels: ["docs"],
    assignee: "priya",
    project: "website",
    milestone: "v2.0 launch",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Chart view: axis labels and value tooltips",
    description:
      "Findings from usability testing: people read the charts as decoration. Add axis labels, a legend and a hover tooltip with the exact value.",
    type: "feature",
    status: "in_review",
    priority: "medium",
    estimate: 5,
    start: "2026-10-08",
    due: "2026-10-16",
    labels: ["feature", "design"],
    assignee: "priya",
    project: "atlas",
    milestone: "v2.0 launch",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Duplicated rows when two people paste at once",
    description:
      "Pasting a block of rows while a collaborator pastes into the same view duplicates every row. Reproducible with two browsers on the same page.",
    type: "bug",
    status: "in_progress",
    priority: "urgent",
    estimate: 5,
    start: "2026-10-15",
    due: "2026-10-18",
    labels: ["bug", "editor"],
    assignee: "louis",
    project: "atlas",
    milestone: "v2.0 launch",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Timeline drag does not snap to the week",
    description:
      "Dragging a bar in the Timeline view lands on an arbitrary day. It should snap to the week when the zoom level is monthly.",
    type: "bug",
    status: "in_progress",
    priority: "high",
    estimate: 5,
    start: "2026-10-12",
    due: "2026-10-20",
    labels: ["bug", "design"],
    assignee: "priya",
    project: "atlas",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Board WIP limits are forgotten per view",
    description:
      "A per-column WIP limit is saved on the board but lost after a reload. It should persist with the rest of the view config.",
    type: "bug",
    status: "todo",
    priority: "medium",
    estimate: 3,
    start: "2026-10-19",
    due: "2026-10-23",
    labels: ["bug", "editor"],
    assignee: "tomas",
    project: "atlas",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Export: put destructive options behind a disclosure",
    description:
      "The export screen lists \"delete everything\" next to the happy path. Collapse destructive options behind a disclosure.",
    type: "task",
    status: "todo",
    priority: "low",
    estimate: 2,
    start: "2026-10-20",
    due: "2026-10-24",
    labels: ["design", "docs"],
    assignee: "priya",
    project: "website",
  },
  {
    title: "Add the source chip to embedded databases",
    description:
      "Every embed needs a visible link back to the database it reads from, so nobody edits a view believing it is a copy.",
    type: "task",
    status: "in_review",
    priority: "low",
    estimate: 1,
    start: "2026-10-09",
    due: "2026-10-15",
    labels: ["design", "editor"],
    assignee: "priya",
    project: "atlas",
    milestone: "v2.0 launch",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Onboarding tour: five steps",
    description:
      "From an empty workspace to a page with a database in five steps, each skippable and never shown twice.",
    type: "task",
    status: "in_progress",
    priority: "medium",
    estimate: 5,
    start: "2026-10-06",
    due: "2026-10-22",
    labels: ["docs", "design"],
    assignee: "sofia",
    project: "website",
  },
  {
    title: "Write the launch blog post",
    description:
      "Nine hundred words, one screenshot, one sentence of story: \"Your databases, inside your documents.\"",
    type: "task",
    status: "in_progress",
    priority: "medium",
    estimate: 3,
    start: "2026-10-13",
    due: "2026-10-19",
    labels: ["docs"],
    assignee: "sofia",
    project: "website",
    milestone: "v2.0 launch",
    cycle: "Sprint 22 — v2.0 launch",
  },
  {
    title: "Virtualise the sidebar for 2,000+ pages",
    description:
      "The sidebar mounts every top-level page. On a workspace with 2,000 pages the first paint is 900 ms; render only what is visible.",
    type: "task",
    status: "in_progress",
    priority: "high",
    estimate: 8,
    start: "2026-10-05",
    due: "2026-10-26",
    labels: ["performance", "editor"],
    assignee: "tomas",
    project: "atlas",
  },
  {
    title: "Sessions: rotate the signing key without logging everyone out",
    description:
      "Accept two signing keys during a rotation window so a key change is not a mass sign-out.",
    type: "chore",
    status: "todo",
    priority: "high",
    estimate: 5,
    start: "2026-10-20",
    due: "2026-10-30",
    labels: ["auth", "infra"],
    assignee: "louis",
    project: "atlas",
  },
  {
    title: "Recurring database templates run twice on a DST change",
    description:
      "A weekly template created before the clocks change fires twice the following week. The scheduler compares local times.",
    type: "bug",
    status: "todo",
    priority: "high",
    estimate: 3,
    start: "2026-10-19",
    due: "2026-10-27",
    labels: ["bug", "infra"],
    assignee: "tomas",
    project: "atlas",
  },
  {
    title: "Dark theme: callout colours fail contrast",
    description:
      "Three callout colours drop below 4.5:1 against the dark surface. Adjust the token, not the component.",
    type: "bug",
    status: "todo",
    priority: "medium",
    estimate: 2,
    start: "2026-10-21",
    due: "2026-10-28",
    labels: ["bug", "design"],
    assignee: "priya",
    project: "design-system",
  },
  {
    title: "Reduce the desktop bundle by 30 MB",
    description:
      "The installer is 73 MB. Strip unused locales from the payload and drop the duplicated Postgres client build.",
    type: "chore",
    status: "todo",
    priority: "medium",
    estimate: 5,
    start: "2026-10-22",
    due: "2026-11-06",
    labels: ["performance", "infra"],
    assignee: "tomas",
    project: "atlas",
  },
  {
    title: "Pricing page: annual toggle",
    description: "Add a monthly/annual switch with the two-month discount shown on the annual price.",
    type: "feature",
    status: "todo",
    priority: "low",
    estimate: 3,
    start: "2026-10-23",
    due: "2026-11-04",
    labels: ["feature", "design"],
    assignee: "sofia",
    project: "website",
  },
  {
    title: "Community feature requests triage",
    description:
      "Go through the open feature requests, merge the duplicates, and reply to everyone who voted.",
    type: "task",
    status: "in_progress",
    priority: "low",
    estimate: 2,
    start: "2026-10-12",
    due: "2026-10-17",
    labels: ["chore"],
    assignee: "amara",
  },
  {
    title: "Hire: founding designer spec",
    description:
      "Write the role, the first ninety days and the interview loop so the posting can go out before the launch.",
    type: "task",
    status: "todo",
    priority: "high",
    estimate: 3,
    start: "2026-10-14",
    due: "2026-10-18",
    labels: ["chore"],
    assignee: "amara",
  },
  {
    title: "Audit log: filter by actor",
    description: "Filter the workspace audit log by the person who made the change, with a date range.",
    type: "feature",
    status: "todo",
    priority: "low",
    estimate: 5,
    start: "2026-10-26",
    due: "2026-11-13",
    labels: ["feature", "infra"],
    assignee: "louis",
    project: "atlas",
  },
  {
    title: "Search: filter by type (page, ticket, comment)",
    description:
      "The most requested addition in interviews. Add a type filter to the search panel and remember it per user.",
    type: "feature",
    status: "backlog",
    priority: "medium",
    estimate: 8,
    labels: ["feature", "search"],
    assignee: "tomas",
    project: "atlas",
  },
  {
    title: "Public API v1: read endpoints",
    description:
      "GET for pages, databases, rows and tickets, with cursor pagination and scoped tokens. Write endpoints follow in v1.1.",
    type: "feature",
    status: "backlog",
    priority: "high",
    estimate: 13,
    labels: ["feature", "api"],
    assignee: "louis",
    project: "atlas",
    cycle: "Sprint 23 — Public API",
  },
  {
    title: "Rate-limit the public API",
    description: "Per-token sliding window, 600 requests a minute, with a clear 429 and Retry-After.",
    type: "chore",
    status: "backlog",
    priority: "medium",
    estimate: 3,
    labels: ["api", "infra"],
    assignee: "louis",
    project: "atlas",
    cycle: "Sprint 23 — Public API",
  },
  {
    title: "Add webhook documentation with a worked example",
    description:
      "Signature verification, the event catalogue and a curl example that actually runs against a local instance.",
    type: "task",
    status: "backlog",
    priority: "none",
    estimate: 3,
    labels: ["docs", "api"],
    assignee: "priya",
    project: "atlas",
    cycle: "Sprint 23 — Public API",
  },
  {
    title: "Two-factor: recovery codes",
    description:
      "Ten single-use recovery codes, stored hashed, shown once. Needed before we can call 2FA complete.",
    type: "feature",
    status: "backlog",
    priority: "medium",
    estimate: 8,
    labels: ["feature", "auth"],
    assignee: "louis",
    project: "atlas",
  },
  {
    title: "Bookmark previews on paywalled sites",
    description: "Fall back to the page title and favicon when the metadata fetch is blocked.",
    type: "bug",
    status: "backlog",
    priority: "low",
    estimate: 2,
    labels: ["bug"],
    assignee: "tomas",
    project: "atlas",
  },
  {
    title: "Custom emoji picker is slow on large sets",
    description: "Searching 1,800 emoji re-renders every row. Debounce and window the list.",
    type: "bug",
    status: "backlog",
    priority: "low",
    estimate: 2,
    labels: ["bug", "performance"],
    assignee: "priya",
    project: "design-system",
  },
  {
    title: "Mobile: offline draft queue",
    description:
      "Queue edits made while offline and replay them on reconnect, with a visible pending state.",
    type: "epic",
    status: "backlog",
    priority: "none",
    estimate: 21,
    labels: ["feature"],
    assignee: "tomas",
    project: "mobile",
    milestone: "v1.0",
  },
  {
    title: "Mobile: share sheet target",
    description: "Let the OS share sheet send a link straight into a page on the mobile app.",
    type: "feature",
    status: "todo",
    priority: "low",
    estimate: 5,
    start: "2026-10-26",
    due: "2026-11-13",
    labels: ["feature"],
    assignee: "tomas",
    project: "mobile",
    milestone: "v1.0",
  },
  {
    title: "Fix login redirect loop on expired sessions",
    description:
      "Refreshing with a stale cookie bounced between /login and the workspace. The middleware now refreshes before it redirects.",
    type: "bug",
    status: "done",
    priority: "urgent",
    estimate: 3,
    start: "2026-10-01",
    due: "2026-10-03",
    labels: ["bug", "auth"],
    assignee: "louis",
    project: "atlas",
  },
  {
    title: "Keyboard: ⌘K opens search from any page",
    description: "One shortcut, from anywhere, including inside the editor and a ticket drawer.",
    type: "task",
    status: "done",
    priority: "low",
    estimate: 2,
    start: "2026-10-05",
    due: "2026-10-07",
    labels: ["editor"],
    assignee: "priya",
    project: "atlas",
  },
  {
    title: "Migrate the search index to GIN",
    description: "Postgres full-text search over a maintained searchText column, with a GIN index.",
    type: "chore",
    status: "done",
    priority: "high",
    estimate: 5,
    start: "2026-09-30",
    due: "2026-10-02",
    labels: ["search", "infra"],
    assignee: "tomas",
    project: "atlas",
    cycle: "Sprint 21 — Editor performance",
  },
  {
    title: "Document the tickets API",
    description: "Every action on GET/POST /api/tickets with an example payload and a response.",
    type: "task",
    status: "done",
    priority: "low",
    estimate: 2,
    start: "2026-09-29",
    due: "2026-10-01",
    labels: ["docs", "api"],
    assignee: "priya",
    project: "atlas",
    cycle: "Sprint 21 — Editor performance",
  },
  {
    title: "Rotate the demo SMTP credentials",
    description: "Rotated as part of the mail hardening pass; the old key is revoked.",
    type: "chore",
    status: "done",
    priority: "medium",
    estimate: 1,
    unit: "hours",
    start: "2026-09-28",
    due: "2026-09-28",
    labels: ["chore", "infra"],
    assignee: "louis",
  },
  {
    title: "Rebuild the marketing site in a new framework",
    description:
      "Cancelled: the current site is fast enough and the rebuild would have cost two sprints for no user-visible gain.",
    type: "chore",
    status: "cancelled",
    priority: "none",
    estimate: null,
    labels: ["chore"],
    assignee: "amara",
    project: "website",
  },
];

/** `[from, to, type]` — resolved by ticket title. */
export const ticketRelationSpecs: [string, string, string][] = [
  ["Public API v1: read endpoints", "Rate-limit the public API", "blocked_by"],
  ["Ship the inline-database block", "Duplicated rows when two people paste at once", "blocked_by"],
  ["Virtualise the sidebar for 2,000+ pages", "Reduce the desktop bundle by 30 MB", "relates"],
  ["Search: filter by type (page, ticket, comment)", "Audit log: filter by actor", "relates"],
  ["Bookmark previews on paywalled sites", "Custom emoji picker is slow on large sets", "relates"],
];

/** Comments keyed by ticket title. `author` is a user handle. */
export const ticketCommentSpecs: {
  ticket: string;
  author: string;
  body: string;
  daysAgo: number;
}[] = [
  {
    ticket: "Ship the inline-database block",
    author: "priya",
    body: "The compact layout is in — the header collapses below 480px. Screenshot attached in the spec page.",
    daysAgo: 3,
  },
  {
    ticket: "Ship the inline-database block",
    author: "amara",
    body: "Please keep the source chip visible in compact mode too. That was the finding that mattered most.",
    daysAgo: 2,
  },
  {
    ticket: "Duplicated rows when two people paste at once",
    author: "tomas",
    body: "Reproduced with two browsers: both paste transactions read the same row count before either commits.",
    daysAgo: 2,
  },
  {
    ticket: "Duplicated rows when two people paste at once",
    author: "louis",
    body: "Taking it — the fix is to take the position lock before reading the count. Regression test first.",
    daysAgo: 1,
  },
  {
    ticket: "Fix login redirect loop on expired sessions",
    author: "louis",
    body: "Added a regression test for the loop before closing. Middleware refreshes, then redirects once.",
    daysAgo: 13,
  },
  {
    ticket: "Public API v1: read endpoints",
    author: "amara",
    body: "Blocked on rate limiting — let's land that first so we never ship an unthrottled endpoint.",
    daysAgo: 1,
  },
  {
    ticket: "Chart view: axis labels and value tooltips",
    author: "priya",
    body: "Axis labels landed; tooltips are in review. The palette now derives from the grouped property's colours.",
    daysAgo: 4,
  },
];

/** `[ticket, actor, kind, detail]` — extra activity beyond the "created" entry. */
export const ticketActivitySpecs: {
  ticket: string;
  actor: string;
  kind: string;
  detail?: Record<string, unknown>;
  daysAgo: number;
}[] = [
  {
    ticket: "Ship the inline-database block",
    actor: "louis",
    kind: "status_changed",
    detail: { from: "todo", to: "in_progress" },
    daysAgo: 3,
  },
  {
    ticket: "Ship the inline-database block",
    actor: "amara",
    kind: "commented",
    daysAgo: 2,
  },
  {
    ticket: "Duplicated rows when two people paste at once",
    actor: "louis",
    kind: "assignee_changed",
    detail: { from: null, to: "Louis Marchand" },
    daysAgo: 1,
  },
  {
    ticket: "Chart view: axis labels and value tooltips",
    actor: "priya",
    kind: "status_changed",
    detail: { from: "in_progress", to: "in_review" },
    daysAgo: 2,
  },
  {
    ticket: "Fix login redirect loop on expired sessions",
    actor: "louis",
    kind: "status_changed",
    detail: { from: "in_progress", to: "done" },
    daysAgo: 13,
  },
  {
    ticket: "Virtualise the sidebar for 2,000+ pages",
    actor: "tomas",
    kind: "estimate_changed",
    detail: { from: 5, to: 8 },
    daysAgo: 5,
  },
];

export type TicketSeedContext = {
  workspace: { id: string; name: string; ticketCounter: number };
  /** Seed handle → user id (`demo`, `amara`, `louis`, `priya`, `tomas`, `sofia`). */
  users: Record<string, string>;
  /** Seed handle → project id (`atlas`, `mobile`, `website`, `design-system`). */
  projects?: Record<string, string>;
  /** Milestone name → milestone id. */
  milestones?: Record<string, string>;
};

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/**
 * Create the labels, cycles, tickets, relations, comments and activity for a
 * workspace. Returns the number of tickets created (0 when the workspace
 * already had tickets, so the caller can report "skipped").
 */
export async function seedDemoTickets(
  prisma: PrismaClient,
  context: TicketSeedContext,
): Promise<number> {
  const { workspace, users } = context;
  const projects = context.projects ?? {};
  const milestones = context.milestones ?? {};

  const existing = await prisma.ticket.count({ where: { workspaceId: workspace.id } });
  if (existing > 0) return 0;

  // --- labels ---------------------------------------------------------------
  const labelIds: Record<string, string> = {};
  for (const spec of ticketLabelSpecs) {
    const label = await prisma.label.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name: spec.name } },
      update: { color: spec.color, description: spec.description },
      create: { workspaceId: workspace.id, ...spec },
      select: { id: true },
    });
    labelIds[spec.name] = label.id;
  }

  // --- cycles ---------------------------------------------------------------
  const cycleIds: Record<string, string> = {};
  for (const spec of ticketCycleSpecs) {
    const cycle = await prisma.cycle.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name: spec.name } },
      update: { startDate: new Date(spec.startDate), endDate: new Date(spec.endDate), goal: spec.goal },
      create: {
        workspaceId: workspace.id,
        name: spec.name,
        startDate: new Date(spec.startDate),
        endDate: new Date(spec.endDate),
        goal: spec.goal,
      },
      select: { id: true },
    });
    cycleIds[spec.name] = cycle.id;
  }

  // --- tickets --------------------------------------------------------------
  const prefix = keyPrefix(workspace.name);
  const demoUserId = users.demo;
  let counter = workspace.ticketCounter;
  let position = 1000;
  const created: { id: string; key: string; title: string }[] = [];

  for (const spec of ticketSpecs) {
    counter += 1;
    const ticket = await prisma.ticket.create({
      data: {
        workspaceId: workspace.id,
        number: counter,
        key: ticketKey(prefix, counter),
        title: spec.title,
        description: doc(p(text(spec.description))) as unknown as Prisma.InputJsonValue,
        type: spec.type,
        status: spec.status,
        priority: spec.priority,
        estimate: spec.estimate,
        estimateUnit: spec.unit ?? "points",
        startDate: spec.start ? new Date(spec.start) : null,
        dueDate: spec.due ? new Date(spec.due) : null,
        completedAt: spec.status === "done" ? new Date(`${spec.due ?? spec.start ?? "2026-10-01"}T12:00:00Z`) : null,
        projectId: spec.project ? (projects[spec.project] ?? null) : null,
        milestoneId: spec.milestone ? (milestones[spec.milestone] ?? null) : null,
        cycleId: spec.cycle ? (cycleIds[spec.cycle] ?? null) : null,
        assigneeId: spec.assignee ? (users[spec.assignee] ?? null) : null,
        reporterId: demoUserId,
        position,
        labels: { create: spec.labels.map((name) => ({ labelId: labelIds[name] })) },
      },
      select: { id: true, key: true, title: true },
    });
    position += 1000;
    created.push(ticket);
  }

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { ticketCounter: counter },
  });

  const byTitle = Object.fromEntries(created.map((ticket) => [ticket.title, ticket]));

  // --- relations ------------------------------------------------------------
  for (const [from, to, type] of ticketRelationSpecs) {
    if (!byTitle[from] || !byTitle[to]) continue;
    await prisma.ticketRelation.create({
      data: { fromId: byTitle[from].id, toId: byTitle[to].id, type },
    });
  }

  // --- comments -------------------------------------------------------------
  for (const spec of ticketCommentSpecs) {
    const ticket = byTitle[spec.ticket];
    if (!ticket) continue;
    await prisma.ticketComment.create({
      data: {
        ticketId: ticket.id,
        authorId: users[spec.author] ?? demoUserId,
        body: spec.body,
        createdAt: daysAgo(spec.daysAgo),
      },
    });
  }

  // --- activity -------------------------------------------------------------
  for (const spec of ticketActivitySpecs) {
    const ticket = byTitle[spec.ticket];
    if (!ticket) continue;
    await prisma.ticketActivity.create({
      data: {
        ticketId: ticket.id,
        actorId: users[spec.actor] ?? demoUserId,
        kind: spec.kind,
        detail: (spec.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        createdAt: daysAgo(spec.daysAgo),
      },
    });
  }

  // --- created activity -----------------------------------------------------
  await prisma.ticketActivity.createMany({
    data: created.map((ticket, index) => ({
      ticketId: ticket.id,
      actorId: demoUserId,
      kind: "created",
      detail: { seeded: true },
      createdAt: daysAgo(20 - Math.min(index, 19)),
    })),
  });

  return created.length;
}
