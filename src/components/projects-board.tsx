"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleDot, FolderKanban, Pause, Plus, Target } from "lucide-react";
import { toast } from "sonner";
import { createProjectAction } from "@/server/actions/projects";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

export type ProjectCard = {
  id: string;
  name: string;
  summary: string | null;
  description: string | null;
  status: string;
  color: string;
  icon: string | null;
  dueDate: string | null;
  pageCount: number;
  milestones: { id: string; name: string; status: string; dueDate: string | null }[];
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-600",
  paused: "bg-amber-500/10 text-amber-600",
  done: "bg-accent/10 text-accent",
  archived: "bg-surface-2 text-muted",
};

/** Projects list: progress at a glance, with inline creation. */
export function ProjectsBoard({
  locale,
  workspaceId,
  slug,
  projects,
}: {
  workspaceId: string;
  slug: string;
  projects: ProjectCard[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [dueDate, setDueDate] = useState("");

  const create = () =>
    startTransition(async () => {
      const outcome = await safeAction(() =>
        createProjectAction({ workspaceId, name, summary, dueDate: dueDate || null }),
      );
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      setName("");
      setSummary("");
      setDueDate("");
      toast.success("Project created");
      router.push(`/w/${slug}/projects/${value.id}`);
      router.refresh();
    });

  return (
    <div>
      <div className="mb-6 rounded-xl border border-border p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-medium">
          <FolderKanban className="h-4 w-4" /> {t(locale, "newProject")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            aria-label={t(locale, "projectName")}
            placeholder={t(locale, "projectName")}
            onChange={(event) => setName(event.target.value)}
            className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <input
            value={summary}
            aria-label={t(locale, "projectSummary")}
            placeholder={t(locale, "projectSummary")}
            onChange={(event) => setSummary(event.target.value)}
            className="h-9 w-72 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <input
            type="date"
            value={dueDate}
            aria-label={t(locale, "projectDue")}
            onChange={(event) => setDueDate(event.target.value)}
            className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={pending || !name.trim()}
            onClick={create}
            className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Create
          </button>
        </div>
      </div>

      {projects.length === 0 ? (
        <p className="text-sm text-muted">
          No projects yet — create one, then attach notes from the sidebar
          (right-click a page → Add to project).
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const total = project.milestones.length;
            const done = project.milestones.filter((m) => m.status === "done").length;
            const progress = total === 0 ? 0 : Math.round((done / total) * 100);
            const next = project.milestones.find((m) => m.status !== "done");
            return (
              <li key={project.id}>
                <Link
                  href={`/w/${slug}/projects/${project.id}`}
                  className="flex h-full flex-col gap-3 rounded-xl border border-border p-4 transition hover:bg-surface-2"
                >
                  <div className="flex items-center gap-2">
                    <span aria-hidden>{project.icon ?? "🚀"}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {project.name}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                        STATUS_STYLES[project.status] ?? STATUS_STYLES.active
                      }`}
                    >
                      {project.status}
                    </span>
                  </div>
                  {project.description && (
                    <p className="line-clamp-1 text-xs text-muted">{project.description}</p>
                  )}
                  {project.summary && (
                    <p className="line-clamp-2 text-xs text-muted">{project.summary}</p>
                  )}
                  <div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-surface-2">
                      <div
                        className="h-full rounded bg-accent transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {done}/{total} milestones · {project.pageCount} note
                      {project.pageCount === 1 ? "" : "s"}
                      {project.dueDate
                        ? ` · due ${new Date(project.dueDate).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  {next && (
                    <p className="flex items-center gap-1.5 text-xs text-muted">
                      <Target className="h-3.5 w-3.5" />
                      Next: {next.name}
                    </p>
                  )}
                  <div className="mt-auto flex items-center gap-2 text-[11px] text-muted">
                    {project.status === "done" ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : project.status === "paused" ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <CircleDot className="h-3.5 w-3.5" />
                    )}
                    {total} milestone{total === 1 ? "" : "s"}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
