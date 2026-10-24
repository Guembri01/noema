import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const db = vi.hoisted(() => ({ update: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/db", () => ({ prisma: { user: { update: db.update } } }));
vi.mock("next/cache", () => cache);

import { dismissOnboardingAction } from "./onboarding";

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1" });
  db.update.mockResolvedValue({ id: "u1" });
});

describe("dismissOnboardingAction", () => {
  it("stamps the signed-in user and revalidates the workspace shell", async () => {
    await dismissOnboardingAction();
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { onboardingDismissedAt: expect.any(Date) },
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });
});
