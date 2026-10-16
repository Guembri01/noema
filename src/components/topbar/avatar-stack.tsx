import {
  avatarSrcSet,
  dedupeUsers,
  presenceLabel,
  resolveAvatar,
  stackPlan,
  type Avatar,
  type AvatarSize,
  type AvatarUser,
} from "@/lib/avatars";
import { cn } from "@/lib/utils";

/**
 * Topbar presence/avatar stack (§7 Avatars, docs/specs/realtime-collab.md
 * R9.19). This is the surface the avatar engine was written for: a row of tiny
 * faces with a `+N` overflow chip, right of the page-actions cluster.
 *
 * The component owns no avatar logic of its own — `src/lib/avatars.ts` decides
 * every pixel: which faces are visible (`stackPlan`), what each one paints
 * (`resolveAvatar`, including the density `srcSet` for photo avatars) and the
 * one-sentence description of the room (`presenceLabel`). Only here is that
 * model turned into markup, so the rules stay provable without a DOM.
 */

/** The member shape the topbar receives from the route. */
export type TopbarMember = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  email?: string | null;
};

/** Shared empty list so a defaulted prop never invalidates a memo. */
export const NO_MEMBERS: readonly TopbarMember[] = [];

/**
 * Pure: narrow the route's member rows to {@link AvatarUser}s the engine
 * accepts. Blank ids cannot be keyed (dedupe/order would be unstable) and are
 * dropped; the id is trimmed so `"id"` and `" id "` collapse to one person.
 */
export function toAvatarUsers(
  members: readonly TopbarMember[] | null | undefined,
): AvatarUser[] {
  if (!Array.isArray(members)) return [];
  const users: AvatarUser[] = [];
  for (const member of members) {
    if (!member || typeof member !== "object") continue;
    if (typeof member.id !== "string" || member.id.trim() === "") continue;
    users.push({
      id: member.id.trim(),
      name: typeof member.name === "string" ? member.name : "",
      avatarUrl: member.avatarUrl ?? null,
      email: member.email ?? null,
    });
  }
  return users;
}

export type AvatarStackProps = {
  users: readonly AvatarUser[];
  /** The viewer's own id; dropped from the spoken label when present. */
  selfId?: string | null;
  /** Faces shown before the `+N` chip. Defaults to 5 (R9.19). */
  max?: number;
  /** Render size in CSS pixels. Defaults to 24 (R9.19). */
  size?: AvatarSize;
  className?: string;
};

/** One overlapping face: a photo when the engine resolved one, else initials. */
function AvatarFace({
  name,
  avatar,
  size,
}: {
  name: string;
  avatar: Avatar;
  size: AvatarSize;
}) {
  const label = name.trim() === "" ? "Anonymous" : name.trim();
  const srcSet = avatarSrcSet(avatar);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      style={{ backgroundColor: avatar.background, color: avatar.foreground }}
      className={cn(
        "-ml-2 grid shrink-0 place-items-center overflow-hidden rounded-full border-2 border-bg",
        "text-[10px] font-medium leading-none outline-none first:ml-0 focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      <span
        aria-hidden
        className="grid place-items-center"
        style={{ width: size, height: size }}
      >
        {avatar.kind === "image" && avatar.src ? (
          <img
            src={avatar.src}
            srcSet={srcSet === "" ? undefined : srcSet}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          avatar.initials
        )}
      </span>
    </button>
  );
}

/**
 * Render the presence stack. Absent or all-blank input renders nothing, so a
 * page with no resolvable viewers leaves the topbar untouched.
 */
export function AvatarStack({
  users,
  selfId = null,
  max = 5,
  size = 24,
  className,
}: AvatarStackProps) {
  const plan = stackPlan(users, { max, size });
  if (plan.visible.length === 0) return null;
  // `stackPlan` picks who shows and who overflows; the paint of each visible
  // face is re-resolved from the same user record so the render path is
  // explicit about the engine call that owns the pixels.
  const byId = new Map(dedupeUsers(users).map((user) => [user.id.trim(), user]));
  const label = presenceLabel(users, { selfId });

  return (
    <div
      role="group"
      aria-label={label}
      data-testid="topbar-avatar-stack"
      className={cn("flex items-center", className)}
    >
      {plan.visible.map((entry) => {
        const user = byId.get(entry.id);
        return (
          <AvatarFace
            key={entry.id}
            name={entry.name}
            avatar={user ? resolveAvatar(user, { size }) : entry.avatar}
            size={size}
          />
        );
      })}
      {plan.overflowLabel !== "" && (
        <span
          title={plan.overflowLabel}
          aria-hidden
          className="-ml-2 grid shrink-0 place-items-center rounded-full border-2 border-bg bg-surface-2 text-[10px] font-medium text-muted"
          style={{ width: size, height: size }}
        >
          {plan.overflowLabel}
        </span>
      )}
    </div>
  );
}
