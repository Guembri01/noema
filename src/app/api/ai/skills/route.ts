import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import {
  bodyReadError,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
} from "@/lib/body-limit";
import { AI_SKILLS, aiSkill, type AiSkillId } from "@/lib/ai-skills";
import {
  SKILL_CATALOG,
  SKILL_DEFAULT_PARAMS,
  buildContinuePrompt,
  buildExplainPrompt,
  buildSimplifyPrompt,
  buildSummarizePrompt,
  buildTranslatePrompt,
  chunkForSummarize,
  postProcess,
  truncateToBudget,
  type AiWritingKind,
  type PromptBuild,
  type SimplifyAudience,
  type SummarizeStyle,
  type WritingTone,
} from "@/lib/ai-writing";
import { isLocale } from "@/lib/i18n";
import {
  AI_NOT_CONFIGURED,
  chatComplete,
  resolveAiConfigForUser,
  type AiRuntimeConfig,
  type ChatResult,
} from "@/lib/ai-provider";
import { aiSkillRequestSchema } from "@/lib/validation";
import { redactSecrets } from "@/lib/error-reporting";

export const runtime = "nodejs";

/** Cap on the raw selection accepted from the client, in characters. */
const MAX_TEXT_CHARS = 8000;
/** Input tokens handed to a single writing call before it is truncated. */
const MAX_INPUT_TOKENS = 2000;
/** Tokens per map chunk for long-form summarization (map-reduce). */
const SUMMARIZE_CHUNK_TOKENS = 1200;

const SYSTEM =
  "You are a precise writing assistant embedded in a notes app. Reply with the transformed text only — no preamble, no quotes, no explanation.";

/** Standing instruction for the reduce step of chunked summarization. */
const REDUCE_SYSTEM =
  "You combine partial summaries faithfully and without commentary. Keep the original order and facts and add nothing new.";

const SUMMARIZE_STYLES: readonly SummarizeStyle[] = ["bullets", "paragraph", "outline"];
const WRITING_TONES: readonly WritingTone[] = ["neutral", "formal", "casual", "friendly"];
const SIMPLIFY_AUDIENCES: readonly SimplifyAudience[] = ["general", "beginner", "expert"];

type SkillBody = {
  skillId?: string;
  text?: string;
  workspaceId?: string | null;
  /** Optional per-request knobs for the writing skills. */
  targetLocale?: string;
  tone?: string;
  style?: string;
  audience?: string;
  maxWords?: number;
};

/** A resolved request: either a writing skill (builders) or an editor skill. */
type ResolvedSkill = {
  id: string;
  replacesSelection: boolean;
  /** Present for the five writing skills. */
  writing?: AiWritingKind;
  /** Present for the editor skills in `./ai-skills`. */
  prompt?: (text: string) => string;
};

/**
 * Resolve a requested id to a skill. The writing catalog (`./ai-writing`) is
 * checked first so `summarize` / `translate` / `explain` route through the
 * richer prompt builders; the editor registry keeps `improve` / `proofread` /
 * `reformat` / `shorten`.
 */
function resolveSkill(id: string | undefined): ResolvedSkill | undefined {
  const writing = SKILL_CATALOG.find((skill) => skill.id === id);
  if (writing) {
    return {
      id: writing.id,
      replacesSelection: writing.replacesSelection,
      writing: writing.id,
    };
  }
  const editor = aiSkill(id as AiSkillId);
  if (editor) {
    return { id: editor.id, replacesSelection: editor.replacesSelection, prompt: editor.prompt };
  }
  return undefined;
}

/** Keep only an allowed enum value, otherwise `undefined` (builder default). */
function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Build the prompt for a writing skill from the request's optional knobs. */
function buildWritingPrompt(kind: AiWritingKind, text: string, body: SkillBody): PromptBuild {
  const maxWords = typeof body.maxWords === "number" ? body.maxWords : undefined;
  const tone = pick(body.tone, WRITING_TONES);
  switch (kind) {
    case "summarize":
      return buildSummarizePrompt({ text, maxWords, style: pick(body.style, SUMMARIZE_STYLES) });
    case "translate":
      return buildTranslatePrompt({
        text,
        targetLocale:
          typeof body.targetLocale === "string" && isLocale(body.targetLocale)
            ? body.targetLocale
            : "en",
        tone,
      });
    case "continue":
      return buildContinuePrompt({ text, tone, maxWords });
    case "simplify":
      return buildSimplifyPrompt({ text, audience: pick(body.audience, SIMPLIFY_AUDIENCES) });
    case "explain":
      return buildExplainPrompt({ text });
  }
}

/**
 * Run a writing skill end-to-end: truncate the input to the call budget, then
 * either summarize in map-reduce chunks or make a single completion. Raw model
 * output is always run through `postProcess` so preambles, fences and labels
 * never reach the editor.
 */
async function runWritingSkill(
  kind: AiWritingKind,
  text: string,
  body: SkillBody,
  config: AiRuntimeConfig,
): Promise<ChatResult> {
  const budgeted = truncateToBudget(text, MAX_INPUT_TOKENS);

  if (kind === "summarize") {
    const plan = chunkForSummarize(budgeted, { maxTokens: SUMMARIZE_CHUNK_TOKENS });
    if (plan.chunks.length > 1) {
      const partials: string[] = [];
      for (const chunk of plan.chunks) {
        const build = buildWritingPrompt("summarize", chunk, body);
        const result = await chatComplete(
          {
            system: build.system,
            user: build.user,
            temperature: build.params.temperature,
            maxTokens: build.params.maxTokens,
          },
          config,
        );
        if (!result.ok) return result;
        partials.push(postProcess("summarize", result.text));
      }

      const reduceParams = SKILL_DEFAULT_PARAMS.summarize;
      const reduced = await chatComplete(
        {
          system: REDUCE_SYSTEM,
          user: `${plan.reducePrompt}\n\n${partials.join("\n\n")}`,
          temperature: reduceParams.temperature,
          maxTokens: reduceParams.maxTokens,
        },
        config,
      );
      if (!reduced.ok) return reduced;
      return { ok: true, text: postProcess("summarize", reduced.text) };
    }
  }

  const build = buildWritingPrompt(kind, budgeted, body);
  const request = {
    system: build.system,
    user: build.user,
    temperature: build.params.temperature,
    maxTokens: build.params.maxTokens,
  };
  const result = await chatComplete(request, config);
  if (!result.ok) return result;
  const cleaned = postProcess(kind, result.text);
  if (cleaned.trim() !== "") return { ok: true, text: cleaned };

  // A provider can occasionally answer with nothing. Retry once at a slightly
  // higher temperature before surfacing an error, so a blank reply never
  // silently reaches the editor as an empty result.
  const retry = await chatComplete({ ...request, temperature: Math.min(1, request.temperature + 0.2) }, config);
  if (!retry.ok) return retry;
  const retried = postProcess(kind, retry.text);
  if (retried.trim() !== "") return { ok: true, text: retried };

  return { ok: false, status: 502, error: "The model returned an empty reply. Please try again." };
}

/** The catalogue the UI/editors consume: editor skills plus the writing-only ids. */
function mergedCatalog(): { id: string; label: string; hint: string; replacesSelection: boolean }[] {
  const editorIds = new Set<string>(AI_SKILLS.map((skill) => skill.id));
  return [
    ...AI_SKILLS.map((skill) => ({
      id: skill.id,
      label: skill.label,
      hint: skill.hint,
      replacesSelection: skill.replacesSelection,
    })),
    ...SKILL_CATALOG.filter((skill) => !editorIds.has(skill.id)).map((skill) => ({
      id: skill.id,
      label: skill.label,
      hint: skill.hint,
      replacesSelection: skill.replacesSelection,
    })),
  ];
}

/**
 * List the available AI skills. The merged catalogue includes the writing
 * skills from `./ai-writing` (`continue`, `simplify`, …) that are not in the
 * editor registry, so a client can discover every id the POST handler accepts.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ skills: mergedCatalog() });
}

/**
 * Run one of the editor's AI skills over a text selection. The prompt wording
 * lives server-side — the editor registry (`src/lib/ai-skills.ts`) for the
 * proofreading skills and the writing builders (`src/lib/ai-writing.ts`) for
 * summarize / translate / continue / simplify / explain — so the toolbar, the
 * block menu and any future automation all behave identically.
 *
 * Body: { skillId, text, workspaceId?, targetLocale?, tone?, style?, audience?, maxWords? }
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "ai-skills", 30, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Invalid JSON body.");
  }
  const parsed = aiSkillRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body: SkillBody = parsed.data;

  const skill = resolveSkill(body.skillId);
  if (!skill) return NextResponse.json({ error: "Unknown skill." }, { status: 400 });

  const text = (body.text ?? "").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return NextResponse.json({ error: "text is required." }, { status: 400 });

  // The provider (endpoint + API key) belongs to the workspace it is stored
  // for, so it is only used when the caller has access to the workspace it
  // names; otherwise the environment defaults apply (audit B13).
  const config = await resolveAiConfigForUser(user.id, body.workspaceId);
  if (!config) {
    return NextResponse.json({ error: AI_NOT_CONFIGURED }, { status: 503 });
  }

  const result =
    skill.writing !== undefined
      ? await runWritingSkill(skill.writing, text, body, config)
      : await chatComplete(
          {
            system: SYSTEM,
            user: skill.prompt ? skill.prompt(text) : text,
            temperature: skill.replacesSelection ? 0.2 : 0.5,
          },
          config,
        );
  if (!result.ok) {
    // The provider already reduced its failure to a class (status + code); the
    // message is scrubbed once more so no credential-shaped string can leave
    // the server.
    const detail = redactSecrets(result.error);
    const error =
      typeof detail === "string" && detail !== "" ? detail : "AI request failed";
    return NextResponse.json({ error }, { status: result.status });
  }

  return NextResponse.json({
    skill: skill.id,
    replacesSelection: skill.replacesSelection,
    text: result.text,
  });
}
