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
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";


export type LabelManagerRow = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  count: number;
};

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
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
            >
              <input
                defaultValue={label.name}
                aria-label={`${t(locale, "rename")} ${label.name}`}
                onBlur={(event) =>
                  event.target.value !== label.name &&
                  run(t(locale, "labelRenamed"), async () => {
                    const result = await updateLabelAction({
                      labelId: label.id,
                      name: event.target.value,
                    });
                    return "error" in result ? { ok: false, message: result.error } : { ok: true };
                  })
                }
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
