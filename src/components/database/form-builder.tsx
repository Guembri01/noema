"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";
import {
  createFormDraft,
  finalizeFormSchema,
  formDraftIssues,
  moveFormField,
  setFormFieldIncluded,
  setFormFieldLabel,
  setFormFieldRequired,
  updateFormSettings,
} from "@/lib/form-builder";
import type { FormSchema } from "@/lib/form-view";
import type { DBProperty } from "./database-types";

/**
 * Inline builder for an internal FORM view.
 *
 * The respondent renderer (`LazyFormView`) only ever sees a stored
 * `config.form`; this panel edits that blob: title/description, submit and
 * success copy, accepting state, question inclusion, required flags, labels and
 * order. It is intentionally a disclosure above the form so editors can preview
 * the result without leaving the view.
 */
export function FormBuilder({
  locale,
  properties,
  config,
  viewId,
  databaseId,
  defaultTitle,
  onSave,
}: {
  locale: string;
  properties: DBProperty[];
  config?: unknown;
  viewId: string;
  databaseId: string;
  defaultTitle: string;
  onSave: (schema: FormSchema) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FormSchema>(() =>
    createFormDraft(properties, config, { id: viewId, databaseId, title: defaultTitle }),
  );

  const toggle = () => {
    if (!open) {
      // Re-read the persisted config each time the panel opens so a server
      // refresh, a reverted write or another view's edit is not masked by an
      // old draft.
      setDraft(createFormDraft(properties, config, { id: viewId, databaseId, title: defaultTitle }));
    }
    setOpen((value) => !value);
  };

  const issues = formDraftIssues(draft, properties);
  const canSave = issues.length === 0;

  const save = () => {
    const next = finalizeFormSchema(draft);
    if (formDraftIssues(next, properties).length > 0) return;
    onSave(next);
    setOpen(false);
  };

  return (
    <div className="mb-3" data-testid="form-builder-shell">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        leftIcon={<Settings2 className="h-3.5 w-3.5" aria-hidden />}
        aria-expanded={open}
        data-testid="form-builder-trigger"
        onClick={toggle}
      >
        {open ? "Close form builder" : "Edit form"}
      </Button>

      {open && (
        <section
          data-testid="form-builder"
          aria-label="Form builder"
          className="mt-2 space-y-3 rounded-lg border border-border bg-surface p-3"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted">
              <span>Form title</span>
              <Input
                size="sm"
                value={draft.title}
                data-testid="form-builder-title"
                onChange={(event) =>
                  setDraft((current) =>
                    updateFormSettings(current, { title: event.target.value }),
                  )
                }
              />
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>Submit button label</span>
              <Input
                size="sm"
                value={draft.submitLabel ?? ""}
                placeholder="Submit"
                data-testid="form-builder-submit-label"
                onChange={(event) =>
                  setDraft((current) =>
                    updateFormSettings(current, { submitLabel: event.target.value }),
                  )
                }
              />
            </label>
            <label className="space-y-1 text-xs text-muted sm:col-span-2">
              <span>Description</span>
              <Input
                size="sm"
                value={draft.description ?? ""}
                data-testid="form-builder-description"
                onChange={(event) =>
                  setDraft((current) =>
                    updateFormSettings(current, { description: event.target.value }),
                  )
                }
              />
            </label>
            <label className="space-y-1 text-xs text-muted sm:col-span-2">
              <span>Success message</span>
              <Input
                size="sm"
                value={draft.successMessage ?? ""}
                placeholder="Your response has been recorded."
                data-testid="form-builder-success-message"
                onChange={(event) =>
                  setDraft((current) =>
                    updateFormSettings(current, { successMessage: event.target.value }),
                  )
                }
              />
            </label>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="text-xs text-muted">
              {draft.fields.filter((field) => field.hidden !== true).length} of{" "}
              {draft.fields.length} questions shown
            </span>
            <span data-testid="form-builder-accepting">
              <Switch
                size="sm"
                checked={draft.accepting}
                label="Accepting responses"
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    updateFormSettings(current, { accepting: checked === true }),
                  )
                }
              />
            </span>
          </div>

          <ul className="space-y-1" data-testid="form-builder-fields">
            {draft.fields.map((field, index) => (
              <li
                key={field.propertyId}
                data-testid={`form-builder-field-${field.propertyId}`}
                className="flex flex-wrap items-center gap-2 rounded-control border border-border p-2"
              >
                <Checkbox
                  size="sm"
                  checked={field.hidden !== true}
                  aria-label={`Show ${field.label}`}
                  onCheckedChange={(checked) =>
                    setDraft((current) =>
                      setFormFieldIncluded(current, field.propertyId, checked === true),
                    )
                  }
                />
                <Input
                  size="sm"
                  value={field.label}
                  aria-label={`Question label for ${field.label}`}
                  className="min-w-0 flex-1"
                  onChange={(event) =>
                    setDraft((current) =>
                      setFormFieldLabel(current, field.propertyId, event.target.value),
                    )
                  }
                />
                <label className="flex items-center gap-1 text-xs text-muted">
                  <Checkbox
                    size="sm"
                    checked={field.required === true}
                    disabled={field.hidden === true}
                    onCheckedChange={(checked) =>
                      setDraft((current) =>
                        setFormFieldRequired(current, field.propertyId, checked === true),
                      )
                    }
                  />
                  Required
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${field.label} up`}
                  data-testid={`form-builder-up-${field.propertyId}`}
                  disabled={index === 0}
                  onClick={() =>
                    setDraft((current) => moveFormField(current, field.propertyId, -1))
                  }
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${field.label} down`}
                  data-testid={`form-builder-down-${field.propertyId}`}
                  disabled={index === draft.fields.length - 1}
                  onClick={() =>
                    setDraft((current) => moveFormField(current, field.propertyId, 1))
                  }
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>

          {issues.length > 0 && (
            <ul
              data-testid="form-builder-issues"
              className="space-y-0.5 text-xs text-danger"
            >
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t(locale, "cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              data-testid="form-builder-save"
              onClick={save}
            >
              {t(locale, "save")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
