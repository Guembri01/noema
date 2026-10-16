/**
 * Chat action layer — turn an explicit, imperative chat message into a
 * *proposed* workspace change.
 *
 * This is deliberately model-free, exactly like the keyword intents in
 * `chat-context.ts`: the routing is deterministic so it works with every
 * OpenAI-compatible provider (no function-calling API needed). The parser is
 * pure; anything that needs the database (resolving a ticket by key/title,
 * detecting "several tickets match") lives in `planChatAction` /
 * `resolveTicketRef`.
 *
 * Safety rules:
 *   - Only clear imperative phrasing is recognised ("create a ticket called …",
 *     "delete ABC-3", "move ABC-3 to Done"). A plain question returns `null`.
 *   - When an action is recognisable but underspecified (no title, no ticket,
 *     unknown status, several matching tickets) the result is a short
 *     clarifying question, never a guess.
 *   - Nothing here changes data. `planChatAction` returns a proposal the UI
 *     renders as a confirm button; only `executeChatActionAction`
 *     (`src/server/actions/chat.ts`) applies it through the real ticket/page
 *     actions.
 */

import { prisma } from "@/lib/db";

export type ChatActionKind =
  | "createTicket"
  | "updateTicket"
  | "moveTicket"
  | "deleteTicket"
  | "archiveTicket"
  | "createNote";

/** Fields an update may change (a subset of the real ticket fields). */
export type ChatActionChanges = {
  status?: string;
  priority?: string;
  estimate?: number;
  estimateUnit?: string;
  dueDate?: string;
  assigneeName?: string;
  projectName?: string;
  labels?: string[];
};

/** The parsed arguments of a proposed action. */
export type ChatActionArgs = {
  /** `createTicket` / `createNote` title. */
  title?: string;
  /** A ticket key (`ABC-3`) or a title fragment, resolved server-side. */
  ticketRef?: string;
  /** Filled in by `planChatAction` once `ticketRef` resolves. */
  ticketId?: string;
  ticketKey?: string;
  /** `createTicket`/`moveTicket` status. */
  status?: string;
  priority?: string;
  estimate?: number;
  estimateUnit?: string;
  dueDate?: string;
  assigneeName?: string;
  projectName?: string;
  labels?: string[];
  /** `updateTicket` payload. */
  changes?: ChatActionChanges;
};

export type ChatActionProposal = {
  kind: ChatActionKind;
  args: ChatActionArgs;
  /** One-line, human-readable description shown above the confirm button. */
  summary: string;
  requiresConfirm: boolean;
};

/** `parseChatAction` result: a proposal, a clarifying question, or `null`. */
export type ChatActionParse =
  | ChatActionProposal
  | { clarify: string }
  | null;

export type ChatActionPlan =
  | { status: "proposal"; proposal: ChatActionProposal }
  | { status: "clarify"; message: string };

export type ParseOptions = { now?: Date };

/* ------------------------------------------------------------------------- *
 * Small pure helpers
 * ------------------------------------------------------------------------- */

const KEY_RE = /\b([A-Za-z]{1,5}-\d+)\b/;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A status label ("In progress") from its id. */
export function statusLabel(id: string): string {
  const labels: Record<string, string> = {
    backlog: "Backlog",
    todo: "Todo",
    in_progress: "In progress",
    in_review: "In review",
    done: "Done",
    cancelled: "Cancelled",
  };
  return labels[id] ?? id;
}

/** Map a free-text status ("in progress", "done", "to-do") to a status id. */
export function normalizeStatus(phrase: string): string | null {
  const value = phrase.trim().toLowerCase().replace(/\s+/g, " ").replace(/[_-]+/g, " ");
  const table: Record<string, string> = {
    backlog: "backlog",
    "to do": "todo",
    todo: "todo",
    "in progress": "in_progress",
    doing: "in_progress",
    "in review": "in_review",
    review: "in_review",
    done: "done",
    complete: "done",
    completed: "done",
    closed: "done",
    cancel: "cancelled",
    canceled: "cancelled",
    cancelled: "cancelled",
  };
  return table[value] ?? null;
}

/** The first status mentioned anywhere in the text, or `null`. */
function findStatus(text: string): string | null {
  const candidates: [RegExp, string][] = [
    [/\bin\s*[_-]?\s*progress\b/i, "in_progress"],
    [/\bin\s*[_-]?\s*review\b/i, "in_review"],
    [/\bbacklog\b/i, "backlog"],
    [/\bto\s*[_-]?\s*do\b/i, "todo"],
    [/\bcomplete(?:d)?\b/i, "done"],
    [/\bclosed?\b/i, "done"],
    [/\bcancel+?ed\b/i, "cancelled"],
    [/\bdoing\b/i, "in_progress"],
    [/\bdone\b/i, "done"],
  ];
  for (const [re, id] of candidates) {
    if (re.test(text)) return id;
  }
  return null;
}

function extractQuoted(text: string): string | null {
  const match = text.match(/"([^"]+)"|“([^”]+)”|«([^»]+)»|'([^']+)'|`([^`]+)`/);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
  return value || null;
}

/** Where a title stops and the trailing options ("with priority high") start. */
const ATTR_CUTS: RegExp[] = [
  /\s+with\s+(?:priority|status|estimate|labels?|due|assignee|project)\b/i,
  /,\s*(?:with\s+)?(?:priority|status|estimate|labels?|due|assignee|project)\b/i,
  /\s+(?:priority|status|estimate|assignee|labels?)\s+(?:to|of|=|:)/i,
  /\s+due\s+(?:on|by|date)?\b/i,
  /\s+assigned\s+to\b/i,
  /\s+in\s+project\b/i,
];

function cleanTitle(raw: string): string {
  let cut = raw.length;
  for (const re of ATTR_CUTS) {
    const match = re.exec(raw);
    if (match && match.index < cut) cut = match.index;
  }
  return raw
    .slice(0, cut)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:]+$/, "")
    .trim();
}

/** Title after "called/named/titled" or "ticket for/about/to …". */
function extractTitleFrom(text: string): string | null {
  const named = text.match(/\b(?:called|named|titled)\s+([\s\S]+)$/i);
  if (named) {
    const title = cleanTitle(named[1]);
    if (title) return title;
  }
  const target = text.match(/\btickets?\s+(?:for|about|to)\s+([\s\S]+)$/i);
  if (target) {
    const title = cleanTitle(target[1]);
    if (title) return title;
  }
  return null;
}

/** A ticket reference: key, quoted title, "called …" or after the noun. */
function extractRef(text: string): string | null {
  const key = KEY_RE.exec(text);
  if (key) return key[1].toUpperCase();
  const quoted = extractQuoted(text);
  if (quoted) return quoted;
  const named = text.match(
    /\b(?:called|named|titled)\s+["']?([^"';,]+?)["']?(?:\s+(?:in\s+project|with|due|priority)\b|[,.;!?]|$)/i,
  );
  if (named) {
    const value = named[1].trim();
    if (value) return value;
  }
  const afterNoun = text.match(
    /\btickets?\s+["']?([^"';,]+?)["']?(?:\s+(?:to|in\s+project|with|due)\b|[,.;!?]|$)/i,
  );
  if (afterNoun) {
    const value = afterNoun[1].trim();
    if (value && !/^(?:to|the|a|an|and|or|for|is|are)\b/i.test(value)) return value;
  }
  return null;
}

function parsePriority(text: string): string | null {
  const match =
    text.match(/\bpriority\s*(?:is|to|:|=)?\s*(urgent|high|medium|low|none|no priority)\b/i) ??
    text.match(/\b(urgent|high|medium|low)\s+priority\b/i);
  if (!match) return null;
  const word = match[1].toLowerCase();
  return word === "no priority" ? "none" : word;
}

function parseEstimate(text: string): { estimate: number; estimateUnit: string } | null {
  const match =
    text.match(
      /\b(?:estimate|estimated|est)\s*(?:is|of|to|:|=)?\s*(\d+(?:\.\d+)?)\s*(points?|hours?|days?)?/i,
    ) ?? text.match(/\b(\d+(?:\.\d+)?)\s*(points?|hours?|days?)\b/i);
  if (!match) return null;
  const estimate = Number(match[1]);
  if (!Number.isFinite(estimate)) return null;
  const unit = (match[2] ?? "points").toLowerCase().replace(/s$/, "");
  const estimateUnit = unit === "hour" ? "hours" : unit === "day" ? "days" : "points";
  return { estimate, estimateUnit };
}

function parseAssignee(text: string): string | null {
  const match =
    text.match(
      /\b(?:assign(?:ed)?|reassign(?:ed)?)\b[\s\S]*?\bto\s+@?([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)?)/i,
    ) ?? text.match(/\bto\s+@([A-Za-z][\w.'-]*)/i);
  if (!match) return null;
  return match[1].trim().replace(/[.,;]+$/, "");
}

function parseProject(text: string): string | null {
  const match =
    text.match(/\b(?:in|to|into)\s+(?:the\s+)?project\s+["']?([^"',.;]+)["']?/i) ??
    text.match(/\bproject\s*[:=]\s*["']?([^"',.;]+)["']?/i);
  if (!match) return null;
  return match[1].trim();
}

function parseLabels(text: string): string[] {
  let raw: string | null = null;
  const labelled = text.match(/\blabels?\s*[:=]\s*([^.;]+)/i);
  if (labelled) raw = labelled[1];
  const withLabel = text.match(/\bwith\s+labels?\s+([^.;]+)/i);
  if (withLabel) raw = raw ?? withLabel[1];
  const addLabel = text.match(/\b(?:add|attach|apply)\s+labels?\s+(.+?)\s+to\b/i);
  if (addLabel) raw = addLabel[1];
  if (!raw) return [];
  return raw
    .split(/\s*(?:,|\/|\band\b)\s*/i)
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function resolveDueToken(token: string, now: Date): string | null {
  const value = token.trim().toLowerCase().replace(/^(?:the|next|by|on|to)\s+/g, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  if (value === "today") return isoDate(now);
  if (value === "tomorrow") {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    return isoDate(next);
  }
  if (value === "yesterday") {
    const prev = new Date(now);
    prev.setDate(prev.getDate() - 1);
    return isoDate(prev);
  }

  const dayIndex = WEEKDAYS.indexOf(value);
  if (dayIndex >= 0) {
    const date = new Date(now);
    const delta = (dayIndex - date.getDay() + 7) % 7 || 7;
    date.setDate(date.getDate() + delta);
    return isoDate(date);
  }

  const monthDay = value.match(/^([a-z]{3,9})\s+(\d{1,2})$/);
  if (monthDay && MONTHS[monthDay[1]] !== undefined) {
    const date = new Date(now.getFullYear(), MONTHS[monthDay[1]], Number(monthDay[2]));
    return isoDate(date);
  }
  const dayMonth = value.match(/^(\d{1,2})\s+([a-z]{3,9})$/);
  if (dayMonth && MONTHS[dayMonth[2]] !== undefined) {
    const date = new Date(now.getFullYear(), MONTHS[dayMonth[2]], Number(dayMonth[1]));
    return isoDate(date);
  }
  return null;
}

function parseDueDate(text: string, now: Date): string | null {
  const match = text.match(
    /\bdue\s+(?:date\s+)?(?:on\s+|by\s+|to\s+)?([A-Za-z0-9][A-Za-z0-9 \-]{0,30})/i,
  );
  if (!match) return null;
  return resolveDueToken(match[1], now);
}

/* ------------------------------------------------------------------------- *
 * Proposals
 * ------------------------------------------------------------------------- */

export function proposalLabel(kind: ChatActionKind): string {
  const labels: Record<ChatActionKind, string> = {
    createTicket: "Create ticket",
    updateTicket: "Update ticket",
    moveTicket: "Move ticket",
    deleteTicket: "Delete ticket",
    archiveTicket: "Archive ticket",
    createNote: "Create note",
  };
  return labels[kind];
}

function changeSummary(changes: ChatActionChanges): string {
  const parts: string[] = [];
  if (changes.status) parts.push(`status → ${statusLabel(changes.status)}`);
  if (changes.priority) parts.push(`priority → ${changes.priority}`);
  if (changes.assigneeName) parts.push(`assignee → ${changes.assigneeName}`);
  if (changes.estimate !== undefined) {
    parts.push(`estimate → ${changes.estimate} ${changes.estimateUnit ?? "points"}`);
  }
  if (changes.dueDate) parts.push(`due → ${changes.dueDate}`);
  if (changes.projectName) parts.push(`project → ${changes.projectName}`);
  if (changes.labels && changes.labels.length > 0) parts.push(`labels → ${changes.labels.join(", ")}`);
  return parts.join(" · ");
}

export function summarize(kind: ChatActionKind, args: ChatActionArgs): string {
  switch (kind) {
    case "createTicket": {
      const extras: string[] = [];
      if (args.status) extras.push(statusLabel(args.status));
      if (args.priority) extras.push(`${args.priority} priority`);
      if (args.estimate !== undefined) extras.push(`${args.estimate} ${args.estimateUnit ?? "points"}`);
      if (args.dueDate) extras.push(`due ${args.dueDate}`);
      if (args.assigneeName) extras.push(`@${args.assigneeName}`);
      return `Create ticket "${args.title ?? "Untitled"}"${extras.length ? ` (${extras.join(", ")})` : ""}`;
    }
    case "updateTicket":
      return `Update ${args.ticketKey ?? args.ticketRef ?? "ticket"}${
        args.changes ? ` — ${changeSummary(args.changes)}` : ""
      }`;
    case "moveTicket":
      return `Move ${args.ticketKey ?? args.ticketRef ?? "ticket"} to ${
        args.status ? statusLabel(args.status) : "a new status"
      }`;
    case "deleteTicket":
      return `Delete ${args.ticketKey ?? args.ticketRef ?? "ticket"}`;
    case "archiveTicket":
      return `Archive ${args.ticketKey ?? args.ticketRef ?? "ticket"}`;
    case "createNote":
      return `Create note "${args.title ?? "Untitled"}"`;
  }
}

function proposal(kind: ChatActionKind, args: ChatActionArgs): ChatActionProposal {
  return { kind, args, summary: summarize(kind, args), requiresConfirm: true };
}

/** Markdown body rendered for a proposal (the confirm button sits below it). */
export function proposalBody(proposal: ChatActionProposal): string {
  return `${proposal.summary}.\n\n_Not applied yet — confirm to make this change._`;
}

/* ------------------------------------------------------------------------- *
 * The parser
 * ------------------------------------------------------------------------- */

function isCreateTicket(text: string): boolean {
  if (/\bnew\s+tickets?\b/i.test(text)) return true;
  if (/\b(note|page|doc|document)\b/i.test(text) && !/\btickets?\b/i.test(text)) return false;
  return /\b(create|add|make|open|file|log|raise)\b(?:\s+\w+){0,3}?\s+\btickets?\b/i.test(text);
}

function isCreateNote(text: string): boolean {
  if (/\bnew\s+(?:note|page|doc|document)\b/i.test(text)) return true;
  return /\b(create|add|make|write|start)\b(?:\s+\w+){0,2}?\s*\b(?:note|page|doc|document)\b/i.test(
    text,
  );
}

function parseCreateTicket(text: string, now: Date): ChatActionParse {
  const title = extractQuoted(text) ?? extractTitleFrom(text);
  if (!title) {
    return { clarify: "What should the ticket be called?" };
  }
  const args: ChatActionArgs = { title };
  const status = findStatus(text);
  if (status) args.status = status;
  const priority = parsePriority(text);
  if (priority) args.priority = priority;
  const estimate = parseEstimate(text);
  if (estimate) {
    args.estimate = estimate.estimate;
    args.estimateUnit = estimate.estimateUnit;
  }
  const dueDate = parseDueDate(text, now);
  if (dueDate) args.dueDate = dueDate;
  const assignee = parseAssignee(text);
  if (assignee) args.assigneeName = assignee;
  const project = parseProject(text);
  if (project) args.projectName = project;
  const labels = parseLabels(text);
  if (labels.length > 0) args.labels = labels;
  return proposal("createTicket", args);
}

function parseCreateNote(text: string): ChatActionParse {
  let title = extractQuoted(text) ?? extractTitleFrom(text);
  if (!title) {
    const afterNoun = text.match(
      /\b(?:note|page|doc|document)\s+["']?([^"';,]+?)["']?(?:\s+with\b|[,.;!?]|$)/i,
    );
    const value = afterNoun?.[1]?.trim();
    if (value && !/^(?:to|the|a|an|and|or|for|is|are)\b/i.test(value)) title = value;
  }
  if (!title) return { clarify: "What should the note be called?" };
  return proposal("createNote", { title });
}

function parseRefAction(kind: "deleteTicket" | "archiveTicket", text: string): ChatActionParse {
  const ticketRef = extractRef(text);
  if (!ticketRef) {
    return {
      clarify:
        kind === "deleteTicket"
          ? "Which ticket should I delete? Give its key (like ABC-3) or its exact title."
          : "Which ticket should I archive? Give its key (like ABC-3) or its exact title.",
    };
  }
  return proposal(kind, { ticketRef });
}

function parseMove(text: string): ChatActionParse {
  const ticketRef = extractRef(text);
  if (!ticketRef) {
    return { clarify: "Which ticket should I move? Give its key (like ABC-3) or its exact title." };
  }
  const toMatch = text.match(
    /\bto\s+(?:the\s+)?([A-Za-z_][A-Za-z_ ]*?)(?:\s+(?:column|status|in\s+project)\b|[,.;!?]|$)/i,
  );
  const phrase = toMatch?.[1]?.trim();
  const status = phrase ? normalizeStatus(phrase) : findStatus(text);
  if (!status) {
    const options = "Backlog, Todo, In progress, In review, Done or Cancelled";
    return {
      clarify: phrase
        ? `I don't recognise the status "${phrase}". Try ${options}.`
        : `Which status should I move it to? ${options}.`,
    };
  }
  return proposal("moveTicket", { ticketRef, status });
}

function parseUpdate(text: string, now: Date): ChatActionParse {
  const ticketRef = extractRef(text);
  if (!ticketRef) {
    return { clarify: "Which ticket should I update? Give its key (like ABC-3) or its exact title." };
  }
  const changes: ChatActionChanges = {};
  const status = findStatus(text);
  if (status) changes.status = status;
  const priority = parsePriority(text);
  if (priority) changes.priority = priority;
  const estimate = parseEstimate(text);
  if (estimate) {
    changes.estimate = estimate.estimate;
    changes.estimateUnit = estimate.estimateUnit;
  }
  const dueDate = parseDueDate(text, now);
  if (dueDate) changes.dueDate = dueDate;
  const assignee = parseAssignee(text);
  if (assignee) changes.assigneeName = assignee;
  const project = parseProject(text);
  if (project) changes.projectName = project;
  const labels = parseLabels(text);
  if (labels.length > 0) changes.labels = labels;

  if (Object.keys(changes).length === 0) {
    return {
      clarify:
        "What should I change? I can update the status, priority, assignee, estimate, due date, labels or project.",
    };
  }
  return proposal("updateTicket", { ticketRef, changes });
}

/**
 * Parse an explicit request into a proposed action. Returns `null` for a plain
 * question, `{ clarify }` when the phrasing is an action but underspecified,
 * else the proposal.
 */
export function parseChatAction(message: string, options: ParseOptions = {}): ChatActionParse {
  const raw = (message ?? "").trim();
  if (!raw) return null;
  const text = raw.replace(/^\/ask\s*/i, "").trim();
  if (!text) return null;
  const now = options.now ?? new Date();

  if (isCreateTicket(text)) return parseCreateTicket(text, now);
  if (isCreateNote(text)) return parseCreateNote(text);

  const hasTicketNoun = /\btickets?\b/i.test(text);
  const hasRef = Boolean(KEY_RE.exec(text) ?? extractQuoted(text));

  if (/\b(delete|remove|trash|drop|destroy)\b/i.test(text) && (hasTicketNoun || hasRef)) {
    return parseRefAction("deleteTicket", text);
  }
  if (/\barchive\b/i.test(text) && (hasTicketNoun || hasRef)) {
    return parseRefAction("archiveTicket", text);
  }
  if (/\bmove\b/i.test(text) && (hasTicketNoun || hasRef)) {
    return parseMove(text);
  }
  if (
    /\b(update|change|set|mark|edit|rename|assign|reassign|add|attach|apply)\b/i.test(text) &&
    (hasTicketNoun || hasRef)
  ) {
    return parseUpdate(text, now);
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Server-side resolution + planning
 * ------------------------------------------------------------------------- */

export type ResolvedTicket = { id: string; key: string; title: string; status: string };

const TICKET_SELECT = { id: true, key: true, title: true, status: true } as const;

export type TicketLookup =
  | { ok: true; ticket: ResolvedTicket }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; candidates: ResolvedTicket[] };

/**
 * Resolve a ticket reference within one workspace: exact key first, then exact
 * (case-insensitive) title, then a title substring match. Returns every
 * candidate for an ambiguous substring so the caller can ask instead of guess.
 */
export async function resolveTicketRef(
  workspaceId: string,
  ref: string,
): Promise<TicketLookup> {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) return { ok: false, reason: "not-found" };

  if (/^[A-Za-z]{1,5}-\d+$/.test(trimmed)) {
    const byKey = await prisma.ticket.findFirst({
      where: { workspaceId, archived: false, key: trimmed.toUpperCase() },
      select: TICKET_SELECT,
    });
    if (byKey) return { ok: true, ticket: byKey };
  }

  const exact = await prisma.ticket.findFirst({
    where: { workspaceId, archived: false, title: { equals: trimmed, mode: "insensitive" } },
    select: TICKET_SELECT,
  });
  if (exact) return { ok: true, ticket: exact };

  const partial = await prisma.ticket.findMany({
    where: { workspaceId, archived: false, title: { contains: trimmed, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    take: 6,
    select: TICKET_SELECT,
  });
  if (partial.length === 1) return { ok: true, ticket: partial[0] };
  if (partial.length > 1) return { ok: false, reason: "ambiguous", candidates: partial };
  return { ok: false, reason: "not-found" };
}

/**
 * Parse a message and, when it references a ticket, resolve that reference
 * against the workspace. Ambiguity becomes a clarifying question — never a
 * guess. `null` means the message is not an action (answer it normally).
 */
export async function planChatAction(
  workspaceId: string,
  message: string,
  options: ParseOptions = {},
): Promise<ChatActionPlan | null> {
  const parsed = parseChatAction(message, options);
  if (!parsed) return null;
  if ("clarify" in parsed) return { status: "clarify", message: parsed.clarify };

  const ref = parsed.args.ticketRef;
  if (ref) {
    const resolved = await resolveTicketRef(workspaceId, ref);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        const list = resolved.candidates
          .map((ticket) => `${ticket.key} — ${ticket.title}`)
          .join(", ");
        return {
          status: "clarify",
          message: `I found several tickets matching "${ref}": ${list}. Which one did you mean?`,
        };
      }
      return {
        status: "clarify",
        message: `I couldn't find a ticket matching "${ref}". Which ticket did you mean?`,
      };
    }
    parsed.args.ticketId = resolved.ticket.id;
    parsed.args.ticketKey = resolved.ticket.key;
    parsed.summary = summarize(parsed.kind, parsed.args);
  }

  return { status: "proposal", proposal: parsed };
}
