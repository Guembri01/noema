/**
 * The session a provider request belongs to.
 *
 * OpenCode Go asks its clients for a stable session id per conversation, so
 * the provider can route and cache per conversation instead of per request
 * (https://opencode.ai/v2/docs/console/go/). The id travels in
 * `x-opencode-session`.
 *
 * The ids live here rather than in the provider client: a session names a
 * *conversation*, and the surfaces that have one (a discussion) know it long
 * before the transport is reached. The client only carries the id along.
 */

import { randomToken } from "./random";

/**
 * The session id of a deployment-wide default.
 *
 * It stands in for a conversation that does not exist — the environment
 * configuration is shared by every workspace of the installation, so there is
 * no single conversation to name. It is random per process, so two
 * installations never share a bucket, and stable for the life of the
 * process, so the provider can still cache.
 */
export const DEPLOYMENT_SESSION_ID = `noema:deployment:${randomToken(9)}`;

/**
 * The session id of a workspace's requests.
 *
 * The one-shot surfaces (Ask AI, skills, autofill) are not conversations of
 * their own: the workspace is the stable scope they all share.
 */
export function workspaceSessionId(workspaceId: string): string {
  return `noema:workspace:${workspaceId}`;
}

/**
 * The session id of a conversation: the discussion's own id.
 *
 * A discussion is what a provider can cache per conversation, so its id is
 * the id that travels with every message of it.
 */
export function conversationSessionId(conversationId: string): string {
  return `noema:conversation:${conversationId}`;
}
