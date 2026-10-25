"use client";

/**
 * AI settings — the presentational layer plus its pure mappings.
 *
 * These pieces live apart from `ai-settings.tsx` and the prompt-library page so
 * they render without the Next router (that is what lets
 * `ai-settings-providers.test.ts` statically render them):
 *
 *  - `ProviderCard` — one provider row: a `Card` carrying a status `Badge`
 *    (configured / missing key / local / not set up), a token-only endpoint +
 *    model summary, a test-connection `Button` (pending spinner + inline
 *    success/error live region) and a danger `ConfirmDialog` for clearing the
 *    stored key.
 *  - `PromptCard` — one saved prompt: name, scope, a one-line preview, the
 *    `{{variable}}` tokens as `Tag`s, its labels, and the use / edit / delete
 *    actions behind a danger `ConfirmDialog`.
 *
 * Everything is token-only (docs/DESIGN_SYSTEM.md): colour comes from the
 * `--*` tokens, motion/layering from the primitives, and the pure mappings
 * below are pinned by the node tests.
 */

import { CheckCircle2, Globe, Pencil, Play, Server, Trash2, TriangleAlert } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Progress,
  progressPercent,
  type ProgressTone,
} from "@/components/ui/progress";
import { Tag } from "@/components/ui/tag";
import { extractVariables, type PromptScope } from "@/lib/ai-prompt-library";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- *
 * Pure mappings
 * -------------------------------------------------------------------------- */

/** The four states a provider row can describe itself with. */
export type ProviderStatus = "configured" | "missing-key" | "local" | "unconfigured";

/** Status → badge tone + human label. Pinned by `ai-settings-providers.test.ts`. */
export const PROVIDER_STATUS: Record<ProviderStatus, { tone: BadgeTone; label: string }> = {
  configured: { tone: "success", label: "Configured" },
  "missing-key": { tone: "warning", label: "Missing key" },
  local: { tone: "accent", label: "Local" },
  unconfigured: { tone: "neutral", label: "Not set up" },
};

/** The `Badge` tone for a provider status. */
export function providerStatusTone(status: ProviderStatus): BadgeTone {
  return (PROVIDER_STATUS[status] ?? PROVIDER_STATUS.unconfigured).tone;
}

/** The human label for a provider status. */
export function providerStatusLabel(status: ProviderStatus): string {
  return (PROVIDER_STATUS[status] ?? PROVIDER_STATUS.unconfigured).label;
}

/** The inputs that decide one provider row's status. */
export type ProviderStatusInput = {
  /** A self-hosted runtime (Ollama, LM Studio, …) rather than a cloud API. */
  local: boolean;
  /** Whether this row is the workspace's current provider. */
  active: boolean;
  /** The stored config is switched on. */
  enabled: boolean;
  /** A key is stored for the active provider. */
  hasKey: boolean;
  /** Where the effective config comes from. */
  source: "workspace" | "env" | "none";
};

/**
 * Classify one provider row. A local runtime is always `local`; an inactive
 * cloud row is `unconfigured`; the active row is `configured` when it is
 * enabled with a key (or comes from the environment) and `missing-key`
 * otherwise.
 */
export function providerRowStatus(input: ProviderStatusInput): ProviderStatus {
  if (input.local) return "local";
  if (!input.active) return "unconfigured";
  if (input.source === "env") return "configured";
  if (input.enabled && input.hasKey) return "configured";
  return "missing-key";
}

/** Beyond this share of the budget the bar is a warning (accent) tone. */
export const BUDGET_WARN_PERCENT = 80;

/** The derived shape of the context-budget usage bar. */
export type BudgetUsage = {
  /** Clamped 0–100 share of the budget in use. */
  percent: number;
  tone: ProgressTone;
  overBudget: boolean;
  /** Whole tokens left before the budget is exceeded (never negative). */
  remaining: number;
};

/**
 * Map a used/budget token pair onto the usage bar: the clamped percentage, the
 * tone (danger once over budget, accent past `warnPercent`, success while there
 * is comfortable headroom) and the remaining tokens. `warnPercent` defaults to
 * {@link BUDGET_WARN_PERCENT} so the existing caller keeps its behaviour; the
 * AI settings panel passes the workspace's own threshold.
 */
export function budgetUsage(
  used: number,
  budget: number,
  warnPercent: number = BUDGET_WARN_PERCENT,
): BudgetUsage {
  const percent = progressPercent(used, budget);
  const overBudget = Number.isFinite(budget) && budget > 0 && used > budget;
  const warn =
    Number.isFinite(warnPercent) && warnPercent > 0
      ? Math.min(100, Math.max(1, warnPercent))
      : BUDGET_WARN_PERCENT;
  const tone: ProgressTone = overBudget
    ? "danger"
    : percent >= warn
      ? "accent"
      : "success";
  const remaining =
    Number.isFinite(used) && Number.isFinite(budget)
      ? Math.max(0, Math.floor(budget) - Math.floor(used))
      : 0;
  return { percent, tone, overBudget, remaining };
}

/** Character cap for a prompt card's one-line preview. */
export const PROMPT_PREVIEW_MAX = 160;

/** A collapsed, length-capped preview of a prompt body. */
export type PromptPreview = { text: string; truncated: boolean; empty: boolean };

/**
 * Collapse a prompt body to a single line and cap it at `maxLength` characters.
 * An empty body reports `empty` so the card can render its placeholder instead.
 */
export function promptPreview(
  body: string,
  maxLength: number = PROMPT_PREVIEW_MAX,
): PromptPreview {
  const collapsed = (typeof body === "string" ? body : "").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return { text: "", truncated: false, empty: true };
  const cap = Math.max(1, Math.floor(maxLength));
  if (collapsed.length <= cap) return { text: collapsed, truncated: false, empty: false };
  return {
    text: `${collapsed.slice(0, cap - 1).trimEnd()}…`,
    truncated: true,
    empty: false,
  };
}

/** The `{{variable}}` names a prompt body references, deduped and sorted. */
export function extractPromptVariables(body: string): string[] {
  return extractVariables(body);
}

/** The badge tone for a prompt's scope. */
export function promptScopeTone(scope: PromptScope): BadgeTone {
  return scope === "personal" ? "neutral" : "accent";
}

/** The human label for a prompt's scope. */
export function promptScopeLabel(scope: PromptScope): string {
  return scope === "personal" ? "Personal" : "Workspace";
}

/* -------------------------------------------------------------------------- *
 * ProviderCard
 * -------------------------------------------------------------------------- */

export type ProviderTestState = "idle" | "success" | "error";

export type ProviderCardData = {
  id: string;
  label: string;
  description: string;
  /** A self-hosted runtime (renders the server glyph and `local` chrome). */
  local: boolean;
  status: ProviderStatus;
  selected: boolean;
  baseUrl?: string;
  model?: string;
};

export type ProviderCardProps = {
  provider: ProviderCardData;
  /** A test/fetch/clear action is in flight. */
  pending?: boolean;
  testState?: ProviderTestState;
  testMessage?: string | null;
  /** A stored key exists and can be cleared (danger confirm). */
  canClearKey?: boolean;
  /** Controlled open state for the clear-key confirm. */
  clearOpen?: boolean;
  onClearOpenChange?: (open: boolean) => void;
  onTest?: () => void;
  onClearKey?: () => void;
};

/** One provider row. Pure presentational — every action arrives as a prop. */
export function ProviderCard({
  provider,
  pending = false,
  testState = "idle",
  testMessage,
  canClearKey = false,
  clearOpen = false,
  onClearOpenChange,
  onTest,
  onClearKey,
}: ProviderCardProps) {
  const { id, label, description, local, status, selected, baseUrl, model } = provider;

  return (
    <Card
      variant={selected ? "raised" : "flat"}
      padding="md"
      data-provider={id}
      data-status={status}
      data-selected={selected ? "true" : undefined}
      className={cn("flex flex-col gap-3", selected && "bg-selection-soft ring-1 ring-focus/40")}
    >
      <CardHeader
        icon={
          local ? (
            <Server className="h-4 w-4" aria-hidden />
          ) : (
            <Globe className="h-4 w-4" aria-hidden />
          )
        }
        title={label}
        subtitle={description}
        actions={<Badge tone={providerStatusTone(status)}>{providerStatusLabel(status)}</Badge>}
      />

      {baseUrl || model ? (
        <dl className="grid gap-0.5 text-xs text-muted">
          {baseUrl ? (
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-fg-subtle">Endpoint</dt>
              <dd className="truncate" title={baseUrl}>
                {baseUrl}
              </dd>
            </div>
          ) : null}
          {model ? (
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-fg-subtle">Model</dt>
              <dd className="truncate" title={model}>
                {model}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          disabled={!selected}
          onClick={onTest}
          leftIcon={<Play className="h-3.5 w-3.5" aria-hidden />}
        >
          Test connection
        </Button>
        {canClearKey ? (
          <Button
            size="sm"
            variant="danger"
            tone="soft"
            disabled={pending}
            onClick={() => onClearOpenChange?.(true)}
            leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
          >
            Clear key
          </Button>
        ) : null}
      </div>

      {testState !== "idle" ? (
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "flex items-center gap-1.5 text-xs",
            testState === "error" ? "text-danger" : "text-success",
          )}
        >
          {testState === "error" ? (
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          )}
          {testMessage}
        </p>
      ) : null}

      {canClearKey ? (
        <ConfirmDialog
          open={clearOpen}
          onOpenChange={onClearOpenChange ?? (() => {})}
          tone="danger"
          title={`Clear the ${label} key?`}
          description="The workspace falls back to its environment default. Stored models keep working only while a key is present."
          confirmLabel="Clear key"
          cancelLabel="Cancel"
          pending={pending}
          onConfirm={() => onClearKey?.()}
        />
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- *
 * PromptCard
 * -------------------------------------------------------------------------- */

export type PromptCardData = {
  id: string;
  name: string;
  body: string;
  scope: PromptScope;
  variables: readonly string[];
  tags?: readonly string[];
};

export type PromptCardProps = {
  prompt: PromptCardData;
  selected?: boolean;
  /** A delete action is in flight. */
  pending?: boolean;
  deleteOpen?: boolean;
  onDeleteOpenChange?: (open: boolean) => void;
  onUse?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
};

/** One saved prompt. Pure presentational — every action arrives as a prop. */
export function PromptCard({
  prompt,
  selected = false,
  pending = false,
  deleteOpen = false,
  onDeleteOpenChange,
  onUse,
  onEdit,
  onDelete,
}: PromptCardProps) {
  const { id, name, body, scope, variables, tags } = prompt;
  const preview = promptPreview(body);
  const variableCount = variables.length;

  return (
    <Card
      variant={selected ? "raised" : "flat"}
      padding="md"
      data-prompt={id}
      data-scope={scope}
      data-selected={selected ? "true" : undefined}
      className={cn("flex flex-col gap-3", selected && "bg-selection-soft ring-1 ring-focus/40")}
    >
      <CardHeader
        title={name}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={promptScopeTone(scope)} size="sm">
              {promptScopeLabel(scope)}
            </Badge>
            <span>
              {variableCount === 0
                ? "No variables"
                : `${variableCount} variable${variableCount === 1 ? "" : "s"}`}
            </span>
          </span>
        }
      />

      {preview.empty ? (
        <p className="text-sm text-muted">No preview yet — add a prompt body.</p>
      ) : (
        <p className="text-sm text-muted" title={preview.truncated ? body : undefined}>
          {preview.text}
        </p>
      )}

      {variableCount > 0 ? (
        <div className="flex flex-wrap gap-1">
          {variables.map((variable) => (
            <Tag key={variable} hue="blue" size="sm">
              {`{{${variable}}}`}
            </Tag>
          ))}
        </div>
      ) : null}

      {tags && tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Tag key={tag} hue="gray" size="sm">
              {tag}
            </Tag>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onUse}
          leftIcon={<Play className="h-3.5 w-3.5" aria-hidden />}
        >
          Use prompt
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onEdit}
          leftIcon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="danger"
          tone="soft"
          disabled={pending}
          onClick={() => onDeleteOpenChange?.(true)}
          leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
        >
          Delete
        </Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={onDeleteOpenChange ?? (() => {})}
        tone="danger"
        title={`Delete “${name}”?`}
        description="This removes the prompt from the library. This cannot be undone."
        confirmLabel="Delete prompt"
        cancelLabel="Cancel"
        pending={pending}
        onConfirm={() => onDelete?.()}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- *
 * BudgetUsageBar
 * -------------------------------------------------------------------------- */

export type BudgetUsageBarProps = {
  used: number;
  budget: number;
  label?: string;
};

/**
 * The context-budget usage bar: a token-only `Progress` driven by
 * {@link budgetUsage}, with the used/budget caption and the tone that follows
 * the headroom (success → accent → danger).
 */
export function BudgetUsageBar({ used, budget, label = "Context usage" }: BudgetUsageBarProps) {
  const usage = budgetUsage(used, budget);
  return (
    <Progress
      label={label}
      value={used}
      max={Number.isFinite(budget) && budget > 0 ? budget : 1}
      tone={usage.tone}
      showValue
      data-over-budget={usage.overBudget ? "true" : undefined}
      className="tabular-nums"
    />
  );
}

/* -------------------------------------------------------------------------- *
 * AiBudgetPanel
 * -------------------------------------------------------------------------- */

/** The four states the workspace spend can be in. */
export type AiBudgetState = "unset" | "ok" | "warn" | "over";

/** One surface's slice of the month. */
export type AiBudgetSurfaceData = {
  surface: string;
  tokensIn: number;
  tokensOut: number;
  requests: number;
  failures: number;
};

/** The read model the settings dashboard renders (R25.12–R25.14). */
export type AiBudgetPanelData = {
  period: string;
  configured: boolean;
  monthlyTokenLimit: number;
  warnPercent: number;
  hardStop: boolean;
  tokensIn: number;
  tokensOut: number;
  usedTokens: number;
  requests: number;
  failures: number;
  remainingTokens: number;
  percent: number;
  state: AiBudgetState;
  bySurface: readonly AiBudgetSurfaceData[];
};

const BUDGET_STATE_BADGE: Record<AiBudgetState, { tone: BadgeTone; label: string }> = {
  unset: { tone: "neutral", label: "No limit" },
  ok: { tone: "success", label: "Within budget" },
  warn: { tone: "warning", label: "Warning" },
  over: { tone: "danger", label: "Over budget" },
};

/** Locale-aware, thousands-separated token count with a safe fallback. */
export function formatTokens(value: number, locale = "en"): string {
  const number = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(number);
  } catch {
    return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(number);
  }
}

/**
 * The AI usage dashboard (settings → AI). Pure presentational: it takes the
 * summary `getAiBudgetSummary` returns and renders the month's totals, the
 * budget state (amber at `warnPercent`, red when over) and the per-surface
 * breakdown. The editable controls live in `AiSettings`, which is why this
 * piece can be statically rendered in `ai-settings-providers.test.ts`.
 */
export function AiBudgetPanel({
  summary,
  locale = "en",
}: {
  summary: AiBudgetPanelData;
  locale?: string;
}) {
  const state = BUDGET_STATE_BADGE[summary.state] ?? BUDGET_STATE_BADGE.unset;
  const usage = budgetUsage(summary.usedTokens, summary.monthlyTokenLimit, summary.warnPercent);
  const limitLabel = summary.monthlyTokenLimit > 0 ? formatTokens(summary.monthlyTokenLimit, locale) : "—";

  return (
    <Card
      variant="flat"
      padding="md"
      data-budget-panel="true"
      data-budget-state={summary.state}
      data-budget-period={summary.period}
      data-budget-warn-percent={summary.warnPercent}
      className="flex flex-col gap-3"
    >
      <CardHeader
        title={`AI usage · ${summary.period}`}
        subtitle="Tokens spent this calendar month (UTC) across every AI surface."
        actions={<Badge tone={state.tone}>{state.label}</Badge>}
      />

      <Progress
        label="Monthly token budget"
        value={summary.usedTokens}
        max={summary.monthlyTokenLimit > 0 ? summary.monthlyTokenLimit : 1}
        tone={usage.tone}
        showValue
        data-over-budget={summary.state === "over" ? "true" : undefined}
        className="tabular-nums"
      />

      <dl className="grid gap-1 text-xs text-muted sm:grid-cols-2" data-budget-totals="true">
        <div>
          <dt className="inline">Tokens used: </dt>
          <dd className="inline text-fg">
            {formatTokens(summary.usedTokens, locale)}
            {summary.monthlyTokenLimit > 0 ? ` / ${limitLabel} (${summary.percent}%)` : ""}
          </dd>
        </div>
        <div>
          <dt className="inline">Calls: </dt>
          <dd className="inline text-fg">
            {formatTokens(summary.requests, locale)} call
            {summary.requests === 1 ? "" : "s"}
            {summary.failures > 0 ? ` · ${formatTokens(summary.failures, locale)} failed` : ""}
          </dd>
        </div>
        <div>
          <dt className="inline">Input / output: </dt>
          <dd className="inline text-fg">
            {formatTokens(summary.tokensIn, locale)} / {formatTokens(summary.tokensOut, locale)}
          </dd>
        </div>
        <div>
          <dt className="inline">Remaining: </dt>
          <dd className="inline text-fg">
            {summary.monthlyTokenLimit > 0
              ? formatTokens(summary.remainingTokens, locale)
              : "Unlimited"}
          </dd>
        </div>
      </dl>

      {summary.state === "over" ? (
        <p role="status" className="flex items-start gap-1.5 text-xs text-danger">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            The monthly budget is exhausted
            {summary.hardStop ? " — new AI calls are refused" : " (soft limit — calls still run)"}.
            Raise the limit, reset this month, or wait for {summary.period} to end.
          </span>
        </p>
      ) : summary.state === "warn" ? (
        <p role="status" className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {summary.percent}% of this month&apos;s AI token budget is used (warning at{" "}
            {summary.warnPercent}%).
          </span>
        </p>
      ) : summary.state === "unset" ? (
        <p className="text-xs text-muted">
          {summary.configured
            ? "The token ceiling is disabled (0). Usage is still metered but calls are never refused."
            : "No monthly token budget is set. Calls are metered but never refused."}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          {summary.percent}% of this month&apos;s budget used.
        </p>
      )}

      {summary.bySurface.length > 0 ? (
        <div className="overflow-hidden rounded-control border border-border">
          <table className="w-full text-xs">
            <caption className="sr-only">AI usage by surface</caption>
            <thead className="bg-surface-2 text-fg-subtle">
              <tr>
                <th scope="col" className="px-2 py-1 text-left font-medium">
                  Surface
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Tokens
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Calls
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.bySurface.map((row) => (
                <tr key={row.surface} className="border-t border-border" data-budget-surface={row.surface}>
                  <td className="px-2 py-1">{row.surface}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {formatTokens(row.tokensIn + row.tokensOut, locale)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {formatTokens(row.requests, locale)}
                    {row.failures > 0 ? ` (${formatTokens(row.failures, locale)} failed)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted">No AI calls have been recorded this month yet.</p>
      )}
    </Card>
  );
}
