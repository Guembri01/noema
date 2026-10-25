"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  CheckCircle2,
  Plug,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  clearAiProviderAction,
  listAiModelsAction,
  resetAiUsageAction,
  saveAiBudgetAction,
  saveAiProviderAction,
  testAiProviderAction,
  type AiBudgetSummary,
  type AiProviderSummary,
} from "@/server/actions/ai-settings";
import { runAiAutofillAction } from "@/server/actions/ai-autofill";
import {
  AI_PROVIDERS,
  classifyAiBaseUrl,
  providerDefaultBaseUrl,
  type ProviderDefinition,
} from "@/lib/ai-providers";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Select, type SelectOption } from "@/components/ui/select";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import {
  AiBudgetPanel,
  BudgetUsageBar,
  ProviderCard,
  providerRowStatus,
  providerStatusTone,
  type ProviderCardData,
  type ProviderStatus,
  type ProviderTestState,
} from "@/components/ai-settings-providers";

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

/** Upper bound for the context-budget stepper. */
const MAX_CONTEXT_BUDGET = 200_000;

/** Which async action is in flight, so only its control shows a spinner. */
type BusyAction = "models" | "test" | "save" | "clear" | "local" | "autofill" | "budget" | "reset" | null;

/** The result of the last action, tagged with the action that produced it. */
type ActionStatus = { ok: boolean; message: string; action: Exclude<BusyAction, null> };

/**
 * Workspace AI provider settings.
 *
 * One `Section` per concern — Provider, Models, Budget, Prompt library, Data
 * boundaries (plus the AI autofill tool) — built from the design-system
 * primitives: the provider picker is a `Select`, each provider row is a
 * `ProviderCard` with a status `Badge`, the local-model toggle is a `Switch`,
 * the budget is a `Stepper` + usage `Progress`, and clearing a stored key goes
 * through a danger `ConfirmDialog`.
 */
export function AiSettings({
  workspaceId,
  summary,
  budget,
  locale,
}: {
  workspaceId: string;
  summary: AiProviderSummary;
  budget?: AiBudgetSummary | null;
  locale: string;
}) {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const [, startTransition] = useTransition();
  const [provider, setProvider] = useState(summary.provider);
  const [baseUrl, setBaseUrl] = useState(summary.baseUrl);
  const [model, setModel] = useState(summary.model);
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(summary.enabled);
  const [models, setModels] = useState<string[]>(
    AI_PROVIDERS.find((entry) => entry.id === summary.provider)?.models.map((m) => m.id) ?? [],
  );
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [useLocal, setUseLocal] = useState(false);
  const [contextBudget, setContextBudget] = useState(DEFAULT_CONTEXT_BUDGET);
  const [samplePrompt, setSamplePrompt] = useState(CONTEXT_PREVIEW_SAMPLE);
  const [localProviderId, setLocalProviderId] = useState(LOCAL_PROVIDERS[0]?.id ?? "ollama");
  const [localBaseUrl, setLocalBaseUrl] = useState(LOCAL_PROVIDERS[0]?.baseUrl ?? "");
  const [localModel, setLocalModel] = useState(LOCAL_PROVIDERS[0]?.defaultModel ?? "");
  const [localApiKey, setLocalApiKey] = useState("");
  const [autofillPropertyId, setAutofillPropertyId] = useState("");
  const [autofillRowId, setAutofillRowId] = useState("");
  const [monthlyTokenLimit, setMonthlyTokenLimit] = useState(
    String(budget?.monthlyTokenLimit ?? 0),
  );
  const [warnPercent, setWarnPercent] = useState(String(budget?.warnPercent ?? 80));
  const [hardStop, setHardStop] = useState(budget?.hardStop ?? true);

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

  // The endpoint decides both facts the form must state: whether plain http is
  // allowed and whether a key is required. `classifyAiBaseUrl` is the same
  // check the server action runs, so the UI cannot promise something the save
  // will refuse.
  const endpointCheck = useMemo(() => classifyAiBaseUrl(baseUrl), [baseUrl]);
  const endpointLocal = endpointCheck.ok && endpointCheck.local;
  const keyMissingForRemote =
    !useLocal && !endpointLocal && !apiKey.trim() && !summary.hasKey;
  const saveBlockedReason = useLocal
    ? null
    : !endpointCheck.ok
      ? endpointCheck.error
      : enabled && !model.trim()
        ? "Choose a model before enabling this provider."
        : enabled && keyMissingForRemote
          ? "Add an API key — a remote provider cannot be enabled keyless."
          : null;

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

  const run = (
    action: Exclude<BusyAction, null>,
    label: string,
    task: () => Promise<{ ok: boolean; message: string }>,
  ) => {
    setBusy(action);
    startTransition(async () => {
      const outcome = await safeAction(task);
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      setStatus({ ok: value.ok, message: value.message, action });
      if (value.ok) toast.success(label);
      else toast.error(value.message);
      setBusy(null);
    });
  };

  const fetchModels = () =>
    run("models", t(locale, "modelListRefreshed"), async () => {
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
      return {
        ok: true,
        message: `${result.models.length} ${t(locale, "modelsCount")} (${result.source})`,
      };
    });

  const test = () =>
    run("test", t(locale, "connectionOk"), async () => {
      const result = await testAiProviderAction(
        useLocal
          ? {
              workspaceId,
              provider: "custom",
              baseUrl: localBaseUrl,
              model: localModel,
              // Keyless local runtimes get no key at all; the transport omits
              // the Authorization header rather than sending a placeholder.
              apiKey: localApiKey.trim() || undefined,
            }
          : { workspaceId, provider, baseUrl, model, apiKey },
      );
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      return {
        ok: true,
        message: `${result.provider} · ${result.model} · ${result.ms} ms · "${result.sample}"`,
      };
    });

  const save = () =>
    run("save", t(locale, "aiProviderSaved"), async () => {
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
    run("clear", t(locale, "providerRemoved"), async () => {
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

  // Store a keyless self-hosted endpoint. The action allows an empty key only
  // while the endpoint is loopback/private; the token field is optional and
  // stays empty for runtimes that do not expect one.
  const saveLocal = () =>
    run("local", t(locale, "aiProviderSaved"), async () => {
      const result = await saveAiProviderAction({
        workspaceId,
        provider: "custom",
        baseUrl: localBaseUrl,
        model: localModel,
        apiKey: localApiKey.trim() || undefined,
        enabled: true,
      });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      // Saving the local form makes the local endpoint the workspace provider:
      // switch the UI into local mode so the form reflects what was stored.
      setUseLocal(true);
      setEnabled(true);
      router.refresh();
      return { ok: true, message: t(locale, "savedWord") };
    });

  // Run one AI-autofill column for a row (`@/server/actions/ai-autofill`).
  const runAutofill = () => {
    if (!autofillPropertyId.trim() || !autofillRowId.trim()) return;
    setBusy("autofill");
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
        setStatus({
          ok: true,
          action: "autofill",
          message: `AI autofill wrote "${value.value}" to ${value.propertyId}.`,
        });
        toast.success(t(locale, "autofilled"));
        router.refresh();
      } else {
        setStatus({ ok: false, action: "autofill", message: value.error });
        toast.error(value.error);
      }
      setBusy(null);
    });
  };

  // Save the monthly token budget (R25.13). The server validates the numbers
  // again; the client only parses the two text fields into integers.
  const saveBudget = () =>
    run("budget", "AI budget saved", async () => {
      const limit = Number(monthlyTokenLimit.replace(/[\s,]/g, ""));
      const warn = Number(warnPercent);
      const result = await saveAiBudgetAction({
        workspaceId,
        monthlyTokenLimit: limit,
        warnPercent: warn,
        hardStop,
      });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      router.refresh();
      return { ok: true, message: "AI budget saved" };
    });

  // Reset this month's counters only (period-keyed rows, so the next month
  // starts at zero on its own).
  const resetUsage = () =>
    run("reset", "AI usage reset", async () => {
      const result = await resetAiUsageAction(workspaceId);
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      router.refresh();
      return {
        ok: true,
        message: `AI usage reset (${result.removed} counter${result.removed === 1 ? "" : "s"} cleared)`,
      };
    });

  const providerOptions: SelectOption[] = useMemo(
    () =>
      AI_PROVIDERS.map((entry) => ({
        value: entry.id,
        label: entry.label,
        description: entry.defaultBaseUrl || "Any OpenAI-compatible endpoint",
      })),
    [],
  );

  const modelOptions: SelectOption[] = useMemo(
    () => models.map((id) => ({ value: id, label: id })),
    [models],
  );

  const localOptions: SelectOption[] = useMemo(
    () => LOCAL_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label })),
    [],
  );

  // One card per provider: the cloud catalogue plus the self-hosted runtimes.
  const providerRows: ProviderCardData[] = useMemo(() => {
    const cloud = AI_PROVIDERS.map((entry) => {
      const active = !useLocal && entry.id === provider;
      return {
        id: entry.id,
        label: entry.label,
        description: entry.defaultBaseUrl || "Any OpenAI-compatible endpoint",
        local: false,
        selected: active,
        status: providerRowStatus({
          local: false,
          active,
          enabled,
          // A local endpoint needs no key: mark the active row configured
          // rather than "missing key".
          hasKey: active && (summary.hasKey || endpointLocal),
          source: summary.source,
        }),
        baseUrl: active ? baseUrl : entry.defaultBaseUrl || undefined,
        model: active ? model : entry.models[0]?.id,
      } satisfies ProviderCardData;
    });
    const local = LOCAL_PROVIDERS.map((entry) => {
      const active = useLocal && entry.id === localProviderId;
      return {
        id: entry.id,
        label: entry.label,
        description: entry.baseUrl,
        local: true,
        selected: active,
        status: providerRowStatus({
          local: true,
          active,
          enabled: true,
          hasKey: false,
          source: "none",
        }),
        baseUrl: active ? localBaseUrl : entry.baseUrl,
        model: active ? localModel : entry.defaultModel,
      } satisfies ProviderCardData;
    });
    return [...cloud, ...local];
  }, [useLocal, provider, enabled, summary.hasKey, summary.source, endpointLocal, baseUrl, model, localProviderId, localBaseUrl, localModel]);

  const testStatus = status?.action === "test" ? status : null;
  const testState: ProviderTestState =
    testStatus === null ? "idle" : testStatus.ok ? "success" : "error";
  const sourceStatus: ProviderStatus =
    summary.source === "workspace" || summary.source === "env" ? "configured" : "unconfigured";

  const budgetLimitNumber = Number(monthlyTokenLimit.replace(/[\s,]/g, ""));
  const budgetWarnNumber = Number(warnPercent);
  const budgetInvalid =
    !Number.isInteger(budgetLimitNumber) ||
    budgetLimitNumber < 0 ||
    budgetLimitNumber > 1_000_000_000 ||
    !Number.isInteger(budgetWarnNumber) ||
    budgetWarnNumber < 1 ||
    budgetWarnNumber > 100;

  return (
    <div className="mt-10 flex flex-col gap-12">
      {/* Provider — picker, status cards, test connection, clear key. */}
      <Section
        level={2}
        title={t(locale, "aiProvider")}
        description={t(locale, "aiSettingsIntro")}
        action={
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-muted" aria-hidden />
            <Switch
              size="sm"
              checked={useLocal}
              onCheckedChange={setUseLocal}
              label="Use local model"
              aria-label={t(locale, "useLocalModel")}
            />
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{t(locale, "activeSource")}</span>
          <Badge tone={providerStatusTone(sourceStatus)}>
            {summary.source === "workspace"
              ? `${t(locale, "sourceWorkspace")} · ${summary.providerLabel}`
              : summary.source === "env"
                ? t(locale, "sourceEnv")
                : t(locale, "notConfigured")}
          </Badge>
          {summary.hasKey && summary.keyMask ? (
            <span>{t(locale, "keyStored")}</span>
          ) : null}
        </div>

        {useLocal ? (
          <p className="text-sm text-muted">
            Local mode sends every request to the self-hosted runtime configured under Data
            boundaries. No prompt text leaves your infrastructure.
          </p>
        ) : (
          <Field id="ai-provider" label={t(locale, "providerLabel")}>
            <Select
              id="ai-provider"
              aria-label={t(locale, "aiProvider")}
              options={providerOptions}
              value={provider}
              onChange={setProvider}
              allowClear={false}
              searchable={false}
            />
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {providerRows.map((row) => {
            const active = row.selected;
            return (
              <ProviderCard
                key={row.id}
                provider={row}
                pending={busy === "test" && active}
                testState={active ? testState : "idle"}
                testMessage={active ? testStatus?.message ?? null : null}
                canClearKey={!useLocal && row.id === summary.provider && summary.hasKey}
                clearOpen={clearOpen}
                onClearOpenChange={setClearOpen}
                onTest={active ? test : undefined}
                onClearKey={() => {
                  setClearOpen(false);
                  clear();
                }}
              />
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone={summary.processing === "local" ? "accent" : "neutral"}>
            {summary.processing === "local"
              ? "Local-only processing"
              : summary.processing === "remote"
                ? "Remote provider"
                : "No provider"}
          </Badge>
          <span>
            {summary.processing === "local"
              ? "Prompts and completions stay on this machine or private network."
              : summary.processing === "remote"
                ? "Prompts and completions are sent to the configured provider. See docs/AI-BOUNDARIES.md."
                : "No model is configured yet."}
          </span>
        </div>

        {!summary.envAvailable && !summary.hasKey && !summary.local && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> {t(locale, "aiNoProviderHint")}
          </p>
        )}
        {summary.endpointError ? (
          <p className="flex items-center gap-1.5 text-xs text-danger">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> {summary.endpointError}
          </p>
        ) : null}
      </Section>

      {/* Models — model id, endpoint, key, enable, save. */}
      {!useLocal && (
        <Section
          level={2}
          title="Models"
          description="Choose the model the workspace calls, the endpoint it is reached at and the key that authenticates it."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ai-model" label={t(locale, "modelLabel")}>
              <Select
                id="ai-model"
                aria-label={t(locale, "aiModel")}
                options={modelOptions}
                value={model}
                onChange={setModel}
                allowClear={false}
                searchable={false}
                placeholder={t(locale, "typeModelBelow")}
              />
            </Field>

            <Field id="ai-model-id" label={t(locale, "modelIdLabel")}>
              <Input
                id="ai-model-id"
                value={model}
                aria-label={t(locale, "modelIdLabel")}
                placeholder={t(locale, "modelIdPlaceholder")}
                onChange={(event) => setModel(event.target.value)}
              />
            </Field>

            <Field id="ai-base-url" label={t(locale, "baseUrlLabel")}>
              <Input
                id="ai-base-url"
                value={baseUrl}
                aria-label={t(locale, "aiBaseUrl")}
                placeholder={definition?.defaultBaseUrl ?? "https://…/v1"}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>

            <Field
              id="ai-api-key"
              label={t(locale, "apiKeyLabel")}
              hint={
                summary.hasKey
                  ? t(locale, "savedKeyHint")
                  : endpointLocal
                    ? "Optional — this endpoint is loopback/private."
                    : "Required for a remote provider."
              }
            >
              <Input
                id="ai-api-key"
                type="password"
                value={apiKey}
                aria-label={t(locale, "aiApiKey")}
                placeholder={
                  summary.hasKey
                    ? t(locale, "savedKeyHint")
                    : endpointLocal
                      ? "No key needed for a local runtime"
                      : definition?.keyHint ?? t(locale, "apiKeyLabel")
                }
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
          </div>

          <p className="text-xs text-muted">
            {endpointCheck.ok
              ? endpointLocal
                ? "Local endpoint: plain http is allowed and the API key is optional. Nothing is sent to a Noema server."
                : "Remote endpoint: TLS is required and the API key is mandatory."
              : endpointCheck.error}
          </p>

          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            label={t(locale, "useProviderForWorkspace")}
            aria-label={t(locale, "enableProviderAria")}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              loading={busy === "models"}
              onClick={fetchModels}
              leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}
            >
              {t(locale, "fetchModels")}
            </Button>
            <Button
              loading={busy === "save"}
              onClick={save}
              disabled={(busy !== null && busy !== "save") || Boolean(saveBlockedReason)}
            >
              {t(locale, "save")}
            </Button>
          </div>
          {saveBlockedReason ? (
            <p role="status" className="flex items-center gap-1.5 text-xs text-muted">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> {saveBlockedReason}
            </p>
          ) : null}
        </Section>
      )}

      {/* AI usage & budget — the durable meter and the ceiling (R25.12–R25.14). */}
      <Section
        level={2}
        title="AI usage & budget"
        description="Every model call is metered against the workspace's monthly token budget (UTC calendar month). The guard runs in the transport before dispatch, so an exhausted budget refuses new calls instead of discovering the overspend afterwards."
      >
        {budget ? (
          <AiBudgetPanel summary={budget} locale={locale} />
        ) : (
          <p className="text-xs text-muted">
            Usage is not available yet. Save a budget to create the workspace meter.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="ai-budget-limit"
            label="Monthly token limit"
            hint="0 disables the ceiling; usage is still recorded."
          >
            <Input
              id="ai-budget-limit"
              inputMode="numeric"
              value={monthlyTokenLimit}
              aria-label="Monthly token limit"
              onChange={(event) => setMonthlyTokenLimit(event.target.value)}
            />
          </Field>
          <Field
            id="ai-budget-warn"
            label="Warn at %"
            hint="Amber from this share of the limit."
          >
            <Input
              id="ai-budget-warn"
              inputMode="numeric"
              value={warnPercent}
              aria-label="Warning threshold percent"
              onChange={(event) => setWarnPercent(event.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Switch
              checked={hardStop}
              onCheckedChange={setHardStop}
              label="Refuse calls over budget"
              aria-label="Refuse AI calls over budget"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            loading={busy === "budget"}
            disabled={(busy !== null && busy !== "budget") || budgetInvalid}
            onClick={saveBudget}
          >
            Save budget
          </Button>
          <Button
            variant="danger"
            tone="soft"
            loading={busy === "reset"}
            disabled={busy !== null && busy !== "reset"}
            onClick={resetUsage}
          >
            Reset this month
          </Button>
        </div>

        {budgetInvalid ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Use a whole number ≥ 0 for the
            limit and a whole number from 1 to 100 for the warning threshold.
          </p>
        ) : (
          <p className="text-xs text-muted">
            {hardStop
              ? "Calls are refused once this month's tokens would exceed the limit."
              : "Soft mode: calls still run over the limit; the dashboard turns red."}
          </p>
        )}
      </Section>

      {/* Budget — a Stepper bound to a usage Progress bar. */}
      <Section
        level={2}
        title="Budget"
        description="Preview how a sample prompt is measured and trimmed before it is sent to the model. The limit is a planning aid — it is not stored with the provider."
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <Stepper
            label="Max tokens"
            value={contextBudget}
            onValueChange={setContextBudget}
            min={0}
            max={MAX_CONTEXT_BUDGET}
            step={256}
            unit="tok"
          />
          <Field id="sample-prompt" label="Sample prompt">
            <Textarea
              id="sample-prompt"
              value={samplePrompt}
              rows={3}
              aria-label={t(locale, "samplePrompt")}
              onChange={(event) => setSamplePrompt(event.target.value)}
            />
          </Field>
        </div>

        <BudgetUsageBar used={contextPreview.assembledTokens} budget={contextBudget} />

        <dl className="grid gap-1 text-xs text-muted sm:grid-cols-3">
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

        <p className="flex items-center gap-1.5 text-xs text-muted">
          {contextPreview.noteDropped || contextPreview.truncated ? (
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          )}
          {contextPreview.statusLabel}
        </p>

        <pre
          aria-label={t(locale, "truncatedSamplePreview")}
          className="max-h-40 overflow-auto whitespace-pre-wrap rounded-control border border-border bg-surface-2 p-2 text-xs text-fg scrollbar-thin"
        >
          {contextPreview.preview}
        </pre>
      </Section>

      {/* Prompt library — the writing-skills catalogue and a link to manage it. */}
      <Section
        level={2}
        title="Prompt library"
        description="Built-in writing skills run from the editor menus and /api/ai/skills. Save your own reusable prompts with {{variable}} placeholders."
        action={
          <Button asChild variant="secondary">
            <Link href={`/w/${slug}/settings/prompts`}>Manage prompts</Link>
          </Button>
        }
      >
        <ul className="flex flex-wrap gap-1.5">
          {SKILLS.map((skill) => (
            <li key={skill.id}>
              <Tag hue="gray" size="sm" title={skill.hint}>
                {skill.label}
              </Tag>
            </li>
          ))}
        </ul>
      </Section>

      {/* Data boundaries — where the model runs and what leaves the workspace. */}
      <Section
        level={2}
        title="Data boundaries"
        description="Point the workspace at a self-hosted runtime. A loopback/private endpoint keeps every prompt and completion on your infrastructure and needs no API key."
      >
        <ul className="grid gap-1 text-xs text-muted">
          <li>• Prompts and completions are not written to application logs by default.</li>
          <li>• Noema adds no training or telemetry forwarding to the AI transport.</li>
          <li>• Keys are encrypted at rest and never returned to the browser.</li>
          <li>• The written policy and its enforcement points live in docs/AI-BOUNDARIES.md.</li>
        </ul>
        {localDescriptor && (
          <p className="text-xs text-muted">
            {describeProvider(localDescriptor)} · {isLocal(localDescriptor) ? "local" : "cloud"}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="local-runtime" label="Runtime">
            <Select
              id="local-runtime"
              aria-label={t(locale, "localRuntime")}
              options={localOptions}
              value={localProviderId}
              onChange={pickLocalProvider}
              allowClear={false}
              searchable={false}
            />
          </Field>
          <Field id="local-base-url" label="Base URL">
            <Input
              id="local-base-url"
              value={localBaseUrl}
              aria-label={t(locale, "baseUrlLabel")}
              onChange={(event) => setLocalBaseUrl(event.target.value)}
            />
          </Field>
          <Field id="local-model" label="Model">
            <Input
              id="local-model"
              value={localModel}
              aria-label={t(locale, "modelLabel")}
              onChange={(event) => setLocalModel(event.target.value)}
            />
          </Field>
        </div>

        <Field id="local-token" label="Token (optional)">
          <Input
            id="local-token"
            type="password"
            value={localApiKey}
            aria-label={t(locale, "localApiToken")}
            onChange={(event) => setLocalApiKey(event.target.value)}
          />
        </Field>

        <p
          role="status"
          aria-live="polite"
          className={
            localValidation.ok
              ? "flex items-center gap-1.5 text-xs text-success"
              : "flex items-center gap-1.5 text-xs text-danger"
          }
        >
          {localValidation.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
          )}
          {localValidation.ok
            ? "Endpoint looks valid."
            : localValidation.errors.map((entry) => entry.message).join(" ")}
        </p>

        <div>
          <Button
            loading={busy === "local"}
            disabled={!localValidation.ok}
            onClick={saveLocal}
          >
            {t(locale, "save")} local provider
          </Button>
        </div>
      </Section>

      {/* AI autofill tool (`@/server/actions/ai-autofill`). */}
      <Section
        level={2}
        title="AI autofill"
        description="Run an AI-autofill column for a single row. Paste the column id and the row id to backfill it."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="autofill-column" label="Column id">
            <Input
              id="autofill-column"
              value={autofillPropertyId}
              aria-label={t(locale, "autofillColumnId")}
              onChange={(event) => setAutofillPropertyId(event.target.value)}
            />
          </Field>
          <Field id="autofill-row" label="Row id">
            <Input
              id="autofill-row"
              value={autofillRowId}
              aria-label={t(locale, "autofillRowId")}
              onChange={(event) => setAutofillRowId(event.target.value)}
            />
          </Field>
        </div>
        <div>
          <Button
            variant="secondary"
            loading={busy === "autofill"}
            disabled={!autofillPropertyId.trim() || !autofillRowId.trim()}
            onClick={runAutofill}
          >
            Run autofill
          </Button>
        </div>
      </Section>

      {/* Async result banner (live region) for the non-test actions. */}
      {status && status.action !== "test" ? (
        <p
          role="status"
          aria-live="polite"
          className={
            status.ok
              ? "flex items-center gap-1.5 text-xs text-success"
              : "flex items-center gap-1.5 text-xs text-danger"
          }
        >
          {status.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
          )}
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
