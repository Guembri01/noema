/**
 * Ask-AI block engine — the pure, dependency-free layer behind the editor's
 * "Ask AI" block (spec `docs/specs/ai-surface.md` §1, matrix row "AI block",
 * requirements R25.2 "streaming parity for the selection surfaces" and R25.3
 * "Stop control").
 *
 * An `AskAiBlock` is a single question card dropped into a page: a prompt, the
 * action it runs (`ask` / `summarize`), where its answer goes (`answer` /
 * `insert` / `replace`), whether it is grounded in the page, an optional pinned
 * model, an optional reference to the page context the answer is grounded in,
 * the last answer (or error) and a status. This module owns every decision that
 * has to be provable without a provider — parsing the block from untrusted
 * stored JSON, validating it against a model allowlist and a prompt cap,
 * building the deterministic request, folding answer/error transitions, and
 * detecting that the page context changed since the answer was produced
 * (staleness, by content hash) — mirroring the contract of `ai-autofill.ts` /
 * `ai-context.ts`.
 *
 * Design rules (same contract as the other `src/lib` helpers):
 *
 * - **Parse is strict, everything else is fail-safe.** `parseAskAiBlock`
 *   reports structural problems (`ok: false`) for malformed JSON or a
 *   wrong-typed field, so an editor can show a real error; `validate…`,
 *   `build…`, `apply…` and `describe…` never throw.
 * - **Issues, not booleans.** `validateAskAiBlock` returns one structured
 *   issue per problem so a caller can surface them all at once.
 * - **Pure and immutable.** No function mutates its argument; equal inputs
 *   always yield byte-identical output. Time is injected (`now`), never read
 *   from a hidden clock.
 * - **Content-hash staleness.** The context baseline is a map of block-id →
 *   content hash; `isStale` compares it against the live page, so an answer is
 *   "stale" exactly when the blocks it was grounded in changed.
 */

/** The lifecycle state of an Ask-AI block. */
export type AskAiStatus = "idle" | "pending" | "done" | "error";

/** Every legal status, in lifecycle order. */
export const ASK_AI_STATUSES = ["idle", "pending", "done", "error"] as const;

/**
 * What the block asks the provider to do — persisted as the `mode` node attr so
 * a reloaded page runs the same action the author chose.
 */
export type AskAiMode = "ask" | "summarize";

/** Every legal request mode. */
export const ASK_AI_MODES = ["ask", "summarize"] as const;

/**
 * What happens to a successful answer — persisted as `output`. `answer` keeps
 * it in the card, `insert` writes it below the block, `replace` replaces the
 * block with it.
 */
export type AskAiOutput = "answer" | "insert" | "replace";

/** Every legal answer destination. */
export const ASK_AI_OUTPUTS = ["answer", "insert", "replace"] as const;

/**
 * Where an ask request is grounded. `page` sends this page's content (derived
 * server-side from the page the caller may read); `none` asks the bare prompt.
 */
export type AskAiSource = "page" | "none";

/** Every legal grounding selector. */
export const ASK_AI_SOURCES = ["page", "none"] as const;

/** The default prompt a summarize block runs when the author wrote none. */
export const ASK_AI_SUMMARIZE_PROMPT = "Summarize this page";

/** A single page block offered to the block as grounding context. */
export type AskAiContextBlock = {
  id: string;
  content: string;
};

/** The live page the block is embedded in, as handed to `isStale`/`buildAskAiRequest`. */
export type AskAiPageContext = {
  pageId?: string;
  blocks?: readonly AskAiContextBlock[];
};

/**
 * The grounding an answer is based on. `blockIds` selects which page blocks
 * matter (empty/absent means "the whole page"); `maxTokens` caps how much of
 * that context is sent; `hashes` is the baseline of block-id → content hash
 * captured by `refreshContext`, which `isStale` compares against the live page.
 */
export type AskAiContext = {
  pageId?: string;
  blockIds?: string[];
  maxTokens?: number;
  hashes?: Record<string, string>;
};

/** A persisted Ask-AI block (`Page.block` JSON, an editor node attribute). */
export type AskAiBlock = {
  id: string;
  prompt: string;
  /** The action the block runs; asks a custom prompt when omitted. */
  mode?: AskAiMode;
  /** Where a successful answer goes; the card when omitted. */
  output?: AskAiOutput;
  /** What the ask prompt is grounded in; this page when omitted. */
  source?: AskAiSource;
  /** Pinned model id; the workspace default is used when omitted. */
  model?: string;
  context?: AskAiContext;
  /** The last successful answer. */
  answer?: string;
  status: AskAiStatus;
  /** ISO-8601 instant of the last change. */
  updatedAt: string;
  /**
   * Whether the answer is known to be outdated (the referenced blocks changed
   * since it was produced). Set by `refreshContext`, cleared by `applyAnswer`.
   */
  stale?: boolean;
  /** The last failure message, when `status` is `"error"`. */
  error?: string;
};

/** Options accepted by `buildAskAiRequest`. */
export type AskAiRequestOptions = {
  pageContext?: AskAiPageContext;
  /** Injected capture instant; when present it is stamped into the request. */
  now?: string | Date;
};

/** A ready-to-send request: a system instruction, the user turn and sampling. */
export type AskAiRequest = {
  system: string;
  user: string;
  params: { temperature: number; maxTokens: number };
};

/** The result of a strict structural parse. */
export type AskAiParseResult =
  | { ok: true; block: AskAiBlock }
  | { ok: false; error: string };

/** One problem `validateAskAiBlock` can report. */
export type AskAiIssueCode =
  | "EMPTY_PROMPT"
  | "PROMPT_TOO_LONG"
  | "MODEL_NOT_ALLOWED"
  | "INVALID_STATUS"
  | "INVALID_MAX_TOKENS"
  | "INVALID_MODE"
  | "INVALID_OUTPUT"
  | "INVALID_SOURCE"
  | "SUMMARIZE_NEEDS_PAGE";

/** One problem with an Ask-AI block. */
export type AskAiIssue = {
  code: AskAiIssueCode;
  message: string;
};

/** Bounds `validateAskAiBlock` checks against. */
export type AskAiValidateOptions = {
  /** When given, a pinned `model` must be a member. */
  modelAllowlist?: readonly string[];
  /** When given, the prompt must be at most this many characters. */
  maxPromptChars?: number;
};

/** Spec estimate: one token ≈ four characters (`ai-context.ts` heuristic). */
export const CHARS_PER_TOKEN = 4;

/** Context token budget used when a block does not set `context.maxTokens`. */
export const DEFAULT_CONTEXT_MAX_TOKENS = 800;

/** Default sampling parameters for an Ask-AI completion. */
export const ASK_AI_DEFAULT_PARAMS: { temperature: number; maxTokens: number } = {
  temperature: 0.4,
  maxTokens: 512,
};

/** Character cap applied when an answer's context is elided in `describeAskAi`. */
const DESCRIBE_PROMPT_LIMIT = 60;

/** Suggested prompts offered when an Ask-AI block is empty. */
export const PLACEHOLDER_PROMPTS: readonly string[] = [
  "Summarize this page",
  "List the open questions on this page",
  "Extract action items with owners",
  "Explain this page for a newcomer",
  "Draft a short update based on this page",
];

/** The system instruction every Ask-AI request shares. */
const SYSTEM_PROMPT = [
  "You answer a question about a single page of a notes workspace.",
  "Use only the page context provided; never invent notes, people, dates or numbers.",
  "Reply in GitHub-flavoured Markdown and answer first — the opening sentence is the answer.",
  "Keep the reply under 160 words unless the question asks for detail.",
].join(" ");

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite, non-negative whole number of tokens, or `undefined`. */
function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * FNV-1a (32-bit) over the UTF-8 bytes of `text`, as eight lowercase hex
 * characters. Tiny, dependency-free and deterministic (same input → same hash
 * on every platform), and it spreads short similar strings far better than a
 * length/char sum — enough to detect that a referenced block changed.
 */
export function hashContent(text: string): string {
  const bytes = new TextEncoder().encode(typeof text === "string" ? text : "");
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** An ISO-8601 instant from an injected value; falls back to now when invalid. */
function toIso(value: string | Date | undefined): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return new Date().toISOString();
}

/** Trim, drop blanks and dedupe, preserving first order. */
function normalizeIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

/** Keep only `string → string` entries, returning `undefined` for none. */
function normalizeHashes(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() !== "" && typeof entry === "string") out[key.trim()] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a raw block into the canonical shape, reporting structural problems.
 * Accepts an object or a JSON string. The `id` must be a non-empty string; the
 * prompt/answer/model are strings; `status` must be a legal value (defaults to
 * `"idle"`); `updatedAt` is a string (defaults to `""`); and `context` may carry
 * `pageId`, `blockIds`, `maxTokens` and `hashes`. Wrong-typed fields and
 * malformed JSON return `ok: false` (never a throw). Out-of-range numeric
 * bounds are *not* rejected here — `validateAskAiBlock` owns those.
 */
export function parseAskAiBlock(raw: unknown): AskAiParseResult {
  let source: unknown;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Ask-AI block is not valid JSON." };
    }
  } else {
    source = raw;
  }

  if (!isRecord(source)) {
    return { ok: false, error: "Ask-AI block must be an object." };
  }

  const id = source.id;
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, error: "ID must be a non-empty string." };
  }

  const prompt = source.prompt;
  if (prompt !== undefined && prompt !== null && typeof prompt !== "string") {
    return { ok: false, error: "prompt must be a string." };
  }

  const model = source.model;
  if (model !== undefined && model !== null && typeof model !== "string") {
    return { ok: false, error: "model must be a string." };
  }

  const answer = source.answer;
  if (answer !== undefined && answer !== null && typeof answer !== "string") {
    return { ok: false, error: "answer must be a string." };
  }

  const updatedAt = source.updatedAt;
  if (updatedAt !== undefined && updatedAt !== null && typeof updatedAt !== "string") {
    return { ok: false, error: "updatedAt must be a string." };
  }

  const status = source.status;
  if (status !== undefined && status !== null) {
    if (typeof status !== "string" || !(ASK_AI_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, error: "status must be idle, pending, done or error." };
    }
  }

  const mode = source.mode;
  if (mode !== undefined && mode !== null) {
    if (typeof mode !== "string" || !(ASK_AI_MODES as readonly string[]).includes(mode)) {
      return { ok: false, error: "mode must be ask or summarize." };
    }
  }

  const output = source.output;
  if (output !== undefined && output !== null) {
    if (typeof output !== "string" || !(ASK_AI_OUTPUTS as readonly string[]).includes(output)) {
      return { ok: false, error: "output must be answer, insert or replace." };
    }
  }

  const askSource = source.source;
  if (askSource !== undefined && askSource !== null) {
    if (typeof askSource !== "string" || !(ASK_AI_SOURCES as readonly string[]).includes(askSource)) {
      return { ok: false, error: "source must be page or none." };
    }
  }

  const context = parseContext(source.context);
  if (context === false) {
    return { ok: false, error: "context must be an object with pageId/blockIds/maxTokens/hashes." };
  }

  const block: AskAiBlock = {
    id: id.trim(),
    prompt: typeof prompt === "string" ? prompt.trim() : "",
    status: (typeof status === "string" ? status : "idle") as AskAiStatus,
    updatedAt: typeof updatedAt === "string" ? updatedAt : "",
  };
  if (typeof mode === "string") block.mode = mode as AskAiMode;
  if (typeof output === "string") block.output = output as AskAiOutput;
  if (typeof askSource === "string") block.source = askSource as AskAiSource;
  const trimmedModel = typeof model === "string" ? model.trim() : "";
  if (trimmedModel !== "") block.model = trimmedModel;
  if (typeof answer === "string") block.answer = answer;
  if (context) block.context = context;

  return { ok: true, block };
}

/** Parse the optional context, `undefined` when absent and `false` on a type error. */
function parseContext(raw: unknown): AskAiContext | undefined | false {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) return false;

  const context: AskAiContext = {};

  const pageId = raw.pageId;
  if (pageId !== undefined && pageId !== null) {
    if (typeof pageId !== "string") return false;
    if (pageId.trim() !== "") context.pageId = pageId.trim();
  }

  const blockIds = raw.blockIds;
  if (blockIds !== undefined && blockIds !== null) {
    if (!Array.isArray(blockIds) || blockIds.some((entry) => typeof entry !== "string")) {
      return false;
    }
    const ids = normalizeIdList(blockIds);
    if (ids) context.blockIds = ids;
  }

  const maxTokens = raw.maxTokens;
  if (maxTokens !== undefined && maxTokens !== null) {
    if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) return false;
    context.maxTokens = maxTokens;
  }

  const hashes = raw.hashes;
  if (hashes !== undefined && hashes !== null) {
    if (!isRecord(hashes) || Object.values(hashes).some((entry) => typeof entry !== "string")) {
      return false;
    }
    const normalized = normalizeHashes(hashes);
    if (normalized) context.hashes = normalized;
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * Validate an Ask-AI block, returning one issue per problem and never throwing.
 * Checks that the prompt is a non-empty string within `maxPromptChars` (when a
 * cap is given), that a pinned `model` is in `modelAllowlist` (when a list is
 * given), and that `status` and `context.maxTokens` are well-formed.
 */
export function validateAskAiBlock(
  block: unknown,
  options: AskAiValidateOptions = {},
): AskAiIssue[] {
  const issues: AskAiIssue[] = [];
  try {
    const record = isRecord(block) ? block : {};

    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (prompt === "") {
      issues.push({ code: "EMPTY_PROMPT", message: "Ask-AI needs a prompt." });
    } else if (
      typeof options.maxPromptChars === "number" &&
      Number.isFinite(options.maxPromptChars) &&
      prompt.length > options.maxPromptChars
    ) {
      issues.push({
        code: "PROMPT_TOO_LONG",
        message: `Prompt is limited to ${options.maxPromptChars} characters.`,
      });
    }

    const allowlist = options.modelAllowlist;
    const model = typeof record.model === "string" ? record.model.trim() : "";
    if (Array.isArray(allowlist) && model !== "" && !allowlist.includes(model)) {
      issues.push({
        code: "MODEL_NOT_ALLOWED",
        message: `Model "${model}" is not available in this workspace.`,
      });
    }

    const status = record.status;
    if (
      status !== undefined &&
      (typeof status !== "string" || !(ASK_AI_STATUSES as readonly string[]).includes(status))
    ) {
      issues.push({
        code: "INVALID_STATUS",
        message: "Status must be idle, pending, done or error.",
      });
    }

    const mode = record.mode;
    if (
      mode !== undefined &&
      mode !== null &&
      (typeof mode !== "string" || !(ASK_AI_MODES as readonly string[]).includes(mode))
    ) {
      issues.push({
        code: "INVALID_MODE",
        message: "Action must be ask or summarize.",
      });
    }

    const output = record.output;
    if (
      output !== undefined &&
      output !== null &&
      (typeof output !== "string" || !(ASK_AI_OUTPUTS as readonly string[]).includes(output))
    ) {
      issues.push({
        code: "INVALID_OUTPUT",
        message: "Output must be answer, insert or replace.",
      });
    }

    const source = record.source;
    if (
      source !== undefined &&
      source !== null &&
      (typeof source !== "string" || !(ASK_AI_SOURCES as readonly string[]).includes(source))
    ) {
      issues.push({
        code: "INVALID_SOURCE",
        message: "Context source must be page or none.",
      });
    } else if (mode === "summarize" && source === "none") {
      // A summary with no page to summarize has nothing to run on; refusing it
      // up front is more honest than a provider error after the request.
      issues.push({
        code: "SUMMARIZE_NEEDS_PAGE",
        message: "Summarizing needs this page as context.",
      });
    }

    const context = record.context;
    if (isRecord(context) && context.maxTokens !== undefined && context.maxTokens !== null) {
      const tokens = context.maxTokens;
      if (
        typeof tokens !== "number" ||
        !Number.isFinite(tokens) ||
        !Number.isInteger(tokens) ||
        tokens < 1
      ) {
        issues.push({
          code: "INVALID_MAX_TOKENS",
          message: "Context maxTokens must be a positive whole number.",
        });
      }
    }
  } catch {
    // Fail-safe: exotic input must never break the caller.
    return issues;
  }
  return issues;
}

/** The blocks a request may draw on: the referenced subset, or the whole page. */
function selectBlocks(
  block: AskAiBlock,
  pageContext: AskAiPageContext | undefined,
): AskAiContextBlock[] {
  const available = Array.isArray(pageContext?.blocks) ? pageContext.blocks : [];
  const wanted = block.context?.blockIds;
  const read = (entry: AskAiContextBlock): AskAiContextBlock => ({
    id: entry.id,
    content: typeof entry.content === "string" ? entry.content : "",
  });
  if (Array.isArray(wanted) && wanted.length > 0) {
    const byId = new Map(available.map((entry) => [entry.id, entry]));
    const out: AskAiContextBlock[] = [];
    for (const id of wanted) {
      const found = byId.get(id);
      if (found) out.push(read(found));
    }
    return out;
  }
  return available.map(read);
}

/** The content-hash baseline for a set of blocks. */
function hashesOf(blocks: readonly AskAiContextBlock[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of blocks) hashes[entry.id] = hashContent(entry.content);
  return hashes;
}

/** Whether two id → hash maps differ (including added or removed ids). */
function hashesDiffer(
  baseline: Record<string, string> | undefined,
  current: Record<string, string>,
): boolean {
  if (!baseline) return false;
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const key of keys) {
    if (baseline[key] !== current[key]) return true;
  }
  return false;
}

/** Estimated token count of `text` using the `chars / 4` heuristic. */
function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The longest prefix of `text` that fits `maxChars` on a word boundary, with a
 * trailing ellipsis when it was shortened. `""` for an empty budget.
 */
function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const boundary = head.replace(/\s+\S*$/, "");
  const kept = boundary.length > 0 ? boundary : head;
  return `${kept.trimEnd()}…`;
}

/**
 * Fit the selected blocks into `maxTokens`, keeping whole blocks in order and
 * truncating the one that only partly fits (dropping the rest). Returns the
 * rendered context and whether it was shortened.
 */
function fitBlocks(
  blocks: readonly AskAiContextBlock[],
  maxTokens: number,
): { text: string; truncated: boolean } {
  const budget =
    typeof maxTokens === "number" && Number.isFinite(maxTokens)
      ? Math.max(0, Math.floor(maxTokens))
      : 0;
  const separator = "\n\n";
  const separatorTokens = estimateTokens(separator);
  const parts: string[] = [];
  let remaining = budget;
  let truncated = false;

  for (const entry of blocks) {
    const content = entry.content.trim();
    if (content === "") continue;
    const sep = parts.length > 0 ? separatorTokens : 0;
    const cost = estimateTokens(content);
    if (cost + sep <= remaining) {
      parts.push(content);
      remaining -= cost + sep;
      continue;
    }
    const roomChars = Math.max(0, remaining * CHARS_PER_TOKEN - (parts.length > 0 ? separator.length : 0));
    const shortened = truncateChars(content, roomChars);
    if (shortened.length > 0) {
      parts.push(shortened);
      truncated = true;
    }
    break;
  }

  return { text: parts.join(separator), truncated };
}

/**
 * Build a deterministic `{system, user, params}` request. The user turn is
 * `Question: <prompt>` followed by the page context — the referenced blocks
 * (or the whole page) rendered in order and truncated to
 * `context.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS`. When `now` is supplied it
 * is stamped into the context header, so the same inputs always produce the
 * same request and no hidden clock is read. The completion `params` are fixed
 * and independent of the context budget.
 */
export function buildAskAiRequest(
  block: AskAiBlock,
  options: AskAiRequestOptions = {},
): AskAiRequest {
  const prompt = typeof block?.prompt === "string" ? block.prompt.trim() : "";
  const selected = selectBlocks(block, options.pageContext);
  const maxTokens =
    typeof block?.context?.maxTokens === "number"
      ? block.context.maxTokens
      : DEFAULT_CONTEXT_MAX_TOKENS;
  const fitted = fitBlocks(selected, maxTokens);

  const lines: string[] = [`Question: ${prompt}`];
  if (fitted.text.length > 0) {
    const pageId = block?.context?.pageId ?? options.pageContext?.pageId;
    const captured =
      options.now !== undefined ? ` (captured ${toIso(options.now)})` : "";
    const label = pageId ? `Page context for ${pageId}${captured}:` : `Page context${captured}:`;
    lines.push(`${label}\n${fitted.text}`);
  }

  return {
    system: SYSTEM_PROMPT,
    user: lines.join("\n\n"),
    params: { ...ASK_AI_DEFAULT_PARAMS },
  };
}

/** Fold an answer into the block: `status: "done"`, a fresh timestamp, no error. */
export function applyAnswer(
  block: AskAiBlock,
  options: { answer: string; now?: string | Date },
): AskAiBlock {
  const answer = typeof options?.answer === "string" ? options.answer : "";
  const next: AskAiBlock = {
    ...block,
    status: "done",
    updatedAt: toIso(options?.now),
    stale: false,
  };
  if (answer.trim() === "") {
    next.status = "idle";
    delete next.answer;
  } else {
    next.answer = answer;
  }
  delete next.error;
  return next;
}

/** Fold a failure into the block: `status: "error"` with the message kept. */
export function applyError(
  block: AskAiBlock,
  options: { message: string; now?: string | Date },
): AskAiBlock {
  const message = typeof options?.message === "string" ? options.message.trim() : "";
  const next: AskAiBlock = {
    ...block,
    status: "error",
    error: message,
    updatedAt: toIso(options?.now),
  };
  return next;
}

/**
 * Re-capture the context baseline from the live page. The new baseline is the
 * current content hashes of the referenced blocks (updated `pageId` when the
 * page supplies one); `stale` becomes `true` when a previous baseline existed
 * and the content changed, so the UI can flag that the answer may be outdated.
 * Pure: the input block is never mutated.
 */
export function refreshContext(
  block: AskAiBlock,
  pageContext: AskAiPageContext | undefined,
): AskAiBlock {
  const previous = block?.context ?? {};
  const selected = selectBlocks(block, pageContext);
  const current = hashesOf(selected);
  const hadBaseline = previous.hashes !== undefined && Object.keys(previous.hashes).length > 0;
  const changed = hadBaseline && hashesDiffer(previous.hashes, current);

  const context: AskAiContext = { ...previous, hashes: current };
  if (pageContext?.pageId && pageContext.pageId.trim() !== "") {
    context.pageId = pageContext.pageId.trim();
  }

  return {
    ...block,
    context,
    stale: hadBaseline ? changed : block?.stale === true,
  };
}

/**
 * Whether the answer is stale relative to `pageContext`: `true` exactly when a
 * recorded baseline exists and the referenced blocks' current hashes differ
 * (a changed, added or removed block). With no baseline there is nothing to
 * compare against, so the block is reported fresh.
 */
export function isStale(block: AskAiBlock, pageContext: AskAiPageContext | undefined): boolean {
  const baseline = block?.context?.hashes;
  if (!baseline || Object.keys(baseline).length === 0) return false;
  return hashesDiffer(baseline, hashesOf(selectBlocks(block, pageContext)));
}

/**
 * A one-line, human-readable description for menus and tooltips, e.g.
 * `Ask AI "Summarize this page" — pending · gpt-4o · 2 blocks · stale` or, on
 * failure, `… — error: Network died`. An over-long prompt is elided with an
 * ellipsis. Never throws; malformed input reads as `""`.
 */
export function describeAskAi(block: AskAiBlock): string {
  if (!block || typeof block !== "object") return "";
  const prompt = typeof block.prompt === "string" ? block.prompt.trim() : "";
  const shown =
    prompt === ""
      ? "(no prompt)"
      : prompt.length > DESCRIBE_PROMPT_LIMIT
        ? `${prompt.slice(0, DESCRIBE_PROMPT_LIMIT)}…`
        : prompt;
  const status: AskAiStatus = (ASK_AI_STATUSES as readonly string[]).includes(block.status)
    ? block.status
    : "idle";

  const parts = [`Ask AI "${shown}"`, status];
  if (typeof block.model === "string" && block.model.trim() !== "") parts.push(block.model.trim());
  const blockCount = Array.isArray(block.context?.blockIds) ? block.context.blockIds.length : 0;
  if (blockCount > 0) parts.push(`${blockCount} block${blockCount === 1 ? "" : "s"}`);
  if (block.stale === true) parts.push("stale");
  const description = parts.join(" · ");
  const error = typeof block.error === "string" ? block.error.trim() : "";
  return error !== "" ? `${description} — error: ${error}` : description;
}

// Re-export the token estimate so callers can measure a built request without
// importing the heavier `ai-context` module.
export { estimateTokens as estimateAskAiTokens };
