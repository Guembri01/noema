import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import {
  AVATAR_SIZES,
  avatarSrcSet,
  presenceLabel,
  resolveAvatar,
  stackPlan,
  type AvatarSize,
  type AvatarUser,
} from "@/lib/avatars";

/**
 * Avatar + AvatarGroup (§7 "Avatars").
 *
 * Every face is resolved by `@/lib/avatars` (`resolveAvatar` / `initialsOf`), so
 * an avatar is either a real `<img>` with `alt` or a deterministic initials
 * tile. Sizes snap to the 16–128 window; the render box is set inline so an
 * image never causes a layout shift. A status ring and a presence stack (with
 * `+N` overflow and a hover tooltip listing the names) layer on top.
 */

export type AvatarStatus = "online" | "away" | "busy";

export const AVATAR_STATUSES: readonly AvatarStatus[] = ["online", "away", "busy"];

export const AVATAR_MIN_PX = 16;
export const AVATAR_MAX_PX = 128;

/** Type guard for a presence status coming from untrusted data. */
export function isAvatarStatus(value: unknown): value is AvatarStatus {
  return typeof value === "string" && (AVATAR_STATUSES as readonly string[]).includes(value);
}

/** Clamp any requested size into the 16–128 window (default 32). */
export function avatarSizePx(size: AvatarSize | number | null | undefined): number {
  const n = typeof size === "number" && Number.isFinite(size) ? Math.round(size) : 32;
  return Math.min(AVATAR_MAX_PX, Math.max(AVATAR_MIN_PX, n));
}

/** Snap an arbitrary pixel size to the nearest sanctioned `AVATAR_SIZES` step. */
export function nearestAvatarSize(size: AvatarSize | number | null | undefined): AvatarSize {
  const px = avatarSizePx(size);
  let best: AvatarSize = AVATAR_SIZES[0];
  for (const candidate of AVATAR_SIZES) {
    if (Math.abs(candidate - px) < Math.abs(best - px)) best = candidate;
  }
  return best;
}

/** Initials type size for a given box (40% of the box, never below 8px). */
export function initialsFontPx(size: AvatarSize | number | null | undefined): number {
  return Math.max(8, Math.round(avatarSizePx(size) * 0.4));
}

const STATUS_RING: Record<AvatarStatus, string> = {
  online: "bg-success",
  away: "bg-warning",
  busy: "bg-danger",
};

/** Ring colour for a status, or `""` for an unknown/absent status. */
export function statusRingClass(status: unknown): string {
  return isAvatarStatus(status) ? STATUS_RING[status] : "";
}

const STATUS_LABEL: Record<AvatarStatus, string> = {
  online: "Online",
  away: "Away",
  busy: "Busy",
};

/** Accessible label for a status, or `""` for an unknown/absent status. */
export function statusLabel(status: unknown): string {
  return isAvatarStatus(status) ? STATUS_LABEL[status] : "";
}

export type AvatarProps = {
  user?: AvatarUser | null;
  size?: AvatarSize | number;
  status?: AvatarStatus | null;
  /** Override the image/initials accessible name (defaults to the user name). */
  alt?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

function displayName(user: AvatarUser | null | undefined): string | undefined {
  const name = typeof user?.name === "string" ? user.name.trim() : "";
  return name === "" ? undefined : name;
}

export function Avatar({
  user,
  size = 32,
  status,
  alt,
  className,
  style,
  title,
  ...rest
}: AvatarProps) {
  const px = avatarSizePx(size);
  const avatar = resolveAvatar(user, { size: nearestAvatarSize(size) });
  const label = alt ?? displayName(user) ?? "Avatar";
  const isImage = avatar.kind === "image" && typeof avatar.src === "string";
  const ringClass = statusRingClass(status);
  const ringSize = Math.max(6, Math.round(px / 3));
  const statusText = statusLabel(status);

  return (
    <span
      {...rest}
      title={title ?? label}
      data-kind={avatar.kind}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold leading-none select-none",
        className,
      )}
      style={{ ...style, width: px, height: px, fontSize: initialsFontPx(px) }}
      role={isImage ? undefined : "img"}
      aria-label={isImage ? undefined : label}
    >
      {isImage ? (
        <img
          src={avatar.src}
          srcSet={avatarSrcSet(avatar) || undefined}
          alt={label}
          width={px}
          height={px}
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-full items-center justify-center"
          style={{ background: avatar.background, color: avatar.foreground }}
        >
          {avatar.initials}
        </span>
      )}
      {ringClass !== "" ? (
        <span
          aria-hidden
          data-status={status}
          className={cn("absolute bottom-0 end-0 rounded-full border-2 border-surface", ringClass)}
          style={{ width: ringSize, height: ringSize }}
        />
      ) : null}
      {statusText !== "" ? <span className="sr-only">{statusText}</span> : null}
    </span>
  );
}

export type AvatarGroupProps = {
  users?: readonly AvatarUser[];
  /** Maximum visible faces before the rest collapse into `+N` (default 4). */
  max?: number;
  size?: AvatarSize | number;
  /** The viewer, excluded from the hover tooltip sentence. */
  selfId?: string | null;
  /** Attach a hover `title` listing the names (default true). */
  tooltip?: boolean;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

export function AvatarGroup({
  users = [],
  max = 4,
  size = 32,
  selfId,
  tooltip = true,
  className,
  title,
  ...rest
}: AvatarGroupProps) {
  const px = avatarSizePx(size);
  const plan = stackPlan(users, { max, size: nearestAvatarSize(size) });
  const overlap = Math.round(px * 0.28);
  const label = presenceLabel(users, { selfId });
  const overlapStyle: CSSProperties = { marginInlineStart: -overlap };

  return (
    <span
      {...rest}
      role="group"
      aria-label={label}
      title={tooltip ? label : title}
      className={cn("inline-flex items-center align-middle", className)}
    >
      {plan.visible.map((entry, index) => (
        <Avatar
          key={entry.id}
          user={{ id: entry.id, name: entry.name }}
          size={size}
          alt={entry.name}
          className="border-2 border-surface"
          style={index === 0 ? undefined : overlapStyle}
        />
      ))}
      {plan.overflow > 0 ? (
        <span
          aria-hidden
          className="inline-flex shrink-0 items-center justify-center rounded-full border-2 border-surface bg-surface-2 font-semibold text-muted"
          style={{ ...overlapStyle, width: px, height: px, fontSize: initialsFontPx(px) }}
        >
          {plan.overflowLabel}
        </span>
      ) : null}
    </span>
  );
}
