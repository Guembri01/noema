"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR_CHOICES, type DBProperty } from "@/components/database/database-types";
import { updatePropertyAction } from "@/server/actions/database";
import { useAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { DialogContent } from "@/components/ui/dialog";

type OptionDraft = { id: string; name: string; color: string; group?: string };

/**
 * Editor for SELECT / MULTI_SELECT / STATUS options: rename an option, change
 * its colour, bucket a status option (To-do / In progress / Done), remove or
 * add options. Every change persists the full option list through
 * `updatePropertyAction` — the latest draft is always what gets written, so
 * two quick edits can never revert each other.
 */
export function PropertyOptionsEditor({
  locale,
  property,
  onClose,
}: {
  locale: string;
  property: DBProperty;
  onClose: () => void;
}) {
  const router = useRouter();
  const initial = (property.config?.options ?? []) as OptionDraft[];
  const [draft, setDraft] = useState<OptionDraft[]>(initial);
  // Latest intended option list while a save is still in flight.
  const pending = useRef<OptionDraft[]>(initial);
  const { run } = useAction(locale);

  const save = (next: OptionDraft[]) => {
    pending.current = next;
    setDraft(next);
    run(
      () =>
        updatePropertyAction(property.id, {
          config: { ...(property.config ?? {}), options: next },
        }),
      // The table behind the dialog re-renders from storage, so closing the
      // editor never shows a stale chip.
      { onSuccess: () => router.refresh() },
    );
  };

  const commitName = (index: number, name: string) => {
    const trimmed = name.trim();
    const current = pending.current;
    if (!trimmed || (current[index] && current[index].name === trimmed)) return;
    save(
      current.map((option, i) =>
        i === index ? { ...option, name: trimmed.slice(0, 60) } : option,
      ),
    );
  };

  const isStatus = property.type === "STATUS";

  return (
    <DialogContent
      className="w-full max-w-md rounded-xl border border-border bg-bg p-4 shadow-2xl"
      aria-label={`${t(locale, "editOptions")} — ${property.name}`}
      aria-describedby={undefined}
      data-testid="property-options-editor"
    >
      <h2 className="text-base font-semibold">
        {t(locale, "editOptions")} — {property.name}
      </h2>

      <ul className="mt-4 space-y-2">
        {draft.map((option, index) => (
          <li
            key={option.id}
            className="flex items-center gap-2 rounded border border-border p-2"
          >
            <input
              value={option.name}
              aria-label={`${t(locale, "optionNameLabel")}: ${option.name}`}
              onChange={(event) =>
                setDraft((current) =>
                  current.map((entry, i) =>
                    i === index ? { ...entry, name: event.target.value } : entry,
                  ),
                )
              }
              onBlur={(event) => commitName(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitName(index, event.currentTarget.value);
                  event.currentTarget.blur();
                }
              }}
              className="h-8 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            />
            <select
              value={option.color}
              aria-label={`${t(locale, "optionColorLabel")}: ${option.name}`}
              onChange={(event) =>
                save(
                  pending.current.map((entry, i) =>
                    i === index ? { ...entry, color: event.target.value } : entry,
                  ),
                )
              }
              className="h-8 rounded border border-border bg-bg px-1 text-xs outline-none"
            >
              {COLOR_CHOICES.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
            {isStatus && (
              <select
                value={option.group ?? ""}
                aria-label={`${t(locale, "group")}: ${option.name}`}
                onChange={(event) =>
                  save(
                    pending.current.map((entry, i) =>
                      i === index
                        ? { ...entry, group: event.target.value || undefined }
                        : entry,
                    ),
                  )
                }
                className="h-8 rounded border border-border bg-bg px-1 text-xs outline-none"
              >
                <option value="">—</option>
                <option value="todo">{t(locale, "statusGroupTodo")}</option>
                <option value="doing">{t(locale, "statusGroupDoing")}</option>
                <option value="done">{t(locale, "statusGroupDone")}</option>
              </select>
            )}
            <button
              type="button"
              aria-label={`${t(locale, "removeOption")}: ${option.name}`}
              onClick={() => save(pending.current.filter((_, i) => i !== index))}
              className="text-muted hover:text-red-500"
            >
              ×
            </button>
          </li>
        ))}
        {draft.length === 0 && (
          <li className="text-sm text-muted">{t(locale, "noOptionsYet")}</li>
        )}
      </ul>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          data-testid="add-option"
          onClick={() =>
            save([
              ...pending.current,
              {
                id: `opt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                name: `${t(locale, "optionWord")} ${pending.current.length + 1}`,
                color: "gray",
                ...(isStatus ? { group: "todo" } : {}),
              },
            ])
          }
          className="flex items-center gap-1 text-xs text-accent"
        >
          + {t(locale, "addOption")}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={cn(
            "h-8 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2",
          )}
        >
          {t(locale, "close")}
        </button>
      </div>
    </DialogContent>
  );
}
