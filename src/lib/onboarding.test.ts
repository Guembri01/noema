import { describe, expect, it } from "vitest";
import { buildOnboardingChecklist } from "./onboarding";

describe("buildOnboardingChecklist", () => {
  it("marks each step from workspace counts", () => {
    const checklist = buildOnboardingChecklist("acme", {
      pages: 3,
      databases: 1,
      members: 2,
      assets: 0,
    });
    expect(checklist.done).toBe(3);
    expect(checklist.complete).toBe(false);
    expect(checklist.steps.find((step) => step.id === "file")?.done).toBe(false);
    expect(checklist.steps.find((step) => step.id === "database")?.href).toBe(
      "/w/acme#quick-start",
    );
    expect(checklist.steps.find((step) => step.id === "member")?.href).toBe("/w/acme/settings");
  });

  it("is complete only when every step is done", () => {
    expect(
      buildOnboardingChecklist("acme", { pages: 1, databases: 1, members: 2, assets: 1 })
        .complete,
    ).toBe(true);
    expect(
      buildOnboardingChecklist("acme", { pages: 0, databases: 0, members: 1, assets: 0 })
        .done,
    ).toBe(0);
  });
});
