"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Copy, FileText, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import {
  PromptRenderError,
  clonePrompt,
  createPrompt,
  createPromptLibrary,
  deletePrompt,
  extractVariables,
  listPrompts,
  renderPrompt,
  updatePrompt,
  type PromptLibraryState,
  type PromptScope,
  type PromptTemplate,
} from "@/lib/ai-prompt-library";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { PromptCard } from "@/components/ai-settings-providers";
import { SettingsNav } from "../settings-nav";

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

const SCOPE_OPTIONS: SelectOption[] = [
  { value: "all", label: "All scopes" },
  { value: "workspace", label: "Workspace" },
  { value: "personal", label: "Personal" },
];

const EDITOR_SCOPE_OPTIONS: SelectOption[] = [
  { value: "workspace", label: "Workspace" },
  { value: "personal", label: "Personal" },
];

/**
 * Workspace prompt library (settings → Prompt library).
 *
 * A reusable-prompt manager built on the pure `@/lib/ai-prompt-library` engine:
 * every control below is one of the module's reducers (`createPrompt`,
 * `updatePrompt`, `deletePrompt`, `listPrompts`, `clonePrompt`, `renderPrompt`),
 * so the library page, the chat picker and any future server row all behave
 * identically. The library is held in local state — persistence is a follow-up
 * once a `WorkspacePrompt` table ships, so the first paint shows a `Skeleton`
 * sized to the card list while that store is still being read.
 */
export default function PromptLibraryPage() {
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";

  // This page is a client shell with no server-provided locale yet (its settings
  // nav is already rendered with the default catalogue), so it resolves copy
  // through the catalogue with the default locale rather than hard-coding
  // English literals — a single place to swap once locale plumbing lands.
  const locale = "en";

  const [library, setLibrary] = useState<PromptLibraryState>(() => createPromptLibrary([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<PromptScope | "all">("all");
  const [tagFilter, setTagFilter] = useState("");
  const [query, setQuery] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The library is read from local state today; flip off the first-paint
  // skeleton once the page has mounted.
  useEffect(() => {
    setLoading(false);
  }, []);

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

  const save = () => {
    if (draft.name.trim().length === 0 || draft.body.trim().length === 0) {
      setError("A prompt needs a name and a body.");
      return;
    }
    if (selected) {
      setLibrary((state) =>
        updatePrompt(state, selected.id, {
          name: draft.name,
          body: draft.body,
          scope: draft.scope,
          tags: parseTags(draft.tags),
        }),
      );
      toast.success("Prompt updated");
    } else {
      const before = library.prompts.length;
      const next = createPrompt(library, {
        name: draft.name,
        body: draft.body,
        scope: draft.scope,
        tags: parseTags(draft.tags),
      });
      setLibrary(next);
      const created = next.prompts.at(-1);
      if (created && next.prompts.length > before) setSelectedId(created.id);
      toast.success("Prompt created");
    }
    setError(null);
  };

  const remove = (id: string) => {
    setLibrary((state) => deletePrompt(state, id));
    setDeleteId(null);
    if (selectedId === id) startNew();
    toast.success("Prompt deleted");
  };

  const duplicate = () => {
    if (!selected) return;
    const copy = clonePrompt(selected);
    setLibrary((state) => ({ prompts: [...state.prompts, copy] }));
    select(copy);
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
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Link href={`/w/${slug}/settings`} className="text-xs text-muted hover:underline">
        ← Settings
      </Link>
      <h1 className="mb-2 mt-3 text-title font-semibold tracking-title">Prompt library</h1>
      <p className="mb-8 text-sm text-muted">
        Save reusable prompts with <code>{"{{variable}}"}</code> placeholders and insert them from
        the editor or the chat composer. Workspace prompts are shared; personal prompts are private.
      </p>

      <SettingsNav slug={slug} locale={locale} className="mb-8" />

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

            <Button onClick={startNew} leftIcon={<Plus className="h-4 w-4" aria-hidden />}>
              New prompt
            </Button>

            {loading ? (
              <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
                <span className="sr-only">Loading prompts…</span>
                <Skeleton variant="card" />
                <Skeleton variant="card" />
              </div>
            ) : visible.length === 0 ? (
              <EmptyState
                variant="compact"
                icon={<FileText className="h-4 w-4" aria-hidden />}
                title={hasAnyPrompt ? "No matching prompts" : "No prompts yet"}
                description={
                  hasAnyPrompt
                    ? "No prompt matches the current search, tag or scope."
                    : "Save your first reusable prompt to insert it from the editor or chat."
                }
                primaryAction={<Button onClick={startNew}>New prompt</Button>}
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
                      deleteOpen={deleteId === template.id}
                      onDeleteOpenChange={(open) => setDeleteId(open ? template.id : null)}
                      onUse={() => select(template)}
                      onEdit={() => select(template)}
                      onDelete={() => remove(template.id)}
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
              aria-label={t(locale, "promptName")}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>

          <Field id="prompt-body" label="Body" hint="Use {{variable}} placeholders for values filled at run time.">
            <Textarea
              id="prompt-body"
              value={draft.body}
              rows={7}
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
                onChange={(value) => setDraft({ ...draft, scope: value as PromptScope })}
                allowClear={false}
                searchable={false}
              />
            </Field>
            <Field id="prompt-tags" label="Tags" hint="Comma-separated.">
              <Input
                id="prompt-tags"
                value={draft.tags}
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
            <Button onClick={save}>{selected ? "Save changes" : "Create prompt"}</Button>
            {selected && (
              <>
                <Button
                  variant="secondary"
                  onClick={duplicate}
                  leftIcon={<Copy className="h-4 w-4" aria-hidden />}
                >
                  Clone
                </Button>
                <Button
                  variant="danger"
                  tone="soft"
                  onClick={() => setDeleteId(selected.id)}
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
              if (selected) remove(selected.id);
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
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 text-xs text-fg scrollbar-thin">
                  {rendered}
                </pre>
              )}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
