/**
 * DOM-free header model for the page title: breadcrumb fitting, sticky-title
 * visibility, cover encoding/decoding and the last-edited adapter.
 *
 * Extracted from ./page-title; the public import path stays stable through that
 * module's re-export.
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  ImagePlus,
  Link as LinkIcon,
  Loader2,
  Lock,
  Move,
  Redo2,
  Smile,
  Star,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import {
  archivePageAction,
  getPageContentAction,
  movePageAction,
  toggleFavoriteAction,
  toggleFollowAction,
  transferPageAction,
  updatePageAction,
} from "@/server/actions/pages";
import {
  duplicatePageAction,
  getPageEditedAction,
  getPageMenuDataAction,
  type PageEditedInfo,
  type PageMenuData,
} from "@/server/actions/page-menu";
import { setPageTeamspaceAction } from "@/server/actions/teamspaces";
import { WhoHasAccess } from "@/components/who-has-access";
import { ShareDialog } from "@/components/share-dialog";
import { NotionImportDialog } from "@/components/notion-import-dialog";
import { NavHistory } from "@/components/nav-history";
import {
  ActionsMenu,
  EMOJIS,
  type ActionsMenuToggleKey,
  type NotifyLevel,
} from "@/components/topbar/actions-menu";
import { sendChatPrompt } from "@/components/topbar/chat-bridge";
import {
  AvatarStack,
  NO_MEMBERS,
  toAvatarUsers,
  type TopbarMember,
} from "@/components/topbar/avatar-stack";
import { useUndoRedo } from "@/components/providers/undo-redo-provider";
import {
  describeLastEdited,
  lastEditor,
  resolveDisplayName,
  type EditEvent,
} from "@/lib/last-edited";
import {
  appearanceClasses,
  parseAppearance,
  patchAppearance,
  type PageAppearance,
} from "@/lib/page-appearance";
import { isImageIcon, pageIconToCss, parsePageIcon, type PageIcon } from "@/lib/page-icon";
import {
  buildBreadcrumb,
  type BreadcrumbItem,
  type BreadcrumbPage,
} from "@/lib/breadcrumb";
import {
  DEFAULT_COVER_POSITION,
  formatObjectPosition,
  nudgePosition,
  parseCoverPosition,
  type CoverPosition,
} from "@/lib/cover-position";
import {
  GRADIENTS,
  coverCss,
  coverKey,
  validateCover,
  type CoverValue,
  type GradientId,
} from "@/lib/page-cover";
import { isImage, uploadFile } from "@/lib/upload-client";
import { pageToMarkdown } from "@/lib/serialize";
import type { TextBlock } from "@/lib/text-stats";
import { DUR, Z } from "@/lib/design-tokens";
import { t } from "@/lib/i18n";
import { estimateTextWidth } from "@/lib/text-measure";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Stored ProseMirror/RichNode JSON (`{ type: "doc", content: [...] }`) → the
 * minimal block tree `computeStats` walks. Unknown nodes are skipped rather
 * than coerced, so a malformed document only loses stats, never a render.
 */
export function mapTextBlocks(nodes: unknown): TextBlock[] {
  if (!Array.isArray(nodes)) return [];
  const blocks: TextBlock[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const { type, text, content } = node as {
      type?: unknown;
      text?: unknown;
      content?: unknown;
    };
    if (typeof type !== "string") continue;
    const children = mapTextBlocks(content);
    blocks.push({
      type,
      ...(typeof text === "string" ? { text } : {}),
      ...(children.length > 0 ? { children } : {}),
    });
  }
  return blocks;
}

export function collectTextBlocks(raw: unknown): TextBlock[] {
  const root =
    raw && typeof raw === "object" ? (raw as { content?: unknown }) : null;
  return mapTextBlocks(root?.content);
}

/**
 * A breadcrumb trail from the route (`getAncestorTrail`): root → … → parent,
 * the current page excluded. Kept `readonly` and defaulted to one shared empty
 * array so the memo below is not invalidated on every render.
 */
export type BreadcrumbTrail = readonly { id: string; title: string }[];

export const EMPTY_BREADCRUMB_TRAIL: BreadcrumbTrail = [];

/** Header crumbs beyond this budget collapse their middle into an overflow menu. */
export const HEADER_BREADCRUMB_MAX = 6;

/* ------------------------------------------------------------------------- *
 * Pure header geometry — the title-row model
 *
 * The header is the first thing a user sees, so its behaviour is decided by
 * small, DOM-free functions the node tests can pin: how many breadcrumbs fit
 * before the middle folds into an overflow menu, and when the compact sticky
 * title takes over from the in-page `h1`.
 * ------------------------------------------------------------------------- */

/** Font size (px) the header breadcrumb renders at (`text-sm` = 14). */
export const HEADER_CRUMB_FONT_PX = 14;

/** Width (px) reserved after each crumb for its separator + gap. */
export const HEADER_CRUMB_GAP_PX = 18;

/** Fewest crumbs the header keeps when the trail must collapse (root + current). */
export const HEADER_BREADCRUMB_MIN = 2;

/** Default inline width (px) budgeted for the breadcrumb trail. */
export const HEADER_BREADCRUMB_WIDTH_PX = 560;

/** Estimated inline width (px) of one breadcrumb, separator included. */
export function crumbWidthPx(label: string): number {
  return estimateTextWidth(label) * HEADER_CRUMB_FONT_PX + HEADER_CRUMB_GAP_PX;
}

/**
 * How many crumbs fit the header at `availablePx`, never fewer than
 * {@link HEADER_BREADCRUMB_MIN} (root + current) when both fit, never more than
 * {@link HEADER_BREADCRUMB_MAX}. The root and the current page are kept first;
 * spare room is filled from the deepest middle crumbs outward. A non-finite or
 * non-positive width falls back to {@link HEADER_BREADCRUMB_WIDTH_PX} rather
 * than collapsing the trail.
 */
export function headerBreadcrumbBudget(
  items: readonly BreadcrumbItem[],
  availablePx: number = HEADER_BREADCRUMB_WIDTH_PX,
): number {
  const count = items.length;
  if (count === 0) return 0;
  if (count === 1) return 1;
  const limit =
    Number.isFinite(availablePx) && availablePx > 0
      ? availablePx
      : HEADER_BREADCRUMB_WIDTH_PX;
  const ends = crumbWidthPx(items[0].label) + crumbWidthPx(items[count - 1].label);
  if (ends > limit) return 1;
  let used = ends;
  let budget = 2;
  for (let i = count - 2; i >= 1; i -= 1) {
    if (budget >= HEADER_BREADCRUMB_MAX) break;
    const next = used + crumbWidthPx(items[i].label);
    if (next > limit) break;
    used = next;
    budget += 1;
  }
  return Math.min(budget, count);
}

/**
 * Split a crumb trail into the crumbs that render inline and the middle crumbs
 * that fold into the overflow menu. Mirrors `truncateBreadcrumb`'s keep-ends
 * rule: the root and the current page always survive, and `budget === 1` keeps
 * the current page alone. Returns fresh arrays and never mutates `items`.
 */
export function splitBreadcrumbOverflow(
  items: readonly BreadcrumbItem[],
  budget: number,
): { visible: BreadcrumbItem[]; overflow: BreadcrumbItem[] } {
  const count = items.length;
  if (budget <= 0) return { visible: [], overflow: items.slice() };
  if (count <= budget) return { visible: items.slice(), overflow: [] };
  if (budget === 1) {
    return { visible: items.slice(-1), overflow: items.slice(0, count - 1) };
  }
  const tail = items.slice(count - (budget - 1));
  return { visible: [items[0], ...tail], overflow: items.slice(1, count - tail.length) };
}

/** Budget + split in one step: the layout the header renders for `availablePx`. */
export function layoutHeaderBreadcrumbs(
  items: readonly BreadcrumbItem[],
  availablePx: number = HEADER_BREADCRUMB_WIDTH_PX,
): { visible: BreadcrumbItem[]; overflow: BreadcrumbItem[] } {
  return splitBreadcrumbOverflow(items, headerBreadcrumbBudget(items, availablePx));
}

/**
 * Sticky-title threshold: the compact title fades into the sticky bar only once
 * the in-page `h1` has scrolled fully out of view — i.e. once the scroll offset
 * passes the `h1`'s top. Non-finite inputs fail closed (hidden), so a
 * not-yet-measured heading never flashes a title.
 */
export function stickyTitleVisible(scrollTop: number, h1Top: number): boolean {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(h1Top)) return false;
  return scrollTop > h1Top;
}

/** A persisted cover decoded into its tagged value plus the focal point. */
export type StoredCover = { value: CoverValue; position: CoverPosition };

/** Reverse lookup `coverCss` output → gradient preset id (mirrors the menu). */
export const GRADIENT_ID_BY_CSS: ReadonlyMap<string, GradientId> = new Map(
  (Object.keys(GRADIENTS) as GradientId[]).map(
    (id) => [GRADIENTS[id], id] as const,
  ),
);

/**
 * Split a stored cover string into its CSS value and the focal point encoded
 * after it (`"<css> <x>% <y>%"`). A cover without a position decodes centred.
 */
export function splitCoverCss(raw: string): { css: string; position: CoverPosition } {
  const match = raw.match(/^(.*\S)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return { css: raw, position: { ...DEFAULT_COVER_POSITION } };
  return {
    css: match[1],
    position: parseCoverPosition(`${match[2]}% ${match[3]}%`),
  };
}

/** `url("…")` / `url(…)` wrapper emitted by `coverCss` for an image cover. */
export const COVER_URL_CSS = /^url\(\s*["']?([^"')]+)["']?\s*\)$/i;

/**
 * Decode a persisted cover string through the page-cover engine, or `null` for
 * an absent/unrecognised value. Gradients match the catalog by CSS value; an
 * image's `url("…")` wrapper is unwrapped first and the href must pass
 * `isImageIcon`, so a hostile string never reaches the renderer as a banner.
 */
export function decodeCover(raw: string | null): StoredCover | null {
  if (!raw) return null;
  const { css, position } = splitCoverCss(raw);
  const gradientId = GRADIENT_ID_BY_CSS.get(css);
  if (gradientId) return { value: { type: "gradient", gradientId }, position };
  const imageMatch = COVER_URL_CSS.exec(css);
  const href = imageMatch ? imageMatch[1] : css;
  if (isImageIcon(href)) return { value: { type: "image", url: href }, position };
  return null;
}

/**
 * Encode a validated cover plus focal point back into the single `coverUrl`
 * column the save path persists. The centred default is omitted so a plain
 * preset round-trips byte-for-byte.
 */
export function encodeCover(value: CoverValue, position: CoverPosition): string {
  const css = coverCss(value);
  if (css === "") return "";
  const focal = formatObjectPosition(position);
  return focal === formatObjectPosition(DEFAULT_COVER_POSITION)
    ? css
    : `${css} ${focal}`;
}

/**
 * "Last edited by …" adapter (docs/MISSING_FEATURES §4, `src/lib/last-edited`).
 *
 * The page route exposes only the resolved editor name and the `updatedAt`
 * instant (`PageEditedInfo`), not the edit-event log the engine consumes, so
 * this rebuilds the single event that data implies, resolves the author through
 * `resolveDisplayName` (member first, the server's own name otherwise) and hands
 * the summary to `describeLastEdited`.
 *
 * Seam to make this lossless: `PageEditedInfo` should carry the last edit's
 * `actorId` — the `PageVersion.createdById` its query already reads — and its
 * `kind`, or the raw `EditEvent[]`, so `lastEditor` can pick the true newest
 * edit instead of the one synthetic event built here.
 */
export function lastEditedLabel(
  edited: PageEditedInfo | null,
  members: readonly TopbarMember[],
  now: Date,
): string {
  if (edited === null) return describeLastEdited(null, { now });
  const member = members.find((candidate) => candidate.name === edited.lastEditedBy);
  const event: EditEvent = {
    id: `page-edit:${edited.updatedAt}`,
    entityType: "page",
    entityId: "page",
    actorId: member?.id ?? edited.lastEditedBy ?? "",
    kind: "content",
    at: edited.updatedAt,
  };
  const latest = lastEditor([event], { entityId: "page" });
  const resolved = resolveDisplayName(latest, {
    members: members.map((candidate) => ({ id: candidate.id, name: candidate.name })),
    fallback: "unknown",
  });
  return describeLastEdited(latest, {
    now,
    // Prefer the member name; otherwise keep the server-resolved name so a
    // departed author still renders instead of "Unknown".
    actorName: resolved === "Unknown" ? edited.lastEditedBy : resolved,
  });
}

/** Px of scroll before the sticky bar gains its hairline + the title can appear. */
export const HEADER_SCROLL_HAIRLINE = 12;

