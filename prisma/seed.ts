import { PrismaClient, type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { welcomeDoc } from "../src/lib/welcome";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@noema.local";
const DEMO_PASSWORD = "password123";

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: "Demo User",
      passwordHash,
    },
  });

  let workspace = await prisma.workspace.findUnique({
    where: { slug: "demo-workspace" },
  });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: "Demo Workspace",
        slug: "demo-workspace",
        icon: "🚀",
        ownerId: user.id,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
  }

  const existing = await prisma.page.count({
    where: { workspaceId: workspace.id },
  });
  if (existing > 0) {
    console.log(`Seed complete. Demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    return;
  }

  const gettingStarted = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: "Getting started",
      icon: "👋",
      createdById: user.id,
      content: welcomeDoc() as unknown as Prisma.InputJsonValue,
      position: 1000,
    },
  });

  // A nested page under Getting started.
  await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      parentId: gettingStarted.id,
      title: "Editor tips",
      icon: "⌨️",
      createdById: user.id,
      position: 1000,
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Editor tips" }] },
          { type: "paragraph", content: [{ type: "text", text: "Type / on an empty line for the block menu. Use the toolbar for formatting." }] },
          { type: "bulletList", content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Markdown shortcuts: # (heading), - (list), > (quote), ``` (code)." }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "⌘/Ctrl+B, +I for bold and italic." }] }] },
          ] },
        ],
      },
    },
  });

  // A database page with properties, views and rows.
  const database = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: "Product roadmap",
      icon: "🗂️",
      type: "DATABASE",
      createdById: user.id,
      position: 2000,
    },
  });

  const nameProp = await prisma.property.create({
    data: {
      databasePageId: database.id,
      name: "Name",
      type: "TEXT",
      position: 1000,
      config: { primary: true },
    },
  });
  const statusProp = await prisma.property.create({
    data: {
      databasePageId: database.id,
      name: "Status",
      type: "STATUS",
      position: 2000,
      config: {
        options: [
          { id: "todo", name: "To-do", color: "gray" },
          { id: "doing", name: "In progress", color: "blue" },
          { id: "done", name: "Done", color: "green" },
        ],
      },
    },
  });
  const ownerProp = await prisma.property.create({
    data: {
      databasePageId: database.id,
      name: "Owner",
      type: "PEOPLE",
      position: 3000,
    },
  });
  await prisma.property.create({
    data: {
      databasePageId: database.id,
      name: "Due",
      type: "DATE",
      position: 4000,
    },
  });

  await prisma.databaseView.createMany({
    data: [
      { databasePageId: database.id, name: "Table", type: "TABLE", position: 1000 },
      {
        databasePageId: database.id,
        name: "Board",
        type: "BOARD",
        position: 2000,
        config: { groupByPropertyId: statusProp.id },
      },
      { databasePageId: database.id, name: "List", type: "LIST", position: 3000 },
    ],
  });

  const seedRows: { title: string; status: string; owner: string }[] = [
    { title: "Define the data model", status: "done", owner: "Demo User" },
    { title: "Build the block editor", status: "doing", owner: "Demo User" },
    { title: "Add realtime collaboration", status: "todo", owner: "Demo User" },
    { title: "Ship public API", status: "todo", owner: "Demo User" },
  ];

  for (const [index, row] of seedRows.entries()) {
    const page = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        parentId: database.id,
        title: row.title,
        createdById: user.id,
        position: (index + 1) * 1000,
      },
    });
    const values: { propertyId: string; pageId: string; value: Prisma.InputJsonValue }[] = [
      { propertyId: nameProp.id, pageId: page.id, value: { text: row.title } },
      { propertyId: statusProp.id, pageId: page.id, value: { optionId: row.status } },
    ];
    if (row.owner) {
      values.push({
        propertyId: ownerProp.id,
        pageId: page.id,
        value: { names: [row.owner] },
      });
    }
    await prisma.propertyValue.createMany({ data: values });
  }

  await prisma.favorite.create({
    data: { userId: user.id, pageId: gettingStarted.id },
  });

  await prisma.comment.create({
    data: {
      pageId: gettingStarted.id,
      authorId: user.id,
      body: "Welcome to Noema! Try editing this page.",
    },
  });

  console.log(`Seed complete. Demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
