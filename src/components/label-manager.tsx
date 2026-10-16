"use client";

import { useId, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Check, Palette, Plus, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createLabelAction,
  deleteLabelAction,
  updateLabelAction,
} from "@/server/actions/tickets";
import { safeAction } from "@/lib/actions-client";
import { LABEL_COLORS } from "@/lib/tickets";
import { TAG_HUES, tagStyle, type TagHue } from "@/lib/design-tokens";
import { allocateSlugs, uniqueSlug } from "@/lib/slug-uniqueness";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag as TagChip } from "@/components/ui/tag";

/* ------------------------------------------------------------------------- *
 * Pure domain helpers
 *
 * The label colour contract and the delete-impact copy are decided here, so
 * they can be proven without a browser. Every swatch reads from the tag token
 * palette (`--tag-<hue>-*`) — never a raw hex — and an unknown colour fails
 * closed to gray.
 * ------------------------------------------------------------------------- */

/** The 10 tag-palette hues a label swatch may paint with. */
export const LABEL_HUE_TOKENS: readonly TagHue[] = TAG_HUES;

/**
 * Resolve a stored label colour to a tag-palette hue. The persisted domain
 * (`LABEL_COLORS`) is a subset of the 10 tokens; anything else (including a
 * future hue the server does not know yet) reads as `gray` so a chip is never
 * unstyled.
 */
export function labelHue(color: unknown): TagHue {
  return typeof color === "string" && (TAG_HUES as readonly string[]).includes(color)
    ? (color as TagHue)
    : "gray";
}

/** Solid token swatch paint for a label colour (fill = hue ink, edge = hue border). */
export function labelSwatchStyle(color: unknown): CSSProperties {
  const { color: fg, borderColor } = tagStyle(labelHue(color));
  return { backgroundColor: fg, borderColor };
}

/** Title + description for the delete confirmation, naming how many items use it. */
export function labelDeleteCopy(name: string, count: number): { title: string; description: string } {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const items = safe === 1 ? "1 item uses" : `${safe} items use`;
  return {
    title: `Delete “${name}”?`,
    description:
      safe === 0
        ? `“${name}” is not attached to any items.`
        : `${items} “${name}”. They keep their other labels.`,
  };
}

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

/**
 * Colour swatch picker for labels. The grid is a radiogroup over the persisted
 * `LABEL_COLORS` values, so the stored value domain and CRUD are unchanged,
 * while each swatch is painted from the tag token palette (`labelSwatchStyle`)
 * — no raw hex anywhere.
 */
function LabelColorPicker({
  value,
  onSelect,
  ariaLabel,
}: {
  value: string;
  onSelect: (color: string) => void;
  ariaLabel: string;
}) {
  const [selected, setSelected] = useState(value);
  const choose = (color: string) => {
    setSelected(color);
    onSelect(color);
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1">
      {LABEL_COLORS.map((option) => {
        const active = option === selected;
        return (
          <Button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option}
            title={option}
            variant="ghost"
            size="icon"
            onClick={() => choose(option)}
            className={cn(
              "rounded-full p-0",
              active && "ring-2 ring-accent ring-offset-1 ring-offset-bg",
            )}
          >
            <span
              aria-hidden
              data-swatch={option}
              className="size-4 rounded-full border"
              style={labelSwatchStyle(option)}
            />
            {active ? (
              <Check
                aria-hidden
                className="pointer-events-none absolute inset-0 m-auto size-2.5 text-bg"
              />
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}

/** A layout-shaped loading placeholder for the label list. */
function LabelRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-2 rounded-md border border-border p-3"
        >
          <Skeleton variant="block" width={72} height={24} />
          <Skeleton variant="block" width={160} height={32} />
          <Skeleton variant="block" width={120} height={32} />
          <Skeleton variant="block" width={28} height={28} />
        </div>
      ))}
    </div>
  );
}

/** Workspace-level label catalogue used by every ticket. */
export function LabelManager({
  workspaceId,
  labels,
  locale,
  loading = false,
}: {
  workspaceId: string;
  labels: LabelManagerRow[];
  locale: string;
  loading?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(TAG_HUES[5]);
  const [description, setDescription] = useState("");
  const [renamedSlug, setRenamedSlug] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<LabelManagerRow | null>(null);
  const nameId = useId();
  const descriptionId = `${nameId}-description`;

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

  const deleteCopy = deleteTarget
    ? labelDeleteCopy(deleteTarget.name, deleteTarget.count)
    : null;

  return (
    <Section
      title={t(locale, "ticketLabels")}
      description={t(locale, "labelsIntro")}
      className="mt-10"
    >
      <Card variant="flat" padding="md">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            run(t(locale, "labelCreated"), async () => {
              const result = await createLabelAction({ workspaceId, name, color, description });
              if ("error" in result) return { ok: false, message: result.error };
              setName("");
              setDescription("");
              return { ok: true };
            });
          }}
        >
          <Field id={nameId} label={t(locale, "labelName")} className="w-48 shrink-0">
            <Input
              value={name}
              placeholder={t(locale, "labelName")}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          {draftSlug && (
            <code
              data-slug={draftSlug}
              title={`${t(locale, "permalinkLabel")} ${draftSlug}`}
              className="inline-flex h-9 items-center rounded-sm bg-surface-2 px-2 font-mono text-xs text-muted"
            >
              {draftSlug}
            </code>
          )}

          <Field
            id={descriptionId}
            label={t(locale, "descriptionLabel")}
            className="w-64 shrink-0"
          >
            <Input
              value={description}
              placeholder={t(locale, "descriptionOptional")}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <div className="flex shrink-0 flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <Palette className="h-4 w-4 text-muted" aria-hidden />
              {t(locale, "labelColourAria")}
            </span>
            <LabelColorPicker
              value={color}
              onSelect={setColor}
              ariaLabel={t(locale, "labelColourAria")}
            />
          </div>

          <Button
            type="submit"
            disabled={pending || !name.trim()}
            loading={pending}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {t(locale, "create")}
          </Button>
        </form>
      </Card>

      {loading ? (
        <LabelRowsSkeleton />
      ) : labels.length === 0 ? (
        <EmptyState
          variant="compact"
          icon={<Tag className="h-4 w-4" />}
          title={t(locale, "noLabels")}
          description="Create your first label to group and filter tickets."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {labels.map((label) => (
            <li
              key={label.id}
              data-slug={renamedSlug[label.id] ?? slugById.get(label.id) ?? ""}
            >
              <Card
                variant="flat"
                padding="sm"
                className="flex flex-wrap items-center gap-2"
              >
                <TagChip hue={labelHue(label.color)} size="sm" dot>
                  {label.name}
                </TagChip>
                <Badge
                  count={label.count}
                  title={`${label.count} ${t(locale, "ticketsLower")}`}
                />

                <Input
                  size="sm"
                  defaultValue={label.name}
                  aria-label={`${t(locale, "rename")} ${label.name}`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
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
                      return "error" in result
                        ? { ok: false, message: result.error }
                        : { ok: true };
                    });
                  }}
                  className="w-40"
                />

                <code
                  title={`${t(locale, "permalinkLabel")} ${renamedSlug[label.id] ?? slugById.get(label.id) ?? ""}`}
                  className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted"
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
                      return "error" in result
                        ? { ok: false, message: result.error }
                        : { ok: true };
                    })
                  }
                />

                <Input
                  size="sm"
                  defaultValue={label.description ?? ""}
                  aria-label={`${t(locale, "descriptionFor")} ${label.name}`}
                  placeholder={t(locale, "descriptionLabel")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  onBlur={(event) =>
                    run(t(locale, "descriptionUpdated"), async () => {
                      const result = await updateLabelAction({
                        labelId: label.id,
                        description: event.target.value || null,
                      });
                      return "error" in result
                        ? { ok: false, message: result.error }
                        : { ok: true };
                    })
                  }
                  className="min-w-40 flex-1"
                />

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${t(locale, "delete")} ${label.name}`}
                  onClick={() => setDeleteTarget(label)}
                  className="text-muted hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        tone="danger"
        title={deleteCopy?.title ?? ""}
        description={deleteCopy?.description}
        confirmLabel={t(locale, "delete")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={() => {
          const target = deleteTarget;
          if (!target) return;
          run(t(locale, "labelDeleted"), async () => {
            const result = await deleteLabelAction(target.id);
            if ("error" in result) return { ok: false, message: result.error };
            setDeleteTarget(null);
            return { ok: true };
          });
        }}
      />
    </Section>
  );
}
