import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { nextRunFor, type TemplateRecurrence } from "@/lib/recurrence";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

/**
 * Materialize due recurring database templates. Point a scheduler (cron, Vercel
 * Cron, GitHub Actions, Task Scheduler) at this endpoint. Protect it by setting
 * CRON_SECRET and sending `x-cron-secret: <value>`.
 */
export async function POST(request: Request) {
  // Fail closed: materializing recurring templates mutates the workspace, so an
  // unconfigured secret is a deployment error rather than an open endpoint.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "CRON_SECRET is not configured. Set CRON_SECRET in the environment and send it as the x-cron-secret header.",
      },
      { status: 503 },
    );
  }
  if (request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = rateLimit(request, "cron", 12, 60_000);
  if (limited) return limited;

  const due = await prisma.template.findMany({
    where: { recurrence: { not: null }, nextRunAt: { lte: new Date() } },
    select: {
      id: true,
      databasePageId: true,
      name: true,
      icon: true,
      content: true,
      config: true,
      recurrence: true,
    },
  });

  let created = 0;
  for (const template of due) {
    const database = await prisma.page.findUnique({
      where: { id: template.databasePageId },
      select: { workspaceId: true, createdById: true, deletedAt: true },
    });
    const recurrence = (template.recurrence ?? "daily") as TemplateRecurrence;

    if (!database || database.deletedAt) {
      await prisma.template.update({
        where: { id: template.id },
        data: { nextRunAt: nextRunFor(recurrence) },
      });
      continue;
    }

    const last = await prisma.page.findFirst({
      where: { parentId: template.databasePageId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const row = await prisma.page.create({
      data: {
        workspaceId: database.workspaceId,
        parentId: template.databasePageId,
        title: template.name,
        icon: template.icon,
        createdById: database.createdById,
        position: (last?.position ?? 0) + 1000,
        content: (template.content ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true },
    });

    const configured = (template.config ?? {}) as {
      values?: { propertyId: string; value: unknown }[];
    };
    const values = configured.values ?? [];
    if (values.length > 0) {
      await prisma.propertyValue.createMany({
        data: values.map((entry) => ({
          propertyId: entry.propertyId,
          pageId: row.id,
          value: entry.value as Prisma.InputJsonValue,
        })),
      });
    }

    await prisma.template.update({
      where: { id: template.id },
      data: { nextRunAt: nextRunFor(recurrence) },
    });
    created += 1;
  }

  return NextResponse.json({ due: due.length, created });
}
