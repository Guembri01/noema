/**
 * Chat runtime shared by the two transports: the Server Action (single answer)
 * and the streaming route. Keeping the prompt and the grounding in one place is
 * what stops the streaming and non-streaming replies from drifting apart.
 */

import { gatherChatIntel } from "@/lib/chat-context";

/** The assistant's contract. Markdown-first, synthesis first, no invention. */
export const CHAT_SYSTEM_PROMPT = [
  "You are Noema's assistant inside a self-hosted notes workspace. You answer from the workspace data provided, never from the open internet.",
  "Always reply in GitHub-flavoured Markdown, and answer FIRST — the opening sentence is the synthesis of your answer.",
  "Use `### Heading` for sections, `-` or `1.` lists for items, `**bold**` for the few key terms, `| a | b |` tables when comparing three or more things, and fenced code blocks for code.",
  "Prefer a short list or a small table over a wall of prose. Keep the reply under 160 words unless asked for detail.",
  "Never invent notes, people, dates, statuses or numbers that are not in the provided data; say plainly when the data does not cover something.",
  "When you mention a note that appears in the workspace data, keep its exact title so it can be linked.",
].join(" ");

export type ChatRequest = {
  system: string;
  context: string | undefined;
  user: string;
  intel: Awaited<ReturnType<typeof gatherChatIntel>>;
};

/** Ground a question in the workspace data it needs (notes, members, projects, tickets, tasks). */
export async function buildChatRequest(input: {
  workspaceId: string;
  pageId: string | null;
  question: string;
}): Promise<ChatRequest> {
  const intel = await gatherChatIntel({
    workspaceId: input.workspaceId,
    pageId: input.pageId,
    question: input.question,
  });
  return {
    system: CHAT_SYSTEM_PROMPT,
    context: intel.context || undefined,
    user: input.question || "Summarize this note and suggest next steps.",
    intel,
  };
}
