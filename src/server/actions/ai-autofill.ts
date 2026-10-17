"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { AI_NOT_CONFIGURED, chatComplete, resolveAiConfig } from "@/lib/ai-provider";
import { parseAiAutofillConfig, validateAiAutofillConfig } from "@/lib/ai-autofill";

export type AiAutofillRunResult =
  | { ok: true; propertyId: string; value: string }
  | { ok: false; error: string };

/** Render one stored property value as a line of model context. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Run one AI-autofill column against a row: read the column's `Property.config`
 * prompt, ask the configured provider to fill it using the rest of the row as
 * context, and write the result into the target property (the column itself
 * when no `targetPropertyId` is set).
 *
 * The config is untrusted stored JSON, so it is validated with
 * `validateAiAutofillConfig` (rejecting an empty prompt, out-of-range sampling
 * knobs) and then parsed with `parseAiAutofillConfig` before use. Guests and
 * non-members are refused, the column and the row must belong to the workspace
 * the caller names, and the column the value is written into must belong to
 * the row's own database — a forged id cannot write across workspaces.
 */
export async function runAiAutofillAction(input: {
  workspaceId: string;
  rowId: string;
  propertyId: string;
}): Promise<AiAutofillRunResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { ok: false, error: "You do not have permission to run AI autofill." };
  }

  const property = await prisma.property.findUnique({
    where: { id: input.propertyId },
    select: {
      id: true,
      type: true,
      config: true,
      databasePage: { select: { workspaceId: true } },
    },
  });
  if (!property || property.type !== "AI_AUTOFILL") {
    return { ok: false, error: "That property is not an AI-autofill column." };
  }
  if (property.databasePage.workspaceId !== input.workspaceId) {
    return { ok: false, error: "That column does not belong to this workspace." };
  }

  const issues = validateAiAutofillConfig(property.config);
  if (issues.length > 0) {
    return { ok: false, error: issues[0].message };
  }
  const parsed = parseAiAutofillConfig(property.config);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const config = parsed.config;

  const row = await prisma.page.findUnique({
    where: { id: input.rowId },
    select: {
      id: true,
      workspaceId: true,
      parentId: true,
      title: true,
      propertyValues: {
        select: { value: true, property: { select: { name: true } } },
      },
    },
  });
  if (!row || row.workspaceId !== input.workspaceId) {
    return { ok: false, error: "That row does not belong to this workspace." };
  }

  // B99: the column the generated value is written into has to belong to the
  // row's **own** database — the database the row hangs under. The target id
  // comes out of the stored, untrusted column config and used to be written
  // unchecked, so a forged `targetPropertyId` filed the generated value under
  // a column of a foreign database (another workspace, or another database of
  // this workspace). The same rule binds the fallback target — the column
  // itself — to the row's database.
  //
  // The answer is the same for a target id that does not exist (no existence
  // oracle), and the check runs before the provider is called: a run that
  // cannot write is not worth a model call.
  const targetPropertyId = config.targetPropertyId ?? property.id;
  const targetProperty = await prisma.property.findFirst({
    where: { id: targetPropertyId, databasePageId: row.parentId ?? "" },
    select: { id: true },
  });
  if (!targetProperty) {
    return { ok: false, error: "That target property does not belong to this database." };
  }

  const runtime = await resolveAiConfig(input.workspaceId);
  if (!runtime) return { ok: false, error: AI_NOT_CONFIGURED };

  const context = [
    ...row.propertyValues
      .map((entry) => `${entry.property.name}: ${describeValue(entry.value)}`)
      .filter((line) => line.trim().length > 0),
    `Title: ${row.title}`,
  ].join("\n");

  const result = await chatComplete(
    {
      system:
        "You fill in a database property. Reply with the property value only — no preamble, no quotes.",
      user: `${config.prompt}\n\nRow context:\n${context}`,
      temperature: config.temperature ?? undefined,
      maxTokens: config.maxTokens ?? undefined,
    },
    runtime,
  );
  if (!result.ok) return { ok: false, error: result.error };

  const value = result.text.trim();
  await prisma.propertyValue.upsert({
    where: { propertyId_pageId: { propertyId: targetPropertyId, pageId: row.id } },
    create: { propertyId: targetPropertyId, pageId: row.id, value: { text: value } },
    update: { value: { text: value } },
  });

  revalidatePath("/w", "layout");
  return { ok: true, propertyId: targetPropertyId, value };
}
