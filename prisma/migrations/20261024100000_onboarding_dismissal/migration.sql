-- First-run checklist dismissal (per user, across their workspaces).
ALTER TABLE "User" ADD COLUMN "onboardingDismissedAt" TIMESTAMP(3);
