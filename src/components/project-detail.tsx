"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  addMilestoneAction,
  deleteMilestoneAction,
  deleteProjectAction,
  updateMilestoneAction,
  updateProjectAction,
} from "@/server/actions/projects";
import {
  listProjectRolesAction,
  removeProjectRoleAction,
  setProjectRoleAction,
} from "@/server/actions/workspaces";
import type { ProjectMemberSummary, ProjectRole } from "@/lib/project-roles";
import {safeAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";


export type MilestoneRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
};

export type ProjectDetailData = {
  id: string;
  name: string;
  summary: string | null;
  description: string | null;
  status: string;
  icon: string | null;
  startDate: string | null;
  dueDate: string | null;
  milestones: MilestoneRow[];
  pages: { id: string; title: string; icon: string | null; type: string }[];
};

const NEXT_STATUS: Record<string, "planned" | "in_progress" | "done"> = {
  planned: "in_progress",
  in_progress: "done",
  done: "planned",
};

/** Project detail: status, milestones (add/advance/remove) and attached notes. */
export function ProjectDetail({
  project,
  slug,
  locale,
}: {
  project: ProjectDetailData;
  slug: string;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary ?? "");
  const [description, setDescription] = useState(project.description ?? "");
  const [status, setStatus] = useState(project.status);
  const [startDate, setStartDate] = useState(project.startDate?.slice(0, 10) ?? "");
  const [dueDate, setDueDate] = useState(project.dueDate?.slice(0, 10) ?? "");
  const [milestoneName, setMilestoneName] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");

  const run = (label: string | null, task: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const outcome = await safeAction(task);
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      if (!value.ok) {
        toast.error(value.message ?? t(locale, "somethingWentWrong"));
        return;
      }
      if (label) toast.success(label);
      router.refresh();
    });

  const statusLabel = (value: string) =>
    value === "planned"
      ? t(locale, "statusPlanned")
      : value === "in_progress"
        ? t(locale, "statusInProgress")
        : value === "done"
          ? t(locale, "done")
          : value;

  const saveProject = () =>
    run(t(locale, "projectSaved"), async () => {
      const result = await updateProjectAction({
        projectId: project.id,
        name,
        summary,
        description,
        status: status as "active" | "paused" | "done" | "archived",
        startDate: startDate || null,
        dueDate: dueDate || null,
      });
      return "error" in result ? { ok: false, message: result.error } : { ok: true };
    });

  const addMilestone = () =>
    run(t(locale, "milestoneAdded"), async () => {
      const result = await addMilestoneAction({
        projectId: project.id,
        name: milestoneName,
        dueDate: milestoneDue || null,
      });
      if ("error" in result) return { ok: false, message: result.error };
      setMilestoneName("");
      setMilestoneDue("");
      return { ok: true };
    });

  const total = project.milestones.length;
  const done = project.milestones.filter((milestone) => milestone.status === "done").length;
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            aria-label={t(locale, "projectName")}
            onChange={(event) => setName(event.target.value)}
            className="h-9 min-w-48 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <select
            value={status}
            aria-label={t(locale, "projectStatusAria")}
            onChange={(event) => setStatus(event.target.value)}
            className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none"
          >
            {["active", "paused", "done", "archived"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={startDate}
            aria-label={t(locale, "projectStartAria")}
            onChange={(event) => setStartDate(event.target.value)}
            className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
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
            disabled={pending}
            onClick={saveProject}
            className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
          >
            {t(locale, "save")}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(t(locale, "projectDeleted"), async () => {
                const result = await deleteProjectAction(project.id);
                if ("error" in result) return { ok: false, message: result.error };
                router.push(`/w/${slug}/projects`);
                return { ok: true };
              })
            }
            className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm text-muted hover:text-red-500 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> {t(locale, "delete")}
          </button>
        </div>
        <textarea
          value={summary}
          aria-label={t(locale, "projectSummaryLabel")}
          rows={2}
          placeholder={t(locale, "projectSummaryPlaceholder")}
          onChange={(event) => setSummary(event.target.value)}
          className="mt-3 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
        <textarea
          value={description}
          aria-label={t(locale, "projectDescriptionLabel")}
          rows={3}
          placeholder={t(locale, "projectDescriptionPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
          className="mt-3 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded bg-surface-2">
            <div className="h-full rounded bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">
            {done}/{total} {t(locale, "milestonesComplete")} · {progress}%
            {project.dueDate
              ? ` · ${t(locale, "dueWord")} ${new Date(project.dueDate).toLocaleDateString()}`
              : ""}
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
          {t(locale, "milestonesHeading")}
        </h2>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={milestoneName}
            aria-label={t(locale, "milestoneName")}
            placeholder={t(locale, "milestoneName")}
            onChange={(event) => setMilestoneName(event.target.value)}
            className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <input
            type="date"
            value={milestoneDue}
            aria-label={t(locale, "milestoneDueAria")}
            onChange={(event) => setMilestoneDue(event.target.value)}
            className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={pending || !milestoneName.trim()}
            onClick={addMilestone}
            className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> {t(locale, "addMilestone")}
          </button>
        </div>

        {project.milestones.length === 0 ? (
          <p className="text-sm text-muted">{t(locale, "noMilestones")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {project.milestones.map((milestone) => (
              <li key={milestone.id} className="flex items-center gap-3 px-3 py-2">
                <button
                  type="button"
                  aria-label={`${t(locale, "advancePrefix")} ${milestone.name}`}
                  disabled={pending}
                  onClick={() =>
                    run(null, async () => {
                      const result = await updateMilestoneAction({
                        milestoneId: milestone.id,
                        status: NEXT_STATUS[milestone.status] ?? "planned",
                      });
                      return "error" in result ? { ok: false, message: result.error } : { ok: true };
                    })
                  }
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full border",
                    milestone.status === "done"
                      ? "border-transparent bg-emerald-500 text-white"
                      : milestone.status === "in_progress"
                        ? "border-accent text-accent"
                        : "border-border text-transparent",
                  )}
                >
                  {milestone.status === "done" ? (
                    <Check className="h-3 w-3" />
                  ) : milestone.status === "in_progress" ? (
                    <Play className="h-2.5 w-2.5" />
                  ) : null}
                </button>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "truncate text-sm",
                      milestone.status === "done" && "text-muted line-through",
                    )}
                  >
                    {milestone.name}
                  </p>
                  <p className="flex items-center gap-2 text-[11px] text-muted">
                    {statusLabel(milestone.status)}
                    {milestone.dueDate && (
                      <span className="flex items-center gap-1">
                        <CalendarDays className="h-3 w-3" />
                        {new Date(milestone.dueDate).toLocaleDateString()}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`${t(locale, "delete")} ${milestone.name}`}
                  disabled={pending}
                  onClick={() =>
                    run(t(locale, "milestoneRemoved"), async () => {
                      const result = await deleteMilestoneAction(milestone.id);
                      return "error" in result ? { ok: false, message: result.error } : { ok: true };
                    })
                  }
                  className="shrink-0 text-muted hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
          {t(locale, "notesInProject")} · {project.pages.length}
        </h2>
        {project.pages.length === 0 ? (
          <p className="text-sm text-muted">
            {t(locale, "attachNotesA")}
            <em>{t(locale, "attachNotesB")}</em>.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {project.pages.map((page) => (
              <li key={page.id}>
                <Link
                  href={`/w/${slug}/${page.id}`}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition hover:bg-surface-2"
                >
                  <span aria-hidden>{page.icon ?? (page.type === "DATABASE" ? "🗂️" : "📄")}</span>
                  <span className="truncate">{page.title || t(locale, "untitled")}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProjectRoleEditor projectId={project.id} locale={locale} />
    </div>
  );
}

/**
 * Per-project role editor. Loads the workspace roster projected onto the
 * `@/lib/project-roles` decision table (via `listProjectRolesAction`) and lets a
 * member who may `manageMembers` re-role or remove project members. Every change
 * is re-checked server-side (ceiling + last-owner guard); the component only
 * renders what the engine says is allowed.
 */
function ProjectRoleEditor({ projectId, locale }: { projectId: string; locale: string }) {
  const router = useRouter();
  const [members, setMembers] = useState<ProjectMemberSummary[]>([]);
  const [roles, setRoles] = useState<{ id: ProjectRole; description: string }[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const outcome = await safeAction(() => listProjectRolesAction(projectId), { locale });
    if (!outcome.ok) {
      toast.error(outcome.error);
    } else if ("error" in outcome.value) {
      toast.error(outcome.value.error);
    } else {
      setMembers(outcome.value.members);
      setRoles(outcome.value.roles);
      setCanManage(outcome.value.canManage);
    }
    setLoading(false);
  }, [projectId, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (userId: string, task: () => Promise<{ ok: true } | { error: string }>) => {
    setBusy(userId);
    const outcome = await safeAction(task, { locale });
    setBusy(null);
    const value = outcome.ok ? outcome.value : { error: outcome.error };
    if ("error" in value) {
      toast.error(value.error);
      return;
    }
    await load();
    router.refresh();
  };

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
        {t(locale, "members")}
      </h2>
      {loading ? (
        <p className="text-sm text-muted">{t(locale, "loading")}</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-muted">No project members yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{member.name ?? member.userId}</span>
              <span className="text-[11px] uppercase text-muted">{member.source}</span>
              <select
                value={member.role ?? ""}
                aria-label={`Role for ${member.name ?? member.userId}`}
                disabled={!canManage || busy === member.userId}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next) void mutate(member.userId, () => setProjectRoleAction(projectId, member.userId, next));
                }}
                className="h-8 rounded border border-border bg-bg px-2 text-xs outline-none disabled:opacity-50"
              >
                {member.role === null && <option value="">No access</option>}
                {roles.map((role) => (
                  <option key={role.id} value={role.id} title={role.description}>
                    {role.id}
                  </option>
                ))}
              </select>
              {canManage && (
                <button
                  type="button"
                  disabled={busy === member.userId}
                  aria-label={`Remove ${member.name ?? member.userId} from project`}
                  onClick={() => void mutate(member.userId, () => removeProjectRoleAction(projectId, member.userId))}
                  className="shrink-0 text-muted hover:text-red-500 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
