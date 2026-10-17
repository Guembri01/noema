/**
 * Noema demo seed — `npm run db:seed` (`tsx prisma/seed.ts`).
 *
 * Builds a complete, believable product team's workspace: six people, three
 * teamspaces, four projects with milestones, a page tree (handbook, specs,
 * meeting notes, research, onboarding), seven databases with views, rows,
 * relations and rollups, a full ticket backlog with cycles and labels, chat
 * threads, comments, history, notifications, a content calendar and sharing.
 *
 * Two rules keep this safe to run against a workspace the test suite knows:
 *
 *   1. **Additive.** The original demo user, workspace slug, "Getting started"
 *      page, "Editor tips" page and "Product roadmap" database are created
 *      exactly as the first seed made them, so the smoke test and the e2e
 *      suite keep passing.
 *   2. **Idempotent.** If the workspace already has pages the seed prints the
 *      credentials and returns — re-running never duplicates anything.
 *
 * The content lives in `demo-pages.ts` / `demo-databases.ts` / `demo-tickets.ts`;
 * this file is the engine that turns those specs into rows.
 */

// `Prisma` is imported as a value (not `import type`) because the seed uses the
// `Prisma.JsonNull` sentinel for nullable Json columns.
import { Prisma, PrismaClient, type WorkspaceRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createRelationPair, setRollupConfig } from "../src/lib/relation-pairs";
import { pageSearchText } from "../src/lib/search";
import { welcomeDoc } from "../src/lib/welcome";
import { databaseIntros, pageSpecs } from "./demo-pages";
import { databaseSpecs, relationPairs, rowLinks, type DbSpec } from "./demo-databases";
import { seedDemoTickets, ticketCycleSpecs, ticketLabelSpecs } from "./demo-tickets";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@noema.local";
const DEMO_PASSWORD = "password123";
const WORKSPACE_SLUG = "demo-workspace";

/** Json columns accept arbitrary documents; this keeps the casts in one place. */
const json = (value: unknown) => value as Prisma.InputJsonValue;

/** A cuid-shaped id, minted up front so relation configs can reference it. */
const newId = () => `c${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/* ------------------------------------------------------------------ people */

type PersonSpec = {
  handle: string;
  email: string;
  name: string;
  role: WorkspaceRole;
};

const people: PersonSpec[] = [
  { handle: "demo", email: DEMO_EMAIL, name: "Demo User", role: "OWNER" },
  { handle: "amara", email: "amara@noema.local", name: "Amara Okafor", role: "ADMIN" },
  { handle: "louis", email: "louis@noema.local", name: "Louis Marchand", role: "MEMBER" },
  { handle: "priya", email: "priya@noema.local", name: "Priya Raman", role: "MEMBER" },
  { handle: "tomas", email: "tomas@noema.local", name: "Tomás Ferreira", role: "MEMBER" },
  { handle: "sofia", email: "sofia@noema.local", name: "Sofia Lindqvist", role: "GUEST" },
];

/* -------------------------------------------------------------- teamspaces */

const teamspaceSpecs = [
  { key: "product", name: "Product", icon: "🧭", members: ["demo", "amara", "louis", "priya", "tomas"] },
  { key: "engineering", name: "Engineering", icon: "🛠️", members: ["demo", "louis", "tomas"] },
  { key: "marketing", name: "Marketing", icon: "📣", members: ["demo", "amara", "sofia"] },
];

/* ---------------------------------------------------------------- projects */

const projectSpecs = [
  {
    key: "atlas",
    name: "Atlas — web app v2.0",
    summary: "Inline databases, a faster editor and the public API.",
    description:
      "The flagship release: databases become first-class inside any page, the editor stops being the bottleneck on long documents, and the workspace opens up through a documented API.",
    status: "active",
    color: "blue",
    icon: "🛰️",
    owner: "amara",
    startDate: "2026-07-06",
    dueDate: "2026-12-18",
    members: ["amara", "louis", "priya", "tomas"],
    milestones: [
      { name: "v2.0 beta", status: "completed", dueDate: "2026-09-26", description: "Design partners on the flag." },
      { name: "v2.0 launch", status: "active", dueDate: "2026-10-20", description: "Public release with the changelog and docs." },
      { name: "Public API", status: "planned", dueDate: "2026-12-12", description: "Read endpoints, scoped tokens, webhooks." },
    ],
  },
  {
    key: "mobile",
    name: "Mobile app — iOS & Android",
    summary: "The workspace in your pocket, with an offline draft queue.",
    description:
      "A responsive shell around the same document model, plus an offline queue so notes taken on a train survive the tunnel.",
    status: "active",
    color: "purple",
    icon: "📱",
    owner: "tomas",
    startDate: "2026-09-01",
    dueDate: "2027-03-31",
    members: ["tomas", "priya"],
    milestones: [
      { name: "v1.0", status: "active", dueDate: "2027-01-30", description: "Read, edit and search on the phone." },
    ],
  },
  {
    key: "website",
    name: "Website redesign",
    summary: "A faster marketing site that tells one story.",
    description:
      "Fewer pages, one narrative, and a changelog that reads like it was written by a person. Performance budget: 100 kB of JavaScript on the landing page.",
    status: "active",
    color: "green",
    icon: "🌐",
    owner: "sofia",
    startDate: "2026-08-17",
    dueDate: "2026-11-30",
    members: ["sofia", "priya"],
    milestones: [
      { name: "Redesign launch", status: "active", dueDate: "2026-10-20", description: "Ships with v2.0." },
    ],
  },
  {
    key: "design-system",
    name: "Design system 2.0",
    summary: "Tokens, contrast and the component catalogue.",
    description:
      "One source of truth for colour, spacing and motion, with an accessibility pass on every surface — including the dark theme.",
    status: "planned",
    color: "orange",
    icon: "🎨",
    owner: "priya",
    startDate: "2026-11-02",
    dueDate: "2027-01-16",
    members: ["priya", "louis"],
    milestones: [
      { name: "Tokens v2", status: "planned", dueDate: "2026-12-05", description: "Colour and spacing tokens in one file." },
    ],
  },
];

/* --------------------------------------------------------------------- run */

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // --- users ---------------------------------------------------------------
  const users: Record<string, string> = {};
  for (const person of people) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: { name: person.name },
      create: { email: person.email, name: person.name, passwordHash, locale: "en", theme: "system" },
      select: { id: true },
    });
    users[person.handle] = user.id;
  }
  const demoUserId = users.demo;

  // --- workspace -----------------------------------------------------------
  let workspace = await prisma.workspace.findUnique({ where: { slug: WORKSPACE_SLUG } });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: "Demo Workspace",
        slug: WORKSPACE_SLUG,
        icon: "🚀",
        ownerId: demoUserId,
        members: { create: { userId: demoUserId, role: "OWNER" } },
      },
    });
  }

  for (const person of people) {
    if (person.handle === "demo") continue;
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: users[person.handle] } },
      update: { role: person.role },
      create: { workspaceId: workspace.id, userId: users[person.handle], role: person.role },
    });
  }

  const existingPages = await prisma.page.count({ where: { workspaceId: workspace.id } });
  if (existingPages > 0) {
    console.log(`Seed complete (workspace already populated). Demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    return;
  }

  // --- teamspaces ----------------------------------------------------------
  const teamspaces: Record<string, string> = {};
  for (const spec of teamspaceSpecs) {
    const teamspace = await prisma.teamspace.create({
      data: { workspaceId: workspace.id, name: spec.name, icon: spec.icon },
      select: { id: true },
    });
    teamspaces[spec.key] = teamspace.id;
    for (const handle of spec.members) {
      await prisma.teamspaceMember.create({
        data: { teamspaceId: teamspace.id, userId: users[handle], role: handle === "demo" ? "OWNER" : "MEMBER" },
      });
    }
  }

  // --- projects ------------------------------------------------------------
  const projects: Record<string, string> = {};
  const milestones: Record<string, string> = {};
  for (const [index, spec] of projectSpecs.entries()) {
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: spec.name,
        summary: spec.summary,
        description: spec.description,
        status: spec.status,
        color: spec.color,
        icon: spec.icon,
        ownerId: users[spec.owner],
        startDate: new Date(spec.startDate),
        dueDate: new Date(spec.dueDate),
        position: (index + 1) * 1000,
      },
      select: { id: true },
    });
    projects[spec.key] = project.id;
    for (const handle of spec.members) {
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: users[handle], role: handle === spec.owner ? "LEAD" : "MEMBER" },
      });
    }
    for (const [position, milestone] of spec.milestones.entries()) {
      const created = await prisma.milestone.create({
        data: {
          projectId: project.id,
          name: milestone.name,
          description: milestone.description,
          status: milestone.status,
          dueDate: new Date(milestone.dueDate),
          completedAt: milestone.status === "completed" ? new Date(milestone.dueDate) : null,
          position: (position + 1) * 1000,
        },
        select: { id: true },
      });
      milestones[milestone.name] = created.id;
    }
  }

  // --- the two original pages (preserved byte-for-byte) --------------------
  const gettingStarted = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: "Getting started",
      icon: "👋",
      createdById: demoUserId,
      content: json(welcomeDoc()),
      searchText: pageSearchText("Getting started", welcomeDoc()),
      position: 1000,
      isFavorite: true,
    },
  });

  await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      parentId: gettingStarted.id,
      title: "Editor tips",
      icon: "⌨️",
      createdById: demoUserId,
      position: 1000,
      content: json({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Editor tips" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Type / on an empty line for the block menu. Use the toolbar for formatting." },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "Markdown shortcuts: # (heading), - (list), > (quote), ``` (code).",
                      },
                    ],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "⌘/Ctrl+B, +I for bold and italic." }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      searchText: pageSearchText("Editor tips", null),
    },
  });

  // --- the document tree ---------------------------------------------------
  const pageIds: Record<string, string> = {};
  const pageTitles: Record<string, string> = {};
  for (const spec of pageSpecs) {
    const created = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        parentId: spec.parent ? (pageIds[spec.parent] ?? null) : null,
        teamspaceId: spec.teamspace ? (teamspaces[spec.teamspace] ?? null) : null,
        projectId: spec.project ? (projects[spec.project] ?? null) : null,
        title: spec.title,
        icon: spec.icon,
        coverUrl: spec.cover ?? null,
        fullWidth: spec.fullWidth ?? false,
        locked: spec.locked ?? false,
        isFavorite: spec.favorite ?? false,
        createdById: demoUserId,
        content: json(spec.content),
        searchText: pageSearchText(spec.title, spec.content),
        position: (Object.keys(pageIds).length + 2) * 1000,
      },
      select: { id: true },
    });
    pageIds[spec.key] = created.id;
    pageTitles[spec.key] = spec.title;
  }

  // --- databases -----------------------------------------------------------
  // Phase 1: the pages, the properties (with real ids) and the row pages, so
  // relation configs and view configs can reference ids that already exist.
  const dbIds: Record<string, string> = {};
  const dbProps: Record<string, Record<string, string>> = {};
  const rowIds: Record<string, Record<string, string>> = {};
  const dbSpecsByKey: Record<string, DbSpec> = {};

  for (const spec of databaseSpecs) {
    dbSpecsByKey[spec.key] = spec;
    const intro = databaseIntros[spec.key] ?? [];
    const content = { type: "doc", content: intro };

    const page = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        title: spec.title,
        icon: spec.icon,
        type: "DATABASE",
        createdById: demoUserId,
        isFavorite: spec.favorite ?? false,
        content: json(content),
        searchText: pageSearchText(spec.title, content),
        position: spec.position,
      },
      select: { id: true },
    });
    dbIds[spec.key] = page.id;
    dbProps[spec.key] = {};
    rowIds[spec.key] = {};

    for (const [index, property] of spec.properties.entries()) {
      const propertyId = newId();
      await prisma.property.create({
        data: {
          id: propertyId,
          databasePageId: page.id,
          name: property.name,
          type: property.type as never,
          position: (index + 1) * 1000,
          config: property.options
            ? json({
                ...(property.primary ? { primary: true } : {}),
                options: property.options,
                ...(property.format ? { format: property.format } : {}),
                ...(property.currency ? { currency: property.currency } : {}),
              })
            : property.format || property.primary
              ? json({
                  ...(property.primary ? { primary: true } : {}),
                  ...(property.format ? { format: property.format } : {}),
                  ...(property.currency ? { currency: property.currency } : {}),
                })
              : Prisma.JsonNull,
        },
      });
      dbProps[spec.key][property.name] = propertyId;
    }

    for (const [index, row] of spec.rows.entries()) {
      const created = await prisma.page.create({
        data: {
          workspaceId: workspace.id,
          parentId: page.id,
          title: row.title,
          icon: row.icon ?? null,
          coverUrl: row.coverUrl ?? null,
          createdById: demoUserId,
          searchText: pageSearchText(row.title, null),
          position: (index + 1) * 1000,
        },
        select: { id: true },
      });
      rowIds[spec.key][row.title] = created.id;
    }
  }

  // Phase 2: relation pairs (both sides cross-reference each other), one-way
  // relations, rollups and formulas.
  for (const [aKey, aProp, bKey, bProp] of relationPairs) {
    const pair = createRelationPair({
      a: { databaseId: dbIds[aKey], propertyId: dbProps[aKey][aProp] },
      b: { databaseId: dbIds[bKey], propertyId: dbProps[bKey][bProp] },
      cardinality: "many",
    });
    await prisma.property.update({
      where: { id: dbProps[aKey][aProp] },
      data: { config: json(pair.a.config) },
    });
    await prisma.property.update({
      where: { id: dbProps[bKey][bProp] },
      data: { config: json(pair.b.config) },
    });
  }

  /** Which database a RELATION property on `dbKey` points at, per the specs. */
  const relationTarget = (dbKey: string, propertyName: string) =>
    dbSpecsByKey[dbKey]?.properties.find((entry) => entry.name === propertyName)?.relation;

  const isPaired = (dbKey: string, propertyName: string) =>
    relationPairs.some(([aKey, aProp, bKey, bProp]) =>
      (aKey === dbKey && aProp === propertyName) || (bKey === dbKey && bProp === propertyName),
    );

  for (const spec of databaseSpecs) {
    for (const property of spec.properties) {
      const propertyId = dbProps[spec.key][property.name];

      // A relation that is not part of a pair stays one-way: it still needs a
      // target database, but no inverse metadata.
      if (property.relation && !isPaired(spec.key, property.name)) {
        await prisma.property.update({
          where: { id: propertyId },
          data: { config: json({ targetDatabaseId: dbIds[property.relation], multi: true }) },
        });
      }

      if (property.rollup) {
        // The rollup's target property lives on the database the *relation*
        // property points at, not on this one.
        const targetDbKey = relationTarget(spec.key, property.rollup.relation);
        const targetPropertyId = targetDbKey
          ? dbProps[targetDbKey][property.rollup.target]
          : dbProps[spec.key][property.rollup.target];
        if (!targetPropertyId) {
          throw new Error(
            `Rollup "${property.name}" on "${spec.key}" cannot resolve ${property.rollup.relation} → ${property.rollup.target}`,
          );
        }
        const config = setRollupConfig({
          relationPropertyId: dbProps[spec.key][property.rollup.relation],
          targetPropertyId,
          fn: property.rollup.fn,
        });
        await prisma.property.update({ where: { id: propertyId }, data: { config: json(config) } });
      }

      if (property.expression) {
        await prisma.property.update({
          where: { id: propertyId },
          data: { config: json({ expression: property.expression }) },
        });
      }
    }
  }

  // Phase 3: views. Config placeholders name properties; they are rewritten to
  // real ids here (`groupByPropertyId`, `laneBy`, `previewPropertyId`).
  for (const spec of databaseSpecs) {
    for (const [index, view] of spec.views.entries()) {
      const config: Record<string, unknown> = { ...(view.config ?? {}) };
      for (const key of ["groupByPropertyId", "laneBy", "previewPropertyId"]) {
        const value = config[key];
        if (typeof value === "string" && dbProps[spec.key][value]) {
          config[key] = dbProps[spec.key][value];
        }
      }
      await prisma.databaseView.create({
        data: {
          databasePageId: dbIds[spec.key],
          name: view.name,
          type: view.type as never,
          config: Object.keys(config).length > 0 ? json(config) : Prisma.JsonNull,
          position: (index + 1) * 1000,
        },
      });
    }
  }

  // Phase 4: cell values.
  for (const spec of databaseSpecs) {
    for (const row of spec.rows) {
      for (const [propertyName, value] of Object.entries(row.values)) {
        const propertyId = dbProps[spec.key][propertyName];
        if (!propertyId) continue;
        await prisma.propertyValue.create({
          data: { propertyId, pageId: rowIds[spec.key][row.title], value: json(value) },
        });
      }
    }
  }

  // Phase 5: relation links, written on both sides of every pair.
  const pairByProperty = new Map<string, { inverse: string; pairId: string }>();
  for (const [aKey, aProp, bKey, bProp] of relationPairs) {
    const aId = dbProps[aKey][aProp];
    const bId = dbProps[bKey][bProp];
    pairByProperty.set(aId, { inverse: bId, pairId: `${aId}__${bId}` });
    pairByProperty.set(bId, { inverse: aId, pairId: `${aId}__${bId}` });
  }

  const linksByProperty = new Map<string, Map<string, string[]>>();
  const addLink = (propertyId: string, rowId: string, targetId: string) => {
    const byRow = linksByProperty.get(propertyId) ?? new Map<string, string[]>();
    const list = byRow.get(rowId) ?? [];
    if (!list.includes(targetId)) list.push(targetId);
    byRow.set(rowId, list);
    linksByProperty.set(propertyId, byRow);
  };

  for (const link of rowLinks) {
    const [fromDb, fromRow] = link.from;
    const [toDb, toRow] = link.to;
    const fromPropertyId = dbProps[fromDb][link.property];
    const fromRowId = rowIds[fromDb][fromRow];
    const toRowId = rowIds[toDb][toRow];
    if (!fromPropertyId || !fromRowId || !toRowId) continue;
    addLink(fromPropertyId, fromRowId, toRowId);
    const inverse = pairByProperty.get(fromPropertyId)?.inverse;
    if (inverse) addLink(inverse, toRowId, fromRowId);
  }

  for (const [propertyId, byRow] of linksByProperty) {
    for (const [rowId, pageIds] of byRow) {
      await prisma.propertyValue.create({
        data: { propertyId, pageId: rowId, value: json({ pageIds }) },
      });
    }
  }

  // Phase 6: database templates.
  for (const spec of databaseSpecs) {
    for (const [index, template] of (spec.templates ?? []).entries()) {
      await prisma.template.create({
        data: {
          databasePageId: dbIds[spec.key],
          name: template.name,
          icon: template.icon,
          isDefault: template.isDefault ?? false,
          position: (index + 1) * 1000,
          content: json({
            type: "doc",
            content: template.body.map((line) => ({
              type: "heading",
              attrs: { level: 3 },
              content: [{ type: "text", text: line }],
            })),
          }),
        },
      });
    }
  }

  // --- tickets -------------------------------------------------------------
  const ticketCount = await seedDemoTickets(prisma, {
    workspace: { id: workspace.id, name: workspace.name, ticketCounter: workspace.ticketCounter },
    users,
    projects,
    milestones,
  });

  // --- collaboration: comments, reactions, history -------------------------
  const comments: { page: string; author: string; body: string; reply?: boolean; resolved?: boolean }[] = [
    {
      page: "spec-inline-db",
      author: "amara",
      body: "Strongly in favour of the source chip — it was the finding that blocked a third of participants.",
    },
    {
      page: "spec-inline-db",
      author: "priya",
      body: "@[Louis Marchand](louis) the compact layout is in the branch, screenshot in the design review note.",
      reply: true,
    },
    {
      page: "launch-plan",
      author: "sofia",
      body: "Blog draft is at 900 words. @[Amara Okafor](amara) can you read the opening before I publish?",
    },
    {
      page: "roadmap-q4",
      author: "louis",
      body: "Inline databases are on track; the virtualised editor is the one at risk. Flagged it in the weekly sync.",
      resolved: true,
    },
    {
      page: "sync-12-oct",
      author: "tomas",
      body: "Profiler trace is attached in the ticket. 42 ms → 11 ms in the prototype.",
    },
    {
      page: "usability-findings",
      author: "amara",
      body: "Great write-up. Let's re-run the two High findings after the fix ships.",
    },
  ];

  for (const spec of comments) {
    const pageId = pageIds[spec.page];
    if (!pageId) continue;
    const authorId = users[spec.author] ?? demoUserId;
    const parent = spec.reply
      ? await prisma.comment.findFirst({ where: { pageId, parentId: null }, orderBy: { createdAt: "asc" } })
      : null;
    const comment = await prisma.comment.create({
      data: {
        pageId,
        parentId: parent?.id ?? null,
        authorId,
        body: spec.body,
        resolved: spec.resolved ?? false,
        createdAt: daysAgo(spec.reply ? 4 : 5),
      },
      select: { id: true },
    });
    if (!spec.reply) {
      for (const emoji of ["👍", "🎉"]) {
        await prisma.commentReaction
          .create({ data: { commentId: comment.id, userId: users.priya, emoji } })
          .catch(() => undefined);
      }
    }
  }

  const versionTargets = ["handbook", "mission-values", "roadmap-q4", "spec-inline-db"];
  for (const key of versionTargets) {
    const pageId = pageIds[key];
    if (!pageId) continue;
    const versions = [
      { label: "Autosave", summary: "Minor edit", charDelta: 84, days: 6 },
      { label: "Autosave", summary: "Added the review section", charDelta: 412, days: 3 },
      { label: "Named version", summary: "Reviewed with the team", charDelta: 126, days: 1 },
    ];
    for (const version of versions) {
      await prisma.pageVersion.create({
        data: {
          pageId,
          title: pageTitles[key] ?? key,
          content: json({ type: "doc", content: [] }),
          createdById: demoUserId,
          label: version.label,
          summary: version.summary,
          charDelta: version.charDelta,
          createdAt: daysAgo(version.days),
        },
      });
    }
  }

  // --- follows, permissions, favourites ------------------------------------
  for (const key of ["roadmap-q4", "spec-inline-db", "launch-plan", "sync-12-oct"]) {
    if (!pageIds[key]) continue;
    await prisma.pageFollow.create({ data: { userId: users.amara, pageId: pageIds[key] } });
  }
  if (pageIds["launch-plan"]) {
    await prisma.pagePermission.create({
      data: { pageId: pageIds["launch-plan"], userId: users.sofia, level: "EDIT" },
    });
  }
  for (const key of ["roadmap-q4", "spec-inline-db", "handbook", "okrs", "sync-12-oct"]) {
    if (!pageIds[key]) continue;
    await prisma.favorite.create({ data: { userId: demoUserId, pageId: pageIds[key] } });
  }

  // --- notifications (the inbox) -------------------------------------------
  const notifications: { type: string; page: string; actor: string; title?: string; read: boolean; days: number }[] = [
    { type: "page.mention", page: "launch-plan", actor: "sofia", read: false, days: 0 },
    { type: "comment.reply", page: "spec-inline-db", actor: "priya", read: false, days: 0 },
    { type: "ticket.assigned", page: "spec-inline-db", actor: "amara", title: "Ship the inline-database block", read: false, days: 1 },
    { type: "page.updated", page: "roadmap-q4", actor: "louis", read: false, days: 1 },
    { type: "page.mention", page: "sync-12-oct", actor: "amara", read: true, days: 2 },
    { type: "comment.reply", page: "usability-findings", actor: "amara", read: true, days: 3 },
    { type: "page.shared", page: "launch-plan", actor: "sofia", read: true, days: 4 },
    { type: "page.updated", page: "handbook", actor: "amara", read: true, days: 6 },
  ];
  for (const spec of notifications) {
    await prisma.notification.create({
      data: {
        userId: demoUserId,
        type: spec.type,
        read: spec.read,
        createdAt: daysAgo(spec.days),
        payload: json({
          pageId: pageIds[spec.page] ?? null,
          actorId: users[spec.actor] ?? null,
          ...(spec.title ? { title: spec.title } : {}),
        }),
      },
    });
  }

  // --- activity log --------------------------------------------------------
  const activity: { actor: string; action: string; target: string; page?: string; days: number }[] = [
    { actor: "louis", action: "page.updated", target: "page", page: "spec-inline-db", days: 0 },
    { actor: "sofia", action: "page.updated", target: "page", page: "launch-plan", days: 0 },
    { actor: "priya", action: "comment.created", target: "page", page: "spec-inline-db", days: 0 },
    { actor: "amara", action: "page.updated", target: "page", page: "roadmap-q4", days: 1 },
    { actor: "tomas", action: "page.created", target: "page", page: "usability-findings", days: 2 },
    { actor: "amara", action: "page.updated", target: "page", page: "sync-12-oct", days: 2 },
    { actor: "demo", action: "page.created", target: "page", page: "handbook", days: 5 },
    { actor: "demo", action: "member.invited", target: "user", days: 5 },
  ];
  for (const spec of activity) {
    await prisma.activity.create({
      data: {
        workspaceId: workspace.id,
        actorId: users[spec.actor] ?? demoUserId,
        action: spec.action,
        targetType: spec.target,
        targetId: spec.page ? (pageIds[spec.page] ?? null) : null,
        meta: json({ seeded: true }),
        createdAt: daysAgo(spec.days),
      },
    });
  }

  // --- chat ----------------------------------------------------------------
  const chatThreads: { title: string; page?: string; messages: { author: string | null; body: string }[] }[] = [
    {
      title: "What did we decide about the v2.0 date?",
      messages: [
        { author: "demo", body: "When are we shipping v2.0, and what is still blocking it?" },
        {
          author: null,
          body: "v2.0 ships on 20 October 2026. From the weekly sync on 12 October: the schema freezes on Wednesday, the docs get one more pass, and the editor performance work is not a launch blocker — it ships behind a flag. The launch plan page lists the assets still outstanding (blog post, newsletter, demo video).",
        },
      ],
    },
    {
      title: "Summarise the inline databases spec",
      page: "spec-inline-db",
      messages: [
        { author: "demo", body: "Summarise this spec in three bullets." },
        {
          author: null,
          body: "1. Goal — render any database inside any page as a first-class block, with its own views, filters and layout.\n2. Constraint — edits write through to the source database, so there is one copy of the truth and the embed inherits the source's permissions.\n3. Open questions — whether embedded views need their own share links, and how a chart view renders inside a 400px column.",
        },
      ],
    },
    {
      title: "Who owns the editor performance work?",
      messages: [
        { author: "amara", body: "Who is on the virtualised editor, and when is it landing?" },
        {
          author: null,
          body: "Tomás Ferreira owns it. The prototype is at 11 ms per keystroke on the 5,000-block page (down from 42 ms) and it lands behind the `editor.virtualise` flag, targeted for 14 November. Louis Marchand owns the schema freeze that unblocks it.",
        },
      ],
    },
  ];

  for (const [index, spec] of chatThreads.entries()) {
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: workspace.id,
        pageId: spec.page ? (pageIds[spec.page] ?? null) : null,
        title: spec.title,
        createdById: users.demo,
        createdAt: daysAgo(index + 1),
        updatedAt: daysAgo(index + 1),
      },
      select: { id: true },
    });
    for (const [messageIndex, message] of spec.messages.entries()) {
      await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          userId: message.author ? (users[message.author] ?? demoUserId) : null,
          role: message.author ? "user" : "assistant",
          body: message.body,
          createdAt: daysAgo(index + 1 - messageIndex / 10),
        },
      });
    }
  }

  // --- calendar ------------------------------------------------------------
  const feed = await prisma.calendarFeed.create({
    data: {
      workspaceId: workspace.id,
      name: "Company calendar",
      icsUrl: "https://calendar.example.com/noema/company.ics",
      color: "blue",
    },
    select: { id: true },
  });

  const events: { uid: string; title: string; start: string; end: string; location?: string }[] = [
    { uid: "evt-weekly-sync", title: "Weekly sync", start: "2026-10-19T09:30", end: "2026-10-19T10:15", location: "Huddle" },
    { uid: "evt-design-review", title: "Design review", start: "2026-10-20T14:00", end: "2026-10-20T15:00", location: "Huddle" },
    { uid: "evt-launch", title: "v2.0 launch day", start: "2026-10-20T09:00", end: "2026-10-20T10:00" },
    { uid: "evt-community-ama", title: "Community AMA", start: "2026-10-22T16:00", end: "2026-10-22T17:00" },
    { uid: "evt-demo", title: "Thursday demo", start: "2026-10-22T15:00", end: "2026-10-22T15:30" },
    { uid: "evt-customer-call", title: "Customer call — Meridian Bank", start: "2026-10-23T11:00", end: "2026-10-23T11:45" },
    { uid: "evt-retro", title: "Sprint 22 retro", start: "2026-10-26T15:00", end: "2026-10-26T16:00" },
  ];
  for (const event of events) {
    await prisma.calendarEvent.create({
      data: {
        workspaceId: workspace.id,
        feedId: feed.id,
        uid: event.uid,
        title: event.title,
        start: new Date(event.start),
        end: new Date(event.end),
        location: event.location ?? null,
      },
    });
  }

  // --- sharing, tokens, webhooks, saved views ------------------------------
  if (pageIds.handbook) {
    await prisma.shareLink.create({
      data: {
        pageId: pageIds.handbook,
        token: "demo-handbook-share",
        permission: "READ",
        indexing: true,
      },
    });
  }

  await prisma.invite.create({
    data: {
      workspaceId: workspace.id,
      email: "noor@noema.local",
      role: "MEMBER",
      token: "demo-invite-noor",
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      invitedById: demoUserId,
    },
  });

  await prisma.apiToken.create({
    data: {
      userId: demoUserId,
      name: "Reporting script",
      scopes: ["pages:read", "databases:read", "tickets:read"],
      tokenHash: "seeded-demo-token-hash-not-a-real-secret",
      lastUsedAt: daysAgo(1),
    },
  });

  const webhook = await prisma.webhook.create({
    data: {
      workspaceId: workspace.id,
      url: "https://hooks.example.com/noema/demo",
      events: ["page.created", "page.updated", "ticket.created"],
      secret: "demo-webhook-signing-secret",
      active: true,
    },
    select: { id: true },
  });
  await prisma.webhookDelivery.createMany({
    data: [
      { webhookId: webhook.id, event: "page.updated", ok: true, responseStatus: 200, attempts: 1, createdAt: daysAgo(0) },
      { webhookId: webhook.id, event: "ticket.created", ok: true, responseStatus: 200, attempts: 1, createdAt: daysAgo(1) },
      { webhookId: webhook.id, event: "page.created", ok: false, responseStatus: 500, attempts: 3, error: "500 from the receiver", createdAt: daysAgo(2) },
    ],
  });

  // Saved ticket views use the toolbar's own shape: a view type plus one filter
  // node per active control (`TICKET_FILTER_FIELDS`).
  const bugLabel = await prisma.label.findUnique({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "bug" } },
    select: { id: true },
  });
  const ticketViews: { name: string; config: Record<string, unknown> }[] = [
    {
      name: "My open work",
      config: {
        viewType: "list",
        filter: [
          { field: "assigneeId", value: demoUserId },
          { field: "hideClosed", value: true },
        ],
      },
    },
    {
      name: "Urgent",
      config: { viewType: "board", filter: [{ field: "priority", value: "urgent" }] },
    },
    ...(bugLabel
      ? [
          {
            name: "Bugs",
            config: { viewType: "list", filter: [{ field: "labelId", value: bugLabel.id }] },
          },
        ]
      : []),
  ];
  for (const [index, view] of ticketViews.entries()) {
    await prisma.ticketView.create({
      data: {
        workspaceId: workspace.id,
        createdById: demoUserId,
        name: view.name,
        config: json(view.config),
        position: (index + 1) * 1000,
      },
    });
  }

  // --- trash & archive -----------------------------------------------------
  await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: "Pricing experiments — old notes",
      icon: "🧪",
      createdById: demoUserId,
      deletedAt: daysAgo(8),
      content: json({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Superseded by the launch plan. Kept in the trash as an example." }] },
        ],
      }),
      searchText: pageSearchText("Pricing experiments — old notes", null),
      position: 9000,
    },
  });
  await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: "Q2 planning (archived)",
      icon: "🗄️",
      createdById: demoUserId,
      isArchived: true,
      content: json({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Last quarter's planning page, archived but still searchable." }] },
        ],
      }),
      searchText: pageSearchText("Q2 planning (archived)", null),
      position: 9100,
    },
  });

  // --- report --------------------------------------------------------------
  console.log("Seed complete.");
  console.log(`  Demo user:     ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Workspace:     ${workspace.slug}`);
  console.log(`  People:        ${people.length} (1 owner, 1 admin, 3 members, 1 guest)`);
  console.log(`  Projects:      ${projectSpecs.length} with ${Object.keys(milestones).length} milestones`);
  console.log(`  Pages:         ${pageSpecs.length + 4} documents + ${databaseSpecs.length} databases`);
  console.log(
    `  Databases:     ${databaseSpecs.length} (${databaseSpecs.reduce((total, spec) => total + spec.rows.length, 0)} rows, ${relationPairs.length} relation pairs)`,
  );
  console.log(`  Tickets:       ${ticketCount} across ${ticketCycleSpecs.length} cycles and ${ticketLabelSpecs.length} labels`);
  console.log(`  Chat:          ${chatThreads.length} threads · Comments: ${comments.length} · Notifications: ${notifications.length}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
