// Opt-in demo backlog for the ticket tracker.
//
// The workspace seed (`npm run db:seed`) already creates this backlog. This
// script exists for a workspace that was seeded *before* tickets were part of
// the seed: it adds the same labels, cycles and tickets, and skips entirely if
// the workspace already has tickets. Both callers share the data and the
// writer in `prisma/demo-tickets.ts`, so the two paths cannot drift.
//
//   npm run seed:tickets
//
// It runs through `tsx` rather than plain Node because the modules it imports
// use the project's `@/` path alias and extensionless specifiers, which Node's
// type stripping does not resolve.
import { PrismaClient } from "@prisma/client";
import {
  seedDemoTickets,
  ticketCycleSpecs,
  ticketLabelSpecs,
} from "../prisma/demo-tickets.ts";

const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
if (!user) {
  console.error("Run `npm run db:seed` first (no demo user found).");
  await prisma.$disconnect();
  process.exit(1);
}

const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
if (!workspace) {
  console.error("Demo workspace not found. Run `npm run db:seed` first.");
  await prisma.$disconnect();
  process.exit(1);
}

// Resolve the people and the projects the backlog names, by handle. Anything
// that cannot be resolved is simply left unlinked by the shared writer.
const members = await prisma.workspaceMember.findMany({
  where: { workspaceId: workspace.id },
  include: { user: { select: { id: true, email: true } } },
});
const users = {};
for (const member of members) {
  const handle = member.user.email.split("@")[0];
  if (handle) users[handle] = member.user.id;
}

const PROJECT_KEYWORDS = {
  atlas: "atlas",
  mobile: "mobile",
  website: "website",
  "design-system": "design system",
};
const projects = {};
const milestones = {};
const projectRows = await prisma.project.findMany({
  where: { workspaceId: workspace.id },
  include: { milestones: { select: { id: true, name: true } } },
});
for (const project of projectRows) {
  const name = project.name.toLowerCase();
  const key = Object.keys(PROJECT_KEYWORDS).find((candidate) =>
    name.includes(PROJECT_KEYWORDS[candidate]),
  );
  if (key) projects[key] = project.id;
  for (const milestone of project.milestones) milestones[milestone.name] = milestone.id;
}

const created = await seedDemoTickets(prisma, {
  workspace: {
    id: workspace.id,
    name: workspace.name,
    ticketCounter: workspace.ticketCounter,
  },
  users,
  projects,
  milestones,
});

if (created === 0) {
  console.log("Skipped: this workspace already has tickets.");
} else {
  console.log(
    `Seeded ${created} tickets, ${ticketLabelSpecs.length} labels and ${ticketCycleSpecs.length} cycles in ${workspace.slug}.`,
  );
}

await prisma.$disconnect();
