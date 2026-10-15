/**
 * Pure recipient resolution for mentions (docs/specs/notifications.md, the
 * recipient half of dispatch): who a mention notifies, who it deliberately
 * does not, and why - decided without a database so the same rules can be
 * unit-pinned and shared by a future server dispatcher.
 *
 * The module owns three deterministic pieces:
 *
 *  - `resolveRecipients` - fold the explicit `@`-mentions and the page's
 *    followers into one recipient set, excluding the author (R82.4),
 *    gating on workspace membership (R82.3) and capping the fan-out
 *    (R82.6);
 *  - `reasonFor` - look up why one id was suppressed, without re-running
 *    the pipeline;
 *  - `shouldNotifyMention` - the delivery decision for a directed mention,
 *    reusing `shouldNotify` from `notification-prefs` so there is exactly
 *    one interpretation of the stored preferences.
 *
 * Everything is pure: no prisma, no clock, no routes, no ambient state. The
 * order of `notify` follows the caller's input order (mentions first, then
 * followers, first occurrence wins), so equal inputs yield byte-identical
 * output; suppressed ids are unique and reported in the order first met.
 *
 * Unit-pinned red-first by `src/lib/mention-notify.test.ts`.
 */

import { shouldNotify } from "./notification-prefs";
import type {
  DeliveryDecision,
  NotificationEventType,
} from "./notification-prefs";

/**
 * Most recipients one mention event may fan out to (R82.6). Matches the
 * dispatcher's cap so a caller can pre-truncate before any write.
 */
export const MENTION_RECIPIENT_CAP = 200;

/** Why a candidate never made it into `notify`. */
export type MentionSuppressReason =
  | "self" //         the author mentioned themselves (R82.4)
  | "not-a-member" // not a member of the page's workspace (R82.3)
  | "over-cap"; //    past the per-event recipient cap (R82.6)

/** One id left out of the recipient set, with the rule that dropped it. */
export type SuppressedRecipient = {
  readonly id: string;
  readonly reason: MentionSuppressReason;
};

/** Everything `resolveRecipients` needs; ids are opaque user ids. */
export type ResolveRecipientsInput = {
  /** Users named explicitly via `@` in the body/doc, in mention order. */
  readonly mentionedIds: readonly string[];
  /** The actor; never notified of their own mention (R82.4). */
  readonly authorId?: string | null;
  /** Users following the page; notified after the explicit mentions. */
  readonly pageFollowerIds?: readonly string[];
  /** Allow-list gate: only members can be notified (R82.3). */
  readonly workspaceMemberIds: readonly string[];
  /** Override for the fan-out cap; defaults to {@link MENTION_RECIPIENT_CAP}. */
  readonly cap?: number;
};

/** The split a dispatcher writes from. */
export type ResolvedRecipients = {
  /** Unique, in first-seen order; length never exceeds the cap. */
  readonly notify: readonly string[];
  /** Unique suppressed ids, in first-seen order. */
  readonly suppressed: readonly SuppressedRecipient[];
};

/** Non-empty string ids only; blanks and runtime junk are ignored. */
function isRecipientId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Clamp an arbitrary cap to a non-negative integer, else the default. */
function normalizeCap(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : MENTION_RECIPIENT_CAP;
}

/**
 * Resolve who a mention notifies.
 *
 * Order of operations per candidate id (explicit mentions first, then page
 * followers): drop blanks and repeats; drop the author as `self`; drop
 * non-members as `not-a-member`; drop anything past `cap` as `over-cap`;
 * otherwise deliver. An id is decided exactly once, so an author who is also
 * a follower, or a mention repeated in both lists, never appears twice and
 * never lands in both halves of the result. Inputs are never mutated.
 */
export function resolveRecipients(
  input: ResolveRecipientsInput,
): ResolvedRecipients {
  const mentioned = input.mentionedIds ?? [];
  const followers = input.pageFollowerIds ?? [];
  const members = new Set(input.workspaceMemberIds ?? []);
  const authorId = input.authorId ?? null;
  const cap = normalizeCap(input.cap);

  const notify: string[] = [];
  const suppressed: SuppressedRecipient[] = [];
  const decided = new Set<string>();

  const consider = (id: string): void => {
    if (!isRecipientId(id) || decided.has(id)) return;
    decided.add(id);
    if (authorId !== null && id === authorId) {
      suppressed.push({ id, reason: "self" });
      return;
    }
    if (!members.has(id)) {
      suppressed.push({ id, reason: "not-a-member" });
      return;
    }
    if (notify.length >= cap) {
      suppressed.push({ id, reason: "over-cap" });
      return;
    }
    notify.push(id);
  };

  for (const id of mentioned) consider(id);
  for (const id of followers) consider(id);

  return { notify, suppressed };
}

/**
 * Why `id` was suppressed, or `undefined` when it was delivered (or was
 * never a candidate). The first matching entry wins, which is unambiguous
 * because `resolveRecipients` emits at most one entry per id.
 */
export function reasonFor(
  id: string,
  suppressed: readonly SuppressedRecipient[],
): MentionSuppressReason | undefined {
  for (const entry of suppressed) {
    if (entry.id === id) return entry.reason;
  }
  return undefined;
}

/** Where a mention arrived from; each kind maps to a stored event type. */
export type MentionKind = "comment" | "editor" | "reply";

/** Comment/editor mentions share `page.mention`; replies use `comment.reply`. */
const MENTION_EVENT_TYPE: Readonly<Record<MentionKind, NotificationEventType>> = {
  comment: "page.mention",
  editor: "page.mention",
  reply: "comment.reply",
};

/**
 * Delivery decision for a mention directed at the current user, reusing
 * `shouldNotify` so preferences have a single reading. A mention is by
 * definition addressed to the recipient, so `mentionsCurrentUser` is always
 * true; `kind` only selects the stored event type. Fails closed: an
 * unrecognised kind resolves to no event type and is suppressed.
 */
export function shouldNotifyMention(
  prefs: unknown,
  kind: MentionKind,
): DeliveryDecision {
  const type = MENTION_EVENT_TYPE[kind];
  return shouldNotify(prefs, { type, mentionsCurrentUser: true });
}
