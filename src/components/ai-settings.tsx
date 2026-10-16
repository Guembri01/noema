"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, Gauge, Loader2, Plug, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  clearAiProviderAction,
  listAiModelsAction,
  saveAiProviderAction,
  testAiProviderAction,
  type AiProviderSummary,
} from "@/server/actions/ai-settings";
import { runAiAutofillAction } from "@/server/actions/ai-autofill";
import { AI_PROVIDERS, providerDefaultBaseUrl, type ProviderDefinition } from "@/lib/ai-providers";
import { AI_SKILLS } from "@/lib/ai-skills";
import { SKILL_CATALOG } from "@/lib/ai-writing";
import {
  PROVIDERS,
  describeProvider,
  findProvider,
  isLocal,
  parseProviderConfig,
  validateProviderConfig,
} from "@/lib/local-models";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { assembleContext, estimateTokens, fitToBudget, truncateToTokens } from "@/lib/ai-context";

/** Self-hosted runtimes a workspace can point at without a cloud key. */
const LOCAL_PROVIDERS = PROVIDERS.filter((provider) => isLocal(provider));

/**
 * The full skill catalogue surfaced in settings: the editor's registry
 * (`./ai-skills`) plus the writing skills (`./ai-writing`) that only exist in
 * that module — `continue` and `simplify` — so the new ids are discoverable.
 */
const SKILLS = [
  ...AI_SKILLS.map((skill) => ({ id: skill.id, label: skill.label, hint: skill.hint })),
  ...SKILL_CATALOG.filter(
    (skill) => !AI_SKILLS.some((editor) => editor.id === skill.id),
  ).map((skill) => ({ id: skill.id, label: skill.label, hint: skill.hint })),
];

/** Standing instruction used when previewing an assembled prompt. */
const CONTEXT_PREVIEW_SYSTEM =
  "You are the workspace assistant. Answer using only the notes provided.";

/** Sample question appended to the previewed prompt. */
const CONTEXT_PREVIEW_QUESTION = "Summarise the note above in three bullet points.";

/** Default sample note used to exercise the context budget. */
const CONTEXT_PREVIEW_SAMPLE =
  "Noema keeps every page version, so a note can be restored without losing the discussion around it. " +
  "Mentions resolve to workspace members, and backlinks surface every place a page is referenced.";

/** Default token budget shown in the context-budget preview. */
const DEFAULT_CONTEXT_BUDGET = 2048;


/**
 * Workspace AI provider settings: pick OpenAI / DeepSeek / Gemini / a custom
 * OpenAI-compatible endpoint, fetch the live model list, store the key
 * encrypted, and test the connection before saving.
 */
export function AiSettings({
  workspaceId,
  summary,
  locale,
}: {
  workspaceId: string;
  summary: AiProviderSummary;
  locale: string;
}) {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const [pending, startTransition] = useTransition();
  const [provider, setProvider] = useState(summary.provider);
  const [baseUrl, setBaseUrl] = useState(summary.baseUrl);
  const [model, setModel] = useState(summary.model);
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(summary.enabled);
  const [models, setModels] = useState<string[]>(
    AI_PROVIDERS.find((entry) => entry.id === summary.provider)?.models.map((m) => m.id) ?? [],
  );
  const [status, setStatus] = useState<string | null>(null);
  const [contextBudget, setContextBudget] = useState(DEFAULT_CONTEXT_BUDGET);
  const [samplePrompt, setSamplePrompt] = useState(CONTEXT_PREVIEW_SAMPLE);
  const [localProviderId, setLocalProviderId] = useState(LOCAL_PROVIDERS[0]?.id ?? "ollama");
  const [localBaseUrl, setLocalBaseUrl] = useState(LOCAL_PROVIDERS[0]?.baseUrl ?? "");
  const [localModel, setLocalModel] = useState(LOCAL_PROVIDERS[0]?.defaultModel ?? "");
  const [localApiKey, setLocalApiKey] = useState("");
  const [autofillPropertyId, setAutofillPropertyId] = useState("");
  const [autofillRowId, setAutofillRowId] = useState("");

  // Preview the sizing layer (`@/lib/ai-context`) for the current sample/budget.
  const contextPreview = useMemo(() => {
    const sampleTokens = estimateTokens(samplePrompt);
    const preview = truncateToTokens(samplePrompt, contextBudget);
    const truncated = samplePrompt.length > 0 && preview !== samplePrompt;
    const fit = fitToBudget(
      [
        { id: "system", text: CONTEXT_PREVIEW_SYSTEM },
        { id: "note", text: samplePrompt },
        { id: "question", text: CONTEXT_PREVIEW_QUESTION },
      ],
      {
        maxTokens: contextBudget,
        priorityOf: (chunk) => (chunk.id === "note" ? 2 : chunk.id === "system" ? 1 : 0),
      },
    );
    const assembled = assembleContext({
      system: CONTEXT_PREVIEW_SYSTEM,
      docs: [{ id: "note", title: "Sample note", text: samplePrompt, priority: 2 }],
      question: CONTEXT_PREVIEW_QUESTION,
      maxTokens: contextBudget,
    });
    const empty = samplePrompt.trim().length === 0;
    const noteDropped = assembled.dropped.some((doc) => doc.id === "note");
    const statusLabel = empty
      ? "Enter a sample prompt to preview the budget."
      : noteDropped
        ? "The note is dropped — the budget is too small."
        : truncated
          ? "The note is truncated to fit the budget."
          : "The note fits within the budget.";
    return {
      sampleTokens,
      preview,
      truncated,
      noteDropped,
      statusLabel,
      assembledTokens: assembled.usedTokens,
      keptSections: fit.kept.length,
      totalSections: fit.kept.length + fit.dropped.length,
    };
  }, [samplePrompt, contextBudget]);

  const definition: ProviderDefinition | undefined = AI_PROVIDERS.find(
    (entry) => entry.id === provider,
  );

  // Local-provider support (`@/lib/local-models`): parse the endpoint into the
  // canonical config, then validate it (scheme, model, key requirement) so the
  // form can refuse an unusable endpoint before it is stored.
  const localDescriptor = findProvider(localProviderId);
  const localConfig = useMemo(
    () =>
      parseProviderConfig({
        providerId: localProviderId,
        baseUrl: localBaseUrl,
        model: localModel,
        apiKey: localApiKey,
      }),
    [localProviderId, localBaseUrl, localModel, localApiKey],
  );
  const localValidation = useMemo(() => validateProviderConfig(localConfig), [localConfig]);

  // Static catalogue ids for the selected provider, kept alongside any live
  // ids returned by `listAiModelsAction` so refreshing never drops a known model.
  const staticModelIds = useMemo(
    () => AI_PROVIDERS.find((entry) => entry.id === provider)?.models.map((m) => m.id) ?? [],
    [provider],
  );

  // Reset the form when the provider changes.
  useEffect(() => {
    const next = AI_PROVIDERS.find((entry) => entry.id === provider);
    setModels(next?.models.map((m) => m.id) ?? []);
    if (next) {
      setBaseUrl(providerDefaultBaseUrl(provider));
      if (next.models.length > 0 && !next.models.some((m) => m.id === model)) {
        setModel(next.models[0].id);
      }
    }
    setStatus(null);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (label: string, task: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const outcome = await safeAction(task);
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      setStatus(value.message);
      if (value.ok) toast.success(label);
      else toast.error(value.message);
    });

  const fetchModels = () =>
    run(t(locale, "modelListRefreshed"), async () => {
      const result = await listAiModelsAction({ workspaceId, provider, baseUrl, apiKey });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      // Merge the live ids into the static catalogue: known models keep their
      // catalogue order, live-only ids are appended.
      const merged = [...staticModelIds];
      for (const id of result.models) {
        if (!merged.includes(id)) merged.push(id);
      }
      setModels(merged);
      if (!merged.includes(model) && merged[0]) setModel(merged[0]);
      return { ok: true, message: `${result.models.length} ${t(locale, "modelsCount")} (${result.source})` };
    });

  const test = () =>
    run(t(locale, "connectionOk"), async () => {
      const result = await testAiProviderAction({ workspaceId, provider, baseUrl, model, apiKey });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      return { ok: true, message: `${result.provider} · ${result.model} · ${result.ms} ms · "${result.sample}"` };
    });

  const save = () =>
    run(t(locale, "aiProviderSaved"), async () => {
      const result = await saveAiProviderAction({
        workspaceId,
        provider,
        baseUrl,
        model,
        apiKey: apiKey || undefined,
        enabled,
      });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      setApiKey("");
      router.refresh();
      return { ok: true, message: t(locale, "savedWord") };
    });

  const clear = () =>
    run(t(locale, "providerRemoved"), async () => {
      const result = await clearAiProviderAction(workspaceId);
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      setEnabled(false);
      setApiKey("");
      router.refresh();
      return { ok: true, message: t(locale, "providerRemovedMsg") };
    });

  const pickLocalProvider = (id: string) => {
    setLocalProviderId(id);
    const descriptor = findProvider(id);
    if (descriptor) {
      setLocalBaseUrl(descriptor.baseUrl);
      setLocalModel(descriptor.defaultModel);
    }
    setStatus(null);
  };

  // Store a keyless self-hosted endpoint. The existing provider action requires
  // a key when enabled, so keyless runtimes send the conventional `local`
  // placeholder that OpenAI-compatible and Ollama servers ignore.
  const saveLocal = () =>
    run(t(locale, "aiProviderSaved"), async () => {
      const result = await saveAiProviderAction({
        workspaceId,
        provider: "custom",
        baseUrl: localBaseUrl,
        model: localModel,
        apiKey: localApiKey || "local",
        enabled: true,
      });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      router.refresh();
      return { ok: true, message: t(locale, "savedWord") };
    });

  // Run one AI-autofill column for a row (`@/server/actions/ai-autofill`).
  const runAutofill = () => {
    if (!autofillPropertyId.trim() || !autofillRowId.trim()) return;
    startTransition(async () => {
      const outcome = await safeAction(() =>
        runAiAutofillAction({
          workspaceId,
          rowId: autofillRowId.trim(),
          propertyId: autofillPropertyId.trim(),
        }),
      );
      const value = outcome.ok ? outcome.value : { ok: false as const, error: outcome.error };
      if (value.ok) {
        setStatus(`AI autofill wrote "${value.value}" to ${value.propertyId}.`);
        toast.success(t(locale, "autofilled"));
        router.refresh();
      } else {
        setStatus(value.error);
        toast.error(value.error);
      }
    });
  };

  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <Plug className="h-4 w-4" /> {t(locale, "aiProvider")}
      </h2>
      <p className="mb-4 text-sm text-muted">
        {t(locale, "aiSettingsIntro")}
      </p>

      <p className="mb-4 text-xs text-muted">
        {t(locale, "activeSource")}{" "}
        <strong className="text-fg">
          {summary.source === "workspace"
            ? `${t(locale, "sourceWorkspace")} · ${summary.providerLabel}`
            : summary.source === "env"
              ? t(locale, "sourceEnv")
              : t(locale, "notConfigured")}
        </strong>
        {summary.hasKey && summary.keyMask ? ` · ${t(locale, "keyStored")}` : ""}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "providerLabel")}
          <select
            value={provider}
            aria-label={t(locale, "aiProvider")}
            onChange={(event) => setProvider(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
          >
            {AI_PROVIDERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "modelLabel")}
          <span className="mt-1 flex gap-1">
            <select
              value={model}
              aria-label={t(locale, "aiModel")}
              onChange={(event) => setModel(event.target.value)}
              className="h-9 w-full rounded border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
            >
              {models.length === 0 && <option value="">{t(locale, "typeModelBelow")}</option>}
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </span>
          <input
            value={model}
            aria-label={t(locale, "modelIdLabel")}
            placeholder={t(locale, "modelIdPlaceholder")}
            onChange={(event) => setModel(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>

        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "baseUrlLabel")}
          <input
            value={baseUrl}
            aria-label={t(locale, "aiBaseUrl")}
            placeholder={definition?.defaultBaseUrl ?? "https://…/v1"}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>

        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "apiKeyLabel")}
          <input
            type="password"
            value={apiKey}
            aria-label={t(locale, "aiApiKey")}
            placeholder={summary.hasKey ? t(locale, "savedKeyHint") : definition?.keyHint ?? t(locale, "apiKeyLabel")}
            onChange={(event) => setApiKey(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          aria-label={t(locale, "enableProviderAria")}
          onChange={(event) => setEnabled(event.target.checked)}
          className="accent-[var(--accent)]"
        />
        {t(locale, "useProviderForWorkspace")}
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={fetchModels}
          className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" /> {t(locale, "fetchModels")}
        </button>
        <button
          type="button"
          disabled={pending || !model}
          onClick={test}
          className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {t(locale, "testConnection")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          {t(locale, "save")}
        </button>
        {summary.hasKey && (
          <button
            type="button"
            disabled={pending}
            onClick={clear}
            className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm text-muted hover:text-red-500 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> {t(locale, "remove")}
          </button>
        )}
      </div>

      {status && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <CheckCircle2 className="h-3.5 w-3.5" /> {status}
        </p>
      )}
      {!summary.envAvailable && !summary.hasKey && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <TriangleAlert className="h-3.5 w-3.5" /> {t(locale, "aiNoProviderHint")}
        </p>
      )}

      {/* Context-budget preview. Labels are inline English; add i18n keys in a follow-up. */}
      <div className="mt-10 border-t border-border pt-6">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
          <Gauge className="h-4 w-4" /> Context budget
        </h3>
        <p className="mb-4 text-xs text-muted">
          Preview how a sample prompt is measured and trimmed before it is sent to the model. The
          limit is a planning aid — it is not stored with the provider.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Max tokens
            <input
              type="number"
              min={0}
              step={64}
              value={contextBudget}
              aria-label="Maximum context tokens"
              onChange={(event) => {
                const next = event.target.valueAsNumber;
                setContextBudget(Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 0);
              }}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
            />
          </label>

          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Sample prompt
            <textarea
              value={samplePrompt}
              rows={3}
              aria-label="Sample prompt"
              onChange={(event) => setSamplePrompt(event.target.value)}
              className="mt-1 w-full resize-y rounded border border-border bg-bg px-2 py-1 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            />
          </label>
        </div>

        <dl className="mt-3 grid gap-1 text-xs text-muted sm:grid-cols-3">
          <div>
            <dt className="inline">Sample estimate: </dt>
            <dd className="inline text-fg">{contextPreview.sampleTokens} tokens</dd>
          </div>
          <div>
            <dt className="inline">Assembled prompt: </dt>
            <dd className="inline text-fg">{contextPreview.assembledTokens} tokens</dd>
          </div>
          <div>
            <dt className="inline">Sections kept: </dt>
            <dd className="inline text-fg">
              {contextPreview.keptSections}/{contextPreview.totalSections}
            </dd>
          </div>
        </dl>

        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          {contextPreview.noteDropped || contextPreview.truncated ? (
            <TriangleAlert className="h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {contextPreview.statusLabel}
        </p>

        <pre
          aria-label="Truncated sample preview"
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-2 p-2 text-xs text-fg"
        >
          {contextPreview.preview}
        </pre>
      </div>

      {/* Local model support (`@/lib/local-models`). */}
      <div className="mt-10 border-t border-border pt-6">
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Local model</h3>
        <p className="mb-4 text-xs text-muted">
          Point the workspace at a self-hosted runtime. Requests stay on your infrastructure and a
          key is usually unnecessary.
        </p>

        {localDescriptor && (
          <p className="mb-3 text-xs text-muted">
            {describeProvider(localDescriptor)} · {isLocal(localDescriptor) ? "local" : "cloud"}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Runtime
            <select
              value={localProviderId}
              aria-label="Local runtime"
              onChange={(event) => pickLocalProvider(event.target.value)}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            >
              {LOCAL_PROVIDERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Base URL
            <input
              value={localBaseUrl}
              aria-label="Local base URL"
              onChange={(event) => setLocalBaseUrl(event.target.value)}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Model
            <input
              value={localModel}
              aria-label="Local model"
              onChange={(event) => setLocalModel(event.target.value)}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            />
          </label>
        </div>

        <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-muted">
          Token (optional)
          <input
            type="password"
            value={localApiKey}
            aria-label="Local API token"
            onChange={(event) => setLocalApiKey(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
          />
        </label>

        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          {localValidation.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <TriangleAlert className="h-3.5 w-3.5" />
          )}
          {localValidation.ok
            ? "Endpoint looks valid."
            : localValidation.errors.map((entry) => entry.message).join(" ")}
        </p>

        <button
          type="button"
          disabled={pending || !localValidation.ok}
          onClick={saveLocal}
          className="mt-3 h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          {t(locale, "save")} local provider
        </button>
      </div>

      {/* Skills catalogue (`@/lib/ai-skills` + `@/lib/ai-writing`). */}
      <div className="mt-10 border-t border-border pt-6">
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
          Writing skills
        </h3>
        <p className="mb-3 text-xs text-muted">
          Run from the editor menus and <code>/api/ai/skills</code>. The writing skills add{" "}
          <code>continue</code> and <code>simplify</code> to the editor set.
        </p>
        <ul className="grid gap-1 text-xs text-muted sm:grid-cols-2">
          {SKILLS.map((skill) => (
            <li key={skill.id}>
              <span className="text-fg">{skill.label}</span> — {skill.hint}{" "}
              <code className="text-[10px]">{skill.id}</code>
            </li>
          ))}
        </ul>
        <Link
          href={`/w/${slug}/settings/prompts`}
          className="mt-3 inline-block text-xs text-accent hover:underline"
        >
          Manage the prompt library →
        </Link>
      </div>

      {/* AI autofill (`@/server/actions/ai-autofill`). */}
      <div className="mt-10 border-t border-border pt-6">
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">AI autofill</h3>
        <p className="mb-3 text-xs text-muted">
          Run an AI-autofill column for a single row. Paste the column id and the row id to
          backfill it.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Column id
            <input
              value={autofillPropertyId}
              aria-label="AI autofill column id"
              onChange={(event) => setAutofillPropertyId(event.target.value)}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Row id
            <input
              value={autofillRowId}
              aria-label="AI autofill row id"
              onChange={(event) => setAutofillRowId(event.target.value)}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm font-normal normal-case text-fg outline-none focus:border-accent"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={pending || !autofillPropertyId.trim() || !autofillRowId.trim()}
          onClick={runAutofill}
          className="mt-3 h-9 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          Run autofill
        </button>
      </div>
    </section>
  );
}
