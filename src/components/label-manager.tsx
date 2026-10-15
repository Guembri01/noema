"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createLabelAction,
  deleteLabelAction,
  updateLabelAction,
} from "@/server/actions/tickets";
import { safeAction } from "@/lib/actions-client";
import { LABEL_COLORS } from "@/lib/tickets";
import { allocateSlugs, uniqueSlug } from "@/lib/slug-uniqueness";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";


export type LabelManagerRow = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  count: number;
};

/**
 * Allocate a unique, deduped slug for every label, positionally.
 *
 * Slugs are derived from the label name through the shared engine: comparison
 * is case-insensitive and trimmed (`"Bug"` / `"bug "` collapse), reserved route
 * words (`new`, `settings`, …) are skipped, and the first free `-1`/`-2` suffix
 * resolves a collision — the same slug shape a `/w/<slug>` path would carry.
 */
function labelSlugs(labels: readonly LabelManagerRow[]): string[] {
  return allocateSlugs(labels.map((label) => label.name));
}

/**
 * The unique slug `name` would receive against the workspace's labels,
 * ignoring `exceptId` so renaming a label never collides with its own name.
 */
function slugForName(
  name: string,
  labels: readonly LabelManagerRow[],
  exceptId?: string,
): string {
  const taken = labels
    .filter((label) => label.id !== exceptId)
    .map((label) => label.name);
  return uniqueSlug(name, taken);
}

const TONES: Record<string, string> = {
  gray: "bg-surface-2 text-muted",
  blue: "bg-blue-500/10 text-blue-600",
  green: "bg-emerald-500/10 text-emerald-600",
  yellow: "bg-amber-500/10 text-amber-600",
  orange: "bg-orange-500/10 text-orange-600",
  red: "bg-red-500/10 text-red-500",
  purple: "bg-purple-500/10 text-purple-600",
  pink: "bg-pink-500/10 text-pink-600",
};

/** Workspace-level label catalogue used by every ticket. */
export function LabelManager({
  workspaceId,
  labels,
  locale,
}: {
  workspaceId: string;
  labels: LabelManagerRow[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [color, setColor] = useState("blue");
  const [description, setDescription] = useState("");
  const [renamedSlug, setRenamedSlug] = useState<Record<string, string>>({});

  // Stable slug per row, plus the slug the label in the create box would get.
  const slugById = new Map(
    labelSlugs(labels).map((slug, index) => [labels[index].id, slug] as const),
  );
  const draftSlug = name.trim() ? slugForName(name, labels) : "";

  const run = (label: string, task: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const outcome = await safeAction(task);
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      if (!value.ok) {
        toast.error(value.message ?? t(locale, "somethingWentWrong"));
        return;
      }
      toast.success(label);
      router.refresh();
    });

  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <Tag className="h-4 w-4" /> {t(locale, "ticketLabels")}
      </h2>
      <p className="mb-4 text-sm text-muted">
        {t(locale, "labelsIntro")}
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={name}
          aria-label={t(locale, "labelName")}
          placeholder={t(locale, "labelName")}
          onChange={(event) => setName(event.target.value)}
          className="h-9 w-48 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        {draftSlug && (
          <code
            data-slug={draftSlug}
            title={`${t(locale, "permalinkLabel")} ${draftSlug}`}
            className="inline-flex h-9 items-center rounded bg-surface-2 px-2 font-mono text-xs text-muted"
          >
            {draftSlug}
          </code>
        )}
        <input
          value={description}
          aria-label={t(locale, "labelDescriptionAria")}
          placeholder={t(locale, "descriptionOptional")}
          onChange={(event) => setDescription(event.target.value)}
          className="h-9 w-64 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <select
          value={color}
          aria-label={t(locale, "labelColourAria")}
          onChange={(event) => setColor(event.target.value)}
          className="h-9 rounded border border-border bg-bg px-2 text-sm"
        >
          {LABEL_COLORS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={() =>
            run(t(locale, "labelCreated"), async () => {
              const result = await createLabelAction({ workspaceId, name, color, description });
              if ("error" in result) return { ok: false, message: result.error };
              setName("");
              setDescription("");
              return { ok: true };
            })
          }
          className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> {t(locale, "create")}
        </button>
      </div>

      {labels.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noLabels")}</p>
      ) : (
        <ul className="space-y-2">
          {labels.map((label) => (
            <li
              key={label.id}
              data-slug={renamedSlug[label.id] ?? slugById.get(label.id) ?? ""}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
            >
              <input
                defaultValue={label.name}
                aria-label={`${t(locale, "rename")} ${label.name}`}
                onBlur={(event) => {
                  const nextName = event.target.value;
                  if (nextName === label.name) return;
                  // Derive the renamed label's unique slug up front so the row
                  // shows the same slug the refreshed label list will allocate.
                  setRenamedSlug((previous) => ({
                    ...previous,
                    [label.id]: slugForName(nextName, labels, label.id),
                  }));
                  run(t(locale, "labelRenamed"), async () => {
                    const result = await updateLabelAction({
                      labelId: label.id,
                      name: nextName,
                    });
                    return "error" in result ? { ok: false, message: result.error } : { ok: true };
                  });
                }}
                className="h-8 w-40 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
              />
              <span
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-medium",
                  TONES[label.color] ?? TONES.gray,
                )}
              >
                {label.color}
              </span>
              <code
                title={`${t(locale, "permalinkLabel")} ${renamedSlug[label.id] ?? slugById.get(label.id) ?? ""}`}
                className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted"
              >
                {renamedSlug[label.id] ?? slugById.get(label.id) ?? ""}
              </code>
              <select
                defaultValue={label.color}
                aria-label={`${t(locale, "colourFor")} ${label.name}`}
                onChange={(event) =>
                  run(t(locale, "colourUpdated"), async () => {
                    const result = await updateLabelAction({
                      labelId: label.id,
                      color: event.target.value,
                    });
                    return "error" in result ? { ok: false, message: result.error } : { ok: true };
                  })
                }
                className="h-8 rounded border border-border bg-bg px-1 text-xs"
              >
                {LABEL_COLORS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <input
                defaultValue={label.description ?? ""}
                aria-label={`${t(locale, "descriptionFor")} ${label.name}`}
                placeholder={t(locale, "descriptionLabel")}
                onBlur={(event) =>
                  run(t(locale, "descriptionUpdated"), async () => {
                    const result = await updateLabelAction({
                      labelId: label.id,
                      description: event.target.value || null,
                    });
                    return "error" in result ? { ok: false, message: result.error } : { ok: true };
                  })
                }
                className="h-8 min-w-40 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
              />
              <span className="text-xs text-muted">{label.count} {t(locale, "ticketsLower")}</span>
              <button
                type="button"
                aria-label={`${t(locale, "delete")} ${label.name}`}
                onClick={() =>
                  run(t(locale, "labelDeleted"), async () => {
                    const result = await deleteLabelAction(label.id);
                    return "error" in result ? { ok: false, message: result.error } : { ok: true };
                  })
                }
                className="text-muted hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
