"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  PromptRenderError,
  clonePrompt,
  createPrompt,
  createPromptLibrary,
  deletePrompt,
  describePrompt,
  extractVariables,
  listPrompts,
  renderPrompt,
  updatePrompt,
  type PromptLibraryState,
  type PromptScope,
  type PromptTemplate,
} from "@/lib/ai-prompt-library";

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

/**
 * Workspace prompt library (settings → Prompt library).
 *
 * A reusable-prompt manager built on the pure `@/lib/ai-prompt-library` engine:
 * every control below is one of the module's reducers (`createPrompt`,
 * `updatePrompt`, `deletePrompt`, `listPrompts`, `clonePrompt`, `renderPrompt`),
 * so the library page, the chat picker and any future server row all behave
 * identically. The library is held in local state — persistence is a follow-up
 * once a `WorkspacePrompt` table ships.
 */
export default function PromptLibraryPage() {
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";

  const [library, setLibrary] = useState<PromptLibraryState>(() => createPromptLibrary([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<PromptScope | "all">("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () =>
      listPrompts(library, {
        scope: scopeFilter === "all" ? undefined : scopeFilter,
        query: query.trim().length > 0 ? query : undefined,
      }),
    [library, scopeFilter, query],
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

  const remove = () => {
    if (!selected) return;
    setLibrary((state) => deletePrompt(state, selected.id));
    startNew();
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

  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <Link href={`/w/${slug}/settings`} className="text-xs text-muted hover:underline">
        ← Settings
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">Prompt library</h1>
      <p className="mb-6 text-sm text-muted">
        Save reusable prompts with <code>{"{{variable}}"}</code> placeholders and insert them from
        the editor or the chat composer. Workspace prompts are shared; personal prompts are private.
      </p>

      <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section aria-label="Saved prompts">
          <div className="mb-3 flex items-center gap-2">
            <input
              value={query}
              aria-label="Search prompts"
              placeholder="Search…"
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            />
            <select
              value={scopeFilter}
              aria-label="Filter by scope"
              onChange={(event) => setScopeFilter(event.target.value as PromptScope | "all")}
              className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            >
              <option value="all">All</option>
              <option value="workspace">Workspace</option>
              <option value="personal">Personal</option>
            </select>
          </div>

          <button
            type="button"
            onClick={startNew}
            className="mb-3 h-9 rounded bg-accent px-3 text-sm text-accent-fg"
          >
            New prompt
          </button>

          <ul className="divide-y divide-border rounded-lg border border-border">
            {visible.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted">No prompts yet.</li>
            )}
            {visible.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  onClick={() => select(template)}
                  aria-current={template.id === selectedId}
                  className={`block w-full px-4 py-3 text-left text-sm hover:bg-surface-2 ${
                    template.id === selectedId ? "bg-surface-2" : ""
                  }`}
                >
                  <span className="font-medium text-fg">{template.name}</span>
                  <span className="mt-0.5 block text-xs text-muted">{describePrompt(template)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Prompt editor" className="text-sm">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted">
            Name
            <input
              value={draft.name}
              aria-label="Prompt name"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            />
          </label>

          <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-muted">
            Body
            <textarea
              value={draft.body}
              rows={7}
              aria-label="Prompt body"
              placeholder="Summarize {{transcript}} for {{audience}}."
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              className="mt-1 w-full resize-y rounded border border-border bg-bg px-2 py-1 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            />
          </label>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted">
              Scope
              <select
                value={draft.scope}
                aria-label="Prompt scope"
                onChange={(event) => setDraft({ ...draft, scope: event.target.value as PromptScope })}
                className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
              >
                <option value="workspace">Workspace</option>
                <option value="personal">Personal</option>
              </select>
            </label>
            <label className="text-xs font-medium uppercase tracking-wide text-muted">
              Tags
              <input
                value={draft.tags}
                aria-label="Prompt tags"
                placeholder="meeting, weekly"
                onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
              />
            </label>
          </div>

          <p className="mt-2 text-xs text-muted">
            Variables: {draftVariables.length > 0 ? draftVariables.join(", ") : "none"}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              className="h-9 rounded bg-accent px-3 text-sm text-accent-fg"
            >
              {selected ? "Save changes" : "Create prompt"}
            </button>
            {selected && (
              <>
                <button
                  type="button"
                  onClick={duplicate}
                  className="h-9 rounded border border-border px-3 text-sm hover:bg-surface-2"
                >
                  Clone
                </button>
                <button
                  type="button"
                  onClick={remove}
                  className="h-9 rounded border border-border px-3 text-sm text-muted hover:text-red-500"
                >
                  Delete
                </button>
              </>
            )}
          </div>

          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

          {selected && (
            <div className="mt-8 border-t border-border pt-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                Render preview
              </h2>
              {(selected.variables ?? []).map((variable) => (
                <label key={variable} className="mt-2 block text-xs text-muted">
                  {variable}
                  <input
                    value={values[variable] ?? ""}
                    aria-label={`Value for ${variable}`}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [variable]: event.target.value }))
                    }
                    className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
                  />
                </label>
              ))}
              <button
                type="button"
                onClick={preview}
                className="mt-3 h-9 rounded border border-border px-3 text-sm hover:bg-surface-2"
              >
                Render
              </button>
              {rendered !== null && (
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-2 p-2 text-xs text-fg">
                  {rendered}
                </pre>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
