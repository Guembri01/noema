import { prisma } from "./db";
import { prosemirrorToText, type RichNode } from "./blocks";
import { searchPagesForPrompt } from "@/server/queries";

/**
 * Chat "tools": before the assistant answers, the question is routed to the
 * workspace data it needs — the current note, matching notes, members, projects
 * with their milestones, and open tasks. The result is a compact context block
 * plus the note references the answer may cite, so replies can link straight
 * back to the notes they came from.
 *
 * Routing is deterministic (keyword intents) rather than model-driven tool
 * calls, so it works with every OpenAI-compatible provider.
 */

export type ChatIntent = "notes" | "members" | "projects" | "tasks" | "note" | "tickets" | "messages";

export type ChatReference = { id: string; title: string; icon: string | null };

export type ChatIntel = {
  intents: ChatIntent[];
  context: string;
  references: ChatReference[];
  /** Human-readable tool activity for the UI ("Searched notes", …). */
  activity: string[];
};

const INTENT_RULES: { id: ChatIntent; label: string; test: RegExp }[] = [
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
    id: "notes",
    label: "Searched notes",
    test: /\b(note|notes|page|pages|document|doc|docs|wrote|written|content|about|note|page)\b/i,
  },
];

export function detectIntents(question: string): ChatIntent[] {
  const intents = INTENT_RULES.filter((rule) => rule.test.test(question)).map((rule) => rule.id);
  return intents.length > 0 ? intents : ["notes"];
}

function isIntentAsked(intents: ChatIntent[], id: ChatIntent) {
  return intents.includes(id);
}

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
    `WORKSPACE OVERVIEW — "${workspace.name}"`,
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
      ? `- Next milestone: ${nextMilestone.name} (${nextMilestone.project})${nextMilestone.dueDate ? ` due ${nextMilestone.dueDate.toISOString().slice(0, 10)}` : " with no due date"}`
      : projects.length > 0
        ? "- Milestones: none recorded (or all done)"
        : null,
    recentPages.length > 0
      ? `- Recently edited notes: ${recentPages.map((p) => `"${p.title || "Untitled"}"`).join(", ")}`
      : "- Notes: the workspace has no notes yet",
  ].filter(Boolean);
  return lines.join("\n");
}

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
      text: `[comment on "${c.page.title || "Untitled"}" by ${c.author.name}] ${c.body}`,
    })),
    ...chats.map((m) => ({
      at: m.createdAt,
      text: `[${m.role} in chat "${m.thread.title}"] ${m.body}`,
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

export async function gatherChatIntel(input: {
  workspaceId: string;
  pageId?: string | null;
  question: string;
  limit?: number;
}): Promise<ChatIntel> {
  const intents = detectIntents(input.question);
  const parts: string[] = [];
  const activity: string[] = [];
  const references: ChatReference[] = [];
  const take = input.limit ?? 5;

  // A compact workspace overview is ALWAYS included. Without it the assistant
  // could only say "no data" (which is what it did whenever a question did not
  // match an intent); with it, it can answer with what the workspace actually
  // holds and be explicit about what is missing.
  const overview = await workspaceOverview(input.workspaceId);
  if (overview) {
    parts.push(overview);
    activity.push("Read the workspace overview");
  }

  // Recent comments and chat messages: what "my last message" means.
  if (isIntentAsked(intents, "messages") || isIntentAsked(intents, "note")) {
    const recent = await recentMessages(input.workspaceId, take);
    if (recent) {
      parts.push(recent);
      activity.push("Read recent messages");
    }
  }

  // The note the discussion is pinned to (always the strongest signal).
  if (input.pageId) {
    const page = await prisma.page.findUnique({
      where: { id: input.pageId },
      select: { id: true, title: true, icon: true, content: true },
    });
    if (page) {
      references.push({ id: page.id, title: page.title || "Untitled", icon: page.icon });
      parts.push(
        `Current note "${page.title || "Untitled"}":\n${prosemirrorToText(page.content).slice(0, 5000)}`,
      );
      activity.push("Opened the current note");
      if (isIntentAsked(intents, "tasks")) {
        const open = collectOpenTasks(page.content);
        if (open.length > 0) {
          parts.push(`Open tasks in this note:\n${open.map((task) => `- ${task}`).join("\n")}`);
          activity.push("Checked tasks");
        }
      }
    }
  }

  if (isIntentAsked(intents, "notes")) {
    const matches = await searchPagesForPrompt(input.workspaceId, input.question, take);
    if (matches.length > 0) {
      parts.push(
        `Matching notes:\n${matches
          .map((page) => `- "${page.title}" (id ${page.id}): ${page.snippet}`)
          .join("\n")}`,
      );
      for (const page of matches) {
        if (!references.some((reference) => reference.id === page.id)) {
          references.push({ id: page.id, title: page.title, icon: page.icon });
        }
      }
      activity.push("Searched notes");
    }
  }

  if (isIntentAsked(intents, "members")) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: input.workspaceId },
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
    if (workspace) {
      const members = workspace.members.map(
        (member) => `${member.user.name} (${member.user.email}, ${member.role.toLowerCase()})`,
      );
      parts.push(
        `Workspace members (${members.length + 1}): ${workspace.owner.name} (${workspace.owner.email}, owner)` +
          (members.length > 0 ? `, ${members.join(", ")}` : ""),
      );
      if (workspace.invites.length > 0) {
        parts.push(
          `Pending invitations: ${workspace.invites
            .map((invite) => `${invite.email} (${invite.role.toLowerCase()})`)
            .join(", ")}`,
        );
      }
      activity.push("Checked members");
    }
  }

  if (isIntentAsked(intents, "tickets")) {
    const tickets = await prisma.ticket.findMany({
      where: { workspaceId: input.workspaceId, archived: false },
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
    if (tickets.length > 0) {
      const open = tickets.filter((ticket) => ticket.status !== "done" && ticket.status !== "cancelled");
      const remaining = open.reduce((sum, ticket) => sum + (ticket.estimate ?? 0), 0);
      const unit = open.find((ticket) => ticket.estimateUnit)?.estimateUnit ?? "points";
      parts.push(
        `Tickets (${tickets.length}, ${open.length} open · ${remaining} ${unit} remaining):\n${tickets
          .slice(0, 15)
          .map(
            (ticket) =>
              `- ${ticket.key} [${ticket.status}, ${ticket.priority}]${ticket.assignee ? ` @${ticket.assignee.name}` : ""}${
                ticket.estimate !== null ? ` · ${ticket.estimate} ${ticket.estimateUnit}` : ""
              }${ticket.dueDate ? ` · due ${ticket.dueDate.toISOString().slice(0, 10)}` : ""}${
                ticket.labels.length > 0 ? ` · ${ticket.labels.map((entry) => entry.label.name).join("/")}` : ""
              } — ${ticket.title}`,
          )
          .join("\n")}`,
      );
      activity.push("Reviewed tickets");
    }
  }

  if (isIntentAsked(intents, "projects")) {
    const projects = await prisma.project.findMany({
      where: { workspaceId: input.workspaceId },
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
    if (projects.length > 0) {
      parts.push(
        `Projects:\n${projects
          .map((project) => {
            const done = project.milestones.filter((milestone) => milestone.status === "done").length;
            const next = project.milestones.find((milestone) => milestone.status !== "done");
            return [
              `- ${project.name} (${project.status})`,
              project.dueDate ? `due ${project.dueDate.toISOString().slice(0, 10)}` : null,
              `${done}/${project.milestones.length} milestones`,
              next ? `next: ${next.name}${next.dueDate ? ` (${next.dueDate.toISOString().slice(0, 10)})` : ""}` : null,
              `${project._count.pages} notes`,
            ]
              .filter(Boolean)
              .join(", ");
          })
          .join("\n")}`,
      );
      activity.push("Reviewed projects");
    }
  }

  return {
    intents,
    context: parts.join("\n\n").slice(0, 9000),
    references,
    activity: [...new Set(activity)],
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
