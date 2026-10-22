import type { Extension } from "@tiptap/core";

/**
 * Build-time stub used when `NEXT_PUBLIC_COLLAB_URL` is unset.
 *
 * `next.config.ts` aliases the real collaboration loader to this module for the
 * default build, so Yjs, y-websocket and the TipTap collaboration extensions
 * never enter the client graph. The types mirror the real module so
 * `page-editor.tsx` type-checks unchanged.
 */
export type CollaborationSession = {
  ydoc: import("yjs").Doc;
  provider: import("y-websocket").WebsocketProvider;
  extensions: Extension[];
};

export function collaborationUrl(): string {
  return "";
}

export async function loadCollaborationSession(): Promise<CollaborationSession | null> {
  return null;
}
