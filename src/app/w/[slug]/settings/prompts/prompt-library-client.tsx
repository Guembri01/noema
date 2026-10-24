"use client";

/**
 * Settings → Prompt library (client editor).
 *
 * The persistence seam is now the server: `listPromptsAction` seeded this view,
 * and every change round-trips through `createPromptAction`,
 * `updatePromptAction`, `deletePromptAction` or `clonePromptAction`. The pure
 * `@/lib/ai-prompt-library` engine still owns filtering, ranking and rendering,
 * so the rendered preview and the card list behave exactly as before — only
 * "where the rows live" changed.
 */

import { useMemo, useState } from "react";
import { Copy, FileText, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import {
  PromptRenderError,
  createPromptLibrary,
  deletePrompt,
  extractVariables,
  listPrompts,
  renderPrompt,
  type PromptLibraryState,
  type PromptScope,
  type PromptTemplate,
} from "@/lib/ai-prompt-library";
import {
  clonePromptAction,
  createPromptAction,
  deletePromptAction,
  updatePromptAction,
} from "@/server/actions/prompts";
import { safeAction } from "@/lib/actions-client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Select, type SelectOption } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { PromptCard } from "@/components/ai-settings-providers";

/** Empty draft used when nothing is selected. */
type Draft = {
  name: string;
  body: string;
  scope: PromptScope;
  tags: string;
};

const EMPTY_DRAFT: Draft = { name: "", body: "", scope: "workspace", tags: "" };

/** Split a comma-separated tag field into a trimmed list. */
function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Draft for an existing template. */
function draftFrom(template: PromptTemplate): Draft {
  return {
    name: template.name,
    body: template.body,
    scope: template.scope,
    tags: (template.tags ?? []).join(", "),
  };
}

/** Insert or replace one persisted prompt, preserving engine-shaped state. */
function upsertPrompt(state: PromptLibraryState, prompt: PromptTemplate): PromptLibraryState {
  const index = state.prompts.findIndex((entry) => entry.id === prompt.id);
  if (index < 0) return { prompts: [...state.prompts, prompt] };
  const prompts = [...state.prompts];
  prompts[index] = prompt;
  return { prompts };
}

const SCOPE_OPTIONS: SelectOption[] = [
  { value: "all", label: "All scopes" },
  { value: "workspace", label: "Workspace" },
  { value: "personal", label: "Personal" },
];

const EDITOR_SCOPE_OPTIONS: SelectOption[] = [
  { value: "workspace", label: "Workspace" },
  { value: "personal", label: "Personal" },
];

export function PromptLibraryClient({
  workspaceId,
  locale,
  initialPrompts,
  initialCanEdit,
  initialError = null,
}: {
  workspaceId: string;
  locale: string;
  initialPrompts: PromptTemplate[];
  initialCanEdit: boolean;
  initialError?: string | null;
}) {
  const [library, setLibrary] = useState<PromptLibraryState>(() =>
    createPromptLibrary(initialPrompts),
  );
  const [canEdit] = useState(initialCanEdit);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [scopeFilter, setScopeFilter] = useState<PromptScope | "all">("all");
  const [tagFilter, setTagFilter] = useState("");
  const [query, setQuery] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(
    () =>
      listPrompts(library, {
        scope: scopeFilter === "all" ? undefined : scopeFilter,
        tag: tagFilter.trim().length > 0 ? tagFilter : undefined,
        query: query.trim().length > 0 ? query : undefined,
      }),
    [library, scopeFilter, tagFilter, query],
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const prompt of library.prompts) {
      for (const tag of prompt.tags ?? []) set.add(tag);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [library.prompts]);

  const tagOptions: SelectOption[] = useMemo(
    () => allTags.map((tag) => ({ value: tag, label: tag })),
    [allTags],
  );

  const selected = useMemo(
    () => library.prompts.find((prompt) => prompt.id === selectedId) ?? null,
    [library, selectedId],
  );

  const draftVariables = useMemo(() => extractVariables(draft.body), [draft.body]);

  const select = (template: PromptTemplate) => {
    setSelectedId(template.id);
    setDraft(draftFrom(template));
    setRendered(null);
    setError(null);
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setRendered(null);
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    if (!canEdit) {
      setError("You do not have permission to change prompts in this workspace.");
      return;
    }
    if (draft.name.trim().length === 0 || draft.body.trim().length === 0) {
      setError("A prompt needs a name and a body.");
      return;
    }

    setBusy(true);
    const tags = parseTags(draft.tags);
    const wrapped = await safeAction(() =>
      selected
        ? updatePromptAction({
            workspaceId,
            id: selected.id,
            name: draft.name,
            body: draft.body,
            scope: draft.scope,
            tags,
          })
        : createPromptAction({
            workspaceId,
            name: draft.name,
            body: draft.body,
            scope: draft.scope,
            tags,
          }),
    );
    setBusy(false);

    if (!wrapped.ok) {
      setError(wrapped.error);
      return;
    }
    const result = wrapped.value;
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setLibrary((state) => upsertPrompt(state, result.prompt));
    setSelectedId(result.prompt.id);
    setDraft(draftFrom(result.prompt));
    setRendered(null);
    setError(null);
    toast.success(selected ? "Prompt updated" : "Prompt created");
  };

  const remove = async (id: string) => {
    if (busy) return;
    if (!canEdit) {
      setError("You do not have permission to change prompts in this workspace.");
      return;
    }

    setBusy(true);
    const wrapped = await safeAction(() => deletePromptAction({ workspaceId, id }));
    setBusy(false);

    if (!wrapped.ok) {
      setDeleteId(null);
      setError(wrapped.error);
      return;
    }
    const result = wrapped.value;
    if (!result.ok) {
      setDeleteId(null);
      setError(result.error);
      return;
    }

    setLibrary((state) => deletePrompt(state, id));
    setDeleteId(null);
    if (selectedId === id) startNew();
    toast.success("Prompt deleted");
  };

  const duplicate = async () => {
    if (!selected || busy) return;
    if (!canEdit) {
      setError("You do not have permission to change prompts in this workspace.");
      return;
    }

    setBusy(true);
    const wrapped = await safeAction(() =>
      clonePromptAction({ workspaceId, id: selected.id }),
    );
    setBusy(false);

    if (!wrapped.ok) {
      setError(wrapped.error);
      return;
    }
    const result = wrapped.value;
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setLibrary((state) => upsertPrompt(state, result.prompt));
    select(result.prompt);
    toast.success("Prompt cloned");
  };

  const preview = () => {
    if (!selected) return;
    try {
      setRendered(renderPrompt(selected, values));
      setError(null);
    } catch (err) {
      setRendered(null);
      setError(err instanceof PromptRenderError ? err.message : "Could not render this prompt.");
    }
  };

  const hasAnyPrompt = library.prompts.length > 0;

  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Section
        level={2}
        title="Saved prompts"
        description="Search, filter and manage the prompts available in this workspace."
      >
        <div className="flex flex-col gap-3">
          <Input
            value={query}
            clearable
            onClear={() => setQuery("")}
            aria-label={t(locale, "searchPrompts")}
            placeholder={t(locale, "search")}
            leading={<Search className="h-4 w-4" aria-hidden />}
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="prompt-tag-filter" label="Tag">
              <Select
                id="prompt-tag-filter"
                aria-label={t(locale, "filterByTag")}
                options={tagOptions}
                value={tagFilter}
                onChange={setTagFilter}
                allowClear
                placeholder={t(locale, "allTags")}
                noResultsLabel="No tags"
              />
            </Field>
            <Field id="prompt-scope-filter" label="Scope">
              <Select
                id="prompt-scope-filter"
                aria-label={t(locale, "filterByScope")}
                options={SCOPE_OPTIONS}
                value={scopeFilter}
                onChange={(value) => setScopeFilter(value as PromptScope | "all")}
                allowClear={false}
                searchable={false}
              />
            </Field>
          </div>

          <Button
            onClick={startNew}
            disabled={!canEdit || busy}
            leftIcon={<Plus className="h-4 w-4" aria-hidden />}
          >
            New prompt
          </Button>

          {!canEdit && (
            <p className="text-xs text-muted">
              You can read this workspace&apos;s shared prompts. Guests cannot create or edit them.
            </p>
          )}

          {visible.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<FileText className="h-4 w-4" aria-hidden />}
              title={hasAnyPrompt ? t(locale, "noMatchingPrompts") : t(locale, "noPromptsYet")}
              description={
                hasAnyPrompt
                  ? "No prompt matches the current search, tag or scope."
                  : "Save your first reusable prompt to insert it from the editor or chat."
              }
              primaryAction={
                canEdit ? <Button onClick={startNew}>New prompt</Button> : null
              }
              secondaryAction={
                hasAnyPrompt ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setQuery("");
                      setTagFilter("");
                      setScopeFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((template) => (
                <li key={template.id}>
                  <PromptCard
                    prompt={{
                      id: template.id,
                      name: template.name,
                      body: template.body,
                      scope: template.scope,
                      variables: template.variables ?? [],
                      tags: template.tags,
                    }}
                    selected={template.id === selectedId}
                    pending={busy}
                    deleteOpen={deleteId === template.id}
                    onDeleteOpenChange={(open) => setDeleteId(open ? template.id : null)}
                    onUse={() => select(template)}
                    onEdit={() => select(template)}
                    onDelete={() => void remove(template.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        level={2}
        title="Prompt editor"
        description="Name the prompt, write its body and declare the {{variable}} placeholders the body references."
      >
        <Field id="prompt-name" label="Name">
          <Input
            id="prompt-name"
            value={draft.name}
            disabled={!canEdit}
            aria-label={t(locale, "promptName")}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>

        <Field
          id="prompt-body"
          label="Body"
          hint="Use {{variable}} placeholders for values filled at run time."
        >
          <Textarea
            id="prompt-body"
            value={draft.body}
            rows={7}
            disabled={!canEdit}
            aria-label={t(locale, "promptBody")}
            placeholder="Summarize {{transcript}} for {{audience}}."
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="prompt-scope" label="Scope">
            <Select
              id="prompt-scope"
              aria-label={t(locale, "promptScope")}
              options={EDITOR_SCOPE_OPTIONS}
              value={draft.scope}
              disabled={!canEdit}
              onChange={(value) => setDraft({ ...draft, scope: value as PromptScope })}
              allowClear={false}
              searchable={false}
            />
          </Field>
          <Field id="prompt-tags" label="Tags" hint="Comma-separated.">
            <Input
              id="prompt-tags"
              value={draft.tags}
              disabled={!canEdit}
              aria-label={t(locale, "promptTags")}
              placeholder={t(locale, "promptTagsPlaceholder")}
              onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Variables:</span>
          {draftVariables.length > 0 ? (
            draftVariables.map((variable) => (
              <Tag key={variable} hue="blue" size="sm">
                {`{{${variable}}}`}
              </Tag>
            ))
          ) : (
            <span>none</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={!canEdit} loading={busy}>
            {selected ? "Save changes" : "Create prompt"}
          </Button>
          {selected && (
            <>
              <Button
                variant="secondary"
                onClick={() => void duplicate()}
                disabled={!canEdit || busy}
                leftIcon={<Copy className="h-4 w-4" aria-hidden />}
              >
                Clone
              </Button>
              <Button
                variant="danger"
                tone="soft"
                onClick={() => setDeleteId(selected.id)}
                disabled={!canEdit || busy}
                leftIcon={<Trash2 className="h-4 w-4" aria-hidden />}
              >
                Delete
              </Button>
            </>
          )}
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <ConfirmDialog
          open={selected !== null && deleteId === selected.id}
          onOpenChange={(open) => setDeleteId(open ? selected?.id ?? null : null)}
          tone="danger"
          title={`Delete “${selected?.name ?? ""}”?`}
          description="This removes the prompt from the library. This cannot be undone."
          confirmLabel="Delete prompt"
          cancelLabel="Cancel"
          onConfirm={() => {
            if (selected) void remove(selected.id);
          }}
        />

        {selected && (
          <div className="flex flex-col gap-3 border-t border-border pt-6">
            <h3 className="text-sm font-medium text-muted">Render preview</h3>
            {(selected.variables ?? []).map((variable) => (
              <Field key={variable} id={`prompt-value-${variable}`} label={variable}>
                <Input
                  id={`prompt-value-${variable}`}
                  value={values[variable] ?? ""}
                  aria-label={`${t(locale, "valueFor")} ${variable}`}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [variable]: event.target.value }))
                  }
                />
              </Field>
            ))}
            <div>
              <Button variant="secondary" onClick={preview}>
                Render
              </Button>
            </div>
            {rendered !== null && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-control border border-border bg-surface-2 p-2 text-xs text-fg scrollbar-thin">
                {rendered}
              </pre>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
