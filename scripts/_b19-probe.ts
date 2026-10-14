import { PrismaClient } from "@prisma/client";

async function main() {
  const p = new PrismaClient();
  const ws = await p.workspace.findFirst({
    where: { slug: "demo-workspace" },
    select: { id: true, ownerId: true },
  });
  const pg = await p.page.create({
    data: {
      workspaceId: ws!.id,
      title: `B19 debug probe ${Date.now()}`,
      createdById: ws!.ownerId,
    },
    select: { id: true },
  });
  console.log(pg.id);
  await p.$disconnect();
}

void main();
