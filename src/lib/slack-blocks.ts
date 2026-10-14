/**
 * Slack integration — Block Kit payload builder (docs/FEATURE_MATRIX.md
 * "Slack integration", the outbound half).
 *
 * PURE module: no `fetch`, no prisma, no `node:*`. It only shapes the JSON body
 * Slack's `chat.postMessage` accepts, so a server action, a future worker and
 * these tests all build the exact same payload. Nothing here talks to Slack —
 * posting is the caller's job.
 *
 * Two rules keep the builder safe:
 *
 *  1. every user-controlled string (a page title, a comment body, an actor
 *     name) goes through `escapeMrkdwn` before it lands in a block, so it
 *     cannot inject Slack link/mention syntax or fake a `<http://…|label>` link;
 *  2. `buildSlackMessage` runs the finished payload through
 *     `validateSlackMessage` and throws `SlackPayloadError` on anything Slack
 *     would reject (empty text, unknown block type, over-limit blocks), so a
 *     malformed body never leaves the process.
 *
 * Unit-pinned red-first by `src/lib/slack-blocks.test.ts`.
 */

/* ------------------------------------------------------------------ *
 * Shapes — the subset of Block Kit this module emits.
 * ------------------------------------------------------------------ */

/** A Slack text object; `plain_text` renders literally, `mrkdwn` parses markup. */
export type SlackText = {
  readonly type: "plain_text" | "mrkdwn";
  readonly text: string;
  readonly emoji?: boolean;
  readonly verbatim?: boolean;
};

export type SlackButton = {
  readonly type: "button";
  readonly text: SlackText;
  readonly url: string;
  readonly action_id?: string;
  readonly style?: "primary" | "danger";
};

export type SlackSectionBlock = {
  readonly type: "section";
  readonly text: SlackText;
  readonly block_id?: string;
};

export type SlackContextBlock = {
  readonly type: "context";
  readonly elements: readonly SlackText[];
  readonly block_id?: string;
};

export type SlackDividerBlock = {
  readonly type: "divider";
  readonly block_id?: string;
};

export type SlackActionsBlock = {
  readonly type: "actions";
  readonly elements: readonly SlackButton[];
  readonly block_id?: string;
};

export type SlackHeaderBlock = {
  readonly type: "header";
  readonly text: SlackText;
  readonly block_id?: string;
};

export type SlackBlock =
  | SlackSectionBlock
  | SlackContextBlock
  | SlackDividerBlock
  | SlackActionsBlock
  | SlackHeaderBlock;

/** A ready-to-post message: a fallback `text` plus optional blocks. */
export type SlackMessage = {
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
};

/** What callers may hand `buildSlackMessage`; `validateSlackMessage` takes `unknown`. */
export type SlackMessageInput = {
  readonly text?: string;
  readonly blocks?: readonly SlackBlock[];
};

/** Slack's documented size caps for the pieces this module emits. */
export const SLACK_LIMITS = {
  maxBlocks: 50,
  sectionText: 3000,
  headerText: 150,
  contextText: 3000,
  maxContextElements: 10,
  maxActionElements: 25,
  buttonText: 75,
} as const;

/** Raised by the builders and `buildSlackMessage` when input is not postable. */
export class SlackPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackPayloadError";
  }
}

/* ------------------------------------------------------------------ *
 * Small guards.
 * ------------------------------------------------------------------ */

const HTTP_URL = /^https?:\/\/\S+$/i;

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && HTTP_URL.test(value);
}

/** Non-null, non-array object — the only shape trusted as a record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mrkdwn(text: string): SlackText {
  return { type: "mrkdwn", text };
}

function plainText(text: string): SlackText {
  return { type: "plain_text", text, emoji: true };
}

/* ------------------------------------------------------------------ *
 * Text escaping.
 * ------------------------------------------------------------------ */

/**
 * Escape the three mrkdwn control characters. `&` is replaced first so an
 * input that already looks like an entity (`&amp;`) is escaped again rather
 * than trusted — Slack unescapes the body once, so `&amp;` renders literally.
 */
function escapeLiteral(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `&` inside a link target is the one metacharacter Slack still needs escaped. */
function escapeLinkTarget(url: string): string {
  return url.replace(/&/g, "&amp;");
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^\s)]+)\)/g;

/**
 * Make untrusted text safe for a mrkdwn block.
 *
 * `<`, `>` and `&` are escaped, which neutralizes injected Slack syntax —
 * `<http://evil|pwn>` and `<@U123>` both become inert text. A safe markdown
 * link `[label](https://…)` is the one thing rewritten instead of escaped,
 * into Slack's own `<https://…|label>` form; an unsafe scheme
 * (`javascript:`, `data:`, …) is escaped to plain text rather than linked.
 * Bare URLs are left for Slack to auto-link.
 */
export function escapeMrkdwn(text: string): string {
  const source = typeof text === "string" ? text : "";
  const pattern = new RegExp(MARKDOWN_LINK.source, "g");
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    out += escapeLiteral(source.slice(last, match.index));
    const label = match[1];
    const url = match[2];
    if (isHttpUrl(url)) {
      const href = escapeLinkTarget(url);
      out += label ? `<${href}|${escapeLiteral(label)}>` : `<${href}>`;
    } else {
      out += escapeLiteral(match[0]);
    }
    last = match.index + match[0].length;
  }
  out += escapeLiteral(source.slice(last));
  return out;
}

/* ------------------------------------------------------------------ *
 * Block helpers.
 * ------------------------------------------------------------------ */

export type SlackSectionOptions = {
  /** Render the text literally (defaults to mrkdwn). */
  readonly plain?: boolean;
  readonly blockId?: string;
};

/** A `section` block whose text is escaped-ready mrkdwn by default. */
export function section(
  text: string,
  options: SlackSectionOptions = {},
): SlackSectionBlock {
  const value = typeof text === "string" ? text : "";
  if (value.trim().length === 0) {
    throw new SlackPayloadError("section text cannot be empty");
  }
  return {
    type: "section",
    text: options.plain ? plainText(value) : mrkdwn(value),
    ...(options.blockId ? { block_id: options.blockId } : {}),
  };
}

/** A `header` block (plain_text, no markup). */
export function header(text: string): SlackHeaderBlock {
  const value = typeof text === "string" ? text : "";
  if (value.trim().length === 0) {
    throw new SlackPayloadError("header text cannot be empty");
  }
  return { type: "header", text: plainText(value) };
}

/** A `context` block from strings (mrkdwn) and/or prebuilt text objects. */
export function context(
  ...items: ReadonlyArray<string | SlackText>
): SlackContextBlock {
  return {
    type: "context",
    elements: items.map((item) => (typeof item === "string" ? mrkdwn(item) : item)),
  };
}

/** A `divider` block. */
export function divider(): SlackDividerBlock {
  return { type: "divider" };
}

export type SlackButtonOptions = {
  readonly actionId?: string;
  readonly style?: "primary" | "danger";
};

/** A link button; Slack requires an absolute http(s) url. */
export function button(
  label: string,
  url: string,
  options: SlackButtonOptions = {},
): SlackButton {
  const value = typeof label === "string" ? label : "";
  if (value.trim().length === 0) {
    throw new SlackPayloadError("button text cannot be empty");
  }
  if (!isHttpUrl(url)) {
    throw new SlackPayloadError(`button url must be absolute http(s): ${url}`);
  }
  return {
    type: "button",
    text: plainText(value),
    url,
    ...(options.actionId ? { action_id: options.actionId } : {}),
    ...(options.style ? { style: options.style } : {}),
  };
}

/** An `actions` block wrapping one or more buttons. */
export function actions(...elements: readonly SlackButton[]): SlackActionsBlock {
  if (elements.length === 0) {
    throw new SlackPayloadError("actions needs at least one button");
  }
  for (const element of elements) {
    if (!element || element.type !== "button") {
      throw new SlackPayloadError("actions elements must be buttons");
    }
  }
  return { type: "actions", elements };
}

/* ------------------------------------------------------------------ *
 * Truncation.
 * ------------------------------------------------------------------ */

export type TruncateBlocksOptions = {
  /** Max characters per text field; defaults to the section limit (3000). */
  readonly maxText?: number;
};

/** Cap `text`, appending `…` so the result is never longer than `maxText`. */
function truncateText(text: string, maxText: number): string {
  if (maxText <= 0) return "";
  if (text.length <= maxText) return text;
  return `${text.slice(0, maxText - 1)}…`;
}

/**
 * Return a copy of `blocks` with every text field capped at `maxText`
 * characters (default 3000), the `…` counting toward the cap. Non-text blocks
 * (divider/actions) are passed through and the input is never mutated.
 */
export function truncateBlocks(
  blocks: readonly SlackBlock[],
  options: TruncateBlocksOptions = {},
): SlackBlock[] {
  const maxText = Number.isInteger(options.maxText)
    ? Math.max(0, options.maxText as number)
    : SLACK_LIMITS.sectionText;
  return blocks.map((block) => {
    switch (block.type) {
      case "section":
        return {
          ...block,
          text: { ...block.text, text: truncateText(block.text.text, maxText) },
        };
      case "header":
        return {
          ...block,
          text: { ...block.text, text: truncateText(block.text.text, maxText) },
        };
      case "context":
        return {
          ...block,
          elements: block.elements.map((element) => ({
            ...element,
            text: truncateText(element.text, maxText),
          })),
        };
      default:
        return block;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Validation.
 * ------------------------------------------------------------------ */

export type SlackValidation =
  | { readonly ok: true; readonly message: SlackMessage }
  | { readonly ok: false; readonly error: string };

function validateText(
  value: unknown,
  where: string,
  maxLength: number,
  plainOnly = false,
): string | null {
  if (!isPlainRecord(value)) return `${where} must be a text object`;
  if (value.type !== "plain_text" && value.type !== "mrkdwn") {
    return `${where} has an unknown text type`;
  }
  if (plainOnly && value.type !== "plain_text") {
    return `${where} must use plain_text`;
  }
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    return `${where} text cannot be empty`;
  }
  if (value.text.length > maxLength) {
    return `${where} text exceeds ${maxLength} characters`;
  }
  return null;
}

function validateBlock(block: unknown, index: number): string | null {
  const where = `block ${index + 1}`;
  if (!isPlainRecord(block)) return `${where} must be an object`;
  switch (block.type) {
    case "divider":
      return null;
    case "section":
      return validateText(block.text, `${where} (section)`, SLACK_LIMITS.sectionText);
    case "header":
      return validateText(
        block.text,
        `${where} (header)`,
        SLACK_LIMITS.headerText,
        true,
      );
    case "context": {
      if (!Array.isArray(block.elements) || block.elements.length === 0) {
        return `${where} (context) needs at least one element`;
      }
      if (block.elements.length > SLACK_LIMITS.maxContextElements) {
        return `${where} (context) exceeds ${SLACK_LIMITS.maxContextElements} elements`;
      }
      for (let i = 0; i < block.elements.length; i += 1) {
        const error = validateText(
          block.elements[i],
          `${where} context element ${i + 1}`,
          SLACK_LIMITS.contextText,
        );
        if (error) return error;
      }
      return null;
    }
    case "actions": {
      if (!Array.isArray(block.elements) || block.elements.length === 0) {
        return `${where} (actions) needs at least one button`;
      }
      if (block.elements.length > SLACK_LIMITS.maxActionElements) {
        return `${where} (actions) exceeds ${SLACK_LIMITS.maxActionElements} elements`;
      }
      for (let i = 0; i < block.elements.length; i += 1) {
        const element = block.elements[i];
        if (!isPlainRecord(element) || element.type !== "button") {
          return `${where} actions element ${i + 1} must be a button`;
        }
        const textError = validateText(
          element.text,
          `${where} button ${i + 1}`,
          SLACK_LIMITS.buttonText,
          true,
        );
        if (textError) return textError;
        if (!isHttpUrl(element.url)) {
          return `${where} button ${i + 1} needs an absolute http(s) url`;
        }
      }
      return null;
    }
    default:
      return `${where} has an unknown type`;
  }
}

/**
 * Strictly check an untrusted value against Block Kit. Fails closed: unknown
 * shapes, bad types, empty text, non-http button urls and over-limit blocks all
 * answer `{ ok: false }` with a human-readable reason; a `{ ok: true }` result
 * carries the normalized `{ text, blocks }` message.
 */
export function validateSlackMessage(input: unknown): SlackValidation {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "message must be an object" };
  }
  if (input.text !== undefined && typeof input.text !== "string") {
    return { ok: false, error: "text must be a string" };
  }
  if (input.blocks !== undefined && !Array.isArray(input.blocks)) {
    return { ok: false, error: "blocks must be an array" };
  }
  const blockList: unknown[] = Array.isArray(input.blocks) ? input.blocks : [];
  if (blockList.length > SLACK_LIMITS.maxBlocks) {
    return { ok: false, error: `blocks exceeds ${SLACK_LIMITS.maxBlocks} entries` };
  }
  for (let i = 0; i < blockList.length; i += 1) {
    const error = validateBlock(blockList[i], i);
    if (error) return { ok: false, error };
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (text.trim().length === 0 && blockList.length === 0) {
    return { ok: false, error: "message needs text or blocks" };
  }
  return {
    ok: true,
    message: { text, blocks: blockList as SlackBlock[] },
  };
}

/**
 * Validate and normalize a message, throwing `SlackPayloadError` when it is not
 * postable. `{ text }` alone and `{ blocks }` alone are both accepted; the
 * result always carries both fields (`text` defaults to `""`).
 */
export function buildSlackMessage(input: SlackMessageInput): SlackMessage {
  const result = validateSlackMessage(input);
  if (!result.ok) throw new SlackPayloadError(result.error);
  return result.message;
}

/* ------------------------------------------------------------------ *
 * Noema event → message.
 * ------------------------------------------------------------------ */

/** One Noema event worth announcing in Slack. */
export type NoemaSlackEvent =
  | {
      readonly kind: "comment";
      readonly actor: string;
      readonly pageTitle: string;
      readonly pageUrl: string;
      readonly body: string;
    }
  | {
      readonly kind: "mention";
      readonly actor: string;
      readonly pageTitle: string;
      readonly pageUrl: string;
      readonly body?: string;
    }
  | {
      readonly kind: "ticket";
      readonly actor: string;
      readonly ticketKey: string;
      readonly title: string;
      readonly ticketUrl: string;
      readonly status?: string;
      readonly priority?: string;
    };

/** Build a safe Slack link; the label is escaped, the target only `&`-safe. */
function slackLink(url: string, label: string): string {
  return `<${escapeLinkTarget(url)}|${escapeMrkdwn(label)}>`;
}

/** Plain-text summary used as the notification fallback (`text`). */
function slackFallback(event: NoemaSlackEvent): string {
  switch (event.kind) {
    case "comment":
      return `${event.actor} commented on ${event.pageTitle}`;
    case "mention":
      return `${event.actor} mentioned you on ${event.pageTitle}`;
    case "ticket":
      return `${event.actor} created ${event.ticketKey}: ${event.title}`;
  }
}

/**
 * Map a Noema event (comment / mention / ticket) to a validated Slack message:
 * a header, an escaped mrkdwn summary that links back to the page/ticket, an
 * optional context line (comment/mention body, ticket status + priority) and an
 * action button. All user text is escaped through `escapeMrkdwn`.
 */
export function slackMessageForEvent(event: NoemaSlackEvent): SlackMessage {
  const actor = escapeMrkdwn(event.actor);
  const blocks: SlackBlock[] = [];
  switch (event.kind) {
    case "comment":
      blocks.push(
        header("New comment"),
        section(`*${actor}* commented on ${slackLink(event.pageUrl, event.pageTitle)}`),
        context(escapeMrkdwn(event.body)),
        actions(button("Open page", event.pageUrl)),
      );
      break;
    case "mention":
      blocks.push(
        header("New mention"),
        section(`*${actor}* mentioned you on ${slackLink(event.pageUrl, event.pageTitle)}`),
      );
      if (event.body) blocks.push(context(escapeMrkdwn(event.body)));
      blocks.push(actions(button("Open page", event.pageUrl)));
      break;
    case "ticket": {
      blocks.push(
        header(`New ticket: ${event.ticketKey}`),
        section(`*${actor}* created ${slackLink(event.ticketUrl, event.title)}`),
      );
      const details: string[] = [];
      if (event.status) details.push(`Status: ${event.status}`);
      if (event.priority) details.push(`Priority: ${event.priority}`);
      if (details.length > 0) blocks.push(context(...details));
      blocks.push(actions(button("View ticket", event.ticketUrl)));
      break;
    }
  }
  return buildSlackMessage({ text: slackFallback(event), blocks });
}
