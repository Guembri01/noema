import { z } from "zod";

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
  code: z.string().trim().optional(),
});

export const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  icon: z.string().trim().max(8).optional(),
});

export const pageSchema = z.object({
  title: z.string().max(500).optional(),
  icon: z.string().max(16).optional(),
  parentId: z.string().cuid().nullable().optional(),
});

/**
 * A page's block document. The editor serialises TipTap JSON to a string
 * before it reaches a Server Action — ProseMirror shares one `attrs` object
 * across nodes, and React's action encoder turns a shared object graph into a
 * temporary reference, which the server cannot store. Sending text avoids that
 * entirely and lets us validate and cap the payload here.
 */
export const MAX_PAGE_CONTENT_BYTES = 2_000_000;

export const pageContentSchema = z.object({
  type: z.literal("doc"),
  content: z.array(z.record(z.string(), z.unknown())).max(20_000),
});

/** Parse and validate a page document sent as JSON text (or a plain object). */
export function parsePageContent(
  input: unknown,
): { ok: true; doc: unknown } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, doc: undefined };
  let raw: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_PAGE_CONTENT_BYTES) {
      return { ok: false, error: "That page is too large to save (2 MB limit)." };
    }
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: "The page content could not be read." };
    }
  }
  const parsed = pageContentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "The page content is not valid." };
  return { ok: true, doc: parsed.data };
}

export const commentSchema = z.object({
  pageId: z.string().cuid(),
  body: z.string().trim().min(1, "Comment cannot be empty").max(4000),
  parentId: z.string().cuid().nullable().optional(),
  blockId: z.string().max(200).optional(),
  quote: z.string().max(500).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
