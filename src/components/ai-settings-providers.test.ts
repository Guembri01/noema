import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Local-provider configuration used by `ai-settings.tsx`. The panel builds its
 * runtime list with `isLocal`, parses the form with `parseProviderConfig`,
 * gates the save on `validateProviderConfig` and renders a summary with
 * `describeProvider`; this pins those exact combinations.
 */

import {
  PROVIDERS,
  describeProvider,
  findProvider,
  isLocal,
  parseProviderConfig,
  validateProviderConfig,
} from "@/lib/local-models";

import {
  BUDGET_WARN_PERCENT,
  BudgetUsageBar,
  PROVIDER_STATUS,
  PromptCard,
  ProviderCard,
  budgetUsage,
  extractPromptVariables,
  promptPreview,
  promptScopeLabel,
  promptScopeTone,
  providerRowStatus,
  providerStatusLabel,
  providerStatusTone,
  type PromptCardData,
  type ProviderCardData,
  type ProviderCardProps,
} from "./ai-settings-providers";

const h = createElement;

describe("local runtime list", () => {
  it("offers the self-hosted runtimes and no cloud APIs", () => {
    const local = PROVIDERS.filter((provider) => isLocal(provider)).map((provider) => provider.id);
    expect(local).toEqual(expect.arrayContaining(["ollama", "lmstudio", "llama.cpp", "vllm"]));
    expect(local).not.toContain("openai");
    expect(local).not.toContain("anthropic");
  });
});

describe("endpoint validation", () => {
  it("accepts a keyless loopback endpoint for a local runtime", () => {
    const config = parseProviderConfig({
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
      model: "",
      apiKey: "",
    });
    expect(config).not.toBeNull();
    expect(config?.model).toBe("llama3.1"); // backfilled default
    expect(validateProviderConfig(config).ok).toBe(true);
  });

  it("rejects plain http for a cloud host", () => {
    const config = parseProviderConfig({
      providerId: "openai",
      baseUrl: "http://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-test",
    });
    const codes = validateProviderConfig(config).errors.map((error) => error.code);
    expect(codes).toContain("insecure_url");
  });

  it("requires a key for a keyed provider", () => {
    const config = parseProviderConfig({
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-3-5-sonnet",
      apiKey: "",
    });
    expect(validateProviderConfig(config).errors.map((error) => error.code)).toContain(
      "api_key_required",
    );
  });
});

describe("provider description", () => {
  it("summarizes a local provider in one line", () => {
    const descriptor = findProvider("ollama");
    expect(descriptor).toBeDefined();
    if (!descriptor) return;
    expect(describeProvider(descriptor)).toContain("local");
    expect(describeProvider(descriptor)).toContain("keyless");
  });
});

/* -------------------------------------------------------------------------- *
 * Provider status → badge tone
 * -------------------------------------------------------------------------- */

describe("provider status mapping", () => {
  it("maps every status to its badge tone", () => {
    expect(providerStatusTone("configured")).toBe("success");
    expect(providerStatusTone("missing-key")).toBe("warning");
    expect(providerStatusTone("local")).toBe("accent");
    expect(providerStatusTone("unconfigured")).toBe("neutral");
    expect(PROVIDER_STATUS.configured.tone).toBe("success");
  });

  it("labels every status", () => {
    expect(providerStatusLabel("configured")).toBe("Configured");
    expect(providerStatusLabel("missing-key")).toBe("Missing key");
    expect(providerStatusLabel("local")).toBe("Local");
  });

  it("prefers `local` for a self-hosted runtime regardless of activation", () => {
    expect(
      providerRowStatus({ local: true, active: true, enabled: true, hasKey: false, source: "none" }),
    ).toBe("local");
    expect(
      providerRowStatus({ local: true, active: false, enabled: false, hasKey: false, source: "none" }),
    ).toBe("local");
  });

  it("treats an inactive cloud row as not set up", () => {
    expect(
      providerRowStatus({ local: false, active: false, enabled: true, hasKey: true, source: "workspace" }),
    ).toBe("unconfigured");
  });

  it("is `configured` when enabled with a key or coming from the environment", () => {
    expect(
      providerRowStatus({ local: false, active: true, enabled: true, hasKey: true, source: "workspace" }),
    ).toBe("configured");
    expect(
      providerRowStatus({ local: false, active: true, enabled: false, hasKey: false, source: "env" }),
    ).toBe("configured");
  });

  it("is `missing-key` when the active cloud row has no usable key", () => {
    expect(
      providerRowStatus({ local: false, active: true, enabled: true, hasKey: false, source: "none" }),
    ).toBe("missing-key");
    expect(
      providerRowStatus({ local: false, active: true, enabled: false, hasKey: true, source: "none" }),
    ).toBe("missing-key");
  });
});

/* -------------------------------------------------------------------------- *
 * Budget → progress percent
 * -------------------------------------------------------------------------- */

describe("budget usage mapping", () => {
  it("clamps the percentage to the 0–100 range", () => {
    expect(budgetUsage(512, 2048).percent).toBe(25);
    expect(budgetUsage(1024, 2048).percent).toBe(50);
    expect(budgetUsage(4096, 2048).percent).toBe(100);
    expect(budgetUsage(-10, 2048).percent).toBe(0);
  });

  it("flags the over-budget case with the danger tone", () => {
    const over = budgetUsage(2500, 2048);
    expect(over.overBudget).toBe(true);
    expect(over.tone).toBe("danger");
    expect(over.remaining).toBe(0);
  });

  it("escalates to the accent tone past the warning threshold", () => {
    const quiet = budgetUsage(512, 2048);
    const busy = budgetUsage(Math.ceil((BUDGET_WARN_PERCENT / 100) * 2048), 2048);
    expect(quiet.tone).toBe("success");
    expect(busy.tone).toBe("accent");
  });

  it("reports the remaining headroom", () => {
    expect(budgetUsage(512, 2048).remaining).toBe(1536);
    expect(budgetUsage(2048, 2048).remaining).toBe(0);
  });

  it("fails safe on a zero/invalid budget", () => {
    expect(budgetUsage(100, 0)).toMatchObject({ percent: 0, overBudget: false, remaining: 0 });
    expect(budgetUsage(Number.NaN, 2048).percent).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Prompt preview / variable extraction
 * -------------------------------------------------------------------------- */

describe("prompt preview", () => {
  it("collapses whitespace and reports an empty body", () => {
    expect(promptPreview("Summarize {{notes}}.")).toEqual({
      text: "Summarize {{notes}}.",
      truncated: false,
      empty: false,
    });
    expect(promptPreview("  \n  ")).toEqual({ text: "", truncated: false, empty: true });
    expect(promptPreview(undefined as unknown as string).empty).toBe(true);
  });

  it("truncates a long body with an ellipsis", () => {
    const body = "word ".repeat(100);
    const preview = promptPreview(body, 40);
    expect(preview.truncated).toBe(true);
    expect(preview.empty).toBe(false);
    expect(preview.text.endsWith("…")).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(40);
  });

  it("extracts the {{variable}} tokens, deduped and sorted", () => {
    expect(extractPromptVariables("Summarize {{notes}} for {{audience}}.")).toEqual([
      "audience",
      "notes",
    ]);
    expect(extractPromptVariables("No variables here.")).toEqual([]);
    expect(extractPromptVariables("{{b}} {{a}} {{b}}")).toEqual(["a", "b"]);
  });

  it("maps a prompt scope to its badge", () => {
    expect(promptScopeTone("workspace")).toBe("accent");
    expect(promptScopeTone("personal")).toBe("neutral");
    expect(promptScopeLabel("workspace")).toBe("Workspace");
    expect(promptScopeLabel("personal")).toBe("Personal");
  });
});

/* -------------------------------------------------------------------------- *
 * renderToStaticMarkup
 * -------------------------------------------------------------------------- */

const PROVIDER: ProviderCardData = {
  id: "openai",
  label: "OpenAI",
  description: "api.openai.com/v1",
  local: false,
  status: "configured",
  selected: true,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
};

const renderProvider = (props: Partial<ProviderCardProps> = {}) =>
  renderToStaticMarkup(
    h(ProviderCard, { provider: PROVIDER, ...props } as ProviderCardProps),
  );

describe("ProviderCard render", () => {
  it("renders the status badge, endpoint summary and test action", () => {
    const html = renderProvider();
    expect(html).toContain('data-provider="openai"');
    expect(html).toContain('data-status="configured"');
    expect(html).toContain("Configured");
    expect(html).toContain("bg-success-soft");
    expect(html).toContain("https://api.openai.com/v1");
    expect(html).toContain("gpt-4o");
    expect(html).toContain("Test connection");
    // Cleared-key confirm is absent until a key can be cleared.
    expect(html).not.toContain("confirm-dialog");
  });

  it("renders the missing-key warning row", () => {
    const html = renderProvider({
      provider: { ...PROVIDER, status: "missing-key", selected: false },
    });
    expect(html).toContain('data-status="missing-key"');
    expect(html).toContain("Missing key");
    expect(html).toContain("bg-warning-soft");
    // The inactive row's test action is unavailable.
    expect(html).toContain('disabled=""');
  });

  it("renders a local runtime row with the accent badge", () => {
    const html = renderProvider({
      provider: {
        id: "ollama",
        label: "Ollama",
        description: "self-hosted",
        local: true,
        status: "local",
        selected: false,
      },
    });
    expect(html).toContain('data-status="local"');
    expect(html).toContain("Local");
    expect(html).toContain("bg-accent-soft");
  });

  it("shows a pending test as a busy, disabled button", () => {
    const html = renderProvider({ pending: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-loading=""');
  });

  it("shows an inline error live region for a failed test", () => {
    const html = renderProvider({ testState: "error", testMessage: "401 Unauthorized" });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("401 Unauthorized");
    expect(html).toContain("text-danger");
  });

  it("shows an inline success live region for a passing test", () => {
    const html = renderProvider({ testState: "success", testMessage: "OK · 240 ms" });
    expect(html).toContain("OK · 240 ms");
    expect(html).toContain("text-success");
  });

  it("renders the clear-key danger confirm only when a key exists", () => {
    const html = renderProvider({ canClearKey: true, clearOpen: false });
    expect(html).toContain("Clear key");
    // Closed Radix dialog renders nothing.
    expect(html).not.toContain("confirm-dialog");
  });
});

const PROMPT: PromptCardData = {
  id: "weekly-summary",
  name: "Weekly summary",
  body: "Summarize {{notes}} for {{audience}} in three bullets.",
  scope: "workspace",
  variables: ["audience", "notes"],
  tags: ["weekly"],
};

const renderPrompt = (prompt: PromptCardData, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(h(PromptCard, { prompt, ...extra }));

describe("PromptCard render", () => {
  it("renders the name, preview, variable tags and scope badge", () => {
    const html = renderPrompt(PROMPT);
    expect(html).toContain('data-prompt="weekly-summary"');
    expect(html).toContain("Weekly summary");
    expect(html).toContain("Workspace");
    expect(html).toContain("Summarize {{notes}} for {{audience}} in three bullets.");
    // Each variable is a tag chip.
    expect(html).toContain("{{notes}}");
    expect(html).toContain("{{audience}}");
    expect(html).toContain("weekly");
    expect(html).toContain("Use prompt");
    expect(html).toContain("Delete");
  });

  it("renders an empty prompt with a placeholder preview", () => {
    const html = renderPrompt({ ...PROMPT, id: "blank", name: "Blank", body: "", variables: [] });
    expect(html).toContain("No preview yet");
    expect(html).toContain("No variables");
    // No variable chips are drawn for an empty prompt.
    expect(html).not.toContain("{{");
  });

  it("renders the delete danger confirm only as a closed dialog by default", () => {
    const html = renderPrompt(PROMPT, { deleteOpen: false });
    expect(html).not.toContain("confirm-dialog");
  });
});

describe("BudgetUsageBar render", () => {
  it("renders a determinate bar with the over-budget danger tone", () => {
    const html = renderToStaticMarkup(h(BudgetUsageBar, { used: 2500, budget: 2048 }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("bg-danger");
    expect(html).toContain('data-over-budget="true"');
  });
});
