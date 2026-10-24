"use client";

import { t } from "@/lib/i18n";

/** Thin client for the AI proxy routes, shared by the editor skills. */

export type AiSkillResponse =
  | { text: string; replacesSelection: boolean; skill: string }
  | { error: string };

/**
 * Optional per-request knobs of a built-in skill. The route validates every
 * value again (`src/lib/validation.ts`, `aiSkillRequestSchema`); the client
 * only forwards the ones the caller set.
 */
export type AiSkillRunOptions = {
  /** Translate target — one of the five shipped locale codes (R25.19). */
  targetLocale?: string;
  tone?: string;
  style?: string;
  audience?: string;
  maxWords?: number;
};

export async function runAiText(
  prompt: string,
  locale: string = "en",
): Promise<{ text?: string; error?: string }> {
  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = (await response.json().catch(() => null)) as
      | { text?: string; error?: string }
      | null;
    if (!response.ok) {
      return {
        error: data?.error ?? `${t(locale, "aiRequestFailed")} (${response.status})`,
      };
    }
    return { text: data?.text ?? "" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t(locale, "aiRequestFailed"),
    };
  }
}

/** Run one of the editor's AI skills — prompts are resolved server-side. */
export async function runAiSkill(
  skillId: string,
  text: string,
  workspaceId?: string,
  options: AiSkillRunOptions = {},
  locale: string = "en",
): Promise<AiSkillResponse> {
  try {
    const response = await fetch("/api/ai/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skillId, text, workspaceId, ...options }),
    });
    const data = (await response.json().catch(() => null)) as
      | { text?: string; replacesSelection?: boolean; skill?: string; error?: string }
      | null;
    if (!response.ok) {
      return {
        error: data?.error ?? `${t(locale, "aiRequestFailed")} (${response.status})`,
      };
    }
    return {
      text: data?.text ?? "",
      replacesSelection: Boolean(data?.replacesSelection),
      skill: data?.skill ?? skillId,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t(locale, "aiRequestFailed"),
    };
  }
}
