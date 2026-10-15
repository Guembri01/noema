"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Gauge, Loader2, Plug, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  clearAiProviderAction,
  listAiModelsAction,
  saveAiProviderAction,
  testAiProviderAction,
  type AiProviderSummary,
} from "@/server/actions/ai-settings";
import { AI_PROVIDERS, providerDefaultBaseUrl, type ProviderDefinition } from "@/lib/ai-providers";
import {safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { assembleContext, estimateTokens, fitToBudget, truncateToTokens } from "@/lib/ai-context";

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
    </section>
  );
}
