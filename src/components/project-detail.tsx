"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, ChevronDown, ChevronUp, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  addMilestoneAction,
  deleteMilestoneAction,
  deleteProjectAction,
  setPageProjectAction,
  updateMilestoneAction,
  updateProjectAction,
} from "@/server/actions/projects";
import {
  listProjectRolesAction,
  removeProjectRoleAction,
  setProjectRoleAction,
} from "@/server/actions/workspaces";
import type { ProjectMemberSummary, ProjectRole } from "@/lib/project-roles";
import { formatEstimate, statusMeta } from "@/lib/tickets";
import { safeAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Section } from "@/components/ui/section";
import { Select } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tag } from "@/components/ui/tag";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { LocalTime } from "@/components/local-time";

export type MilestoneRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
};

/** One row of the project's ticket list (labels carry a tag hue). */
export type ProjectDetailTicket = {
  id: string;
  key: string;
  title: string;
  status: string;
  priority?: string | null;
  estimate?: number | null;
  estimateUnit?: string | null;
  labels?: { id: string; name: string; color?: string | null }[];
};

/** One entry of the project's activity timeline. */
export type ProjectActivityEntry = {
  id: string;
  actor: string;
  action: string;
  at: string;
  detail?: string | null;
  /** Nesting level; each level adds one indent guide. */
  depth?: number;
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
  /** Live pages that can still be attached to this project. */
  availablePages?: { id: string; title: string; icon: string | null; type: string }[];
  /** Optional ticket roll-up for the "Tickets" section. */
  tickets?: ProjectDetailTicket[];
  /** Optional activity timeline for the "Activity" section. */
  activity?: ProjectActivityEntry[];
};

/** Project status options for the overview `Select`. */
export const PROJECT_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

/** Milestone status → badge tone. */
export const MILESTONE_STATUS_TONE: Record<string, BadgeTone> = {
  planned: "neutral",
  in_progress: "accent",
  done: "success",
};

export function milestoneStatusTone(status: string): BadgeTone {
  return MILESTONE_STATUS_TONE[status] ?? "neutral";
}

/** planned → in progress → done → planned, the milestone advance cycle. */
const NEXT_MILESTONE_STATUS: Record<string, "planned" | "in_progress" | "done"> = {
  planned: "in_progress",
  in_progress: "done",
  done: "planned",
};

/** Milestone-derived progress: done count + whole-percent completion. */
export function milestoneProgress(
  milestones: readonly { status: string }[],
): { total: number; done: number; percent: number } {
  const total = milestones.length;
  const done = milestones.filter((milestone) => milestone.status === "done").length;
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * Move the item at `index` by `delta` places (clamped to the list bounds).
 * Always returns a fresh array; an out-of-range move is a copy, never a throw.
 */
export function moveMilestone<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = list.slice();
  const target = index + Math.sign(delta);
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/** Project detail: overview, milestones (add/checkbox/date/reorder/remove) and notes. */
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
  const [order, setOrder] = useState<string[]>(() => project.milestones.map((m) => m.id));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachSelected, setAttachSelected] = useState<string[]>([]);

  // Keep the local reorder in sync when the server re-renders the project.
  useEffect(() => {
    setOrder(project.milestones.map((milestone) => milestone.id));
  }, [project.id, project.milestones]);

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

  const attachExistingPages = () => {
    if (attachSelected.length === 0) return;
    run("Added to project", async () => {
      for (const pageId of attachSelected) {
        const result = await setPageProjectAction(pageId, project.id);
        if ("error" in result) return { ok: false, message: result.error };
      }
      setAttachSelected([]);
      setAttachOpen(false);
      return { ok: true };
    });
  };

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

  const setMilestoneDate = (milestone: MilestoneRow, value: string) =>
    run(null, async () => {
      const result = await updateMilestoneAction({
        milestoneId: milestone.id,
        dueDate: value || null,
      });
      return "error" in result ? { ok: false, message: result.error } : { ok: true };
    });

  const byId = useMemo(
    () => new Map(project.milestones.map((milestone) => [milestone.id, milestone])),
    [project.milestones],
  );
  const ordered = order
    .map((id) => byId.get(id))
    .filter((milestone): milestone is MilestoneRow => milestone !== undefined);

  const progress = milestoneProgress(project.milestones);
  const tickets = project.tickets;
  const activity = project.activity;

  return (
    <div className="space-y-10">
      <Section
        title="Overview"
        description={t(locale, "projectDescriptionLabel")}
        action={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={saveProject}
            >
              {t(locale, "save")}
            </Button>
            <Button
              type="button"
              variant="danger"
              tone="soft"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              {t(locale, "delete")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            aria-label={t(locale, "projectName")}
            onChange={(event) => setName(event.target.value)}
            className="h-9 min-w-48 flex-1 rounded-control border-control bg-bg px-2 text-sm outline-none focus-ring"
          />
          <Select
            options={PROJECT_STATUS_OPTIONS}
            value={status}
            onChange={setStatus}
            size="sm"
            aria-label={t(locale, "projectStatusAria")}
          />
          <span className="flex items-center gap-1 text-xs text-muted">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden />
            <label htmlFor="project-start" className="sr-only">
              {t(locale, "projectStartAria")}
            </label>
            <DatePicker
              id="project-start"
              mode="date"
              locale={locale}
              value={{ date: startDate || null }}
              onChange={(value) => setStartDate(value.date ?? "")}
            />
          </span>
          <span className="flex items-center gap-1 text-xs text-muted">
            <label htmlFor="project-due" className="sr-only">
              {t(locale, "projectDue")}
            </label>
            <DatePicker
              id="project-due"
              mode="date"
              locale={locale}
              value={{ date: dueDate || null }}
              onChange={(value) => setDueDate(value.date ?? "")}
            />
          </span>
        </div>

        <textarea
          value={summary}
          aria-label={t(locale, "projectSummaryLabel")}
          rows={2}
          placeholder={t(locale, "projectSummaryPlaceholder")}
          onChange={(event) => setSummary(event.target.value)}
          className="w-full rounded-control border-control bg-bg px-2 py-1.5 text-sm outline-none focus-ring"
        />
        <textarea
          value={description}
          aria-label={t(locale, "projectDescriptionLabel")}
          rows={3}
          placeholder={t(locale, "projectDescriptionPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full rounded-control border-control bg-bg px-2 py-1.5 text-sm outline-none focus-ring"
        />

        <Progress
          value={progress.percent}
          max={100}
          size="md"
          tone={progress.percent >= 100 ? "success" : "accent"}
          showValue
          label={`${progress.done}/${progress.total} ${t(locale, "milestonesComplete")}`}
        />
        {project.dueDate && (
          <p className="text-xs text-muted">
            {t(locale, "dueWord")} <LocalTime value={project.dueDate} mode="date" />
          </p>
        )}
      </Section>

      <Section
        title={t(locale, "milestonesHeading")}
        description={t(locale, "milestonesComplete")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={milestoneName}
            aria-label={t(locale, "milestoneName")}
            placeholder={t(locale, "milestoneName")}
            onChange={(event) => setMilestoneName(event.target.value)}
            className="h-9 w-56 rounded-control border-control bg-bg px-2 text-sm outline-none focus-ring"
          />
          <label htmlFor="milestone-new-due" className="sr-only">
            {t(locale, "milestoneDueAria")}
          </label>
          <DatePicker
            id="milestone-new-due"
            mode="date"
            locale={locale}
            value={{ date: milestoneDue || null }}
            onChange={(value) => setMilestoneDue(value.date ?? "")}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !milestoneName.trim()}
            onClick={addMilestone}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {t(locale, "addMilestone")}
          </Button>
        </div>

        {ordered.length === 0 ? (
          <EmptyState
            variant="compact"
            data-testid="milestones-empty"
            title={t(locale, "noMilestones")}
            description="Add the first milestone to start tracking progress."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {ordered.map((milestone, index) => (
              <li
                key={milestone.id}
                id={`milestone-${milestone.id}`}
                data-testid="milestone-row"
                className="flex scroll-mt-24 flex-wrap items-center gap-3 px-3 py-2"
              >
                <button
                  type="button"
                  aria-label={`${t(locale, "advancePrefix")} ${milestone.name}`}
                  disabled={pending}
                  onClick={() =>
                    run(null, async () => {
                      const result = await updateMilestoneAction({
                        milestoneId: milestone.id,
                        status: NEXT_MILESTONE_STATUS[milestone.status] ?? "planned",
                      });
                      return "error" in result ? { ok: false, message: result.error } : { ok: true };
                    })
                  }
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full border focus-ring u-interactive",
                    milestone.status === "done"
                      ? "border-transparent bg-success text-action-fg"
                      : milestone.status === "in_progress"
                        ? "border-accent text-accent"
                        : "border-border text-transparent",
                  )}
                >
                  {milestone.status === "done" ? (
                    <Check className="h-3 w-3" aria-hidden />
                  ) : milestone.status === "in_progress" ? (
                    <Play className="h-2.5 w-2.5" aria-hidden />
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
                  <p className="flex items-center gap-2 text-2xs text-muted">
                    <Badge
                      tone={milestoneStatusTone(milestone.status)}
                      size="sm"
                      data-testid="milestone-status"
                    >
                      {statusLabel(milestone.status)}
                    </Badge>
                    {milestone.dueDate && (
                      <span className="flex items-center gap-1">
                        <CalendarDays className="h-3 w-3" aria-hidden />
                        <LocalTime value={milestone.dueDate} mode="date" />
                      </span>
                    )}
                  </p>
                </div>

                <label htmlFor={`milestone-due-${milestone.id}`} className="sr-only">
                  {t(locale, "milestoneDueAria")}
                </label>
                <DatePicker
                  id={`milestone-due-${milestone.id}`}
                  mode="date"
                  locale={locale}
                  value={{ date: milestone.dueDate?.slice(0, 10) ?? null }}
                  onChange={(value) => setMilestoneDate(milestone, value.date ?? "")}
                />

                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(locale, "moveUp")}
                    disabled={pending || index === 0}
                    onClick={() => setOrder((current) => moveMilestone(current, index, -1))}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(locale, "moveDown")}
                    disabled={pending || index === ordered.length - 1}
                    onClick={() => setOrder((current) => moveMilestone(current, index, 1))}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${t(locale, "delete")} ${milestone.name}`}
                    disabled={pending}
                    onClick={() =>
                      run(t(locale, "milestoneRemoved"), async () => {
                        const result = await deleteMilestoneAction(milestone.id);
                        return "error" in result
                          ? { ok: false, message: result.error }
                          : { ok: true };
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {tickets && (
        <Section title={t(locale, "tickets")}>
          {tickets.length === 0 ? (
            <EmptyState
              variant="compact"
              data-testid="tickets-empty"
              title="No tickets yet"
              description="Tickets scheduled into this project will show up here."
            />
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {tickets.map((ticket) => (
                <li
                  key={ticket.id}
                  data-testid="ticket-row"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm"
                >
                  <span className="w-16 shrink-0 font-mono text-2xs text-muted">
                    {ticket.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={ticket.title}>
                    {ticket.title}
                  </span>
                  {ticket.labels?.map((label) => (
                    <Tag key={label.id} hue={label.color} size="sm">
                      {label.name}
                    </Tag>
                  ))}
                  <Tag hue={statusMeta(ticket.status).color} size="sm">
                    {statusMeta(ticket.status).label}
                  </Tag>
                  <span className="text-xs text-muted">
                    {formatEstimate(ticket.estimate ?? null, ticket.estimateUnit ?? "points")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {activity && (
        <Section title="Activity">
          <ol className="relative ms-2 space-y-3 border-s border-border ps-4">
            {activity.map((entry) => (
              <li
                key={entry.id}
                data-testid="activity-row"
                className="relative"
                style={{ marginInlineStart: `${(entry.depth ?? 0) * 16}px` }}
              >
                <span
                  aria-hidden
                  className="absolute -start-[1.3rem] top-1 h-2 w-2 rounded-full bg-border-strong"
                />
                <p className="text-sm">
                  <span className="font-medium">{entry.actor}</span> {entry.action}
                </p>
                {entry.detail && <p className="text-xs text-muted">{entry.detail}</p>}
                <p className="text-2xs text-muted">
                  <LocalTime value={entry.at} mode="datetime" />
                </p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section title={`${t(locale, "notesInProject")} · ${project.pages.length}`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">
            {t(locale, "attachNotesA")}
            <em>{t(locale, "attachNotesB")}</em>.
          </p>
          {project.availablePages && project.availablePages.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leftIcon={<Plus className="h-3.5 w-3.5" aria-hidden />}
              onClick={() => setAttachOpen(true)}
            >
              Attach existing page
            </Button>
          ) : null}
        </div>
        {project.pages.length === 0 ? null : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {project.pages.map((page) => (
              <li key={page.id}>
                <Link
                  href={`/w/${slug}/${page.id}`}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm u-colors hover:bg-surface-2 focus-ring"
                >
                  <span aria-hidden>{page.icon ?? (page.type === "DATABASE" ? "🗂️" : "📄")}</span>
                  <span className="truncate">{page.title || t(locale, "untitled")}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Dialog open={attachOpen} onOpenChange={setAttachOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-lg flex-col p-4" aria-describedby="attach-pages-help">
          <h2 className="text-sm font-semibold">Attach existing pages</h2>
          <p id="attach-pages-help" className="mt-1 text-xs text-muted">
            The page stays where it is in the sidebar and is also listed in this
            project.
          </p>
          <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {(project.availablePages ?? []).map((page) => (
              <label
                key={page.id}
                className="flex cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 hover:bg-surface-2"
              >
                <Checkbox
                  checked={attachSelected.includes(page.id)}
                  onCheckedChange={(checked) =>
                    setAttachSelected((current) =>
                      checked
                        ? [...current, page.id]
                        : current.filter((id) => id !== page.id),
                    )
                  }
                  aria-label={`Attach ${page.title || "Untitled"}`}
                />
                <span className="min-w-0 text-sm">
                  <span aria-hidden>{page.icon ?? "📄"} </span>
                  {page.title || t(locale, "untitled")}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setAttachOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || attachSelected.length === 0}
              loading={pending}
              onClick={attachExistingPages}
            >
              Attach {attachSelected.length > 0 ? `(${attachSelected.length})` : ""}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ProjectRoleEditor projectId={project.id} locale={locale} />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        tone="danger"
        title={`${t(locale, "delete")} “${name}”?`}
        description="This permanently removes the project and its milestones."
        confirmLabel={t(locale, "delete")}
        pending={pending}
        onConfirm={() => {
          setConfirmDelete(false);
          run(t(locale, "projectDeleted"), async () => {
            const result = await deleteProjectAction(project.id);
            if ("error" in result) return { ok: false, message: result.error };
            router.push(`/w/${slug}/projects`);
            return { ok: true };
          });
        }}
      />
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
    <Section title={t(locale, "members")}>
      {loading ? (
        <p className="text-sm text-muted">{t(locale, "loading")}</p>
      ) : members.length === 0 ? (
        <EmptyState
          variant="compact"
          data-testid="members-empty"
          title={t(locale, "members")}
          description="No project members yet."
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{member.name ?? member.userId}</span>
              <span className="text-2xs uppercase text-muted">{member.source}</span>
              <Select
                options={roles.map((role) => ({
                  value: role.id,
                  label: role.id,
                  description: role.description,
                }))}
                value={member.role ?? ""}
                size="sm"
                aria-label={`Role for ${member.name ?? member.userId}`}
                disabled={!canManage || busy === member.userId}
                onChange={(next) => {
                  if (next) void mutate(member.userId, () => setProjectRoleAction(projectId, member.userId, next));
                }}
              />
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy === member.userId}
                  aria-label={`Remove ${member.name ?? member.userId} from project`}
                  onClick={() => void mutate(member.userId, () => removeProjectRoleAction(projectId, member.userId))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
