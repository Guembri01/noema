/** First-run workspace checklist — pure, so the completion logic is testable. */

export type OnboardingCounts = {
  pages: number;
  databases: number;
  members: number;
  assets: number;
};

export type OnboardingStep = {
  id: "page" | "database" | "member" | "file";
  title: string;
  description: string;
  href: string;
  done: boolean;
};

export type OnboardingChecklist = {
  steps: OnboardingStep[];
  done: number;
  total: number;
  complete: boolean;
};

export function buildOnboardingChecklist(
  slug: string,
  counts: OnboardingCounts,
): OnboardingChecklist {
  const home = `/w/${slug}`;
  const steps: OnboardingStep[] = [
    {
      id: "page",
      title: "Create your first page",
      description: "Start with a blank page or one of the quick-start templates.",
      href: `${home}#quick-start`,
      done: counts.pages > 0,
    },
    {
      id: "database",
      title: "Create a database",
      description: "Track tasks, projects or any structured list with views.",
      href: `${home}#quick-start`,
      done: counts.databases > 0,
    },
    {
      id: "member",
      title: "Invite a teammate",
      description: "Share the workspace and collaborate in real time.",
      href: `${home}/settings`,
      done: counts.members > 1,
    },
    {
      id: "file",
      title: "Upload a file",
      description: "Images, PDFs and documents live beside your notes.",
      href: `${home}#quick-start`,
      done: counts.assets > 0,
    },
  ];
  const done = steps.filter((step) => step.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}
