/**
 * AI writing-skill prompt builders — spec `docs/specs/ai-surface.md` §14
 * (Summarization, Translation, Continue writing, Explain/Simplify).
 *
 * Every builder is a pure function: the same input always yields the same
 * `{ system, user, params }`. The wording lives here so the skills route, the
 * editor submenu and any future automation share one definition, mirroring the
 * registry shape in `./ai-skills` (`id` / `label` / `hint` /
 * `replacesSelection`). The translate builder takes the five shipped locales
 * (`./i18n.ts`) instead of the hardcoded English the old registry used.
 */

import { isLocale, type LocaleCode } from "./i18n";

export type AiWritingKind = "summarize" | "translate" | "continue" | "simplify" | "explain";

export type PromptParams = {
  /** Sampling temperature handed to the provider. */
  temperature: number;
  /** Maximum completion tokens. */
  maxTokens: number;
};

export type PromptBuild = {
  system: string;
  user: string;
  params: PromptParams;
};

export type SummarizeStyle = "bullets" | "paragraph" | "outline";
export type WritingTone = "neutral" | "formal" | "casual" | "friendly";
export type SimplifyAudience = "general" | "beginner" | "expert";

/** Spec O25.2 estimate: one token ≈ four characters. */
export const CHARS_PER_TOKEN = 4;

export const SUMMARIZE_DEFAULT_MAX_WORDS = 60;
export const CONTINUE_DEFAULT_MAX_WORDS = 120;

/** The default `{temperature, maxTokens}` per skill, reused by the catalog. */
export const SKILL_DEFAULT_PARAMS: Record<AiWritingKind, PromptParams> = {
  summarize: { temperature: 0.3, maxTokens: 400 },
  translate: { temperature: 0.2, maxTokens: 800 },
  continue: { temperature: 0.7, maxTokens: 400 },
  simplify: { temperature: 0.3, maxTokens: 500 },
  explain: { temperature: 0.4, maxTokens: 320 },
};

const MAX_TOKENS_CAP = 4096;

const BASE_SYSTEM =
  "You are Noema's writing assistant. Follow the instruction exactly and return only the requested output.";

const LOCALE_ENGLISH_NAMES: Record<LocaleCode, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  ar: "Arabic",
};

const SUMMARY_INSTRUCTIONS: Record<SummarizeStyle, (maxWords: number) => string> = {
  bullets: (maxWords) => `Summarize the text below as short bullet points (at most ${maxWords} words total).`,
  paragraph: (maxWords) => `Summarize the text below in one tight paragraph (at most ${maxWords} words).`,
  outline: (maxWords) =>
    `Summarize the text below as a short nested outline with headings (at most ${maxWords} words total).`,
};

/** Approximate token count of `text` (see `CHARS_PER_TOKEN`). */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Default params, with `maxTokens` allowed to grow (never shrink) for big inputs. */
function paramsFor(kind: AiWritingKind, requestedMaxTokens?: number): PromptParams {
  const base = SKILL_DEFAULT_PARAMS[kind];
  const maxTokens =
    requestedMaxTokens === undefined
      ? base.maxTokens
      : clamp(Math.max(base.maxTokens, Math.round(requestedMaxTokens)), 1, MAX_TOKENS_CAP);
  return { temperature: base.temperature, maxTokens };
}

/**
 * Cut `text` so it fits `maxTokens` (spec estimate), preferring the last word
 * boundary. Text already within budget is returned unchanged (no ellipsis).
 */
export function truncateToBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (text.length === 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;

  const maxChars = Math.max(1, maxTokens * CHARS_PER_TOKEN);
  const head = text.slice(0, maxChars);
  const boundary = head.replace(/\s+\S*$/, "");
  return `${boundary.length > 0 ? boundary : head}…`;
}

export function buildSummarizePrompt(input: {
  text: string;
  maxWords?: number;
  style?: SummarizeStyle;
}): PromptBuild {
  const maxWords = input.maxWords ?? SUMMARIZE_DEFAULT_MAX_WORDS;
  const style = input.style ?? "bullets";
  return {
    system: `${BASE_SYSTEM} You summarize documents faithfully and without commentary.`,
    user: `${SUMMARY_INSTRUCTIONS[style](maxWords)}\n\n${input.text}`,
    params: paramsFor("summarize", Math.ceil(maxWords * 2)),
  };
}

export function buildTranslatePrompt(input: {
  text: string;
  targetLocale: LocaleCode;
  tone?: WritingTone;
}): PromptBuild {
  if (!isLocale(input.targetLocale)) {
    throw new Error(`Unsupported target locale: ${String(input.targetLocale)}`);
  }
  const tone = input.tone ?? "neutral";
  const name = LOCALE_ENGLISH_NAMES[input.targetLocale];
  return {
    system: `${BASE_SYSTEM} You are a professional translator.`,
    user:
      `Translate the text below into ${name} (${input.targetLocale}) with a ${tone} tone, ` +
      `preserving formatting. Return only the translation.\n\n${input.text}`,
    params: paramsFor("translate", estimateTokens(input.text) * 2 + 64),
  };
}

export function buildContinuePrompt(input: {
  text: string;
  tone?: WritingTone;
  maxWords?: number;
}): PromptBuild {
  const tone = input.tone ?? "neutral";
  const maxWords = input.maxWords ?? CONTINUE_DEFAULT_MAX_WORDS;
  return {
    system: `${BASE_SYSTEM} You continue a piece of writing in the author's own voice.`,
    user:
      `Continue the writing below in a ${tone} tone. Match the voice and formatting, write at ` +
      `most ${maxWords} additional words, and return only the continuation (do not repeat the ` +
      `original text).\n\n${input.text}`,
    params: paramsFor("continue", Math.ceil(maxWords * 2)),
  };
}

export function buildSimplifyPrompt(input: {
  text: string;
  audience?: SimplifyAudience;
}): PromptBuild {
  const audience = input.audience ?? "general";
  return {
    system: `${BASE_SYSTEM} You rewrite complex text so that anyone can understand it.`,
    user:
      `Simplify the text below for a ${audience} audience. Keep every fact, use short sentences ` +
      `and plain words, and return only the simplified text.\n\n${input.text}`,
    params: paramsFor("simplify", estimateTokens(input.text) + 64),
  };
}

export function buildExplainPrompt(input: { text: string }): PromptBuild {
  return {
    system: `${BASE_SYSTEM} You explain ideas in plain language.`,
    user:
      `Explain the text below in plain language for a newcomer. Keep it under 120 words and ` +
      `return only the explanation.\n\n${input.text}`,
    params: paramsFor("explain"),
  };
}

export type SummarizePlan = {
  /** Ordered, non-empty chunks that each fit the token budget. */
  chunks: string[];
  /** Prompt that combines the partial summaries; empty when a single chunk. */
  reducePrompt: string;
};

function splitOversizedUnit(unit: string, maxTokens: number): string[] {
  const maxChars = Math.max(1, maxTokens * CHARS_PER_TOKEN);
  const pieces: string[] = [];
  let rest = unit;
  while (estimateTokens(rest) > maxTokens) {
    const slice = rest.slice(0, maxChars);
    const boundary = slice.replace(/\s+\S*$/, "");
    const piece = boundary.length > 0 ? boundary : slice;
    pieces.push(piece.trim());
    rest = rest.slice(piece.length).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces.filter((piece) => piece.length > 0);
}

function splitSentences(block: string): string[] {
  const parts = block
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [block];
}

function buildReducePrompt(chunkCount: number): string {
  return (
    `You are given ${chunkCount} partial summaries of the same document, in order. Combine them ` +
    `into one coherent summary, keep the original order and facts, and add nothing new. Return ` +
    `only the final summary.`
  );
}

/**
 * Split `text` into ordered map-reduce chunks for summarization. Paragraph
 * boundaries are preferred; oversized paragraphs fall back to sentences and
 * then to a word-boundary hard cut, so no chunk exceeds the budget and no word
 * is split or lost.
 */
export function chunkForSummarize(text: string, options: { maxTokens: number }): SummarizePlan {
  const budget = Math.max(1, Math.floor(options.maxTokens));
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) return { chunks: [], reducePrompt: "" };

  const units: string[] = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;
    if (estimateTokens(trimmed) <= budget) {
      units.push(trimmed);
      continue;
    }
    for (const sentence of splitSentences(trimmed)) {
      if (estimateTokens(sentence) <= budget) units.push(sentence);
      else units.push(...splitOversizedUnit(sentence, budget));
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current.length > 0 ? `${current}\n\n${unit}` : unit;
    if (current.length > 0 && estimateTokens(candidate) > budget) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  return {
    chunks,
    reducePrompt: chunks.length > 1 ? buildReducePrompt(chunks.length) : "",
  };
}

const KIND_LABELS: Record<AiWritingKind, RegExp> = {
  summarize: /^(?:summary|tl;?dr)\s*:?\s*/i,
  translate: /^(?:translation|translated text)\s*:?\s*/i,
  continue: /^(?:continuation|continued)\s*:?\s*/i,
  simplify: /^(?:simplified(?: text)?)\s*:?\s*/i,
  explain: /^(?:explanation)\s*:?\s*/i,
};

const PREAMBLE_PATTERNS: RegExp[] = [
  /^(?:sure|certainly|of course|absolutely|no problem)\b[^\n]*:\s*/i,
  /^(?:here(?:'s| is)|this is|below is)\b[^\n]*:\s*/i,
];

/**
 * Clean raw model output for a given skill: strip a wrapping code fence,
 * conversational preambles, a leading kind label and (for translations)
 * surrounding quotes. Clean text is returned unchanged.
 */
export function postProcess(kind: AiWritingKind, raw: string): string {
  let out = raw.trim();

  const fenced = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) out = fenced[1].trim();

  let previous = "";
  while (previous !== out) {
    previous = out;
    for (const pattern of PREAMBLE_PATTERNS) {
      out = out.replace(pattern, "").trim();
    }
    out = out.replace(KIND_LABELS[kind], "").trim();
  }

  if (kind === "translate") {
    out = out.replace(/^["“«]([\s\S]*)["”»]$/, "$1").trim();
  }

  return out;
}

/** Registry shape shared with `./ai-skills`, extended with default params. */
export type AiWritingSkill = {
  id: AiWritingKind;
  label: string;
  hint: string;
  /** Rewriting skills replace the selection; the others append to it. */
  replacesSelection: boolean;
  params: PromptParams;
};

export const SKILL_CATALOG: AiWritingSkill[] = [
  {
    id: "summarize",
    label: "Summarize",
    hint: "Key points only",
    replacesSelection: false,
    params: SKILL_DEFAULT_PARAMS.summarize,
  },
  {
    id: "translate",
    label: "Translate",
    hint: "Translate to a shipped locale",
    replacesSelection: true,
    params: SKILL_DEFAULT_PARAMS.translate,
  },
  {
    id: "continue",
    label: "Continue writing",
    hint: "Keep the draft going",
    replacesSelection: false,
    params: SKILL_DEFAULT_PARAMS.continue,
  },
  {
    id: "simplify",
    label: "Simplify",
    hint: "Plain-language rewrite",
    replacesSelection: true,
    params: SKILL_DEFAULT_PARAMS.simplify,
  },
  {
    id: "explain",
    label: "Explain",
    hint: "Plain-language explanation",
    replacesSelection: false,
    params: SKILL_DEFAULT_PARAMS.explain,
  },
];
