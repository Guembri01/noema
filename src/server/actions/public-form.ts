"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertScopedParent } from "@/lib/page-parent";
import { pageSearchText } from "@/lib/search";
import { dispatchWebhooks } from "@/lib/webhooks";
import {
  buildFormSchema,
  isAnswerablePropertyType,
  parseFormSchema,
  publicFormFields,
  toRowValues,
  validateFormSchema,
  validateSubmission,
  type FormSchema,
} from "@/lib/form-view";
import { validateCell } from "@/lib/cell-validation";
import { fileUrlsAreAppOwned } from "@/lib/validation";
import { checkRateLimit, clientKeyFromHeaders } from "@/lib/rate-limit";
import { isSharedPageUnavailable } from "@/lib/share-page";
import { shareUnlockCookieName, verifyShareUnlockToken } from "@/lib/secrets";
import { createRowCellsInTransaction } from "@/server/row-cells";

type Result = { ok: true } | { error: string };

const UNAVAILABLE = "This form is no longer available.";

/**
 * Submit a public FORM view through its share token.
 *
 * The token is the whole authorization: it resolves one share row, then the
 * action re-reads the FORM view and its live properties from the database. A
 * client cannot name a database, a property or a view, so a hand-crafted call
 * can only answer the stored form. Row and cells commit in one transaction;
 * the respondent's IP and the link itself have independent rate budgets.
 *
 * Public rows are attributed to the user who created the shared database page
 * (`Page.createdById` is non-null); the activity feed does not pretend the
 * anonymous respondent was that user. See `docs/specs/database-deep.md`
 * R89.29 and O89.1.
 */
export async function submitPublicFormAction(
  token: string,
  answers: unknown,
): Promise<Result> {
  const link = await prisma.shareLink.findUnique({
    where: { token },
    select: {
      id: true,
      passwordHash: true,
      expiresAt: true,
      view: {
        select: {
          id: true,
          databasePageId: true,
          name: true,
          type: true,
          config: true,
        },
      },
      page: {
        select: {
          id: true,
          workspaceId: true,
          type: true,
          deletedAt: true,
          createdById: true,
        },
      },
    },
  });

  if (
    !link ||
    !link.view ||
    !link.page ||
    link.view.type !== "FORM" ||
    link.view.databasePageId !== link.page.id ||
    link.page.type !== "DATABASE" ||
    isSharedPageUnavailable(link, link.page)
  ) {
    return { error: UNAVAILABLE };
  }

  const unlocked = verifyShareUnlockToken(
    token,
    (await cookies()).get(shareUnlockCookieName(token))?.value,
  );
  if (link.passwordHash && !unlocked) {
    return { error: "This form is password-protected. Unlock it first." };
  }

  // The link budget stops one form from being used as a bulk writer even from
  // many addresses; the address budget stops one visitor from rotating links.
  // Count the attempt before the parent query so a spammer cannot use the
  // token as an unthrottled database probe.
  const addressLimit = checkRateLimit(
    clientKeyFromHeaders(await headers(), `public-form:${link.id}`),
    10,
    60_000,
  );
  const linkLimit = checkRateLimit(`public-form-link:${link.id}`, 120, 60_000);
  if (!addressLimit.ok || !linkLimit.ok) {
    return { error: "Too many submissions. Try again shortly." };
  }

  // The parent is the page the token resolved, but re-assert the tenant and
  // trash invariants before the write so a page trashed after the link lookup
  // cannot receive a row.
  const parent = await assertScopedParent({
    workspaceId: link.page.workspaceId,
    parentId: link.page.id,
  });
  if ("error" in parent || parent.parentId !== link.page.id) {
    return { error: UNAVAILABLE };
  }
  const databasePageId = parent.parentId;

  const config = (link.view.config ?? {}) as { form?: unknown };
  const parsed = parseFormSchema(config.form);
  const properties = await prisma.property.findMany({
    where: { databasePageId },
    orderBy: { position: "asc" },
    select: { id: true, name: true, type: true, config: true },
  });
  const propertyById = new Map(properties.map((property) => [property.id, property]));

  // A stored FormSchema is authoritative; a legacy `fieldIds` config (or no
  // config at all) resolves against the live properties exactly like the
  // builder and the internal submit action do.
  const storedFields =
    parsed.fields.length > 0
      ? parsed.fields
      : buildFormSchema(properties, config.form);
  const schema: FormSchema = {
    ...parsed,
    id: link.view.id,
    databaseId: databasePageId,
    title: parsed.title.trim() || link.view.name || "Form",
    fields: publicFormFields(
      storedFields.map((field) => {
        const property = propertyById.get(field.propertyId);
        return property
          ? {
              ...field,
              type: property.type,
              config: (property.config ?? {}) as Record<string, unknown>,
            }
          : field;
      }),
    ),
  };

  if (schema.fields.every((field) => field.hidden === true)) {
    return { error: "This form has no questions that can be answered publicly." };
  }

  const formCheck = validateFormSchema(schema, { properties });
  if (!formCheck.ok) return { error: "This form has an invalid configuration." };
  if (schema.accepting !== true) {
    return { error: "This form is not accepting responses." };
  }

  const validation = validateSubmission(schema, answers);
  if (!validation.ok) {
    return { error: "Please check the answers and try again." };
  }
  const cells = toRowValues(schema, answers);
  const submitted = new Map<string, Prisma.InputJsonValue>();
  for (const cell of cells) {
    const property = propertyById.get(cell.propertyId);
    if (!property || !isAnswerablePropertyType(property.type)) {
      return { error: "This form has an invalid question." };
    }
    if (!fileUrlsAreAppOwned(cell.value)) {
      return { error: "That file link is not allowed." };
    }
    submitted.set(cell.propertyId, cell.value as Prisma.InputJsonValue);
  }

  // Validate the mapped values too, including authored defaults that never
  // appeared in the answer map, so no stored default bypasses the cell rules.
  for (const field of schema.fields) {
    if (field.hidden === true) continue;
    const property = propertyById.get(field.propertyId);
    if (!property || !isAnswerablePropertyType(property.type)) {
      return { error: "This form has an invalid question." };
    }
    const result = validateCell(
      {
        id: property.id,
        name: field.label,
        type: property.type,
        required: field.required === true,
        config: (property.config ?? {}) as Record<string, unknown>,
      },
      submitted.get(field.propertyId),
    );
    if (!result.ok) {
      return { error: "Please check the answers and try again." };
    }
  }

  const primary = properties[0];
  const primaryCell = primary
    ? cells.find((cell) => cell.propertyId === primary.id)
    : undefined;
  const primaryText =
    primaryCell && primaryCell.value && typeof primaryCell.value === "object"
      ? (primaryCell.value as { text?: unknown }).text
      : undefined;
  const title = typeof primaryText === "string" ? primaryText : "";

  const rowId = await prisma.$transaction(async (tx) => {
    const last = await tx.page.findFirst({
      where: { parentId: databasePageId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const rowTitle = title || "Untitled";
    const row = await tx.page.create({
      data: {
        workspaceId: link.page.workspaceId,
        // The parent is the page the share token resolved; the view check above
        // proved this page owns that view, and `assertScopedParent` re-asserted
        // its workspace and live state.
        parentId: databasePageId,
        title: rowTitle,
        createdById: link.page.createdById,
        position: (last?.position ?? 0) + 1000,
        searchText: pageSearchText(rowTitle, null),
      },
      select: { id: true },
    });
    await createRowCellsInTransaction(
      tx,
      databasePageId,
      row.id,
      title,
      submitted,
    );
    return row.id;
  });

  await dispatchWebhooks(link.page.workspaceId, "row.created", {
    rowId,
    databasePageId: link.page.id,
    via: "public-form",
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}
