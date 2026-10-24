import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.15 — AI data boundaries, enforced rather than merely described.
 *
 * The policy in `docs/AI-BOUNDARIES.md` has three code-level guarantees this
 * suite pins: payload fields never reach the log by default, a declared
 * training provider is refused without an explicit opt-in, and a local
 * endpoint is a real local-only processing scope. The static gate keeps a
 * future edit from adding a prompt log line or a telemetry host to an AI path.
 */

import {
  AI_BOUNDARY_POLICY,
  AI_PAYLOAD_FIELDS,
  aiPayloadLoggingEnabled,
  aiProcessingScope,
  assertAiDataBoundary,
  localOnlyProcessingGuaranteed,
  logAiDiagnostic,
  providerTrainingAllowed,
  sanitizeAiDiagnostic,
} from "@/lib/ai-boundary";
import { DataBoundaryError } from "@/lib/ai-cost";

const ENV_KEYS = [
  "AI_LOG_PROMPTS",
  "AI_PROVIDER_TRAINS_ON_DATA",
  "AI_ALLOW_PROVIDER_TRAINING",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("the written policy as constants", () => {
  it("opens with no payload logging, training or telemetry forwarding", () => {
    expect(AI_BOUNDARY_POLICY.promptLogging).toBe(false);
    expect(AI_BOUNDARY_POLICY.responseLogging).toBe(false);
    expect(AI_BOUNDARY_POLICY.providerTraining).toBe(false);
    expect(AI_BOUNDARY_POLICY.telemetryForwarding).toBe(false);
    expect(AI_BOUNDARY_POLICY.keysAtRest).toBe("AES-256-GCM");
    expect(AI_BOUNDARY_POLICY.audioRetention).toBe("none");
  });

  it("defaults payload logging off", () => {
    expect(aiPayloadLoggingEnabled()).toBe(false);
    process.env.AI_LOG_PROMPTS = "true";
    expect(aiPayloadLoggingEnabled()).toBe(true);
  });
});

describe("sanitizeAiDiagnostic — no prompt or completion by default", () => {
  it("drops every payload-shaped field and keeps diagnostics", () => {
    const safe = sanitizeAiDiagnostic({
      status: 401,
      code: "invalid_api_key",
      workspaceId: "cm5wq2k3l4k5b6c7d8e9f0g1h",
      provider: "openai",
      model: "gpt-4o-mini",
      prompt: "the workspace's private notes",
      messages: [{ role: "user", content: "secret" }],
      body: "provider body",
      answer: "the completion",
      completion: "tokens",
      response: "raw response",
      text: "content",
      content: "content",
      transcript: "a meeting",
    });

    expect(safe).toEqual({
      status: 401,
      code: "invalid_api_key",
      workspaceId: "cm5wq2k3l4k5b6c7d8e9f0g1h",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    for (const field of AI_PAYLOAD_FIELDS) {
      expect(safe).not.toHaveProperty(field);
    }
  });

  it("accepts a payload field only with the explicit opt-in", () => {
    process.env.AI_LOG_PROMPTS = "true";

    const safe = sanitizeAiDiagnostic({ prompt: "opted in", status: 200 });

    expect(safe).toEqual({ prompt: "opted in", status: 200 });
  });

  it("drops nested objects even when their key is not payload-shaped", () => {
    const safe = sanitizeAiDiagnostic({
      request: { prompt: "nested secret" },
      provider: "local",
    });

    expect(safe).toEqual({ provider: "local" });
  });

  it("logAiDiagnostic writes metadata only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logAiDiagnostic("ai provider error", {
      code: "provider_error",
      prompt: "private notes",
      answer: "private answer",
    });

    const logged = spy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).toContain("provider_error");
    expect(logged).not.toContain("private notes");
    expect(logged).not.toContain("private answer");
  });
});

describe("local-only processing", () => {
  it("derives the scope from the effective endpoint", () => {
    expect(aiProcessingScope("http://localhost:11434/v1")).toBe("local");
    expect(aiProcessingScope("http://192.168.1.20:8000/v1")).toBe("local");
    expect(aiProcessingScope("https://api.openai.com/v1")).toBe("remote");
    expect(aiProcessingScope("")).toBe("none");
    expect(aiProcessingScope(null)).toBe("none");
  });

  it("guarantees local-only only for loopback/private endpoints", () => {
    expect(localOnlyProcessingGuaranteed("http://127.0.0.1:11434")).toBe(true);
    expect(localOnlyProcessingGuaranteed("https://api.example.com/v1")).toBe(false);
  });
});

describe("the training boundary", () => {
  it("allows an ordinary provider", () => {
    expect(() => assertAiDataBoundary("openai")).not.toThrow();
  });

  it("refuses a declared training provider without an opt-in", () => {
    process.env.AI_PROVIDER_TRAINS_ON_DATA = "true";

    expect(providerTrainingAllowed()).toBe(false);
    expect(() => assertAiDataBoundary("trainer")).toThrow(DataBoundaryError);
  });

  it("allows a declared training provider only with the explicit opt-in", () => {
    process.env.AI_PROVIDER_TRAINS_ON_DATA = "true";
    process.env.AI_ALLOW_PROVIDER_TRAINING = "true";

    expect(providerTrainingAllowed()).toBe(true);
    expect(() => assertAiDataBoundary("trainer")).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- *
 * Static gate — the part a future edit has to keep true.
 * -------------------------------------------------------------------------- */

const AI_SOURCE_FILES = [
  "./ai-provider.ts",
  "./ai-client.ts",
  "./ai-boundary.ts",
  "./ai-cost.ts",
  "../app/api/ai/route.ts",
  "../app/api/ai/skills/route.ts",
  "../app/api/ai/transcribe/route.ts",
  "../app/api/chat/stream/route.ts",
  "../server/actions/ai-settings.ts",
  "../server/actions/ai-autofill.ts",
];

function readAiSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("static no-logging and no-telemetry gate", () => {
  it("has no console.log in an AI source path", () => {
    for (const file of AI_SOURCE_FILES) {
      expect(readAiSource(file), file).not.toMatch(/\bconsole\.log\s*\(/);
    }
  });

  it("never passes a payload-shaped value to a console or logger call", () => {
    const payloadCall =
      /\b(console|logger)\.(log|debug|info|warn|error)\s*\([^;\n]*(prompt|messages|completion|response|body|answer|transcript|content)/i;

    for (const file of AI_SOURCE_FILES) {
      expect(readAiSource(file), file).not.toMatch(payloadCall);
    }
  });

  it("adds no analytics or telemetry host to the AI transport", () => {
    const telemetryHosts =
      /(posthog|sentry\.io|segment\.(io|com)|mixpanel|amplitude|datadoghq|google-analytics|googletagmanager|fullstory|hotjar)/i;

    for (const file of AI_SOURCE_FILES) {
      expect(readAiSource(file), file).not.toMatch(telemetryHosts);
    }
  });
});
