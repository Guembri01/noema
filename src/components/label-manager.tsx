"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Plus, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createLabelAction,
  deleteLabelAction,
  updateLabelAction,
} from "@/server/actions/tickets";
import { safeAction } from "@/lib/actions-client";
import {
  PALETTE_STEPS,
  generatePalette,
  isValidHex,
  shade,
  tint,
} from "@/lib/color-palette";
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

/**
 * Base hex seed per named label colour, mirroring the `TONES` Tailwind chips.
 * The seeds only *derive* swatch paint — the stored label colour stays the
 * named value, so persistence, validation and the `TONES` rendering are
 * untouched.
 */
const LABEL_COLOR_SEEDS: Record<string, string> = {
  gray: "#6b7280",
  blue: "#3b82f6",
  green: "#10b981",
  yellow: "#f59e0b",
  orange: "#f97316",
  red: "#ef4444",
  purple: "#a855f7",
  pink: "#ec4899",
};

/** Neutral seed used when a label carries an unknown or malformed colour. */
const FALLBACK_SEED = "#6b7280";

/** Resolve a named colour to a usable `#RRGGBB` seed (unknown names → gray). */
function labelSeed(color: string): string {
  const candidate = LABEL_COLOR_SEEDS[color] ?? FALLBACK_SEED;
  return isValidHex(candidate) ? candidate : FALLBACK_SEED;
}

/**
 * Derived swatch paint for a named colour: the generated palette's base stop is
 * tinted for the background/border and shaded for the text, so every swatch is
 * deterministic and always a valid `#rrggbb`.
 */
function labelSwatchStyle(color: string): CSSProperties {
  const base = generatePalette(labelSeed(color))[500];
  return {
    backgroundColor: tint(base, 82),
    borderColor: tint(base, 45),
    color: shade(base, 35),
  };
}

/**
 * Colour swatch picker for labels. The grid is a radiogroup over the existing
 * `LABEL_COLORS` values — so the stored value domain and CRUD are unchanged —
 * while each swatch is derived through the shared palette engine. The create
 * box also previews the active colour's generated 50–900 ramp.
 */
function LabelColorPicker({
  value,
  onSelect,
  ariaLabel,
  showRamp = false,
}: {
  value: string;
  onSelect: (color: string) => void;
  ariaLabel: string;
  showRamp?: boolean;
}) {
  const [selected, setSelected] = useState(value);
  const choose = (color: string) => {
    setSelected(color);
    onSelect(color);
  };
  const ramp = showRamp ? generatePalette(labelSeed(selected)) : null;
  return (
    <div className="flex flex-col gap-1">
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="flex flex-wrap items-center gap-1"
      >
        {LABEL_COLORS.map((option) => {
          const active = option === selected;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option}
              title={option}
              onClick={() => choose(option)}
              style={labelSwatchStyle(option)}
              className={cn(
                "h-6 w-6 rounded-full border text-[10px] font-medium transition",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                active ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "hover:scale-110",
              )}
            />
          );
        })}
      </div>
      {ramp && (
        <div aria-hidden className="flex overflow-hidden rounded">
          {PALETTE_STEPS.map((step) => (
            <span
              key={step}
              data-step={step}
              className="h-2 flex-1"
              style={{ backgroundColor: ramp[step] }}
            />
          ))}
        </div>
      )}
    </div>
  );
}


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
        <LabelColorPicker
          value={color}
          onSelect={setColor}
          ariaLabel={t(locale, "labelColourAria")}
          showRamp
        />
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
              <LabelColorPicker
                value={label.color}
                ariaLabel={`${t(locale, "colourFor")} ${label.name}`}
                onSelect={(nextColor) =>
                  run(t(locale, "colourUpdated"), async () => {
                    const result = await updateLabelAction({
                      labelId: label.id,
                      color: nextColor,
                    });
                    return "error" in result ? { ok: false, message: result.error } : { ok: true };
                  })
                }
              />
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
