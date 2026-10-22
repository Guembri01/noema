import type { Extension } from "@tiptap/core";

export type CollaborationSession = {
  ydoc: import("yjs").Doc;
  provider: import("y-websocket").WebsocketProvider;
  extensions: Extension[];
};

/** The configured room URL, inlined by Next at build time. Empty = off. */
export function collaborationUrl(): string {
  return process.env.NEXT_PUBLIC_COLLAB_URL ?? "";
}

/**
 * Load the collaboration transport only when a room is configured.
 *
 * The static imports that used to live in `page-editor.tsx` made every default
 * build download Yjs, y-websocket and both TipTap collaboration extensions even
 * though `NEXT_PUBLIC_COLLAB_URL` is absent from `.env`. The empty branch
 * returns before any dynamic import runs.
 */
export async function loadCollaborationSession(
  url: string,
  pageId: string,
  user: { name: string; color: string },
): Promise<CollaborationSession | null> {
  if (!url) return null;

  const [
    { Doc },
    { WebsocketProvider },
    { default: Collaboration },
    { default: CollaborationCaret },
  ] = await Promise.all([
    import("yjs"),
    import("y-websocket"),
    import("@tiptap/extension-collaboration"),
    import("@tiptap/extension-collaboration-caret"),
  ]);

  const ydoc = new Doc();
  // `connect: false` keeps the socket closed while the editor mounts; the
  // editor body opens it in its transport effect and tears it down on unmount.
  const provider = new WebsocketProvider(url, pageId, ydoc, { connect: false });
  provider.awareness.setLocalStateField("user", {
    name: user.name,
    color: user.color,
  });

  return {
    ydoc,
    provider,
    extensions: [
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user }),
    ],
  };
}
