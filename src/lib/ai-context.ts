/**
 * AI context budgeting — the pure, deterministic sizing layer behind every
 * prompt the assistant is handed.
 *
 * Model context windows are finite and expensive, so a prompt is really a
 * knapsack: a system instruction, a set of source notes and the user's question
 * all compete for a fixed token budget. Raw characters are the only thing we
 * can measure without a tokenizer, so this module uses the ubiquitous
 * `chars / 4` heuristic (code-point aware, so emoji and astral characters count
 * once) and owns every decision that has to be provable without a provider:
 *
 *  - `estimateTokens` — the heuristic token count of a string;
 *  - `truncateToTokens` — the longest word-boundary prefix that still fits;
 *  - `fitToBudget` — keep the highest-priority chunks that fit, truncate the
 *    one that only partly fits and drop the rest, always in stable input order;
 *  - `assembleContext` — order `system → docs → question`, fill the budget the
 *    same way and report what was dropped.
 *
 * Everything is pure: no function mutates its arguments, none reads a clock or
 * random source, and equal inputs always yield byte-identical output.
 */

/** Approximate characters per token used by the sizing heuristic. */
export const CHARS_PER_TOKEN = 4;

/** Separator placed between top-level prompt sections. */
const SECTION_SEPARATOR = "\n\n";

/** A priority-ordered piece of context handed to `fitToBudget`. */
export type ContextChunk = {
  id: string;
  text: string;
};

/** Options accepted by `fitToBudget`. */
export type FitOptions = {
  /** Total token budget the kept chunks together must not exceed. */
  maxTokens: number;
  /**
   * Importance of a chunk (higher wins). Defaults to `0`, so ties keep input
   * order. Must be a finite number; non-finite values are treated as `0`.
   */
  priorityOf?: (chunk: ContextChunk, index: number) => number;
};

/** A chunk after budgeting: its final text and measured cost. */
export type FittedChunk = {
  id: string;
  text: string;
  tokens: number;
  /** True when the chunk was shortened to make it fit. */
  truncated: boolean;
};

/** Result of fitting chunks into a budget. */
export type FitResult = {
  /** Kept chunks in original input order. */
  kept: FittedChunk[];
  /** Chunks that did not fit, in original input order (full text). */
  dropped: FittedChunk[];
  /** Sum of the kept chunks' `tokens`. */
  usedTokens: number;
};

/** One source document offered to `assembleContext`. */
export type ContextDoc = {
  id: string;
  /** Optional heading rendered above the body. */
  title?: string;
  text: string;
  /** Higher is kept first; ties keep input order. Defaults to `0`. */
  priority?: number;
};

/** Why a document never made it into the assembled prompt. */
export type DropReason = "empty" | "budget";

/** A document left out of the assembled prompt. */
export type DroppedDoc = {
  id: string;
  /** Token cost of the document's full rendered body. */
  tokens: number;
  reason: DropReason;
};

/** Input accepted by `assembleContext`. */
export type AssembleInput = {
  /** Standing instruction, always kept. */
  system?: string;
  /** Source documents, kept by priority within the budget. */
  docs: readonly ContextDoc[];
  /** The user's question, always kept and rendered last. */
  question: string;
  /** Total token budget for the assembled prompt. */
  maxTokens: number;
};

/** Result of `assembleContext`. */
export type AssembledContext = {
  /** The ordered prompt, ready to send. */
  prompt: string;
  /** `estimateTokens(prompt)`. */
  usedTokens: number;
  /** Documents left out, in input order. */
  dropped: DroppedDoc[];
};

/** Clamp an arbitrary value to a non-negative integer token budget. */
function normalizeBudget(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** A string's code points (astral characters count once, unlike `.length`). */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * Estimated token count of `text` using the `chars / 4` heuristic. Counting is
 * code-point aware, so a surrogate pair (emoji, rare CJK…) costs one character
 * rather than two, and the result is `0` for empty or non-string input.
 */
export function estimateTokens(text: string): number {
  const input = typeof text === "string" ? text : "";
  const length = codePoints(input).length;
  return length === 0 ? 0 : Math.ceil(length / CHARS_PER_TOKEN);
}

/**
 * The longest prefix of `text` that fits in `maxChars` code points and does not
 * end in the middle of a word. When the whole text fits it is returned as-is.
 */
function truncateToChars(text: string, maxChars: number): string {
  const chars = codePoints(text);
  if (maxChars <= 0) return "";
  if (chars.length <= maxChars) return text;
  const prefix = chars.slice(0, maxChars).join("");
  const next = chars[maxChars];
  // Cut exactly before a space, or at the end of the text: already a boundary.
  if (next === undefined || /\s/.test(next)) return prefix.replace(/\s+$/, "");
  // Mid-word: retreat to the last space so no word is sliced in half.
  const lastSpace = prefix.search(/\s\S*$/);
  return lastSpace > 0 ? prefix.slice(0, lastSpace) : prefix.replace(/\s+$/, "");
}

/**
 * Truncate `text` to at most `maxTokens` estimated tokens, cutting on a word
 * boundary where one exists. Returns `""` for an empty budget and the input
 * unchanged when it already fits. Never splits a surrogate pair.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const input = typeof text === "string" ? text : "";
  const budget = normalizeBudget(maxTokens);
  if (budget <= 0 || input.length === 0) return "";
  if (estimateTokens(input) <= budget) return input;
  return truncateToChars(input, budget * CHARS_PER_TOKEN);
}

/** Importance of a chunk, normalised to a finite number (default `0`). */
function priorityOfChunk(
  options: FitOptions | undefined,
  chunk: ContextChunk,
  index: number,
): number {
  const fn = options?.priorityOf;
  if (typeof fn !== "function") return 0;
  const value = fn(chunk, index);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Fit `chunks` into `maxTokens` by keeping the highest-priority chunks first.
 * A chunk that only partly fits is truncated (word-boundary) so it still
 * contributes; a chunk that cannot contribute anything is dropped. Output is
 * returned in the original input order regardless of priority, so callers get a
 * stable layout and a deterministic `dropped` report.
 */
export function fitToBudget(
  chunks: readonly ContextChunk[],
  options: FitOptions,
): FitResult {
  const list = Array.isArray(chunks) ? chunks : [];
  const maxTokens = normalizeBudget(options?.maxTokens);

  const order = list.map((_, index) => index);
  order.sort((a, b) => {
    const pa = priorityOfChunk(options, list[a], a);
    const pb = priorityOfChunk(options, list[b], b);
    return pa === pb ? a - b : pb - pa;
  });

  const decisions: (FittedChunk | null)[] = list.map(() => null);
  const droppedIndexes = new Set<number>();
  let remaining = maxTokens;

  for (const index of order) {
    const chunk = list[index];
    const id = chunk && typeof chunk.id === "string" ? chunk.id : "";
    const text = chunk && typeof chunk.text === "string" ? chunk.text : "";
    const full = estimateTokens(text);
    if (full <= remaining) {
      decisions[index] = { id, text, tokens: full, truncated: false };
      remaining -= full;
      continue;
    }
    const shortened = remaining > 0 ? truncateToTokens(text, remaining) : "";
    if (shortened.length > 0) {
      const tokens = estimateTokens(shortened);
      decisions[index] = { id, text: shortened, tokens, truncated: true };
      remaining -= tokens;
    } else {
      decisions[index] = { id, text, tokens: full, truncated: false };
      droppedIndexes.add(index);
    }
  }

  const kept: FittedChunk[] = [];
  const dropped: FittedChunk[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const decision = decisions[index];
    if (!decision) continue;
    if (droppedIndexes.has(index)) dropped.push(decision);
    else kept.push(decision);
  }

  return {
    kept,
    dropped,
    usedTokens: kept.reduce((sum, chunk) => sum + chunk.tokens, 0),
  };
}

/** Render a document section: `# Title` heading (when given) above the body. */
function renderDoc(doc: ContextDoc | undefined): string {
  const title = doc && typeof doc.title === "string" ? doc.title.trim() : "";
  const text = doc && typeof doc.text === "string" ? doc.text : "";
  if (text.length === 0) return title.length > 0 ? `# ${title}` : "";
  return title.length > 0 ? `# ${title}\n${text}` : text;
}

/** Number of code points in a string (astral-safe). */
function charLength(text: string): number {
  return codePoints(text).length;
}

/**
 * Assemble a final prompt from an optional `system` instruction, some `docs`
 * and the `question`. The layout is fixed — `system`, then the kept documents
 * in their original order, then `Question: …` — while the budget is spent by
 * priority: documents that fit are included whole, the first that only partly
 * fits is truncated, and the rest are dropped with a reason.
 *
 * `system` and `question` are mandatory and always survive, even if together
 * they already exceed `maxTokens`; in that case every document is dropped.
 */
export function assembleContext(input: AssembleInput): AssembledContext {
  const system = input && typeof input.system === "string" ? input.system.trim() : "";
  const question = input && typeof input.question === "string" ? input.question.trim() : "";
  const docs = input && Array.isArray(input.docs) ? input.docs : [];
  const maxTokens = normalizeBudget(input?.maxTokens);

  const questionSection = question.length > 0 ? `Question: ${question}` : "";
  const fixed = [system, questionSection].filter((section) => section.length > 0);
  const fixedChars = charLength(fixed.join(SECTION_SEPARATOR));

  const order = docs.map((_, index) => index);
  order.sort((a, b) => {
    const pa = docs[a] && typeof docs[a].priority === "number" ? docs[a].priority : 0;
    const pb = docs[b] && typeof docs[b].priority === "number" ? docs[b].priority : 0;
    return pa === pb ? a - b : pb - pa;
  });

  const keptSections = new Map<number, string>();
  const dropped: DroppedDoc[] = [];
  let filledChars = fixedChars;
  let pieceCount = fixed.length;

  for (const index of order) {
    const doc = docs[index];
    const id = doc && typeof doc.id === "string" ? doc.id : "";
    const section = renderDoc(doc);
    if (section.length === 0) {
      dropped.push({ id, tokens: 0, reason: "empty" });
      continue;
    }
    const separatorChars = pieceCount > 0 ? charLength(SECTION_SEPARATOR) : 0;
    const room = maxTokens * CHARS_PER_TOKEN - filledChars - separatorChars;
    if (room <= 0) {
      dropped.push({ id, tokens: estimateTokens(section), reason: "budget" });
      continue;
    }
    const sectionChars = charLength(section);
    if (sectionChars <= room) {
      keptSections.set(index, section);
      filledChars += separatorChars + sectionChars;
      pieceCount += 1;
      continue;
    }
    const shortened = truncateToChars(section, room);
    if (shortened.length > 0) {
      keptSections.set(index, shortened);
      filledChars += separatorChars + charLength(shortened);
      pieceCount += 1;
    } else {
      dropped.push({ id, tokens: estimateTokens(section), reason: "budget" });
    }
  }

  const orderedDocs: string[] = [];
  for (let index = 0; index < docs.length; index += 1) {
    const section = keptSections.get(index);
    if (section !== undefined) orderedDocs.push(section);
  }
  const prompt = [system, ...orderedDocs, questionSection]
    .filter((section) => section.length > 0)
    .join(SECTION_SEPARATOR);

  return { prompt, usedTokens: estimateTokens(prompt), dropped };
}

/* -------------------------------------------------------------------------- *
 * Workspace blocks
 *
 * Workspace content is *data*: a page title or an excerpt may carry an
 * instruction, and a model that reads it as one obeys it. The block is
 * therefore framed by two tags, and the system prompt says what the block is.
 *
 * The tags carry an id that is minted per request. A fixed tag is one the
 * content can simply write — a note that ends the block and continues in its
 * own voice is a prompt injection that needs no cleverness at all. With an id
 * the content cannot know, the frame cannot be closed from the inside.
 * -------------------------------------------------------------------------- */

/** The name of the tag that frames a block of workspace content. */
export const WORKSPACE_BLOCK_TAG = "workspace-matches";

/**
 * An id a block tag may carry: URL-safe and long enough to be unguessable.
 *
 * The id is what the content cannot know, so it is what makes the frame
 * unforgeable — a short or guessable one would leave the frame decorative.
 */
const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The two tags that frame a block of workspace content. */
export type WorkspaceBlockTags = {
  /** The opening tag, e.g. `<workspace-matches id="…">`. */
  open: string;
  /** The closing tag, e.g. `</workspace-matches id="…">`. */
  close: string;
};

/**
 * The tags that frame a block of workspace content.
 *
 * The id must be URL-safe and long enough to be unguessable. An id that does
 * not fit is refused rather than escaped: a weak id would make the frame
 * look like a frame without being one, and a frame that only looks like one
 * is worse than none.
 */
export function workspaceBlockTags(id: string): WorkspaceBlockTags {
  if (typeof id !== "string" || !BLOCK_ID_PATTERN.test(id)) {
    throw new Error(
      `workspaceBlockTags: the id must match ${BLOCK_ID_PATTERN} (16-64 URL-safe characters)`,
    );
  }
  return {
    open: `<${WORKSPACE_BLOCK_TAG} id="${id}">`,
    close: `</${WORKSPACE_BLOCK_TAG} id="${id}">`,
  };
}

/**
 * Frame a block of workspace content for the model.
 *
 * Two things keep the frame honest, and neither of them is the model's
 * cooperation:
 *
 *  - the tags carry an id the content cannot know (`workspaceBlockTags`);
 *  - the text that could pass for a tag is removed from the content, so the
 *    content cannot end the block even for a model that ignores the id.
 *
 * The frame is put around the *fitted* content, so a token budget can never
 * cut the closing tag off: what the model sees is always a whole block.
 */
export function frameWorkspaceBlock(content: string, id: string): string {
  const { open, close } = workspaceBlockTags(id);
  const body = typeof content === "string" ? content : "";
  // A complete tag first — so it leaves no tail behind — and the bare name
  // after it, so nothing that could pass for a tag survives.
  const cleaned = body
    .replace(new RegExp(`</?${WORKSPACE_BLOCK_TAG}\\s*>`, "gi"), "")
    .replace(new RegExp(`</?${WORKSPACE_BLOCK_TAG}`, "gi"), "");
  return `${open}\n${cleaned}\n${close}`;
}
