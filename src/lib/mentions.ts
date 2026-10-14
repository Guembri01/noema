/**
 * Pure helpers for mention nodes. Mentions are inline atoms carrying
 * `{ id, label, type }` where `type` is "page" | "user" | "date". Page mentions
 * are how backlinks ("linked references") are discovered.
 */

export type MentionType = "page" | "user" | "date";

export type MentionAttrs = {
  id: string;
  label: string;
  type: MentionType;
};

type AnyNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: AnyNode[];
};

/** Collect the distinct mention ids of a given type from a document. */
export function collectMentionIds(doc: unknown, type?: MentionType): string[] {
  const ids = new Set<string>();
  const walk = (node: AnyNode | undefined) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "mention") {
      const attrs = (node.attrs ?? {}) as Record<string, unknown>;
      const nodeType = typeof attrs.type === "string" ? attrs.type : "page";
      if ((!type || nodeType === type) && typeof attrs.id === "string") {
        ids.add(attrs.id);
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  const root = doc as AnyNode | null;
  if (root && Array.isArray(root.content)) root.content.forEach(walk);
  else walk(root ?? undefined);
  return [...ids];
}

/** Does a document reference the given page? */
export function docMentionsPage(doc: unknown, pageId: string): boolean {
  return collectMentionIds(doc, "page").includes(pageId);
}

/** Build the mention attributes for a page. */
export function pageMention(page: { id: string; title: string }): MentionAttrs {
  return { id: page.id, label: page.title || "Untitled", type: "page" };
}

/** Build the mention attributes for a user. */
export function userMention(user: { id: string; name: string }): MentionAttrs {
  return { id: user.id, label: user.name, type: "user" };
}

/** Build a date mention from a Date. */
export function dateMention(date: Date): MentionAttrs {
  const iso = date.toISOString().slice(0, 10);
  return {
    id: iso,
    label: date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    type: "date",
  };
}
