"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isLocale } from "@/lib/i18n";

export async function setLocaleAction(
  locale: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!isLocale(locale)) return { error: "Unsupported locale." };
  await prisma.user.update({ where: { id: user.id }, data: { locale } });
  revalidatePath("/", "layout");
  return { ok: true };
}
