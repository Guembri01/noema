import { ESTIMATE_UNITS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_TYPES } from "@/lib/tickets";
import { t } from "@/lib/i18n";

/** Inline "new ticket" composer rendered above the views. */
export function TicketComposer({
  onSubmit,
  pending,
  projects,
  members,
  locale,
  onCancel,
}: {
  onSubmit: (form: FormData) => void;
  pending: boolean;
  projects: { id: string; name: string; icon: string | null }[];
  members: { id: string; name: string }[];
  locale: string;
  onCancel: () => void;
}) {
  return (
    <form
      action={onSubmit}
      className="mb-5 grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <input
        name="title"
        aria-label={t(locale, "ticketTitle")}
        placeholder={t(locale, "ticketTitle")}
        required
        className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent sm:col-span-2 lg:col-span-4"
      />
      <select name="type" aria-label={t(locale, "ticketTypeAria")} className="h-9 rounded border border-border bg-bg px-2 text-sm">
        {TICKET_TYPES.map((type) => (
          <option key={type.id} value={type.id}>
            {type.icon} {type.label}
          </option>
        ))}
      </select>
      <select name="status" aria-label={t(locale, "ticketStatusAria")} className="h-9 rounded border border-border bg-bg px-2 text-sm">
        {TICKET_STATUSES.map((status) => (
          <option key={status.id} value={status.id}>
            {status.label}
          </option>
        ))}
      </select>
      <select name="priority" aria-label={t(locale, "ticketPriorityAria")} className="h-9 rounded border border-border bg-bg px-2 text-sm">
        {TICKET_PRIORITIES.map((priority) => (
          <option key={priority.id} value={priority.id}>
            {priority.label}
          </option>
        ))}
      </select>
      <span className="flex gap-1">
        <input
          name="estimate"
          aria-label={t(locale, "ticketEstimateAria")}
          type="number"
          step="0.5"
          min="0"
          placeholder={t(locale, "estimateWord")}
          className="h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <select name="estimateUnit" aria-label={t(locale, "estimateUnitAria")} className="h-9 rounded border border-border bg-bg px-2 text-sm">
          {ESTIMATE_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </span>
      <input name="startDate" aria-label={t(locale, "startDateAria")} type="date" className="h-9 rounded border border-border bg-bg px-2 text-sm" />
      <input name="dueDate" aria-label={t(locale, "dueDateAria")} type="date" className="h-9 rounded border border-border bg-bg px-2 text-sm" />
      <select name="projectId" aria-label={t(locale, "ticketProjectAria")} className="h-9 rounded border border-border bg-bg px-2 text-sm">
        <option value="">{t(locale, "noProject")}</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <select name="assigneeId" aria-label={t(locale, "ticketAssigneeAria")} className="h-9 rounded border border-border bg-bg px-2 text-sm">
        <option value="">{t(locale, "unassigned")}</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </select>
      <textarea
        name="description"
        aria-label={t(locale, "ticketDescriptionAria")}
        placeholder={t(locale, "descriptionOptional")}
        rows={2}
        className="rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent sm:col-span-2 lg:col-span-4"
      />
      <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
        <button
          type="submit"
          disabled={pending}
          className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          {t(locale, "createTicket")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded border border-border px-3 text-sm text-muted"
        >
          {t(locale, "cancel")}
        </button>
      </div>
    </form>
  );
}
