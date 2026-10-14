/**
 * B90 — the single webhook event catalog (R24.18).
 *
 * PURE module: no `node:crypto`, no `prisma`, no server-only imports. That is
 * the whole point — `src/components/webhook-manager.tsx` must be able to build
 * its event picker without pulling the signature/delivery machinery that lives
 * in `./webhooks` (the node:crypto/prisma import problem B56 documented), while
 * the server dispatcher keeps importing the exact same list. ids, labels and
 * descriptions therefore have exactly one home, guarded by
 * `webhook-events.test.ts` (server list === client list, spec parity, grep gate).
 */

/** One catalog entry: wire id, picker label, user-facing copy. */
export type WebhookEventDefinition = {
  /**
   * `x-noema-event` wire value — what `dispatchWebhooks` sends, what
   * subscriptions store and what delivery logs record.
   */
  readonly id: string;
  /**
   * Picker display string. Today it equals the wire id on purpose: the dropdown
   * has always shown the raw event id, so this extraction renders byte-identical
   * text in every locale and needs no new i18n keys. R24.19 owns humanizing /
   * describing picker entries.
   */
  readonly label: string;
  /** One-line description for the picker (rendered when R24.19 groups the list). */
  readonly description: string;
};

export const WEBHOOK_EVENT_CATALOG = [
  {
    id: "page.created",
    label: "page.created",
    description: "A page was created in the workspace.",
  },
  {
    id: "page.updated",
    label: "page.updated",
    description: "A page's content was edited.",
  },
  {
    id: "row.created",
    label: "row.created",
    description: "A row was created in a database.",
  },
  {
    id: "comment.created",
    label: "comment.created",
    description: "A comment was posted on a page.",
  },
] as const satisfies readonly WebhookEventDefinition[];

/** Every dispatchable event id, derived from the catalog — never re-declared. */
export type WebhookEvent = (typeof WEBHOOK_EVENT_CATALOG)[number]["id"];

/**
 * The event ids in catalog order. Derived from `WEBHOOK_EVENT_CATALOG` so the
 * list cannot drift from the labels/descriptions; `src/lib/webhooks.ts`
 * re-exports this for the server side (export stays stable, R24.18).
 */
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = WEBHOOK_EVENT_CATALOG.map(
  ({ id }) => id,
);
