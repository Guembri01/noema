import { prisma } from "./db";
import { prosemirrorToText, type RichNode } from "./blocks";
import { searchPagesForPrompt } from "@/server/queries";
import { randomToken } from "@/lib/random";

/**
 * Chat "tools": before the assistant answers, a *complete* snapshot of the
 * workspace is assembled — the current note, every note's index, every
 * database with its rows, tickets, projects, members, recent activity and the
 * labels/discussions. The model then reasons over that snapshot to answer
 * anything, instead of having the data routed to it behind keyword "intents".
 *
 * Intents still exist, but only to drive the human-readable activity labels in
 * the chat UI (`detectIntents`); they no longer gate which data is fetched.
 * Retrieval is deterministic and provider-agnostic: no model-driven tool calls,
 * so it works with every OpenAI-compatible endpoint.
 */

export type ChatIntent =
  | "page"
  | "notes"
  | "databases"
  | "members"
  | "projects"
  | "tasks"
  | "note"
  | "tickets"
  | "messages";

export type ChatReference = { id: string; title: string; icon: string | null };

export type ChatIntel = {
  intents: ChatIntent[];
  context: string;
  references: ChatReference[];
  /** Human-readable tool activity for the UI ("Searched notes", …). */
  activity: string[];
  /** The frame around `context` — the system prompt names its tags. */
  frame: ChatSnapshotFrame;
};

/* -------------------------------------------------------------------------- *
 * The frame
 *
 * The chat hands the model the whole workspace, and every value in it was
 * written by a workspace member: a title, a row title, a property value, a
 * member name, a comment, a message. A block header is therefore forgeable —
 * a title with a newline in it ends its line and continues in its own voice.
 *
 * Two things close that gap:
 *
 *  - every interpolated value is folded onto ONE line, so a newline in the
 *    content cannot open a line of its own;
 *  - the snapshot is framed by two tags that carry an id minted per request,
 *    and the system prompt names those tags and says that what is between
 *    them is data to quote, never instructions.
 * -------------------------------------------------------------------------- */

/**
 * The name of the tag that frames the workspace snapshot.
 *
 * The id inside the tag is what makes the frame honest: a fixed tag is one
 * the content could simply write.
 */
export const CHAT_SNAPSHOT_TAG = "workspace-snapshot";

/** The two tags that frame the workspace snapshot of one request. */
export type ChatSnapshotFrame = {
  /** The opening tag, e.g. `<workspace-snapshot id="…">`. */
  open: string;
  /** The closing tag, e.g. `</workspace-snapshot id="…">`. */
  close: string;
};

/**
 * Mint the frame of one request.
 *
 * The id is a fresh random token (16 bytes of entropy, base64url) per request:
 * the workspace content cannot know it, so it cannot write the closing tag and
 * continue in its own voice.
 */
export function chatSnapshotFrame(): ChatSnapshotFrame {
  const id = randomToken(16);
  return {
    open: `<${CHAT_SNAPSHOT_TAG} id="${id}">`,
    close: `</${CHAT_SNAPSHOT_TAG} id="${id}">`,
  };
}

/**
 * Frame the workspace snapshot for the model.
 *
 * The frame goes around the **fitted** context: `fitBlocks` trims by character
 * count, so a frame that was part of the fitted text would lose its closing
 * tag. What the model sees is always a whole block.
 *
 * A string that could pass for the frame's own tag is removed from the
 * content: the id is what makes the frame unclosable, but a fake tag inside
 * the data would still read like structure.
 */
export function frameChatSnapshot(context: string, frame: ChatSnapshotFrame): string {
  const body = typeof context === "string" ? context : "";
  const cleaned = body
    .replace(new RegExp(`</?${CHAT_SNAPSHOT_TAG}(\\s[^>]*)?>`, "gi"), "")
    .replace(new RegExp(`</?${CHAT_SNAPSHOT_TAG}`, "gi"), "");
  return `${frame.open}\n${cleaned}\n${frame.close}`;
}

/**
 * Fold a workspace value onto one line.
 *
 * Everything a block shows was written by a workspace member. A newline in
 * such a value ends the line it belongs to and lets the rest of the value
 * pose as a line of its own — a forged block header, an order in the model's
 * own voice. Folding keeps the words and drops the line breaks.
 */
export function foldToLine(value: string): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * Keep the line structure of a body excerpt while making it impossible for a
 * line of content to pass for a block header: every line is indented, so it
 * cannot start at column 0 with `CURRENT PAGE —`, `WORKSPACE OVERVIEW —`, and
 * so on. Titles and single values still use {@link foldToLine}.
 */
export function indentBlock(value: string): string {
  return typeof value === "string"
    ? value
        .split(/\r?\n/)
        .map((line) => `  ${line}`)
        .join("\n")
    : "";
}

const INTENT_RULES: { id: ChatIntent; label: string; test: RegExp }[] = [
  {
    // "what page am I in?", "describe this", "where am I?" — questions about the
    // page on screen. Matched first so the activity line reads correctly; the
    // page block itself is included whenever a page is open, whatever is asked.
    id: "page",
    label: "Read the current page",
    test: /\b(?:this|the|current|open|same)\s+(?:page|note|doc|document|screen|view|database|tab)\b|\bwhat\s+(?:page|note|doc|document|screen|view)\b|\b(?:am\s+i|i(?:'| a)?m)\s+(?:looking\s+at|on|in|viewing)\b|\bwhere\s+am\s+i\b|\bwhat(?:'s| is)\s+(?:here|on\s+this\s+page|this\s+page)\b|\b(?:describe|explain|summari[sz]e|sum\s+up|tl;?dr)\s+(?:this|it|the\s+page|this\s+page)\b|\b(?:cette|ce)\s+(?:page|note|document)\b|\bo[uù]\s+suis-?je\b/i,
  },
  {
    id: "messages",
    label: "Read the conversation",
    test: /\b(message|messages|comment|comments|thread|threads|discussion|discussions|said|says|replied|reply|conversation|chat|last message|latest)\b/i,
  },
  {
    id: "members",
    label: "Checked members",
    test: /\b(member|members|people|team|who|client|clients|invite|invited|collaborator|membre|membres|équipe|personne)\b/i,
  },
  {
    id: "projects",
    label: "Reviewed projects",
    test: /\b(project|projects|milestone|milestones|gantt|timeline|deadline|due|roadmap|sprint|jalon|projet|projets)\b/i,
  },
  {
    id: "tickets",
    label: "Reviewed tickets",
    test: /\b(ticket|tickets|issue|issues|bug|bugs|backlog|estimate|estimates|points|velocity|sprint|label|labels|ticket)\b/i,
  },
  {
    id: "tasks",
    label: "Checked tasks",
    test: /\b(task|tasks|todo|to-do|to do|checklist|open item|unfinished|done|tâche|tâches)\b/i,
  },
  {
    // The shape of a database — its properties and rows. Distinct from "notes":
    // "what properties does this table have" needs the schema, not page text.
    id: "databases",
    label: "Read the databases",
    test: /\b(database|databases|table|tables|row|rows|column|columns|field|fields|property|properties|board|gallery|kanban|view|views|base|bases|colonne|colonnes|propriété|propriétés)\b/i,
  },
  {
    id: "notes",
    label: "Searched notes",
    test: /\b(note|notes|page|pages|document|doc|docs|wrote|written|content|about|note|page)\b/i,
  },
];

/**
 * Which "intents" a question mentions. This is UI-only — it labels the activity
 * chips shown under an answer. Every workspace block is fetched regardless, so
 * a question with no keywords at all still gets the full snapshot.
 */
export function detectIntents(question: string): ChatIntent[] {
  const intents = INTENT_RULES.filter((rule) => rule.test.test(question)).map((rule) => rule.id);
  return intents.length > 0 ? intents : ["notes"];
}

/* -------------------------------------------------------------------------- *
 * Budgeting
 * -------------------------------------------------------------------------- */

/**
 * Default context budget in characters. Large enough that a normal workspace
 * fits whole, small enough to stay inside every provider's window (roughly
 * 15k tokens at the usual 4 chars/token heuristic).
 */
export const DEFAULT_CONTEXT_CHARS = 60_000;

/** Environment variable that overrides {@link DEFAULT_CONTEXT_CHARS}. */
export const CONTEXT_BUDGET_ENV = "NOEMA_CHAT_CONTEXT_CHARS";

const CONTEXT_SEPARATOR = "\n\n";
const CONTEXT_TRUNCATION_MARKER = "\n… (context truncated)";

/**
 * Read the character budget from the environment. A positive integer wins;
 * anything else (missing, blank, zero, negative, non-numeric) falls back to
 * {@link DEFAULT_CONTEXT_CHARS} so a bad env value can never empty the context.
 */
export function resolveContextBudget(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env?.[CONTEXT_BUDGET_ENV];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return DEFAULT_CONTEXT_CHARS;
}

/**
 * Join priority-ordered `blocks` (index 0 is most important) and keep the
 * joined result within `budget` characters. Blocks that fit whole are kept in
 * input order; the first block that only partly fits is truncated on a word
 * boundary and closed with a visible marker, and everything after it is
 * dropped — so trimming always drops the *least* pertinent data last. Pure and
 * deterministic: equal inputs give byte-identical output.
 */
export function fitBlocks(blocks: readonly string[], budget: number): string {
  const list = (Array.isArray(blocks) ? blocks : []).filter(
    (block): block is string => typeof block === "string" && block.length > 0,
  );
  const max =
    typeof budget === "number" && Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  if (max === 0 || list.length === 0) return "";

  const kept: string[] = [];
  let used = 0;
  for (const block of list) {
    const separator = kept.length > 0 ? CONTEXT_SEPARATOR.length : 0;
    if (used + separator + block.length <= max) {
      kept.push(block);
      used += separator + block.length;
      continue;
    }
    const room = max - used - separator - CONTEXT_TRUNCATION_MARKER.length;
    if (room <= 0) break;
    const head = block.slice(0, room).replace(/\s+$/, "");
    if (head.length === 0) break;
    kept.push(`${head}${CONTEXT_TRUNCATION_MARKER}`);
    used += separator + head.length + CONTEXT_TRUNCATION_MARKER.length;
    break;
  }
  return kept.join(CONTEXT_SEPARATOR);
}

/* -------------------------------------------------------------------------- *
 * Current page
 * -------------------------------------------------------------------------- */

/** Walk a page document and collect unchecked task items. */
function collectOpenTasks(doc: unknown, limit = 8): string[] {
  const tasks: string[] = [];
  const walk = (node: RichNode | undefined) => {
    if (!node || tasks.length >= limit) return;
    if (node.type === "taskItem") {
      const checked = Boolean((node.attrs as { checked?: boolean } | undefined)?.checked);
      if (!checked) {
        const text = (node.content ?? [])
          .map((child) => child.text ?? "")
          .join("")
          .trim();
        if (text) tasks.push(text.slice(0, 120));
      }
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc as RichNode);
  return tasks;
}

/**
 * Everything needed to describe the page the user has open.
 *
 * This exists because the assistant could only see a *workspace* summary: asked
 * "what page am I in?" it answered with counts, because the open page never
 * reached the server. The page id arrives from the client, so every lookup here
 * is scoped by `workspaceId` — a page id from another workspace resolves to null
 * rather than leaking a title.
 */
export type CurrentPageContext = {
  id: string;
  title: string;
  type: string;
  icon: string | null;
  /** Ancestor titles, outermost first, including this page. */
  path: string[];
  children: { title: string; type: string }[];
  /** Properties of a database page, as `Name (TYPE)`. */
  properties: string[];
  /** Rows in a database page (= its child pages). */
  rowCount: number | null;
  excerpt: string;
  openTasks: string[];
  updatedAt: Date;
};

const ANCESTOR_LIMIT = 8;
const CHILD_LIMIT = 12;
const EXCERPT_CHARS = 4000;

export async function resolveCurrentPage(
  workspaceId: string,
  pageId: string | null | undefined,
): Promise<CurrentPageContext | null> {
  if (!pageId || typeof pageId !== "string") return null;
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId, deletedAt: null },
    select: {
      id: true,
      title: true,
      type: true,
      icon: true,
      content: true,
      parentId: true,
      updatedAt: true,
    },
  });
  if (!page) return null;

  // Walk up the tree for a breadcrumb, guarding against a cycle.
  const path: string[] = [];
  let cursor: string | null = page.parentId;
  const seen = new Set<string>([page.id]);
  for (let depth = 0; cursor && depth < ANCESTOR_LIMIT; depth += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const parent: { title: string; parentId: string | null } | null = await prisma.page.findFirst({
      where: { id: cursor, workspaceId, deletedAt: null },
      select: { title: true, parentId: true },
    });
    if (!parent) break;
    path.unshift(parent.title || "Untitled");
    cursor = parent.parentId;
  }
  path.push(page.title || "Untitled");

  // The children are the rows of a database (or the sub-pages of a note).
  // They have to carry the **workspace** of the open page, not just its id: a
  // row that was linked across the boundary before the fix (B08) would put a
  // foreign tenant's title into the AI prompt.
  const children = await prisma.page.findMany({
    where: { parentId: page.id, workspaceId, deletedAt: null },
    orderBy: { position: "asc" },
    take: CHILD_LIMIT,
    select: { title: true, type: true },
  });

  const isDatabase = page.type === "DATABASE";
  const properties = isDatabase
    ? (
        await prisma.property.findMany({
          where: { databasePageId: page.id },
          orderBy: { position: "asc" },
          take: 24,
          select: { name: true, type: true },
        })
      ).map((property) => `${property.name} (${property.type})`)
    : [];

  return {
    id: page.id,
    title: page.title || "Untitled",
    type: page.type,
    icon: page.icon,
    path,
    children: children.map((child) => ({ title: child.title || "Untitled", type: child.type })),
    properties,
    rowCount: isDatabase ? children.length : null,
    excerpt: isDatabase ? "" : prosemirrorToText(page.content).slice(0, EXCERPT_CHARS),
    openTasks: collectOpenTasks(page.content),
    updatedAt: page.updatedAt,
  };
}

/** Render the page the user is looking at, so "this page" has a referent. */
export function currentPageBlock(page: CurrentPageContext): string {
  const lines = [
    "CURRENT PAGE — the user has this open on screen right now",
    `- Title: "${foldToLine(page.title)}"`,
    page.type === "DATABASE"
      ? `- Type: database${page.rowCount === null ? "" : ` (${page.rowCount} row${page.rowCount === 1 ? "" : "s"})`}`
      : "- Type: note (a document)",
    `- Path: ${page.path.map((title) => foldToLine(title)).join(" / ")}`,
    `- Last edited: ${page.updatedAt.toISOString().slice(0, 10)}`,
  ];
  if (page.properties.length > 0) {
    lines.push(`- Properties: ${page.properties.map((property) => foldToLine(property)).join(", ")}`);
  }
  if (page.children.length > 0) {
    const label = page.type === "DATABASE" ? "Rows" : "Sub-pages";
    lines.push(
      `- ${label} (${page.children.length} shown): ${page.children
        .map((child) => `"${foldToLine(child.title)}"`)
        .join(", ")}`,
    );
  }
  if (page.openTasks.length > 0) {
    lines.push(
      `- Open tasks in this page: ${page.openTasks.map((task) => `"${foldToLine(task)}"`).join(", ")}`,
    );
  }
  if (page.excerpt) {
    lines.push("", "Content of the current page:", indentBlock(page.excerpt));
  } else if (page.type === "DATABASE") {
    lines.push("", "This page is a database: its properties and rows are listed above.");
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- *
 * Whole-workspace blocks
 * -------------------------------------------------------------------------- */

/**
 * Always-on summary of what the workspace holds. Counts only, plus the few
 * titles that make an answer concrete, so it stays cheap and small.
 */
async function workspaceOverview(workspaceId: string): Promise<string | null> {
  const [workspace, pageCount, databaseCount, tickets, projects, labelCount, commentCount, chatThreadCount, recentPages] =
    await Promise.all([
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
      prisma.page.count({ where: { workspaceId, type: "PAGE", deletedAt: null } }),
      prisma.page.count({ where: { workspaceId, type: "DATABASE", deletedAt: null } }),
      prisma.ticket.findMany({
        where: { workspaceId, archived: false },
        select: { status: true, dueDate: true, assigneeId: true, estimate: true, estimateUnit: true, title: true, key: true },
      }),
      prisma.project.findMany({
        where: { workspaceId },
        orderBy: { position: "asc" },
        take: 5,
        select: { name: true, status: true, dueDate: true, milestones: { select: { name: true, status: true, dueDate: true } } },
      }),
      prisma.label.count({ where: { workspaceId } }),
      prisma.comment.count({ where: { page: { workspaceId } } }),
      prisma.chatThread.count({ where: { workspaceId } }),
      prisma.page.findMany({
        where: { workspaceId, deletedAt: null, type: "PAGE" },
        orderBy: { updatedAt: "desc" },
        take: 3,
        select: { title: true, updatedAt: true },
      }),
    ]);
  if (!workspace) return null;

  const open = tickets.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const now = Date.now();
  const overdue = open.filter((t) => t.dueDate && t.dueDate.getTime() < now);
  const unassigned = open.filter((t) => !t.assigneeId);
  const noEstimate = open.filter((t) => t.estimate === null);
  const unit = open.find((t) => t.estimateUnit)?.estimateUnit ?? "points";
  const remaining = open.reduce((sum, t) => sum + (t.estimate ?? 0), 0);
  const byStatus = new Map<string, number>();
  for (const t of tickets) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const milestones = projects.flatMap((p) =>
    p.milestones.map((m) => ({ ...m, project: p.name })),
  );
  const nextMilestone = milestones
    .filter((m) => m.status !== "done")
    .sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity))[0];

  const lines = [
    `WORKSPACE OVERVIEW — "${foldToLine(workspace.name)}"`,
    `- Notes: ${pageCount} · Databases: ${databaseCount} · Labels: ${labelCount} · Comments: ${commentCount} · Chat threads: ${chatThreadCount}`,
    tickets.length === 0
      ? "- Tickets: none yet"
      : `- Tickets: ${tickets.length} (${open.length} open, ${remaining} ${unit} remaining)` +
        [...byStatus.entries()].map(([status, count]) => `${status} ${count}`).join(" / ") +
        (overdue.length ? ` · ${overdue.length} overdue` : "") +
        (unassigned.length ? ` · ${unassigned.length} unassigned` : "") +
        (noEstimate.length ? ` · ${noEstimate.length} without an estimate` : ""),
    projects.length === 0
      ? "- Projects: none yet"
      : `- Projects: ${projects.length}${milestones.length ? ` · ${milestones.filter((m) => m.status === "done").length}/${milestones.length} milestones done` : ""}`,
    nextMilestone
      ? `- Next milestone: ${foldToLine(nextMilestone.name)} (${foldToLine(nextMilestone.project)})${nextMilestone.dueDate ? ` due ${nextMilestone.dueDate.toISOString().slice(0, 10)}` : " with no due date"}`
      : projects.length > 0
        ? "- Milestones: none recorded (or all done)"
        : null,
    recentPages.length > 0
      ? `- Recently edited notes: ${recentPages.map((p) => `"${foldToLine(p.title || "Untitled")}"`).join(", ")}`
      : "- Notes: the workspace has no notes yet",
  ].filter(Boolean);
  return lines.join("\n");
}

/* ---------------------------------------------------------------- page index */

/** Cap on the number of pages listed in the index (newest first). */
export const PAGE_INDEX_LIMIT = 400;

type IndexedPage = {
  id: string;
  title: string;
  type: string;
  parentId: string | null;
  icon: string | null;
  updatedAt: Date;
};

function pageTypeLabel(type: string): string {
  return type === "DATABASE" ? "database" : "note";
}

/**
 * Resolve a page's `parent / child` path from a lookup of every indexed page.
 * Stops at the edge of the index (or a cycle) rather than guessing.
 */
function indexPath(
  byId: Map<string, { title: string; parentId: string | null }>,
  id: string,
): string {
  const titles: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  for (let depth = 0; cursor && depth < ANCESTOR_LIMIT; depth += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = byId.get(cursor);
    if (!row) break;
    titles.unshift(foldToLine(row.title || "Untitled"));
    cursor = row.parentId;
  }
  return titles.join(" / ");
}

/**
 * An index of *every* page in the workspace — title, type, path and last-edited
 * date, one line each and no content. This is what lets the model answer
 * "where is X?" or "what pages do I have?" without keyword luck.
 */
async function pageIndexBlock(
  workspaceId: string,
): Promise<{ block: string | null; references: ChatReference[] }> {
  const [pages, total] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: PAGE_INDEX_LIMIT,
      select: {
        id: true,
        title: true,
        type: true,
        parentId: true,
        icon: true,
        updatedAt: true,
      },
    }),
    prisma.page.count({ where: { workspaceId, deletedAt: null } }),
  ]);
  if (pages.length === 0) return { block: null, references: [] };

  const rows = pages as IndexedPage[];
  const byId = new Map(rows.map((page) => [page.id, page]));
  const lines = rows.map(
    (page) =>
      `- "${foldToLine(page.title || "Untitled")}" · ${pageTypeLabel(page.type)} · ${indexPath(byId, page.id)} · edited ${page.updatedAt
        .toISOString()
        .slice(0, 10)}`,
  );
  const shown = rows.length;
  const totalCount = Math.max(total, shown);
  if (totalCount > shown) lines.push(`- …and ${totalCount - shown} more`);
  return {
    block: `PAGES — every page in the workspace (${totalCount}):\n${lines.join("\n")}`,
    references: rows.map((page) => ({
      id: page.id,
      title: page.title || "Untitled",
      icon: page.icon,
    })),
  };
}

/* ---------------------------------------------------------------- databases */

/** How many databases are listed, and how many rows each shows. */
export const DATABASE_LIMIT = 12;
export const ROWS_PER_DATABASE = 50;
const ROWS_TOTAL_LIMIT = 400;

/** Render a property value (JSON) as a short, human string. */
function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value.slice(0, 80);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => formatPropertyValue(entry))
      .join(", ")
      .slice(0, 120);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    if (typeof record.text === "string") return record.text;
    if (record.start || record.end) {
      return [record.start, record.end].filter(Boolean).join(" → ");
    }
    try {
      return JSON.stringify(value).slice(0, 100);
    } catch {
      return "—";
    }
  }
  return String(value);
}

/**
 * Every database page with its properties and its rows — each row as its title
 * plus its property values, so questions like "which tickets are overdue?" over
 * a database are answerable. Bounded per database and overall, with an explicit
 * note whenever rows are left out.
 */
async function databasesBlock(
  workspaceId: string,
): Promise<{ block: string | null; references: ChatReference[] }> {
  const databases = await prisma.page.findMany({
    where: { workspaceId, type: "DATABASE", deletedAt: null },
    orderBy: { position: "asc" },
    take: DATABASE_LIMIT,
    select: {
      id: true,
      title: true,
      icon: true,
      properties: {
        orderBy: { position: "asc" },
        take: 24,
        select: { name: true, type: true },
      },
      _count: { select: { children: true } },
    },
  });
  if (databases.length === 0) return { block: null, references: [] };

  const rows = await prisma.page.findMany({
    // The rows belong to the workspace of the databases they hang under: a row
    // that was linked across the boundary before the fix (B08) would put a
    // foreign tenant's title and cell values into the AI prompt.
    where: {
      parentId: { in: databases.map((database) => database.id) },
      workspaceId,
      deletedAt: null,
    },
    orderBy: { position: "asc" },
    take: ROWS_TOTAL_LIMIT,
    select: {
      id: true,
      title: true,
      parentId: true,
      propertyValues: {
        select: { value: true, property: { select: { name: true } } },
      },
    },
  });

  const rowsByParent = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const bucket = rowsByParent.get(row.parentId) ?? [];
    bucket.push(row);
    rowsByParent.set(row.parentId, bucket);
  }

  const lines: string[] = [];
  for (const database of databases) {
    const databaseRows = rowsByParent.get(database.id) ?? [];
    const total = database._count?.children ?? databaseRows.length;
    lines.push(
      `- "${foldToLine(database.title || "Untitled")}" — ${total} row${total === 1 ? "" : "s"}${
        database.properties?.length
          ? ` · properties: ${database.properties
              .map((property) => foldToLine(`${property.name} (${property.type})`))
              .join(", ")}`
          : ""
      }`,
    );
    const shown = databaseRows.slice(0, ROWS_PER_DATABASE);
    for (const row of shown) {
      const values = (row.propertyValues ?? [])
        .map((entry) =>
          entry.property?.name
            ? `${foldToLine(entry.property.name)}: ${foldToLine(formatPropertyValue(entry.value))}`
            : null,
        )
        .filter((entry): entry is string => Boolean(entry))
        .join(" · ");
      lines.push(`  - "${foldToLine(row.title || "Untitled")}"${values ? ` · ${values}` : ""}`);
    }
    if (total > shown.length) {
      lines.push(
        `  - …and ${total - shown.length} more row${total - shown.length === 1 ? "" : "s"}`,
      );
    }
  }

  return {
    block: `DATABASES — every database and its rows (${databases.length}):\n${lines.join("\n")}`,
    references: databases.map((database) => ({
      id: database.id,
      title: database.title || "Untitled",
      icon: database.icon,
    })),
  };
}

/* ------------------------------------------------------------------- tickets */

async function ticketsBlock(workspaceId: string): Promise<string | null> {
  const tickets = await prisma.ticket.findMany({
    where: { workspaceId, archived: false },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    take: 40,
    select: {
      key: true,
      title: true,
      status: true,
      priority: true,
      estimate: true,
      estimateUnit: true,
      dueDate: true,
      assignee: { select: { name: true } },
      labels: { select: { label: { select: { name: true } } } },
    },
  });
  if (tickets.length === 0) return null;

  const open = tickets.filter((ticket) => ticket.status !== "done" && ticket.status !== "cancelled");
  const remaining = open.reduce((sum, ticket) => sum + (ticket.estimate ?? 0), 0);
  const unit = open.find((ticket) => ticket.estimateUnit)?.estimateUnit ?? "points";
  return `Tickets (${tickets.length}, ${open.length} open · ${remaining} ${unit} remaining):\n${tickets
    .slice(0, 15)
    .map(
      (ticket) =>
        `- ${ticket.key} [${ticket.status}, ${ticket.priority}]${ticket.assignee ? ` @${foldToLine(ticket.assignee.name)}` : ""}${
          ticket.estimate !== null && ticket.estimate !== undefined ? ` · ${ticket.estimate} ${ticket.estimateUnit ?? unit}` : ""
        }${ticket.dueDate ? ` · due ${ticket.dueDate.toISOString().slice(0, 10)}` : ""}${
          ticket.labels?.length ? ` · ${ticket.labels.map((entry) => foldToLine(entry.label.name)).join("/")}` : ""
        } — ${foldToLine(ticket.title)}`,
    )
    .join("\n")}`;
}

/* ------------------------------------------------------------------ projects */

async function projectsBlock(workspaceId: string): Promise<string | null> {
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
    take: 10,
    select: {
      id: true,
      name: true,
      status: true,
      startDate: true,
      dueDate: true,
      _count: { select: { pages: true } },
      milestones: {
        orderBy: { position: "asc" },
        select: { name: true, status: true, dueDate: true },
      },
    },
  });
  if (projects.length === 0) return null;

  return `Projects:\n${projects
    .map((project) => {
      const milestones = project.milestones ?? [];
      const done = milestones.filter((milestone) => milestone.status === "done").length;
      const next = milestones.find((milestone) => milestone.status !== "done");
      return [
        `- ${foldToLine(project.name)} (${project.status})`,
        project.dueDate ? `due ${project.dueDate.toISOString().slice(0, 10)}` : null,
        `${done}/${milestones.length} milestones`,
        next ? `next: ${foldToLine(next.name)}${next.dueDate ? ` (${next.dueDate.toISOString().slice(0, 10)})` : ""}` : null,
        `${project._count?.pages ?? 0} notes`,
      ]
        .filter(Boolean)
        .join(", ");
    })
    .join("\n")}`;
}

/* ------------------------------------------------------------------- members */

async function membersBlock(workspaceId: string): Promise<string[] | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      owner: { select: { name: true, email: true } },
      members: {
        select: { role: true, user: { select: { name: true, email: true } } },
      },
      invites: {
        where: { acceptedAt: null, expiresAt: { gt: new Date() } },
        select: { email: true, role: true },
      },
    },
  });
  if (!workspace || !workspace.owner) return null;

  const members = workspace.members.map(
    (member) =>
      `${foldToLine(member.user.name)} (${foldToLine(member.user.email)}, ${member.role.toLowerCase()})`,
  );
  const blocks = [
    `Workspace members (${members.length + 1}): ${foldToLine(workspace.owner.name)} (${foldToLine(workspace.owner.email)}, owner)` +
      (members.length > 0 ? `, ${members.join(", ")}` : ""),
  ];
  if (workspace.invites.length > 0) {
    blocks.push(
      `Pending invitations: ${workspace.invites
        .map((invite) => `${foldToLine(invite.email)} (${invite.role.toLowerCase()})`)
        .join(", ")}`,
    );
  }
  return blocks;
}

/* ------------------------------------------------- labels & chat discussions */

/** Labels and the most recent chat-thread titles ("small" context). */
async function labelsBlock(workspaceId: string): Promise<string | null> {
  const [labels, threads] = await Promise.all([
    prisma.label.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      take: 50,
      select: { name: true },
    }),
    prisma.chatThread.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { title: true },
    }),
  ]);
  if (labels.length === 0 && threads.length === 0) return null;
  const lines = [
    `LABELS & DISCUSSIONS — ${labels.length} label${labels.length === 1 ? "" : "s"}, ${threads.length} discussion${threads.length === 1 ? "" : "s"}`,
  ];
  if (labels.length > 0) {
    lines.push(`- Labels: ${labels.map((label) => foldToLine(label.name)).join(", ")}`);
  }
  if (threads.length > 0) {
    lines.push(`- Discussions: ${threads.map((thread) => `"${foldToLine(thread.title)}"`).join(", ")}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ messages */

/** The newest comments and chat messages, so "my last message" is answerable. */
async function recentMessages(workspaceId: string, take: number): Promise<string | null> {
  const [comments, chats] = await Promise.all([
    prisma.comment.findMany({
      where: { page: { workspaceId } },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        body: true,
        createdAt: true,
        author: { select: { name: true } },
        page: { select: { id: true, title: true } },
      },
    }),
    prisma.chatMessage.findMany({
      where: { thread: { workspaceId } },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        body: true,
        createdAt: true,
        role: true,
        thread: { select: { title: true } },
      },
    }),
  ]);
  const rows = [
    ...comments.map((c) => ({
      at: c.createdAt,
      text: `[comment on "${foldToLine(c.page.title || "Untitled")}" by ${foldToLine(c.author.name)}] ${foldToLine(c.body)}`,
    })),
    ...chats.map((m) => ({
      at: m.createdAt,
      text: `[${m.role} in chat "${foldToLine(m.thread.title)}"] ${foldToLine(m.body)}`,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, take);
  if (rows.length === 0) {
    return "RECENT MESSAGES: none (the workspace has no comments or chat messages yet).";
  }
  return `RECENT MESSAGES (newest first):\n${rows
    .map((row) => `- ${row.at.toISOString().slice(0, 16).replace("T", " ")} · ${row.text.slice(0, 300)}`)
    .join("\n")}`;
}

/* ----------------------------------------------------------- reference cap */

/** Upper bound on the page/database references kept for linkifying. */
export const REFERENCE_LIMIT = 60;

/** Matching notes from ranked retrieval, as a compact block. */
function matchingNotesBlock(
  matches: { id: string; title: string; snippet: string }[],
): string {
  return `Matching notes:\n${matches
    .map((page) => `- "${foldToLine(page.title)}" (id ${page.id}): ${foldToLine(page.snippet)}`)
    .join("\n")}`;
}

/* ------------------------------------------------------------------ assemble */

export async function gatherChatIntel(input: {
  workspaceId: string;
  /** The note a thread is pinned to (set by "Discuss in chat"). */
  pageId?: string | null;
  /** The page open on screen right now — the strongest possible signal. */
  activePageId?: string | null;
  question: string;
  limit?: number;
}): Promise<ChatIntel> {
  const intents = detectIntents(input.question);
  const take = input.limit ?? 5;
  const workspaceId = input.workspaceId;

  // The page on screen comes FIRST, before any counter. "What page am I in?" was
  // answered with workspace counts because this block did not exist; a page the
  // user is looking at is the most pertinent context a question can have.
  //
  // When the client does not report an open page, a thread pinned to a page
  // ("Discuss in chat") is the next best thing — that is the page being discussed,
  // so it is treated as the current page rather than a separate one.
  const currentPageId = input.activePageId ?? input.pageId ?? null;

  // Every block is fetched for *every* question — no keyword gating. They run
  // together so the whole snapshot costs one round-trip of wall-clock time.
  const [
    activePage,
    overview,
    pageIndex,
    databases,
    ticketBlock,
    projectBlock,
    memberBlocks,
    recent,
    labelBlock,
    matches,
  ] = await Promise.all([
    resolveCurrentPage(workspaceId, currentPageId),
    workspaceOverview(workspaceId),
    pageIndexBlock(workspaceId),
    databasesBlock(workspaceId),
    ticketsBlock(workspaceId),
    projectsBlock(workspaceId),
    membersBlock(workspaceId),
    recentMessages(workspaceId, take),
    labelsBlock(workspaceId),
    // The chat is member-only: both entry points (`postChatMessageAction` and
    // `POST /api/chat/stream`) require `canEditContent`, which denies GUEST, so
    // the whole workspace is the caller's scope here.
    searchPagesForPrompt(workspaceId, input.question, null, take),
  ]);

  const blocks: string[] = [];
  const activity: string[] = [];
  const references: ChatReference[] = [];
  // Index references are stashed and added last: the index can be long, and the
  // more specific pages (current page, databases, matches) must win the cap.
  const indexReferences: ChatReference[] = [];

  const addReferences = (list: ChatReference[]) => {
    for (const reference of list) {
      if (!reference.id) continue;
      if (references.length >= REFERENCE_LIMIT) return;
      if (references.some((existing) => existing.id === reference.id)) continue;
      references.push(reference);
    }
  };

  if (activePage) {
    blocks.push(currentPageBlock(activePage));
    addReferences([{ id: activePage.id, title: activePage.title, icon: activePage.icon }]);
    activity.push("Read the current page");
  }

  // A thread pinned to a different page (opened via "Discuss in chat") keeps that
  // page as context too — the user may be reading one page and discussing another.
  if (input.pageId && input.pageId !== currentPageId) {
    const pinned = await resolveCurrentPage(workspaceId, input.pageId);
    if (pinned) {
      blocks.push(
        `PINNED NOTE — this conversation is pinned to a different page\n- Title: "${foldToLine(pinned.title)}"\n- Path: ${pinned.path.map((title) => foldToLine(title)).join(" / ")}\n${
          pinned.excerpt ? `Content:\n${indentBlock(pinned.excerpt).slice(0, 3000)}` : ""
        }`,
      );
      addReferences([{ id: pinned.id, title: pinned.title, icon: pinned.icon }]);
      activity.push("Opened the pinned note");
    }
  }

  if (overview) {
    blocks.push(overview);
    activity.push("Read the workspace overview");
  }

  if (pageIndex.block) {
    blocks.push(pageIndex.block);
    indexReferences.push(...pageIndex.references);
    activity.push("Indexed the pages");
  }

  if (databases.block) {
    blocks.push(databases.block);
    addReferences(databases.references);
    activity.push("Read the databases");
  }

  if (matches.length > 0) {
    blocks.push(matchingNotesBlock(matches));
    addReferences(
      matches.map((page) => ({ id: page.id, title: page.title, icon: page.icon })),
    );
    activity.push("Searched notes");
  }

  if (ticketBlock) {
    blocks.push(ticketBlock);
    activity.push("Reviewed tickets");
  }

  if (projectBlock) {
    blocks.push(projectBlock);
    activity.push("Reviewed projects");
  }

  if (memberBlocks) {
    blocks.push(...memberBlocks);
    activity.push("Checked members");
  }

  if (recent) {
    blocks.push(recent);
    activity.push("Read recent messages");
  }

  if (labelBlock) {
    blocks.push(labelBlock);
    activity.push("Read the labels and discussions");
  }

  addReferences(indexReferences);

  // The frame is minted per request and put around the **fitted** context: the
  // trimmer cuts by character count, so a frame that was part of the fitted
  // text would lose its closing tag. The frame is paid for out of the budget,
  // so the context the model receives still honours it.
  const frame = chatSnapshotFrame();
  const overhead = frame.open.length + frame.close.length + 2;
  const fitted = fitBlocks(blocks, Math.max(0, resolveContextBudget() - overhead));

  return {
    intents,
    context: frameChatSnapshot(fitted, frame),
    references: references.slice(0, REFERENCE_LIMIT),
    activity: [...new Set(activity)],
    frame,
  };
}

/**
 * Turn note titles mentioned in an answer into linkable references so the chat
 * can link straight to the source note (rendered from `[[page:id|Title]]`).
 */
export function linkifyReferences(answer: string, references: ChatReference[]): string {
  let result = answer;
  for (const reference of references) {
    const title = reference.title.trim();
    if (title.length < 3) continue;
    if (result.includes(`[[page:${reference.id}`)) continue;
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<!\\[\\[page:[a-z0-9]+\\|)"?${escaped}"?`, "i");
    if (pattern.test(result)) {
      result = result.replace(pattern, `[[page:${reference.id}|${title}]]`);
    }
  }
  return result;
}
