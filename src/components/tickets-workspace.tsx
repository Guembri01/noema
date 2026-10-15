"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createTicketAction,
  loadMoreTicketsAction,
  moveTicketAction,
  updateTicketAction,
} from "@/server/actions/tickets";
import { PromptDialog } from "@/components/prompt-dialog";
import { saveTicketViewAction } from "@/server/actions/ticket-views";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { isClosed, sumEstimates } from "@/lib/tickets";
import { type LabelRow, type TicketRow } from "@/components/tickets/ticket-types";
import { TicketsToolbar } from "@/components/tickets/tickets-toolbar";
import { TicketComposer } from "@/components/tickets/ticket-composer";
import {
  TicketBoardView,
  TicketListView,
  TicketTimeline,
  type TicketSortSpec,
} from "@/components/tickets/ticket-view-renderers";
import { TicketDrawer } from "@/components/tickets/ticket-drawer";

export type { LabelRow, TicketRow } from "@/components/tickets/ticket-types";

/** Tickets workspace: list, board and timeline views over one dataset. */
export function TicketsWorkspace({
  workspaceId,
  slug,
  tickets,
  labels,
  members,
  projects,
  initialProjectFilter,
  views,
  locale,
  cycles,
  nextCursor,
}: {
  workspaceId: string;
  slug: string;
  tickets: TicketRow[];
  labels: LabelRow[];
  members: { id: string; name: string }[];
  projects: { id: string; name: string; icon: string | null }[];
  initialProjectFilter?: string;
  views: { id: string; name: string; config: Record<string, unknown> }[];
  locale: string;
  /** Sprints the workspace has planned. */
  cycles: { id: string; name: string }[];
  /** Keyset cursor for the next page of tickets. */
  nextCursor: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [view, setView] = useState<"list" | "board" | "timeline">("board");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [labelFilter, setLabelFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [projectFilter, setProjectFilter] = useState<string>(initialProjectFilter ?? "");
  const [hideDone, setHideDone] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [viewDialog, setViewDialog] = useState(false);
  // Ordered sort keys for the list view. Empty means "keep the incoming order",
  // which is the default until the toolbar's sort control picks a field.
  const [sortSpecs, setSortSpecs] = useState<TicketSortSpec[]>([]);
  // Extra pages fetched with "Load more".
  const [moreRows, setMoreRows] = useState<TicketRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(nextCursor);

  const rows = useMemo(() => [...tickets, ...moreRows], [tickets, moreRows]);

  const filtered = useMemo(
    () =>
      rows.filter((ticket) => {
        if (hideDone && isClosed(ticket.status)) return false;
        if (statusFilter && ticket.status !== statusFilter) return false;
        if (priorityFilter && ticket.priority !== priorityFilter) return false;
        if (labelFilter && !ticket.labelIds.includes(labelFilter)) return false;
        if (assigneeFilter && ticket.assigneeId !== assigneeFilter) return false;
        if (projectFilter && ticket.projectId !== projectFilter) return false;
        if (query) {
          const needle = query.toLowerCase();
          if (!`${ticket.key} ${ticket.title}`.toLowerCase().includes(needle)) return false;
        }
        return true;
      }),
    [rows, hideDone, statusFilter, priorityFilter, labelFilter, assigneeFilter, projectFilter, query],
  );

  const totals = sumEstimates(filtered);
  const remaining = sumEstimates(filtered.filter((ticket) => !isClosed(ticket.status)));
  const closed = filtered.filter((ticket) => isClosed(ticket.status)).length;
  const active = tickets.find((ticket) => ticket.id === selected) ?? null;

  const run = (label: string | null, task: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const outcome = await safeAction(task, { locale });
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      if (!value.ok) {
        toast.error(value.message ?? t(locale, "somethingWentWrong"));
        return;
      }
      if (label) toast.success(label);
      router.refresh();
    });

  const createTicket = (form: FormData) =>
    run(
      form.get("title") ? t(locale, "ticketCreated") : t(locale, "ticketWord"),
      async () => {
      const result = await createTicketAction({
        workspaceId,
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
        type: String(form.get("type") ?? "task"),
        priority: String(form.get("priority") ?? "none"),
        status: String(form.get("status") ?? "todo"),
        estimate: form.get("estimate") ? Number(form.get("estimate")) : null,
        estimateUnit: String(form.get("estimateUnit") ?? "points"),
        startDate: String(form.get("startDate") ?? "") || null,
        dueDate: String(form.get("dueDate") ?? "") || null,
        projectId: String(form.get("projectId") ?? "") || null,
        assigneeId: String(form.get("assigneeId") ?? "") || null,
      });

      if ("error" in result) return { ok: false, message: result.error };
      setComposerOpen(false);
      return { ok: true };
    });

  const patch = (ticketId: string, data: Record<string, unknown>, label?: string) =>
    run(label ?? null, async () => {
      const result = await updateTicketAction({ ticketId, ...data });

      return "error" in result ? { ok: false, message: result.error } : { ok: true };
    });

  return (
    <div>
      <TicketsToolbar
        view={view}
        setView={setView}
        query={query}
        setQuery={setQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        priorityFilter={priorityFilter}
        setPriorityFilter={setPriorityFilter}
        labelFilter={labelFilter}
        setLabelFilter={setLabelFilter}
        assigneeFilter={assigneeFilter}
        setAssigneeFilter={setAssigneeFilter}
        projectFilter={projectFilter}
        setProjectFilter={setProjectFilter}
        hideDone={hideDone}
        setHideDone={setHideDone}
        labels={labels}
        members={members}
        projects={projects}
        views={views}
        locale={locale}
        run={run}
        setComposerOpen={setComposerOpen}
        setViewDialog={setViewDialog}
        filteredCount={filtered.length}
        rowsCount={rows.length}
        totals={totals}
        remaining={remaining}
        closed={closed}
        checked={checked}
        setChecked={setChecked}
        onSortChange={(spec) => setSortSpecs(spec ? [spec] : [])}
      />

      {composerOpen && (
        <TicketComposer
          onSubmit={createTicket}
          pending={pending}
          projects={projects}
          members={members}
          locale={locale}
          onCancel={() => setComposerOpen(false)}
        />
      )}

      {/* Views */}
      {view === "list" && (
        <TicketListView
          filtered={filtered}
          checked={checked}
          setChecked={setChecked}
          onSelect={setSelected}
          locale={locale}
          pending={pending}
          cursor={cursor}
          rowsCount={rows.length}
          sortSpecs={sortSpecs}
          onLoadMore={() => {
            if (!cursor) return;
            run(null, async () => {
              const result = await loadMoreTicketsAction({
                workspaceId,
                cursor,
                take: 100,
              });
              if ("error" in result) return { ok: false, message: result.error };
              setMoreRows((current) => [...current, ...result.tickets]);
              setCursor(result.nextCursor);
              return { ok: true };
            });
          }}
        />
      )}

      {view === "board" && (
        <TicketBoardView
          filtered={filtered}
          onSelect={setSelected}
          onMove={(ticketId, status) =>
            run(null, async () => {
              const result = await moveTicketAction({ ticketId, status });

              return "error" in result ? { ok: false, message: result.error } : { ok: true };
            })
          }
        />
      )}

      {view === "timeline" && <TicketTimeline tickets={filtered} onOpen={setSelected} />}

      <PromptDialog
        open={viewDialog}
        locale={locale}
        title={t(locale, "saveView")}
        description={t(locale, "saveViewDesc")}
        fields={[
          {
            name: "name",
            label: t(locale, "viewName"),
            placeholder: t(locale, "viewNamePlaceholder"),
          },
        ]}
        confirmLabel={t(locale, "saveView")}
        onSubmit={(values) =>
          run(t(locale, "savedView"), async () => {
            const result = await saveTicketViewAction({
              workspaceId,
              name: values.name,
              config: {
                status: statusFilter,
                priority: priorityFilter,
                labelId: labelFilter,
                assigneeId: assigneeFilter,
                projectId: projectFilter,
                query,
                hideClosed: hideDone,
                view,
              },
            });

            return "error" in result ? { ok: false, message: result.error } : { ok: true };
          })
        }
        onClose={() => setViewDialog(false)}
      />

      {active && (
        <TicketDrawer
          ticket={active}
          labels={labels}
          members={members}
          projects={projects}
          allTickets={tickets}
          workspaceId={workspaceId}
          slug={slug}
          locale={locale}
          onClose={() => setSelected(null)}
          onOpen={setSelected}
          onAddChild={(title) =>
            run(null, async () => {
              const result = await createTicketAction({
                workspaceId,
                title,
                parentId: active.id,
                projectId: active.projectId,
                status: active.status,
              });

              return "error" in result ? { ok: false, message: result.error } : { ok: true };
            })
          }
          cycles={cycles}
          patch={patch}
        />
      )}
    </div>
  );
}
