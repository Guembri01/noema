import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useTransition, useState, type ReactNode } from "react";
import { Archive, MessageSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  addTicketCommentAction,
  archiveTicketAction,
  deleteTicketAction,
  linkTicketsAction,
  restoreTicketAction,
  toggleTicketLabelAction,
} from "@/server/actions/tickets";
import { deleteTicketConfirmLabel } from "@/lib/ticket-delete";
import { assignTicketToCycleAction } from "@/server/actions/cycles";
import { safeAction, withUndo } from "@/lib/actions-client";
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
  statusMeta,
  typeMeta,
} from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { applyDirAttr } from "@/lib/bidi";
import { trapPlan, type Focusable, type FocusPlan } from "@/lib/focus-trap";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, type SelectOption } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet } from "@/components/ui/sheet";
import { Stepper } from "@/components/ui/stepper";
import { Tag } from "@/components/ui/tag";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusPill } from "./ticket-bits";
import { type LabelRow, type TicketRow } from "./ticket-types";

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

const pad2 = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DD` for the local calendar day of an instant, or `null` if invalid. */
function dayKey(value: string | number | Date): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** A run of activity entries that share one calendar day. */
export type ActivityGroup = {
  /** Stable key: the `YYYY-MM-DD` day, or `"unknown"` for unparsable times. */
  key: string;
  /** Human label: "Today", "Yesterday", or the locale date. */
  label: string;
  entries: TicketActivityRow[];
};

/**
 * Group an activity trail by calendar day, preserving both the incoming entry
 * order and the first-appearance day order. Pure and total (`now` is injected
 * so the Today/Yesterday labels are deterministic in tests). Each group renders
 * under one heading with the timeline indent guide beneath it.
 */
export function groupActivity(
  entries: readonly TicketActivityRow[],
  now: Date | number = Date.now(),
): ActivityGroup[] {
  const nowDate = new Date(now);
  const todayKey = dayKey(nowDate);
  const yesterdayKey = dayKey(new Date(nowDate.getTime() - 24 * 60 * 60 * 1000));

  const order: string[] = [];
  const buckets = new Map<string, ActivityGroup>();
  for (const entry of entries) {
    const key = dayKey(entry.createdAt) ?? "unknown";
    let group = buckets.get(key);
    if (!group) {
      const label =
        key === todayKey
          ? "Today"
          : key === yesterdayKey
            ? "Yesterday"
            : key === "unknown"
              ? "Unknown"
              : new Date(entry.createdAt).toLocaleDateString();
      group = { key, label, entries: [] };
      buckets.set(key, group);
      order.push(key);
    }
    group.entries.push(entry);
  }
  return order.map((key) => buckets.get(key)!);
}

/* -------------------------------------------------------------------------- *
 * Property row → control (the pure mapping)
 * ------------------------------------------------------------------------- */

/** The ticket properties the drawer edits. */
export type TicketPropertyField =
  | "status"
  | "priority"
  | "assignee"
  | "project"
  | "cycle"
  | "estimate"
  | "startDate"
  | "dueDate"
  | "labels";

/** Which design-system control a property row is rendered with. */
export type TicketPropertyControl = "select" | "date" | "stepper" | "tags";

/**
 * Property → control map. Pure and total, so the node test can pin that every
 * property resolves to a sanctioned primitive (and the drawer renders the same
 * table it advertises).
 */
export const PROPERTY_CONTROL: Record<TicketPropertyField, TicketPropertyControl> = {
  status: "select",
  priority: "select",
  assignee: "select",
  project: "select",
  cycle: "select",
  estimate: "stepper",
  startDate: "date",
  dueDate: "date",
  labels: "tags",
};

/** The control kind for one property. */
export function propertyControl(field: TicketPropertyField): TicketPropertyControl {
  return PROPERTY_CONTROL[field];
}

/* -------------------------------------------------------------------------- *
 * Focus management (shared kernel: @/lib/focus-trap)
 *
 * The drawer chrome now lives on `ui/sheet`, which owns the Tab trap, Escape,
 * the body-scroll lock and focus restore. `planTicketDrawerTab` is kept as the
 * door onto the shared trap kernel for the existing overlay-wiring check.
 * ------------------------------------------------------------------------- */

/**
 * Tab / Shift+Tab plan for the ticket drawer, delegated to the shared
 * `@/lib/focus-trap` kernel. `activeId` is the focused stop's id (`null` when
 * focus is outside the ring, which enters at the first stop — last on
 * Shift+Tab). `null` means "nothing to trap".
 */
export function planTicketDrawerTab(
  stops: readonly Focusable[],
  { activeId = null, shift = false }: { activeId?: string | null; shift?: boolean } = {},
): FocusPlan | null {
  return trapPlan(stops, {
    initial: activeId === null ? null : { id: activeId },
    shift,
  });
}

/** A labelled property row: an uppercase micro-label over its control. */
function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-2xs uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

/** A sectioned block: a heading over a body. */
function DrawerSection({
  title,
  icon,
  children,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <p className="mb-2 flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted">
        {icon}
        {title}
      </p>
      {children}
    </section>
  );
}

export type TicketDrawerBodyProps = {
  ticket: TicketRow;
  labels: LabelRow[];
  members: { id: string; name: string }[];
  projects: { id: string; name: string; icon: string | null }[];
  allTickets: TicketRow[];
  activity: TicketActivityRow[];
  cycles: { id: string; name: string }[];
  slug: string;
  locale: string;
  /** Persist a field patch on this ticket. */
  onPatch: (data: Record<string, unknown>, label?: string) => void;
  /** Open another ticket in the same drawer. */
  onOpen: (ticketId: string) => void;
  /** Create a sub-ticket of this one. */
  onAddChild: (title: string) => void;
  /** Schedule (or unschedule) the ticket in a cycle. */
  onCycleChange: (cycleId: string | null) => void;
  /** Toggle a label relation. */
  onToggleLabel: (labelId: string) => void;
  /** Link a related ticket. */
  onLinkTicket: (toId: string, type: string) => void;
  /** Post a comment. */
  onAddComment: (body: string) => void;
};

/**
 * The drawer body — Properties / Description / Comments / Activity — as a
 * self-contained, router-free component so it can be rendered statically
 * (`renderToStaticMarkup` in the node test) and so `TicketDrawer` stays a thin
 * wiring shell around `ui/sheet`.
 *
 * Property rows use the design-system controls (`Select` / `DatePicker` /
 * `Stepper` / `Tag` / `Avatar`); the activity trail renders grouped under day
 * headings with an indent guide and muted timestamps.
 */
export function TicketDrawerBody({
  ticket,
  labels,
  members,
  projects,
  allTickets,
  activity,
  cycles,
  slug,
  locale,
  onPatch,
  onOpen,
  onAddChild,
  onCycleChange,
  onToggleLabel,
  onLinkTicket,
  onAddComment,
}: TicketDrawerBodyProps) {
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
  const titleDirection = applyDirAttr(ticket.title);
  const descriptionDirection = applyDirAttr(description);

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
    onPatch({ description: value });
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
  const parent = ticket.parentId
    ? allTickets.find((row) => row.id === ticket.parentId) ?? null
    : null;
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

  const statusOptions: SelectOption[] = TICKET_STATUSES.map((status) => ({
    value: status.id,
    label: status.label,
    tag: status.color,
  }));
  const priorityOptions: SelectOption[] = TICKET_PRIORITIES.map((priority) => ({
    value: priority.id,
    label: priority.label,
    tag: priority.color,
  }));
  const assigneeOptions: SelectOption[] = members.map((member) => ({
    value: member.id,
    label: member.name,
    icon: <Avatar user={{ id: member.id, name: member.name }} size={16} />,
  }));
  const projectOptions: SelectOption[] = projects.map((project) => ({
    value: project.id,
    label: project.name,
    icon: project.icon ? <span aria-hidden>{project.icon}</span> : undefined,
  }));
  const cycleOptions: SelectOption[] = cycles.map((cycle) => ({
    value: cycle.id,
    label: cycle.name,
  }));
  const activityGroups = useMemo(() => groupActivity(activity), [activity]);

  return (
    <>
      <DrawerSection title={t(locale, "properties")}>
        <div className="grid grid-cols-2 gap-3">
          <PropertyRow label={t(locale, "statusWord")}>
            <Select
              aria-label={t(locale, "ticketStatusAria")}
              value={ticket.status}
              options={statusOptions}
              onChange={(value) => onPatch({ status: value }, t(locale, "statusUpdated"))}
            />
          </PropertyRow>

          <PropertyRow label={t(locale, "priorityWord")}>
            <Select
              aria-label={t(locale, "ticketPriorityAria")}
              value={ticket.priority}
              options={priorityOptions}
              onChange={(value) => onPatch({ priority: value }, t(locale, "priorityUpdated"))}
            />
          </PropertyRow>

          <PropertyRow label={t(locale, "assigneeWord")}>
            <Select
              aria-label={t(locale, "ticketAssigneeAria")}
              value={ticket.assigneeId ?? ""}
              options={assigneeOptions}
              placeholder={t(locale, "unassigned")}
              onChange={(value) =>
                onPatch({ assigneeId: value || null }, t(locale, "assigneeUpdated"))
              }
            />
          </PropertyRow>

          <PropertyRow label={t(locale, "projectWord")}>
            <Select
              aria-label={t(locale, "ticketProjectAria")}
              value={ticket.projectId ?? ""}
              options={projectOptions}
              placeholder={t(locale, "noProject")}
              onChange={(value) =>
                onPatch({ projectId: value || null }, t(locale, "projectUpdated"))
              }
            />
          </PropertyRow>

          <PropertyRow label={t(locale, "scheduledIn")}>
            <Select
              aria-label={t(locale, "ticketCycleAria")}
              value={ticket.cycleId ?? ""}
              options={cycleOptions}
              placeholder={t(locale, "notScheduled")}
              onChange={(value) => onCycleChange(value || null)}
            />
          </PropertyRow>

          <PropertyRow label={t(locale, "estimateWord")}>
            <div className="flex items-stretch gap-1" role="group" aria-label={t(locale, "ticketEstimateAria")}>
              <Stepper
                value={ticket.estimate ?? 0}
                min={0}
                step={0.5}
                onValueChange={(value) =>
                  onPatch({ estimate: value }, t(locale, "estimateUpdated"))
                }
                className="min-w-0 flex-1"
              />
              <Select
                aria-label={t(locale, "estimateUnitAria")}
                className="w-24"
                value={ticket.estimateUnit ?? "points"}
                options={ESTIMATE_UNITS.map((unit) => ({ value: unit, label: unit }))}
                allowClear={false}
                searchable={false}
                onChange={(value) => onPatch({ estimateUnit: value })}
              />
            </div>
          </PropertyRow>

          <PropertyRow label={t(locale, "startWord")}>
            <DatePicker
              mode="date"
              value={{ date: ticket.startDate?.slice(0, 10) ?? null }}
              placeholder={t(locale, "noStart")}
              locale={locale}
              onChange={(next) => onPatch({ startDate: next.date ?? null })}
              className="w-full"
            />
          </PropertyRow>

          <PropertyRow label={t(locale, "dueLabel")}>
            <DatePicker
              mode="date"
              value={{ date: ticket.dueDate?.slice(0, 10) ?? null }}
              placeholder={t(locale, "noDueDate")}
              locale={locale}
              onChange={(next) => onPatch({ dueDate: next.date ?? null })}
              className="w-full"
            />
          </PropertyRow>
        </div>

        <div className="mt-4">
          <DrawerSection title={t(locale, "labelsHeading")}>
            <div className="flex flex-wrap gap-1.5">
              {labels.map((label) => {
                const on = related.includes(label.id);
                return (
                  <Tag
                    key={label.id}
                    hue={label.color}
                    size="sm"
                    selected={on}
                    onSelectedChange={() => onToggleLabel(label.id)}
                  >
                    {label.name}
                  </Tag>
                );
              })}
              {labels.length === 0 && (
                <p className="text-xs text-muted">{t(locale, "noLabelsInSettings")}</p>
              )}
            </div>
          </DrawerSection>
        </div>
      </DrawerSection>

      <Separator />

      <DrawerSection title={t(locale, "description")}>
        <textarea
          data-testid={hasDescription ? "ticket-description-box" : undefined}
          value={description}
          dir={descriptionDirection.dir}
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
            "focus-ring w-full resize-y rounded-md px-3 py-2 text-sm text-fg outline-none placeholder:text-muted u-colors",
            descriptionDirection.className,
            hasDescription || descriptionFocused
              ? "border border-border bg-bg"
              : "border border-dashed border-border bg-transparent",
          )}
        />
      </DrawerSection>

      <Separator />

      <DrawerSection title={t(locale, "subticketsHeading")}>
        {parent && (
          <button
            type="button"
            onClick={() => onOpen(parent.id)}
            className="focus-ring u-colors mb-2 flex w-full items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-left text-xs hover:bg-surface-2"
          >
            <span className="text-muted">{t(locale, "partOf")}</span>
            <span className="font-mono text-muted">{parent.key}</span>
            <span className="min-w-0 flex-1 truncate">{parent.title}</span>
          </button>
        )}

        {children.length > 0 ? (
          <>
            <p className="mb-1.5 flex flex-wrap items-center gap-1 text-2xs text-muted">
              <Badge tone="neutral" size="sm" count={childRollup.count} />
              <span>{t(locale, "estimateTotal")}:</span>
              <span className="text-fg">{formatEstimate(childRollup.total, childUnit)}</span>
              <span>· {t(locale, "remaining")}:</span>
              <span className="text-fg">{formatEstimate(childRollup.remaining, childUnit)}</span>
              <span>· {childProgress.open} {t(locale, "openWord")} · {childProgress.percent}%</span>
            </p>
            {childByAssignee.length > 1 && (
              <ul className="mb-2 space-y-0.5">
                {childByAssignee.map((bucket) => (
                  <li
                    key={bucket.assigneeId}
                    className="flex items-center justify-between gap-2 text-2xs text-muted"
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
            <ul className="mb-2 divide-y divide-border rounded-md border border-border">
              {children.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(child.id)}
                    className="focus-ring u-colors flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-surface-2"
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
            className="focus-ring u-colors h-8 min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 text-xs outline-none placeholder:text-muted"
          />
          <Button type="submit" size="sm" variant="secondary">
            {t(locale, "add")}
          </Button>
        </form>
      </DrawerSection>

      <Separator />

      <DrawerSection title={t(locale, "relationsHeading")}>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t(locale, "relationTypeAria")}
            className="w-40"
            size="sm"
            value={relationType}
            searchable={false}
            allowClear={false}
            options={[
              { value: "relates", label: t(locale, "relationRelates") },
              { value: "blocks", label: t(locale, "relationBlocks") },
              { value: "blocked_by", label: t(locale, "relationBlockedBy") },
              { value: "duplicates", label: t(locale, "relationDuplicates") },
            ]}
            onChange={setRelationType}
          />
          <input
            value={relationQuery}
            aria-label={t(locale, "findTicketAria")}
            placeholder={t(locale, "findTicketPlaceholder")}
            onChange={(event) => setRelationQuery(event.target.value)}
            className="focus-ring u-colors h-8 min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 text-xs outline-none placeholder:text-muted focus:border-accent"
          />
        </div>
        {candidates.length > 0 && (
          <ul className="mt-2 space-y-1">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => {
                    onLinkTicket(candidate.id, relationType);
                    setRelationQuery("");
                  }}
                  className="focus-ring u-colors w-full rounded-sm border border-border px-2 py-1 text-left text-xs hover:bg-surface-2"
                >
                  <span className="font-mono text-muted">{candidate.key}</span> {candidate.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>

      <Separator />

      <DrawerSection
        title={
          <>
            <MessageSquare className="h-3 w-3" aria-hidden /> {t(locale, "commentsHeading")}
            <Badge tone="neutral" size="sm" count={ticket.commentCount} />
          </>
        }
      >
        <div className="flex items-end gap-2">
          <textarea
            value={comment}
            aria-label={t(locale, "addTicketCommentAria")}
            rows={2}
            placeholder={t(locale, "leaveCommentPlaceholder")}
            onChange={(event) => setComment(event.target.value)}
            className="focus-ring u-colors w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
          />
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={!comment.trim()}
            onClick={() => {
              onAddComment(comment);
              setComment("");
            }}
          >
            {t(locale, "comment")}
          </Button>
        </div>
      </DrawerSection>

      <Separator />

      <DrawerSection title={t(locale, "activityHeading")}>
        {activity.length === 0 ? (
          <p className="text-xs text-muted">{t(locale, "youAreAllCaughtUp")}</p>
        ) : (
          <div className="space-y-3" data-testid="ticket-activity">
            {activityGroups.map((group) => (
              <div key={group.key}>
                <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted">
                  {group.label}
                </p>
                <ol className="relative space-y-1.5 border-s border-border ps-3">
                  {group.entries.map((entry) => {
                    const detail = activityDetail(entry.detail);
                    const iso = activityIso(entry.createdAt);
                    return (
                      <li key={entry.id} className="relative flex items-baseline gap-1.5 text-xs">
                        <span
                          aria-hidden
                          className="absolute -start-[15px] top-1.5 h-1.5 w-1.5 rounded-full bg-border-strong"
                        />
                        <span className="shrink-0 text-fg">{activityVerb(entry.kind)}</span>
                        {entry.actor && (
                          <span className="shrink-0 text-muted">{entry.actor.name}</span>
                        )}
                        {detail && (
                          <span className="min-w-0 flex-1 truncate text-muted">{detail}</span>
                        )}
                        <time
                          dateTime={iso}
                          title={iso}
                          className="ms-auto shrink-0 text-2xs text-muted"
                        >
                          {formatRelativeTime(entry.createdAt, { locale })}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        )}
      </DrawerSection>

      <Separator />

      <DrawerSection title={t(locale, "whereThisLivesHeading")} className="rounded-lg border border-border p-3">
        <p className="text-xs text-muted">
          {ticket.projectName
            ? `${t(locale, "projectColon")} ${ticket.projectName}`
            : t(locale, "notInProject")}
          {ticket.milestoneName
            ? ` · ${t(locale, "milestoneColon")} ${ticket.milestoneName}`
            : ""}
          {ticket.assigneeName ? ` · ${t(locale, "assignedTo")} ${ticket.assigneeName}` : ""}
        </p>
        <p className="mt-1 text-2xs text-muted">
          {t(locale, "permalinkLabel")} /w/{slug}?ticket={ticket.key}
        </p>
      </DrawerSection>
    </>
  );
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
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const onPatch = (data: Record<string, unknown>, label?: string) =>
    patch(ticket.id, data, label);

  const archive = () =>
    startTransition(async () => {
      const outcome = await safeAction(() => archiveTicketAction(ticket.id), { locale });
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success(
        t(locale, "ticketArchived"),
        withUndo({
          label: t(locale, "archiveTicket"),
          undo: () => restoreTicketAction(ticket.id),
          locale,
        }),
      );
      onClose();
      router.refresh();
    });

  const permanentlyDelete = () =>
    startTransition(async () => {
      const outcome = await safeAction(() => deleteTicketAction(ticket.id), { locale });
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success("Ticket deleted");
      setDeleteOpen(false);
      onClose();
      router.refresh();
    });

  const changeCycle = (cycleId: string | null) =>
    startTransition(async () => {
      const outcome = await safeAction(() => assignTicketToCycleAction(ticket.id, cycleId), {
        locale,
      });
      if (!outcome.ok) toast.error(outcome.error);
      else if ("error" in outcome.value) toast.error(outcome.value.error);
      router.refresh();
    });

  const toggleLabel = (labelId: string) =>
    startTransition(async () => {
      const outcome = await safeAction(() => toggleTicketLabelAction(ticket.id, labelId), {
        locale,
      });
      if (!outcome.ok) toast.error(outcome.error);
      else if ("error" in outcome.value) toast.error(outcome.value.error);
      router.refresh();
    });

  const linkTicket = (toId: string, type: string) =>
    startTransition(async () => {
      const outcome = await safeAction(
        () => linkTicketsAction({ fromId: ticket.id, toId, type }),
        { locale },
      );
      if (!outcome.ok) toast.error(outcome.error);
      else if ("error" in outcome.value) toast.error(outcome.value.error);
      else toast.success(t(locale, "linkedToast"));
      router.refresh();
    });

  const addComment = (body: string) =>
    startTransition(async () => {
      const outcome = await safeAction(() => addTicketCommentAction(ticket.id, body), { locale });
      if (!outcome.ok) toast.error(outcome.error);
      else if ("error" in outcome.value) toast.error(outcome.value.error);
      else toast.success(t(locale, "commentAdded"));
      router.refresh();
    });

  const archiveLabel = t(locale, "archiveTicket");
  const deleteLabel = t(locale, "delete");

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        side="right"
        size="lg"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden>{typeMeta(ticket.type).icon}</span>
            <span className="shrink-0 font-mono text-xs text-muted">{ticket.key}</span>
            <span className="truncate">{ticket.title}</span>
          </span>
        }
        description={statusMeta(ticket.status).label}
        actions={
          <>
            <Tooltip label={archiveLabel}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={archiveLabel}
                disabled={pending}
                leftIcon={<Archive className="h-4 w-4" aria-hidden />}
                onClick={archive}
              />
            </Tooltip>
            <Tooltip label={deleteLabel}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={deleteLabel}
                data-testid="ticket-delete"
                leftIcon={<Trash2 className="h-4 w-4" aria-hidden />}
                onClick={() => setDeleteOpen(true)}
                className="text-danger hover:bg-danger-soft hover:text-danger"
              />
            </Tooltip>
          </>
        }
        footer={
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted">
              {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")} ·{" "}
              {ticket.commentCount} {t(locale, "commentsHeading").toLowerCase()}
            </span>
            <Button type="button" size="sm" variant="secondary" onClick={onClose}>
              {t(locale, "close")}
            </Button>
          </div>
        }
        bodyClassName="space-y-5"
      >
        <TicketDrawerBody
          ticket={ticket}
          labels={labels}
          members={members}
          projects={projects}
          allTickets={allTickets}
          activity={activity}
          cycles={cycles}
          slug={slug}
          locale={locale}
          onPatch={onPatch}
          onOpen={onOpen}
          onAddChild={onAddChild}
          onCycleChange={changeCycle}
          onToggleLabel={toggleLabel}
          onLinkTicket={linkTicket}
          onAddComment={addComment}
        />
      </Sheet>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        tone="danger"
        title={t(locale, "delete")}
        description={deleteTicketConfirmLabel(ticket.key, ticket.title)}
        confirmLabel={t(locale, "deletePermanently")}
        pending={pending}
        onConfirm={() => void permanentlyDelete()}
      />
    </>
  );
}
