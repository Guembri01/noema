"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** Dismiss the first-run checklist for the signed-in user. */
export async function dismissOnboardingAction(): Promise<void> {
  const user = await requireUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { onboardingDismissedAt: new Date() },
  });
  revalidatePath("/w", "layout");
}
