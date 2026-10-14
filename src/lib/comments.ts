/**
 * Pure helpers for the comment surface (kept out of components so they are
 * testable): reaction grouping and mention extraction.
 */

export type RawReaction = { emoji: string; userId: string };
export type GroupedReaction = { emoji: string; count: number; mine: boolean };

/** Collapse reactions into chips, ordered by first appearance. */
export function groupReactions(
  reactions: RawReaction[],
  currentUserId: string,
): GroupedReaction[] {
  const byEmoji = new Map<string, GroupedReaction>();
  for (const reaction of reactions ?? []) {
    const entry = byEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
    entry.count += 1;
    if (reaction.userId === currentUserId) entry.mine = true;
    byEmoji.set(reaction.emoji, entry);
  }
  return [...byEmoji.values()];
}

/**
 * `@tokens` in a comment body: `@Ada`, `@ada@example.com`, `@ada.lovelace`.
 * Returns lowercase, de-duplicated tokens without the leading `@`. A bare email
 * address (no leading whitespace) is not a mention.
 */
export function extractMentions(body: string): string[] {
  const found = [...(body ?? "").matchAll(/(?<![\w.@])@([\w.+-]+(?:@[\w.-]+)?)/g)].map((match) =>
    match[1].toLowerCase(),
  );
  return [...new Set(found)];
}

/** Does a mention token refer to this member? */
export function mentionMatches(
  mention: string,
  member: { name: string; email: string },
): boolean {
  const token = mention.trim().toLowerCase().replace(/\s+/g, "").replace(/@$/, "");
  if (!token) return false;
  const email = member.email.toLowerCase();
  const name = member.name.toLowerCase();
  const compactName = name.replace(/\s+/g, "");
  const firstName = name.split(/\s+/)[0] ?? "";
  return (
    email === token ||
    email.split("@")[0] === token ||
    compactName === token ||
    firstName === token
  );
}
