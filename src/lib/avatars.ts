/**
 * Avatar resolution & the presence-stack model (§7 Avatars).
 *
 * A user in this app may or may not have a photo (`User.avatarUrl`), and a
 * collaboration room shows a row of tiny faces with a `+N` overflow chip. This
 * module owns every decision that turns a user record into something paintable
 * and a room into a sentence — none of it touches the DOM, React, or the DB.
 *
 * The rules, in one place:
 *
 * - An avatar is either an **image** (a usable `avatarUrl`) or **initials**
 *   derived from the name, plus a deterministic background colour keyed by the
 *   user id and a contrasting foreground ink. Gravatar URLs are only honoured
 *   when allowed, and are sized to the requested render box.
 * - The presence stack dedupes by id, orders deterministically (id ascending),
 *   shows up to `max` faces and reports the rest as `+N`.
 * - A presence sentence reads `Ada`, `Ada and Bob` or `Ada, Bob and 3 others`.
 *
 * Everything is pure and synchronous: repeated calls with the same input return
 * byte-for-byte identical values, and no function mutates its arguments.
 */

import { parseHex } from "./color-palette";

/** The fixed render sizes an avatar may be requested at, in CSS pixels. */
export const AVATAR_SIZES = [16, 24, 32, 64, 128] as const;

/** One of the sanctioned avatar sizes. */
export type AvatarSize = (typeof AVATAR_SIZES)[number];

/** The default render size when none is given. */
const DEFAULT_SIZE: AvatarSize = 32;

/**
 * The avatar background palette — twelve mid-tone hues chosen to read at 16 px
 * and to carry white (or, for the lightest stops, near-black) initials. Order
 * only affects which colour a given hash lands on; the set is what matters.
 */
export const AVATAR_PALETTE: readonly string[] = [
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#84cc16", // lime
  "#10b981", // emerald
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#d946ef", // fuchsia
  "#ec4899", // pink
];

/** Ink colours used for initials on top of a {@link AVATAR_PALETTE} fill. */
const INK_LIGHT = "#ffffff";
const INK_DARK = "#18181b";

/**
 * The shape {@link resolveAvatar} needs. It intentionally mirrors the fields
 * the rest of the app already selects (`id`, `name`, `avatarUrl`) with an
 * optional `email` used only when the name is blank.
 */
export type AvatarUser = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  email?: string | null;
};

/** A resolved, ready-to-render avatar. */
export type Avatar = {
  kind: "image" | "initials";
  /** Present (and non-empty) only when `kind === "image"`. */
  src?: string;
  /** One or two characters standing in for the user. */
  initials: string;
  /** Deterministic `#rrggbb` background. */
  background: string;
  /** `#rrggbb` ink that contrasts against {@link background}. */
  foreground: string;
};

/** Options accepted by {@link resolveAvatar}. */
export type ResolveAvatarOptions = {
  size?: AvatarSize;
  /** When `false`, a gravatar URL is ignored in favour of initials. */
  allowGravatar?: boolean;
};

/** One face in a presence stack. */
export type StackEntry = {
  id: string;
  name: string;
  avatar: Avatar;
};

/** The outcome of laying out a presence stack. */
export type StackPlan = {
  visible: StackEntry[];
  overflow: number;
  /** `+N` when faces are hidden, otherwise an empty string. */
  overflowLabel: string;
};

/** Options accepted by {@link stackPlan}. */
export type StackOptions = {
  max?: number;
  size?: AvatarSize;
};

/** Options accepted by {@link presenceLabel}. */
export type PresenceLabelOptions = {
  selfId?: string | null;
};

/** Options accepted by {@link avatarSrcSet}. */
export type SrcSetOptions = {
  dpr?: number;
};

/** FNV-1a (32-bit) over UTF-16 code units — tiny, dependency-free, well-spread. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically map a seed to a palette colour. Keyed by user id, so the
 * same person keeps one colour across reloads, clients and page order.
 */
export function colourFor(seed: string): string {
  const key = typeof seed === "string" ? seed : "";
  return AVATAR_PALETTE[fnv1a(key) % AVATAR_PALETTE.length];
}

/** A letter or a number in any script (Latin, CJK, Cyrillic, …). */
const LETTERLIKE_RE = /[\p{L}\p{N}]/u;

function isLetterlike(char: string): boolean {
  return LETTERLIKE_RE.test(char);
}

/** Split a string into code points, so surrogate pairs are never torn apart. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * Derive one or two initials from a name.
 *
 * - Multi-token names ("Ada Lovelace", "Jean-Luc Picard") use the first letter
 *   of the first and last token.
 * - A single token ("Ada", "李雷") uses its first two letters.
 * - Splitting is on whitespace and hyphens; only letters/numbers count, so
 *   punctuation and emoji are skipped ("Ada 👍 Lovelace" → "AL").
 * - Text is compared by code point, so CJK names and astral-plane letters are
 *   never split mid-surrogate.
 * - A blank or letter-free name falls back to "?".
 */
export function initialsOf(name: string | null | undefined): string {
  const source = typeof name === "string" ? name : "";
  const tokens = source.trim().split(/[\s-]+/u).filter((token) => token.length > 0);
  const perToken = tokens
    .map((token) => codePoints(token).filter(isLetterlike))
    .filter((letters) => letters.length > 0);

  if (perToken.length === 0) return "?";

  const picked =
    perToken.length === 1
      ? perToken[0].slice(0, 2)
      : [perToken[0][0], perToken[perToken.length - 1][0]];
  return picked.join("").toUpperCase();
}

/** Linear sRGB channel for a 0–255 value (WCAG relative luminance). */
function srgbChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

/** Pick readable ink for a background: light fills take dark text and vice versa. */
function foregroundFor(background: string): string {
  return relativeLuminance(background) > 0.45 ? INK_DARK : INK_LIGHT;
}

/** Snap any input to a sanctioned size, defaulting to {@link DEFAULT_SIZE}. */
function normalizeSize(size: number | undefined): AvatarSize {
  const allowed: readonly number[] = AVATAR_SIZES;
  return typeof size === "number" && allowed.includes(size) ? (size as AvatarSize) : DEFAULT_SIZE;
}

/** The host of a URL, or "" when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url, "https://example.invalid").hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True for gravatar.com and its subdomains (www./secure./…). */
function isGravatarUrl(url: string): boolean {
  const host = hostOf(url);
  return host === "gravatar.com" || host.endsWith(".gravatar.com");
}

/** True for URLs a browser can load directly as an image. */
function isUsableImageUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) ||
    url.startsWith("/") ||
    /^data:image\//i.test(url) ||
    /^blob:/i.test(url)
  );
}

/** Set (or replace) the `s` size parameter on an absolute gravatar URL. */
function gravatarSrcWithSize(url: string, size: AvatarSize): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("s", String(size));
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Resolve a raw `avatarUrl` into a usable `src`, or `undefined` to fall back. */
function imageSrcFor(
  avatarUrl: string,
  size: AvatarSize,
  allowGravatar: boolean,
): string | undefined {
  if (!isUsableImageUrl(avatarUrl)) return undefined;
  const gravatar = isGravatarUrl(avatarUrl);
  if (gravatar && !allowGravatar) return undefined;
  if (gravatar) return gravatarSrcWithSize(avatarUrl, size);
  return avatarUrl;
}

/** The name to draw initials from: the name, else the email local part. */
function initialsSource(name: string, email: string): string {
  const trimmed = name.trim();
  if (trimmed !== "") return trimmed;
  const at = email.indexOf("@");
  return (at === -1 ? email : email.slice(0, at)).trim();
}

/** The colour seed: the user id, else the name, else the email. */
function seedFor(id: string, name: string, email: string): string {
  const trimmedId = id.trim();
  if (trimmedId !== "") return trimmedId;
  const trimmedName = name.trim();
  if (trimmedName !== "") return trimmedName;
  return email.trim();
}

/**
 * Turn a user into an avatar.
 *
 * The result is an **image** when `avatarUrl` is a loadable URL — gravatar URLs
 * get an `s=<size>` parameter so the bytes match the box, and are skipped
 * entirely when `allowGravatar` is `false`. Otherwise the result is **initials**
 * derived from the name (falling back to the email local part), filled with the
 * deterministic {@link colourFor} colour for the user id and readable ink.
 */
export function resolveAvatar(
  user: AvatarUser | null | undefined,
  options: ResolveAvatarOptions = {},
): Avatar {
  const size = normalizeSize(options.size);
  const allowGravatar = options.allowGravatar !== false;
  const id = typeof user?.id === "string" ? user.id : "";
  const name = typeof user?.name === "string" ? user.name : "";
  const email = typeof user?.email === "string" ? user.email : "";

  const background = colourFor(seedFor(id, name, email));
  const initials = initialsOf(initialsSource(name, email));
  const foreground = foregroundFor(background);

  const url = typeof user?.avatarUrl === "string" ? user.avatarUrl.trim() : "";
  const src = url === "" ? undefined : imageSrcFor(url, size, allowGravatar);
  if (src !== undefined) {
    return { kind: "image", src, initials, background, foreground };
  }
  return { kind: "initials", initials, background, foreground };
}

/**
 * Remove duplicate users by id, keeping the first occurrence.
 *
 * Entries with a blank id cannot be keyed and are dropped, so the result is
 * always a fresh, identity-stable list. Entries are shallow-copied so a caller
 * can never alias (and then mutate) the input.
 */
export function dedupeUsers(users: readonly AvatarUser[]): AvatarUser[] {
  const list = Array.isArray(users) ? users : [];
  const seen = new Set<string>();
  const out: AvatarUser[] = [];
  for (const user of list) {
    const id = typeof user?.id === "string" ? user.id.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...user });
  }
  return out;
}

/** Deterministic ordering: trimmed id ascending (unique after dedupe). */
function compareById(a: AvatarUser, b: AvatarUser): number {
  const aId = a.id.trim();
  const bId = b.id.trim();
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

/** Clamp `max` to a non-negative integer, defaulting to the stack width. */
function normalizeMax(max: number | undefined): number {
  if (typeof max !== "number" || !Number.isFinite(max)) return 5;
  return Math.max(0, Math.trunc(max));
}

/**
 * Lay out the presence stack: dedupe, order deterministically (id ascending),
 * then show the first `max` faces and summarise the rest.
 *
 * `overflowLabel` is `+N` only when someone is hidden, so a stack that fits
 * renders no chip. Each visible face is resolved at `size` (default 24).
 */
export function stackPlan(
  users: readonly AvatarUser[],
  options: StackOptions = {},
): StackPlan {
  const max = normalizeMax(options.max);
  const size = normalizeSize(options.size);
  const ordered = dedupeUsers(users).sort(compareById);

  const visible = ordered.slice(0, max).map((user) => ({
    id: user.id.trim(),
    name: user.name,
    avatar: resolveAvatar(user, { size }),
  }));

  const overflow = Math.max(0, ordered.length - visible.length);
  return { visible, overflow, overflowLabel: overflow > 0 ? `+${overflow}` : "" };
}

/**
 * Describe who is present in one sentence.
 *
 * - 0 (with a viewer) → `Only you`; 0 (no viewer) → `No one`.
 * - 1 → `Ada`; 2 → `Ada and Bob`.
 * - 3+ → `Ada, Bob and N others` (`1 other` singular).
 *
 * Names are deduped and ordered by id for a stable string; the viewer's own id
 * is dropped when `selfId` is given; blank names read as `Anonymous`.
 */
export function presenceLabel(
  users: readonly AvatarUser[],
  options: PresenceLabelOptions = {},
): string {
  const selfId = typeof options.selfId === "string" ? options.selfId.trim() : "";
  const others = dedupeUsers(users)
    .filter((user) => selfId === "" || user.id.trim() !== selfId)
    .sort(compareById);
  const names = others.map((user) => {
    const name = typeof user.name === "string" ? user.name.trim() : "";
    return name === "" ? "Anonymous" : name;
  });

  if (names.length === 0) return selfId === "" ? "No one" : "Only you";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** Clamp `dpr` to an integer in `1..4`, defaulting to 2. */
function normalizeDpr(dpr: number | undefined): number {
  if (typeof dpr !== "number" || !Number.isFinite(dpr)) return 2;
  return Math.min(4, Math.max(1, Math.trunc(dpr)));
}

/**
 * Build a `srcSet` for an image avatar: one `Nx` descriptor per density up to
 * `dpr` (default 2, clamped to `1..4`). No resize service is assumed, so the
 * same URL is repeated across densities — the browser still picks a density and
 * caches one fetch. An initials (or missing) avatar has no source, so the
 * result is an empty string.
 */
export function avatarSrcSet(
  avatar: Avatar | null | undefined,
  options: SrcSetOptions = {},
): string {
  if (!avatar || avatar.kind !== "image" || typeof avatar.src !== "string" || avatar.src === "") {
    return "";
  }
  const dpr = normalizeDpr(options.dpr);
  const entries: string[] = [];
  for (let factor = 1; factor <= dpr; factor += 1) {
    entries.push(`${avatar.src} ${factor}x`);
  }
  return entries.join(", ");
}

/**
 * A neutral initials avatar for a seed with no known user — e.g. an anonymous
 * cursor or a fallback before a user record loads. Deterministic in the seed.
 */
export function placeholderAvatar(seed: string): Avatar {
  const key = typeof seed === "string" ? seed : "";
  const background = colourFor(key);
  return {
    kind: "initials",
    initials: initialsOf(key),
    background,
    foreground: foregroundFor(background),
  };
}
