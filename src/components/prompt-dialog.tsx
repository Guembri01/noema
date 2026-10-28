"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { DialogContent } from "@/components/ui/dialog";
import { TAG_PALETTE, tagStyle } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type PromptField = {
  name: string;
  label: string;
  defaultValue?: string;
  /** Small helper line under the label. */
  hint?: string;
  placeholder?: string;
  /** Render a textarea (formulas, descriptions). */
  multiline?: boolean;
  required?: boolean;
  /**
   * Control to render. `date` uses the browser calendar, `color` renders the
   * shared tag palette — both keep the same string-value contract as text.
   */
  kind?: "text" | "date" | "color";
};

/**
 * A single replacement for every `window.prompt` in the app: keyboard
 * accessible (focus trap, Escape, focus returns to the trigger), styled,
 * validated, and multi-field so a flow can ask for two values at once.
 */
export function PromptDialog({
  open,
  title,
  description,
  fields,
  confirmLabel,
  onSubmit,
  onClose,
  locale = "en",
}: {
  open: boolean;
  title: string;
  description?: string;
  fields: PromptField[];
  confirmLabel?: string;
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  onClose: () => void;
  locale?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.name, field.defaultValue ?? ""])),
  );
  const [busy, setBusy] = useState(false);

  // Re-seed when the dialog opens with new defaults.
  useEffect(() => {
    if (open) {
      setValues(Object.fromEntries(fields.map((field) => [field.name, field.defaultValue ?? ""])));
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const missing = fields.some(
    (field) => field.required !== false && !(values[field.name] ?? "").trim(),
  );

  const submit = async () => {
    if (missing || busy) return;
    setBusy(true);
    try {
      await onSubmit(values);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        className="w-full max-w-md rounded-overlay border border-border bg-bg p-4 shadow-2xl"
        aria-label={title}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted">{description}</p>}

        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {fields.map((field) => (
            <label key={field.name} className="block text-sm">
              {field.label}
              {field.hint && <span className="ml-2 text-2xs text-muted">{field.hint}</span>}
              {field.kind === "color" ? (
                <span
                  role="radiogroup"
                  aria-label={field.label}
                  className="mt-1 flex flex-wrap gap-1.5"
                >
                  {TAG_PALETTE.map((hue) => {
                    const active = values[field.name] === hue;
                    const swatch = tagStyle(hue);
                    return (
                      <button
                        key={hue}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={hue}
                        title={hue}
                        onClick={() =>
                          setValues((current) => ({ ...current, [field.name]: hue }))
                        }
                        className={cn(
                          "focus-ring h-6 w-6 rounded-full border u-colors",
                          active ? "ring-2 ring-focus ring-offset-1" : "",
                        )}
                        style={{ backgroundColor: swatch.color, borderColor: swatch.borderColor }}
                      />
                    );
                  })}
                </span>
              ) : field.multiline ? (
                <textarea
                  value={values[field.name] ?? ""}
                  placeholder={field.placeholder}
                  rows={3}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                  className="mt-1 w-full resize-y rounded-control border-control bg-bg px-2 py-1.5 font-mono text-xs outline-none focus-ring"
                />
              ) : (
                <input
                  type={field.kind === "date" ? "date" : "text"}
                  value={values[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                  className="mt-1 h-9 w-full rounded-control border-control bg-bg px-2 text-sm outline-none focus-ring"
                />
              )}
            </label>
          ))}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              aria-label={t(locale, "cancel")}
              className="focus-ring u-interactive h-9 rounded-control border border-border px-3 text-sm text-muted hover:bg-surface-2"
            >
              {t(locale, "cancel")}
            </button>
            <button
              type="submit"
              disabled={missing || busy}
              aria-label={busy ? t(locale, "working") : confirmLabel ?? t(locale, "save")}
              className="focus-ring u-interactive h-9 rounded-control bg-action px-3 text-sm text-action-fg disabled:opacity-40"
            >
              {busy ? t(locale, "working") : confirmLabel ?? t(locale, "save")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
