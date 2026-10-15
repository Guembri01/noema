import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition, useState } from "react";
import { MessageSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  addTicketCommentAction,
  archiveTicketAction,
  linkTicketsAction,
  toggleTicketLabelAction,
} from "@/server/actions/tickets";
import { assignTicketToCycleAction } from "@/server/actions/cycles";
import { safeAction } from "@/lib/actions-client";
import { DESCRIPTION_MAX } from "@/lib/description";
import {
  convert,
  formatEstimate,
  isEstimateUnit,
  sumEstimates,
  type EstimateUnit,
} from "@/lib/estimate-units";
import { t } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/i18n-format";
import { progressOf, rollupByAssignee, rollupEstimate } from "@/lib/sub-ticket-rollup";
import {
  ESTIMATE_UNITS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  UNASSIGNED_BUCKET,
  typeMeta,
} from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { StatusPill } from "./ticket-bits";
import { LABEL_TONES, type LabelRow, type TicketRow } from "./ticket-types";

/** Whether a raw estimate is a usable number (missing/non-finite = absent). */
const hasFiniteEstimate = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Convert one raw estimate into `unit`, rounding per row. Missing/non-finite
 * values stay absent (the roll-up engine already counts them as 0) and unknown
 * units are coerced to `points`, matching `sumEstimates`'s own normalisation.
 */
function estimateInUnit(
  estimate: number | null | undefined,
  from: string | null | undefined,
  unit: EstimateUnit,
): number | null {
  if (!hasFiniteEstimate(estimate)) return null;
  return convert(estimate, isEstimateUnit(from) ? from : "points", unit);
}

/**
 * One per-ticket activity row, shaped exactly like the `activity` selection in
 * `getTicketDetail` (`{ id, kind, detail, createdAt, actor }`). Passed in
 * optionally so the drawer's history section is additive: a caller that has the
 * data (e.g. the ticket detail query) supplies it, and a caller without it
 * (the tracker list, which does not select `TicketActivity`) renders unchanged.
 */
export type TicketActivityRow = {
  id: string;
  /** Action verb written by `logActivity`, e.g. `status_changed`, `label_added`. */
  kind: string;
  /** Optional JSON payload (`updated` snapshots, `{ to }`, `{ label }`, …). */
  detail: unknown;
  /** Creation instant — any input `formatRelativeTime` accepts. */
  createdAt: string | number | Date;
  actor: { id: string; name: string } | null;
};

/** Turn an activity `kind` into a readable verb ("status_changed" → "Status changed"). */
function activityVerb(kind: string): string {
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : kind;
}

/**
 * Flatten an activity `detail` payload into one compact line. Plain values pass
 * through, arrays join with commas, and objects render `key: value` pairs joined
 * by `·`; anything else (or an empty object/array) yields `""` so the row simply
 * omits the detail rather than printing `[object Object]`.
 */
function activityDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  if (Array.isArray(detail)) return detail.map(activityDetail).filter(Boolean).join(", ");
  if (typeof detail === "object") {
    return Object.entries(detail as Record<string, unknown>)
      .map(([key, value]) => {
        const text = activityDetail(value);
        return text ? `${key}: ${text}` : "";
      })
      .filter(Boolean)
      .join(" · ");
  }
  return "";
}

/** Safe `datetime` attribute for a `<time>`, or `undefined` when unparsable. */
function activityIso(value: string | number | Date): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Right-hand drawer with every ticket field, relations, comments, activity. */
export function TicketDrawer({
  ticket,
  labels,
  members,
  projects,
  allTickets,
  activity = [],
  slug,
  locale,
  onClose,
  onOpen,
  onAddChild,
  cycles,
  patch,
}: {
  ticket: TicketRow;
  labels: LabelRow[];
  members: { id: string; name: string }[];
  projects: { id: string; name: string; icon: string | null }[];
  allTickets: TicketRow[];
  workspaceId: string;
  /** Per-ticket activity trail; omit/empty hides the section. */
  activity?: TicketActivityRow[];
  slug: string;
  locale: string;
  onClose: () => void;
  /** Open another ticket in the same drawer (parent / child links). */
  onOpen: (ticketId: string) => void;
  onAddChild: (title: string) => void;
  cycles: { id: string; name: string }[];
  patch: (ticketId: string, data: Record<string, unknown>, label?: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [comment, setComment] = useState("");
  const [relationQuery, setRelationQuery] = useState("");
  const [relationType, setRelationType] = useState("relates");

  // Debounced description autosave: local state while typing, one save per
  // quiet period (or on blur). Reset only when another ticket is opened.
  const [description, setDescription] = useState(ticket.description ?? "");
  const [descriptionFocused, setDescriptionFocused] = useState(false);
  const savedDescription = useRef(ticket.description ?? "");
  const descriptionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasDescription = description.trim().length > 0;

  useEffect(() => {
    setDescription(ticket.description ?? "");
    savedDescription.current = ticket.description ?? "";
  }, [ticket.id]); // eslint-disable-line react-hooks/exhaustive-deps -- reset per opened ticket only

  useEffect(
    () => () => {
      if (descriptionTimer.current) clearTimeout(descriptionTimer.current);
    },
    [],
  );

  const saveDescription = (value: string) => {
    if (value === savedDescription.current) return;
    savedDescription.current = value;
    patch(ticket.id, { description: value });
  };

  const onDescriptionChange = (value: string) => {
    const next = value.length > DESCRIPTION_MAX ? value.slice(0, DESCRIPTION_MAX) : value;
    setDescription(next);
    if (descriptionTimer.current) clearTimeout(descriptionTimer.current);
    descriptionTimer.current = setTimeout(() => saveDescription(next), 800);
  };

  const flushDescription = (value: string) => {
    if (descriptionTimer.current) clearTimeout(descriptionTimer.current);
    saveDescription(value);
  };

  const related = ticket.labelIds;
  const parent = ticket.parentId ? allTickets.find((row) => row.id === ticket.parentId) ?? null : null;
  const children = allTickets.filter((row) => row.parentId === ticket.id);
  // Roll the direct children up through the shared sub-ticket engine instead of
  // a flat sum: `rollupEstimate` gives total/remaining, `progressOf` the done
  // split, `rollupByAssignee` the per-assignee share. The engine is unit-blind
  // (one bare number per tree), so first collapse mixed child units onto one
  // "dominant" unit — `sumEstimates` picks the children's most common unit
  // (ties broken by `ESTIMATE_UNITS`) — convert every row with `convert`, then
  // label the totals with that unit. With no child estimate we fall back to the
  // ticket's own unit, so the label never silently defaults to points.
  const childEstimates = children.map((child) => ({
    estimate: child.estimate,
    estimateUnit: child.estimateUnit,
  }));
  const childSummary = sumEstimates(childEstimates);
  const childUnit: EstimateUnit = childEstimates.some((child) => hasFiniteEstimate(child.estimate))
    ? childSummary.unit
    : isEstimateUnit(ticket.estimateUnit)
      ? ticket.estimateUnit
      : "points";
  const childTickets = children.map((child) => ({
    id: child.id,
    parentId: child.parentId,
    estimate: estimateInUnit(child.estimate, child.estimateUnit, childUnit),
    state: child.status,
    assigneeId: child.assigneeId,
  }));
  const childRollup = rollupEstimate(childTickets);
  const childProgress = progressOf(childTickets);
  const childByAssignee = rollupByAssignee(childTickets);
  const assigneeNames = new Map(members.map((member) => [member.id, member.name]));
  const candidates = relationQuery
    ? allTickets
        .filter(
          (candidate) =>
            candidate.id !== ticket.id &&
            `${candidate.key} ${candidate.title}`.toLowerCase().includes(relationQuery.toLowerCase()),
        )
        .slice(0, 5)
    : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label={t(locale, "closeTicket")}
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <aside
        role="dialog"
        aria-label={`${t(locale, "ticketWord")} ${ticket.key}`}
        className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-border bg-bg shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span aria-hidden>{typeMeta(ticket.type).icon}</span>
          <span className="font-mono text-xs text-muted">{ticket.key}</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label={t(locale, "archiveTicket")}
            onClick={() =>
              startTransition(async () => {
                const outcome = await safeAction(
                  () => archiveTicketAction(ticket.id),
                  { locale },
                );
                if (!outcome.ok) toast.error(outcome.error);
                else toast.success(t(locale, "ticketArchived"));
                onClose();
                router.refresh();
              })
            }
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:text-red-500"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t(locale, "close")}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <textarea
            defaultValue={ticket.title}
            aria-label={t(locale, "ticketTitle")}
            rows={2}
            onBlur={(event) =>
              event.target.value !== ticket.title &&
              patch(ticket.id, { title: event.target.value }, t(locale, "renamed"))
            }
            className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-lg font-medium outline-none focus:border-accent"
          />

          {/* Notion-style description: a bare placeholder line while empty
              (no empty box) — the box (and testid) appears only with content.
              One element throughout, so typing never remounts and loses focus. */}
          <textarea
            data-testid={hasDescription ? "ticket-description-box" : undefined}
            value={description}
            aria-label={t(locale, "ticketDescriptionAria")}
            rows={Math.min(12, description.split("\n").length + 1)}
            placeholder={t(locale, "addDescription")}
            onChange={(event) => onDescriptionChange(event.target.value)}
            onFocus={() => setDescriptionFocused(true)}
            onBlur={(event) => {
              setDescriptionFocused(false);
              flushDescription(event.target.value);
            }}
            className={cn(
              "w-full resize-none px-3 py-2 text-sm text-fg outline-none placeholder:text-muted",
              hasDescription || descriptionFocused
                ? "rounded-lg border border-border bg-bg"
                : "border border-transparent bg-transparent",
            )}
          />

          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "statusWord")}
              <select
                value={ticket.status}
                aria-label={t(locale, "ticketStatusAria")}
                onChange={(event) =>
                  patch(
                    ticket.id,
                    { status: event.target.value },
                    t(locale, "statusUpdated"),
                  )
                }
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm text-fg"
              >
                {TICKET_STATUSES.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "priorityWord")}
              <select
                value={ticket.priority}
                aria-label={t(locale, "ticketPriorityAria")}
                onChange={(event) =>
                  patch(
                    ticket.id,
                    { priority: event.target.value },
                    t(locale, "priorityUpdated"),
                  )
                }
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm text-fg"
              >
                {TICKET_PRIORITIES.map((priority) => (
                  <option key={priority.id} value={priority.id}>
                    {priority.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "assigneeWord")}
              <select
                value={ticket.assigneeId ?? ""}
                aria-label={t(locale, "ticketAssigneeAria")}
                onChange={(event) =>
                  patch(
                    ticket.id,
                    { assigneeId: event.target.value || null },
                    t(locale, "assigneeUpdated"),
                  )
                }
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm text-fg"
              >
                <option value="">{t(locale, "unassigned")}</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "projectWord")}
              <select
                value={ticket.projectId ?? ""}
                aria-label={t(locale, "ticketProjectAria")}
                onChange={(event) =>
                  patch(
                    ticket.id,
                    { projectId: event.target.value || null },
                    t(locale, "projectUpdated"),
                  )
                }
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm text-fg"
              >
                <option value="">{t(locale, "noProject")}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "scheduledIn")}
              <select
                value={ticket.cycleId ?? ""}
                aria-label={t(locale, "ticketCycleAria")}
                onChange={(event) =>
                  startTransition(async () => {
                    const outcome = await safeAction(
                      () =>
                        assignTicketToCycleAction(ticket.id, event.target.value || null),
                      { locale },
                    );
                    if (!outcome.ok) toast.error(outcome.error);
                    else if ("error" in outcome.value) toast.error(outcome.value.error);
                    router.refresh();
                  })
                }
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm text-fg"
              >
                <option value="">{t(locale, "notScheduled")}</option>
                {cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "estimateWord")}
              <span className="mt-1 flex gap-1">
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  defaultValue={ticket.estimate ?? ""}
                  aria-label={t(locale, "ticketEstimateAria")}
                  onBlur={(event) =>
                    patch(
                      ticket.id,
                      { estimate: event.target.value === "" ? null : Number(event.target.value) },
                      t(locale, "estimateUpdated"),
                    )
                  }
                  className="h-8 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
                />
                <select
                  value={ticket.estimateUnit ?? "points"}
                  aria-label={t(locale, "estimateUnitAria")}
                  onChange={(event) => patch(ticket.id, { estimateUnit: event.target.value })}
                  className="h-8 rounded border border-border bg-bg px-1 text-xs"
                >
                  {ESTIMATE_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "startWord")}
              <input
                type="date"
                defaultValue={ticket.startDate?.slice(0, 10) ?? ""}
                aria-label={t(locale, "startDateAria")}
                onChange={(event) => patch(ticket.id, { startDate: event.target.value || null })}
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
              />
            </label>
            <label className="text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "dueLabel")}
              <input
                type="date"
                defaultValue={ticket.dueDate?.slice(0, 10) ?? ""}
                aria-label={t(locale, "dueDateAria")}
                onChange={(event) => patch(ticket.id, { dueDate: event.target.value || null })}
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
              />
            </label>
          </div>

          <section>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "subticketsHeading")}
            </p>
            {parent && (
              <button
                type="button"
                onClick={() => onOpen(parent.id)}
                className="mb-2 flex w-full items-center gap-1.5 rounded border border-border px-2 py-1 text-left text-xs hover:bg-surface-2"
              >
                <span className="text-muted">{t(locale, "partOf")}</span>
                <span className="font-mono text-muted">{parent.key}</span>
                <span className="min-w-0 flex-1 truncate">{parent.title}</span>
              </button>
            )}

            {children.length > 0 ? (
              <>
                <p className="mb-1.5 text-[11px] text-muted">
                  {childRollup.count}{" "}
                  {childRollup.count === 1
                    ? t(locale, "subTicketOne")
                    : t(locale, "subTicketMany")}{" "}
                  · {childProgress.open} {t(locale, "openWord")} ·{" "}
                  {t(locale, "estimateTotal")}:{" "}
                  <span className="text-fg">{formatEstimate(childRollup.total, childUnit)}</span> ·{" "}
                  {t(locale, "remaining")}:{" "}
                  <span className="text-fg">{formatEstimate(childRollup.remaining, childUnit)}</span>{" "}
                  · {childProgress.percent}%
                </p>
                {childByAssignee.length > 1 && (
                  <ul className="mb-2 space-y-0.5">
                    {childByAssignee.map((bucket) => (
                      <li
                        key={bucket.assigneeId}
                        className="flex items-center justify-between gap-2 text-[11px] text-muted"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {bucket.assigneeId === UNASSIGNED_BUCKET
                            ? t(locale, "unassigned")
                            : (assigneeNames.get(bucket.assigneeId) ?? bucket.assigneeId)}
                        </span>
                        <span className="shrink-0">
                          {formatEstimate(bucket.points, childUnit)} · {bucket.open}{" "}
                          {t(locale, "openWord")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="mb-2 divide-y divide-border rounded border border-border">
                  {children.map((child) => (
                    <li key={child.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(child.id)}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-surface-2"
                      >
                        <span className="font-mono text-muted">{child.key}</span>
                        <span className="min-w-0 flex-1 truncate">{child.title}</span>
                        <span className="text-muted">
                          {formatEstimate(child.estimate, child.estimateUnit ?? "points")}
                        </span>
                        <StatusPill status={child.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mb-2 text-xs text-muted">{t(locale, "noSubTickets")}</p>
            )}

            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const input = event.currentTarget.elements.namedItem("child") as HTMLInputElement;
                const title = input.value.trim();
                if (!title) return;
                input.value = "";
                onAddChild(title);
              }}
            >
              <input
                name="child"
                aria-label={t(locale, "newSubTicketAria")}
                placeholder={t(locale, "addSubTicketPlaceholder")}
                className="h-8 flex-1 rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
              />
              <button
                type="submit"
                className="h-8 rounded border border-border px-2 text-xs hover:bg-surface-2"
              >
                {t(locale, "add")}
              </button>
            </form>
          </section>

          <section>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">{t(locale, "labelsHeading")}</p>            <div className="flex flex-wrap gap-1.5">
              {labels.map((label) => {
                const on = related.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      startTransition(async () => {
                        const outcome = await safeAction(
                          () => toggleTicketLabelAction(ticket.id, label.id),
                          { locale },
                        );
                        if (!outcome.ok) toast.error(outcome.error);
                        else if ("error" in outcome.value) toast.error(outcome.value.error);
                        router.refresh();
                      })
                    }
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      on
                        ? cn("border-transparent", LABEL_TONES[label.color] ?? LABEL_TONES.gray)
                        : "border-border text-muted hover:bg-surface-2",
                    )}
                  >
                    {label.name}
                  </button>
                );
              })}
              {labels.length === 0 && (
                <p className="text-xs text-muted">{t(locale, "noLabelsInSettings")}</p>
              )}
            </div>
          </section>

          <section>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">{t(locale, "relationsHeading")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={relationType}
                aria-label={t(locale, "relationTypeAria")}
                onChange={(event) => setRelationType(event.target.value)}
                className="h-8 rounded border border-border bg-bg px-2 text-xs"
              >
                <option value="relates">{t(locale, "relationRelates")}</option>
                <option value="blocks">{t(locale, "relationBlocks")}</option>
                <option value="blocked_by">{t(locale, "relationBlockedBy")}</option>
                <option value="duplicates">{t(locale, "relationDuplicates")}</option>
              </select>
              <input
                value={relationQuery}
                aria-label={t(locale, "findTicketAria")}
                placeholder={t(locale, "findTicketPlaceholder")}
                onChange={(event) => setRelationQuery(event.target.value)}
                className="h-8 w-48 rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
              />
            </div>
            {candidates.length > 0 && (
              <ul className="mt-2 space-y-1">
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() =>
                        startTransition(async () => {
                          const outcome = await safeAction(
                            () =>
                              linkTicketsAction({
                                fromId: ticket.id,
                                toId: candidate.id,
                                type: relationType,
                              }),
                            { locale },
                          );
                          if (!outcome.ok) toast.error(outcome.error);
                          else if ("error" in outcome.value) toast.error(outcome.value.error);
                          else {
                            toast.success(t(locale, "linkedToast"));
                            setRelationQuery("");
                          }
                          router.refresh();
                        })
                      }
                      className="w-full rounded border border-border px-2 py-1 text-left text-xs hover:bg-surface-2"
                    >
                      <span className="font-mono text-muted">{candidate.key}</span> {candidate.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
              <MessageSquare className="h-3 w-3" /> {t(locale, "commentsHeading")} (
              {ticket.commentCount})
            </p>
            <div className="flex items-end gap-2">
              <textarea
                value={comment}
                aria-label={t(locale, "addTicketCommentAria")}
                rows={2}
                placeholder={t(locale, "leaveCommentPlaceholder")}
                onChange={(event) => setComment(event.target.value)}
                className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                disabled={!comment.trim()}
                onClick={() =>
                  startTransition(async () => {
                    const outcome = await safeAction(
                      () => addTicketCommentAction(ticket.id, comment),
                      { locale },
                    );
                    if (!outcome.ok) toast.error(outcome.error);
                    else if ("error" in outcome.value) toast.error(outcome.value.error);
                    else {
                      setComment("");
                      toast.success(t(locale, "commentAdded"));
                    }
                    router.refresh();
                  })
                }
                className="h-8 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
              >
                {t(locale, "comment")}
              </button>
            </div>
          </section>

          <section data-testid="ticket-activity">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "activityHeading")}
            </p>
            {activity.length === 0 ? (
              <p className="text-xs text-muted">{t(locale, "youAreAllCaughtUp")}</p>
            ) : (
              <ol className="space-y-1.5">
                {activity.map((entry) => {
                  const detail = activityDetail(entry.detail);
                  const iso = activityIso(entry.createdAt);
                  return (
                    <li key={entry.id} className="flex items-baseline gap-1.5 text-xs">
                      <span className="shrink-0 text-fg">{activityVerb(entry.kind)}</span>
                      {entry.actor && (
                        <span className="shrink-0 text-muted">{entry.actor.name}</span>
                      )}
                      {detail && <span className="min-w-0 flex-1 truncate text-muted">{detail}</span>}
                      <time
                        dateTime={iso}
                        title={iso}
                        className="ml-auto shrink-0 text-[11px] text-muted"
                      >
                        {formatRelativeTime(entry.createdAt, { locale })}
                      </time>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "timelineDatesHeading")}
            </p>
            <p className="text-xs text-muted">
              {ticket.startDate
                ? new Date(ticket.startDate).toLocaleDateString()
                : t(locale, "noStart")}{" "}
              →{" "}
              {ticket.dueDate
                ? new Date(ticket.dueDate).toLocaleDateString()
                : t(locale, "noDueDate")}{" "}
              ·{" "}
              {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")} ·{" "}
              {t(locale, "viewTheTabA")}{" "}
              <span className="text-fg">{t(locale, "timelineLabel")}</span>{" "}
              {t(locale, "viewTheTabB")}
            </p>
          </section>

          <section className="rounded-lg border border-border p-3">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
              {t(locale, "whereThisLivesHeading")}
            </p>
            <p className="text-xs text-muted">
              {ticket.projectName
                ? `${t(locale, "projectColon")} ${ticket.projectName}`
                : t(locale, "notInProject")}
              {ticket.milestoneName
                ? ` · ${t(locale, "milestoneColon")} ${ticket.milestoneName}`
                : ""}
              {ticket.assigneeName ? ` · ${t(locale, "assignedTo")} ${ticket.assigneeName}` : ""}
            </p>
            <p className="mt-1 text-[11px] text-muted">
              {t(locale, "permalinkLabel")} /w/{slug}?ticket={ticket.key}
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}
