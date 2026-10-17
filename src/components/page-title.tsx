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
  type CoverValue,
  type GradientId,
} from "@/lib/page-cover";
import { pageToMarkdown } from "@/lib/serialize";
import type { TextBlock } from "@/lib/text-stats";
import { DUR, Z } from "@/lib/design-tokens";
import { estimateTextWidth } from "@/lib/text-measure";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Stored ProseMirror/RichNode JSON (`{ type: "doc", content: [...] }`) → the
 * minimal block tree `computeStats` walks. Unknown nodes are skipped rather
 * than coerced, so a malformed document only loses stats, never a render.
 */
function mapTextBlocks(nodes: unknown): TextBlock[] {
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

function collectTextBlocks(raw: unknown): TextBlock[] {
  const root =
    raw && typeof raw === "object" ? (raw as { content?: unknown }) : null;
  return mapTextBlocks(root?.content);
}

/**
 * A breadcrumb trail from the route (`getAncestorTrail`): root → … → parent,
 * the current page excluded. Kept `readonly` and defaulted to one shared empty
 * array so the memo below is not invalidated on every render.
 */
type BreadcrumbTrail = readonly { id: string; title: string }[];

const EMPTY_BREADCRUMB_TRAIL: BreadcrumbTrail = [];

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
type StoredCover = { value: CoverValue; position: CoverPosition };

/** Reverse lookup `coverCss` output → gradient preset id (mirrors the menu). */
const GRADIENT_ID_BY_CSS: ReadonlyMap<string, GradientId> = new Map(
  (Object.keys(GRADIENTS) as GradientId[]).map(
    (id) => [GRADIENTS[id], id] as const,
  ),
);

/**
 * Split a stored cover string into its CSS value and the focal point encoded
 * after it (`"<css> <x>% <y>%"`). A cover without a position decodes centred.
 */
function splitCoverCss(raw: string): { css: string; position: CoverPosition } {
  const match = raw.match(/^(.*\S)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return { css: raw, position: { ...DEFAULT_COVER_POSITION } };
  return {
    css: match[1],
    position: parseCoverPosition(`${match[2]}% ${match[3]}%`),
  };
}

/** `url("…")` / `url(…)` wrapper emitted by `coverCss` for an image cover. */
const COVER_URL_CSS = /^url\(\s*["']?([^"')]+)["']?\s*\)$/i;

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
function lastEditedLabel(
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

/**
 * Presentational props for {@link PageTitleRow}. Every handler and interactive
 * cluster is injected, so the row stays a pure function of its props and renders
 * identically on the server — which is what the SSR tests exercise.
 */
export type PageTitleRowProps = {
  workspaceSlug: string;
  workspaceName: string;
  pageId: string;
  title: string;
  icon: PageIcon;
  crumbs: readonly BreadcrumbItem[];
  locked: boolean;
  canEdit: boolean;
  favorite: boolean;
  following: boolean;
  followPending?: boolean;
  starPopped?: boolean;
  scrolled: boolean;
  showStickyTitle: boolean;
  editedLabel?: string | null;
  breadcrumbWidth?: number;
  h1Ref?: React.Ref<HTMLHeadingElement>;
  titleRef?: React.Ref<HTMLTextAreaElement>;
  onTitleChange: (value: string) => void;
  onTitleBlur: () => void;
  onTitleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onToggleIcon: () => void;
  onToggleFavorite: () => void;
  onToggleFollow: () => void;
  onCopyLink: () => void;
  onShare: () => void;
  iconMenu?: ReactNode;
  undoRedo?: ReactNode;
  actions?: ReactNode;
  avatars?: ReactNode;
  cover?: ReactNode;
  addCover?: ReactNode;
};

/**
 * The page header row — the first thing a user sees.
 *
 * It renders four parts: a muted, truncating breadcrumb trail (with a native
 * `<details>` overflow menu for the collapsed middle), the presence/actions
 * cluster, the compact sticky title that fades in once the in-page `h1` scrolls
 * out, and the inline-editable `h1`-scale title with its hover icon affordance.
 * Colours, radii, motion and layering all come from tokens; the seven states
 * (`default`/`hover`/`focus-visible`/`active`/`disabled`/`loading`/`error`) are
 * covered across the controls.
 */
export function PageTitleRow({
  workspaceSlug,
  workspaceName,
  pageId,
  title,
  icon,
  crumbs,
  locked,
  canEdit,
  favorite,
  following,
  followPending = false,
  starPopped = false,
  scrolled,
  showStickyTitle,
  editedLabel,
  breadcrumbWidth,
  h1Ref,
  titleRef,
  onTitleChange,
  onTitleBlur,
  onTitleKeyDown,
  onToggleIcon,
  onToggleFavorite,
  onToggleFollow,
  onCopyLink,
  onShare,
  iconMenu,
  undoRedo,
  actions,
  avatars,
  cover,
  addCover,
}: PageTitleRowProps) {
  const { visible, overflow } = layoutHeaderBreadcrumbs(crumbs, breadcrumbWidth);
  const displayTitle = title.trim() || "Untitled";
  const iconStyle = pageIconToCss(icon);

  return (
    <>
      <div
        className={cn(
          "relative sticky top-0 -mx-12 mb-2 flex items-center justify-between gap-2 bg-bg/85 px-12 py-2 backdrop-blur-sm u-colors",
          scrolled ? "border-b border-border" : "border-b border-transparent",
        )}
        style={{ zIndex: Z.sticky }}
        data-testid="page-title-bar"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-1 text-sm text-muted"
          >
            <a
              href={`/w/${workspaceSlug}`}
              className="focus-ring u-colors truncate rounded px-0.5 hover:text-fg"
            >
              {workspaceName}
            </a>
            {visible.map((crumb) => (
              <span key={crumb.id} className="flex min-w-0 items-center gap-1">
                <span aria-hidden className="shrink-0 px-0.5">
                  /
                </span>
                {crumb.id === pageId ? (
                  <span aria-current="page" className="truncate text-fg">
                    {crumb.label}
                  </span>
                ) : (
                  <a
                    href={`/w/${workspaceSlug}/${crumb.id}`}
                    className="focus-ring u-colors truncate rounded px-0.5 hover:text-fg"
                    title={crumb.label}
                  >
                    {crumb.label}
                  </a>
                )}
              </span>
            ))}
            {overflow.length > 0 && (
              <details className="relative shrink-0" data-testid="breadcrumb-overflow">
                <summary
                  aria-label={`Show ${overflow.length} more ${
                    overflow.length === 1 ? "page" : "pages"
                  }`}
                  className="focus-ring u-colors flex cursor-pointer list-none items-center rounded px-1 text-muted hover:bg-surface-2 hover:text-fg"
                >
                  …
                </summary>
                <ul
                  className="surface-raised absolute start-0 top-full mt-1 max-w-64 min-w-40 py-1 text-sm text-fg"
                  style={{ zIndex: Z.popover }}
                >
                  {overflow.map((crumb) => (
                    <li key={crumb.id}>
                      <a
                        href={`/w/${workspaceSlug}/${crumb.id}`}
                        className="focus-ring u-colors block truncate px-3 py-1 hover:bg-surface-2"
                        title={crumb.label}
                      >
                        {crumb.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {locked && (
              <span
                className="flex shrink-0 items-center rounded px-1 text-muted"
                role="img"
                aria-label="Page locked"
                title="This page is locked"
              >
                <Lock className="h-3.5 w-3.5" aria-hidden />
              </span>
            )}
          </nav>
          {showStickyTitle && (
            <span
              data-testid="sticky-title"
              className="animate-fade flex min-w-0 items-center gap-1.5 ps-2"
            >
              {icon.kind === "emoji" && (
                <span aria-hidden className="shrink-0 text-base leading-none">
                  {icon.value}
                </span>
              )}
              <span className="truncate text-sm font-semibold tracking-[-0.02em] text-fg">
                {displayTitle}
              </span>
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {editedLabel && (
            <span
              className="hidden whitespace-nowrap text-xs text-muted md:inline"
              suppressHydrationWarning
            >
              {editedLabel}
            </span>
          )}
          <button
            type="button"
            aria-label={following ? "Unfollow page" : "Follow page"}
            aria-pressed={following}
            aria-busy={followPending || undefined}
            title={following ? "Following" : "Follow"}
            disabled={followPending}
            onClick={onToggleFollow}
            className={cn(
              "focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50",
              following && "text-accent",
              followPending && "animate-pulse-soft",
            )}
          >
            {followPending ? (
              <Loader2 className="h-4 w-4" aria-hidden />
            ) : (
              <Bell className={cn("h-4 w-4", following && "fill-current")} aria-hidden />
            )}
          </button>
          <button
            type="button"
            aria-label="Share"
            onClick={onShare}
            className="focus-ring u-interactive flex h-7 items-center gap-1 rounded px-2 text-sm text-muted hover:bg-surface-2"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Share</span>
          </button>
          <button
            type="button"
            aria-label="Copy link"
            title="Copy link"
            onClick={onCopyLink}
            className="focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <LinkIcon className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={favorite}
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            onClick={onToggleFavorite}
            className={cn(
              "focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2",
              favorite && "text-warning",
            )}
          >
            <Star
              className={cn("h-4 w-4", favorite && "fill-current")}
              style={
                starPopped
                  ? { animation: "scale-in var(--dur-2) var(--ease-spring) both" }
                  : undefined
              }
              aria-hidden
            />
          </button>
          {undoRedo}
          {actions}
          {avatars}
        </div>
      </div>

      {cover}

      <div className="group/title relative">
        <div className="relative mb-1 flex h-8 items-center gap-1">
          {icon.kind !== "none" ? (
            <button
              type="button"
              disabled={!canEdit}
              onClick={onToggleIcon}
              aria-label="Change icon"
              className={cn(
                "focus-ring u-interactive rounded p-0.5 leading-none hover:bg-surface-2 disabled:cursor-not-allowed",
                icon.kind === "emoji" && "text-5xl",
                icon.kind === "image" && "h-14 w-14 bg-cover bg-center bg-no-repeat",
              )}
              style={iconStyle}
            >
              {icon.kind === "emoji" ? icon.value : null}
            </button>
          ) : canEdit ? (
            <button
              type="button"
              onClick={onToggleIcon}
              aria-label="Add icon"
              className="focus-ring u-colors flex items-center gap-1 rounded px-1 py-0.5 text-sm text-muted opacity-0 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 group-hover/title:opacity-100"
            >
              <Smile className="h-4 w-4" aria-hidden /> Add icon
            </button>
          ) : null}
          {iconMenu}
        </div>
        <h1 ref={h1Ref} className="scroll-mt-16">
          <textarea
            ref={titleRef}
            aria-label="Page title"
            value={title}
            readOnly={!canEdit}
            placeholder="Untitled"
            rows={1}
            spellCheck={false}
            onChange={(event) => {
              onTitleChange(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${event.target.scrollHeight}px`;
            }}
            onBlur={onTitleBlur}
            onKeyDown={onTitleKeyDown}
            className="w-full resize-none overflow-hidden bg-transparent text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] text-fg outline-none placeholder:text-muted/40"
          />
        </h1>
        {addCover}
      </div>
    </>
  );
}

export function PageTitle({
  locale = "en",
  pageId,
  workspaceId,
  workspaceSlug,
  workspaceName,
  initialTitle,
  initialIcon,
  initialCover,
  initialFavorite,
  initialFullWidth,
  initialSmallText,
  initialFont,
  initialLineSpacing = "normal",
  initialAppearance,
  initialSharedToken,
  initialFollowing,
  initialLocked,
  breadcrumbTrail = EMPTY_BREADCRUMB_TRAIL,
  workspaces = [],
  teamspaces = [],
  members = NO_MEMBERS,
  editable,
}: {
  pageId: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  initialTitle: string;
  initialIcon: string | null;
  initialCover: string | null;
  initialFavorite: boolean;
  initialFullWidth: boolean;
  initialSmallText: boolean;
  initialFont: string;
  /** Persisted line-spacing preset (`Page.lineSpacing`); parseAppearance sanitizes the raw column value. */
  initialLineSpacing?: string;
  /** Forward-compatible seed for the full appearance JSON once persisted. */
  initialAppearance?: unknown;
  initialSharedToken: string | null;
  initialFollowing: boolean;
  initialLocked: boolean;
  /**
   * Ancestor trail from the route (`getAncestorTrail`, root → … → parent).
   * Optional and additive: when omitted the header keeps the two static
   * workspace/title crumbs.
   */
  breadcrumbTrail?: BreadcrumbTrail;
  workspaces?: { id: string; name: string; slug: string }[];
  /** Workspace members; resolved into the topbar presence/avatar stack. */
  members?: readonly TopbarMember[];
  teamspaces?: { id: string; name: string; icon: string | null }[];
  editable: boolean;
  locale?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [title, setTitle] = useState(initialTitle);
  const [icon, setIcon] = useState(initialIcon);
  const [cover, setCover] = useState(initialCover);
  const [favorite, setFavorite] = useState(initialFavorite);
  const [fullWidth, setFullWidth] = useState(initialFullWidth);
  const [appearance, setAppearance] = useState<PageAppearance>(() =>
    initialAppearance !== undefined
      ? parseAppearance(initialAppearance)
      : parseAppearance({
          fontSize: initialSmallText ? "small" : "default",
          font: initialFont,
          lineSpacing: initialLineSpacing,
        }),
  );
  const [shareToken, setShareToken] = useState(initialSharedToken);
  const [following, setFollowing] = useState(initialFollowing);
  const [locked, setLocked] = useState(initialLocked);
  // The stored `coverUrl` is decoded once per value into a validated tagged
  // cover plus its focal point; the banner renders from the decoded value and a
  // dragged focal point is re-encoded on release.
  const storedCover = useMemo(() => decodeCover(cover), [cover]);
  const [coverPosition, setCoverPosition] = useState<CoverPosition>(
    () => decodeCover(initialCover)?.position ?? { ...DEFAULT_COVER_POSITION },
  );
  const coverDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPosition: CoverPosition;
    lastPosition: CoverPosition;
    width: number;
    height: number;
  } | null>(null);
  // A locked page is read-only even for otherwise-editable members; the server
  // already folds `!page.locked` into `editable`, but the lock can also flip at
  // runtime through the actions menu before the route refreshes.
  const canEdit = editable && !locked;
  const [showEmoji, setShowEmoji] = useState(false);
  const [showCover, setShowCover] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const h1Ref = useRef<HTMLHeadingElement | null>(null);
  // The in-page `h1`'s offset inside the scroll container, cached so each scroll
  // tick compares against a stable threshold (re-measured on resize / cover swap).
  const h1TopRef = useRef(Number.POSITIVE_INFINITY);
  const [scrolled, setScrolled] = useState(false);
  const [showStickyTitle, setShowStickyTitle] = useState(false);
  const [starPopped, setStarPopped] = useState(false);
  const [followPending, setFollowPending] = useState(false);
  const [draggingCover, setDraggingCover] = useState(false);
  const [repositioning, setRepositioning] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [edited, setEdited] = useState<PageEditedInfo | null>(null);
  const [menuData, setMenuData] = useState<PageMenuData | null>(null);
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);

  // The two legacy booleans now read through the appearance engine.
  const smallText = appearance.fontSize === "small";
  const font = appearance.font;

  // Global undo/redo (mounted by the root layout) drives the topbar controls.
  const { canUndo, canRedo, undo: undoGlobal, redo: redoGlobal } = useUndoRedo();
  // Workspace members → the presence/avatar stack model (src/lib/avatars.ts).
  const avatarUsers = useMemo(() => toAvatarUsers(members), [members]);

  // A stored icon is either an emoji glyph or an http(s) image URL; classify it
  // so `PageTitleRow` shows text for the former and a CSS background for the
  // latter, instead of spilling a raw URL into the heading.
  const pageIcon = parsePageIcon(icon);

  // Ancestor header trail: only the route-supplied ancestors are chained; with
  // no trail the render falls back to the workspace/title crumbs. The engine
  // walk is cycle-safe and fail-closed; a deep chain is folded into an overflow
  // menu by `PageTitleRow` (width-budgeted), never truncated to an ellipsis.
  const crumbs = useMemo<BreadcrumbItem[]>(() => {
    if (breadcrumbTrail.length === 0) return [];
    const pages: BreadcrumbPage[] = breadcrumbTrail.map((ancestor, index) => ({
      id: ancestor.id,
      parentId: index === 0 ? null : breadcrumbTrail[index - 1].id,
      title: ancestor.title,
    }));
    pages.push({
      id: pageId,
      parentId: breadcrumbTrail[breadcrumbTrail.length - 1].id,
      title,
    });
    return buildBreadcrumb(pages, pageId);
  }, [breadcrumbTrail, pageId, title]);

  const notifyKey = `noema:page-notify:${pageId}`;
  const [notifyLevel, setNotifyLevel] = useState<NotifyLevel>("all");

  // Cache the in-page `h1`'s offset inside the scroll container. Recomputed only
  // on resize (and after mount), so the scroll tick stays a cheap comparison.
  const measureH1Top = useCallback(() => {
    const container = document.getElementById("main");
    const heading = h1Ref.current;
    if (!container || !heading) return;
    h1TopRef.current =
      heading.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
  }, []);

  useEffect(() => {
    measureH1Top();
    window.addEventListener("resize", measureH1Top);
    return () => window.removeEventListener("resize", measureH1Top);
  }, [measureH1Top]);

  // Notion keeps the action bar visible and fades the page title into it only
  // once the in-page `h1` has scrolled out of view. The listener is rAF-throttled
  // so a fast wheel never queues a setState per event, and it never runs on the
  // initial paint (both flags start hidden), so a restored scroll position can
  // never flash a title before the user moves.
  useEffect(() => {
    const container = document.getElementById("main");
    if (!container) return;
    let frame = 0;
    const tick = () => {
      frame = 0;
      const top = container.scrollTop;
      setScrolled(top > HEADER_SCROLL_HAIRLINE);
      setShowStickyTitle(stickyTitleVisible(top, h1TopRef.current));
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(tick);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  // Relative "Edited … ago" label in the topbar.
  useEffect(() => {
    let alive = true;
    getPageEditedAction(pageId).then((result) => {
      if (alive && "updatedAt" in result) setEdited(result);
    });
    return () => {
      alive = false;
    };
  }, [pageId]);

  // Per-page comment notification level (localStorage — no server model yet).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(notifyKey);
      setNotifyLevel(
        stored === "mentions" || stored === "none" ? stored : "all",
      );
    } catch {
      setNotifyLevel("all");
    }
  }, [notifyKey]);

  // The persisted cover carries its focal point, so re-seed the drag state
  // whenever the stored string changes: a cover swap in the menu (or another
  // client) is reflected without a remount. A cover adds/removes height above
  // the heading, so the sticky-title threshold is re-measured too.
  useEffect(() => {
    setCoverPosition(
      decodeCover(cover)?.position ?? { ...DEFAULT_COVER_POSITION },
    );
    measureH1Top();
  }, [cover, measureH1Top]);

  // Keep the full-width toggle truthful to the server after a refresh: the
  // local state flips optimistically for the menu, then reconciles with the
  // value the route re-rendered from `Page.fullWidth`.
  useEffect(() => {
    setFullWidth(initialFullWidth);
  }, [initialFullWidth]);

  // Line spacing is server-backed (`Page.lineSpacing`) and seeded through the
  // appearance state above; no localStorage layer remains. A server
  // `initialAppearance` still wins when present.

  const save = (patch: Record<string, unknown>, revalidate = true) =>
    startTransition(async () => {
      await updatePageAction(pageId, patch);
      if (revalidate) router.refresh();
    });

  const saveTitle = () => {
    if (!canEdit || title === initialTitle) return;
    save({ title });
  };

  const pickIcon = (emoji: string) => {
    setIcon(emoji);
    setShowEmoji(false);
    save({ icon: emoji });
  };

  const pickCover = (value: string | null) => {
    setCover(value);
    setShowCover(false);
    save({ coverUrl: value });
  };

  // Optimistic follow toggle: the bell flips immediately and shows a pending
  // (pulsing) state until the server confirms, then reconciles with its answer.
  const toggleFollow = () => {
    if (followPending) return;
    setFollowPending(true);
    const optimistic = !following;
    setFollowing(optimistic);
    startTransition(async () => {
      try {
        const result = await toggleFollowAction(workspaceId, pageId);
        if ("ok" in result) {
          setFollowing(result.following);
          toast.success(result.following ? "Following page" : "Unfollowed");
        } else {
          setFollowing(!optimistic);
          toast.error(result.error);
        }
        router.refresh();
      } finally {
        setFollowPending(false);
      }
    });
  };

  // Star toggle with a small spring "pop": the glyph re-animates on every flip.
  const toggleFavorite = () => {
    const optimistic = !favorite;
    setFavorite(optimistic);
    setStarPopped(true);
    window.setTimeout(() => setStarPopped(false), DUR.slow);
    startTransition(async () => {
      const result = await toggleFavoriteAction(workspaceId, pageId);
      if ("ok" in result) setFavorite(result.favorite);
      else toast.error(result.error);
      router.refresh();
    });
  };

  // ---- Cover reposition (drag the banner) --------------------------------
  const onCoverPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canEdit || !storedCover || event.button !== 0) return;
    const surface = event.currentTarget;
    coverDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: coverPosition,
      lastPosition: coverPosition,
      width: surface.clientWidth || 1,
      height: surface.clientHeight || 1,
    };
    surface.setPointerCapture(event.pointerId);
    // 1:1 drag: the banner drops its transition while the pointer is down.
    setDraggingCover(true);
  };

  const onCoverPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = coverDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // Dragging the image under a fixed viewport moves its visible centre the
    // opposite way, so a rightward pointer reveals the left of the image.
    const dx = (-(event.clientX - drag.startX) / drag.width) * 100;
    const dy = (-(event.clientY - drag.startY) / drag.height) * 100;
    const next = nudgePosition(drag.startPosition, dx, dy);
    drag.lastPosition = next;
    setCoverPosition(next);
  };

  const endCoverDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = coverDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    coverDragRef.current = null;
    setDraggingCover(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
    if (storedCover) {
      save({ coverUrl: encodeCover(storedCover.value, drag.lastPosition) });
    }
  };

  // ---- Actions menu handlers ---------------------------------------------
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Could not copy link");
    }
  };

  const copyPageContents = async () => {
    try {
      const result = await getPageContentAction(pageId);
      if ("error" in result) throw new Error(result.error);
      const markdown = pageToMarkdown(result.title || title, result.content);
      await navigator.clipboard.writeText(markdown);
      toast.success("Page contents copied");
    } catch {
      toast.error("Could not copy page contents");
    }
  };

  const fetchMenuData = () => {
    getPageMenuDataAction(pageId).then((result) => {
      if ("updatedAt" in result) setMenuData(result);
    });
    // The menu's word-count footer prefers text-stats over the server tally,
    // so load the document once per open and derive the block tree locally.
    getPageContentAction(pageId).then((result) => {
      if (!("error" in result)) setBlocks(collectTextBlocks(result.content));
    });
  };

  const duplicate = () =>
    startTransition(async () => {
      const result = await duplicatePageAction(pageId);
      if ("ok" in result) {
        toast.success("Duplicated");
        router.push(`/w/${workspaceSlug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const moveTo = (targetId: string | null) =>
    startTransition(async () => {
      const result = await movePageAction(pageId, targetId);
      if ("ok" in result) {
        toast.success("Page moved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const trash = () =>
    startTransition(async () => {
      await archivePageAction(pageId);
      toast.success("Moved to trash");
      router.push(`/w/${workspaceSlug}`);
      router.refresh();
    });

  const undoEditor = () => {
    const editor = document.querySelector<HTMLElement>(".ProseMirror");
    if (!editor) {
      toast.error("Nothing to undo here");
      return;
    }
    editor.focus();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const scrollToHistory = () => {
    const heading = Array.from(document.querySelectorAll("h2")).find((node) =>
      /^(version\s+)?history$/i.test(node.textContent?.trim() ?? ""),
    );
    const section = heading?.closest("section");
    if (section ?? heading) {
      (section ?? heading)!.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      document
        .getElementById("main")
        ?.scrollTo({ top: 99999, behavior: "smooth" });
    }
  };

  const applyNotify = (level: NotifyLevel) => {
    setNotifyLevel(level);
    try {
      window.localStorage.setItem(notifyKey, level);
    } catch {
      // localStorage unavailable (private mode) — keep the in-memory value.
    }
    const label =
      level === "all" ? "All comments" : level === "mentions" ? "Mentions only" : "Off";
    toast.success(`Comment notifications: ${label}`);
  };

  // Single funnel for the page-appearance engine. The sanitized patch is
  // applied locally first, then every field the page model understands
  // (smallText, font, lineSpacing) is persisted through the update action, so
  // a reload re-seeds from the server.
  const applyAppearance = (patch: Partial<PageAppearance>) => {
    const next = patchAppearance(appearance, patch);
    setAppearance(next);
    const persisted: Record<string, unknown> = {};
    if (patch.fontSize !== undefined || patch.font !== undefined) {
      persisted.smallText = next.fontSize === "small";
      persisted.font = next.font;
    }
    if (patch.lineSpacing !== undefined) {
      persisted.lineSpacing = next.lineSpacing;
    }
    if (Object.keys(persisted).length > 0) save(persisted);
  };

  const applyStyle = (value: string) => {
    if (value === "default" || value === "serif" || value === "mono") {
      applyAppearance({ font: value });
    }
  };

  const applyToggle = (key: ActionsMenuToggleKey) => {
    if (key === "smallText") {
      applyAppearance({
        fontSize: appearance.fontSize === "small" ? "default" : "small",
      });
    } else if (key === "fullWidth") {
      const next = !fullWidth;
      setFullWidth(next);
      save({ fullWidth: next });
    } else {
      const next = !locked;
      setLocked(next);
      save({ locked: next });
    }
  };

  const transferToWorkspace = (targetWorkspaceId: string) =>
    startTransition(async () => {
      const target = workspaces.find(
        (candidate) => candidate.id === targetWorkspaceId,
      );
      const result = await transferPageAction(pageId, targetWorkspaceId);
      if ("ok" in result) {
        toast.success(`Moved to ${target?.name ?? "workspace"}`);
        if (target) router.push(`/w/${target.slug}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const moveToTeamspace = (teamspaceId: string | null) =>
    startTransition(async () => {
      const result = await setPageTeamspaceAction(pageId, teamspaceId);
      if ("ok" in result) {
        if (teamspaceId) {
          const teamspace = teamspaces.find((item) => item.id === teamspaceId);
          toast.success(`Moved to ${teamspace?.name ?? "teamspace"}`);
        } else {
          toast.success("Removed from teamspace");
        }
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  return (
    <header className={cn("mb-4", ...appearanceClasses(appearance))}>
      <PageTitleRow
        workspaceSlug={workspaceSlug}
        workspaceName={workspaceName}
        pageId={pageId}
        title={title}
        icon={pageIcon}
        crumbs={crumbs}
        locked={locked}
        canEdit={canEdit}
        favorite={favorite}
        following={following}
        followPending={followPending}
        starPopped={starPopped}
        scrolled={scrolled}
        showStickyTitle={showStickyTitle}
        editedLabel={edited ? lastEditedLabel(edited, members, new Date()) : null}
        h1Ref={h1Ref}
        titleRef={titleRef}
        onTitleChange={setTitle}
        onTitleBlur={saveTitle}
        onTitleKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            titleRef.current?.blur();
          }
        }}
        onToggleIcon={() => setShowEmoji((value) => !value)}
        onToggleFavorite={toggleFavorite}
        onToggleFollow={toggleFollow}
        onCopyLink={() => void copyLink()}
        onShare={() => setShareOpen(true)}
        iconMenu={
          showEmoji || showCover ? (
            <div
              role="dialog"
              aria-label={showEmoji ? "Pick an icon" : "Pick a cover"}
              /* `top-14` clears the icon itself (h-14 = 56px): the row is only h-8,
                 so the emoji overflows it and anchoring to the row left this panel
                 sitting on top of the glyph. Portalled so an ancestor cannot clip
                 or re-root it either. */
              className="surface-raised absolute start-0 top-14 p-2"
              style={{ zIndex: Z.popover, width: 288 }}
            >
              {showEmoji && (
                <div className="grid grid-cols-8 gap-1">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`Set icon ${emoji}`}
                      onClick={() => pickIcon(emoji)}
                      className="focus-ring grid h-8 w-8 place-items-center rounded text-lg hover:bg-surface-2"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
              {showCover && (
                <div className="grid grid-cols-4 gap-2">
                  {(Object.keys(GRADIENTS) as GradientId[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={`Set cover ${id}`}
                      aria-pressed={
                        storedCover?.value.type === "gradient" &&
                        storedCover.value.gradientId === id
                      }
                      onClick={() => pickCover(GRADIENTS[id])}
                      className="focus-ring h-12 rounded-sm bg-cover"
                      style={{
                        backgroundImage: coverCss({
                          type: "gradient",
                          gradientId: id,
                        }),
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null
        }
        undoRedo={
          <div
            role="group"
            aria-label="Undo and redo"
            className="flex items-center gap-0.5"
          >
            <button
              type="button"
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              disabled={!canUndo}
              onClick={undoGlobal}
              className="focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={redoGlobal}
              className="focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        }
        actions={
          <ActionsMenu
            pageId={pageId}
            title={title || "Untitled"}
            editable={editable}
            font={font}
            fullWidth={fullWidth}
            smallText={smallText}
            locked={locked}
            cover={cover}
            data={menuData}
            notifyLevel={notifyLevel}
            appearance={appearance}
            content={blocks ?? undefined}
            workspaces={workspaces}
            teamspaces={teamspaces}
            onOpening={fetchMenuData}
            onToggle={applyToggle}
            onStyle={applyStyle}
            onAppearance={applyAppearance}
            onCopyLink={() => void copyLink()}
            onCopyContents={() => void copyPageContents()}
            onDuplicate={duplicate}
            onMoveTo={moveTo}
            onTrash={trash}
            onUndo={undoEditor}
            onImport={() => setImportOpen(true)}
            onVersionHistory={scrollToHistory}
            onNotify={applyNotify}
            onWorkspaceMove={transferToWorkspace}
            onMoveTeamspace={moveToTeamspace}
            onShareAccess={() => setAccessOpen(true)}
            onChatPrompt={sendChatPrompt}
            onPickIcon={pickIcon}
            onPickCover={pickCover}
          />
        }
        avatars={<AvatarStack users={avatarUsers} className="ms-1" />}
        cover={
          storedCover ? (
            <div className="group/cover relative -mx-12 mb-4">
              <div
                className={cn(
                  "aspect-[16/6] max-h-64 w-full bg-cover bg-center bg-no-repeat",
                  canEdit && "cursor-grab touch-none active:cursor-grabbing",
                  draggingCover && "u-no-transition",
                )}
                style={{
                  backgroundImage: coverCss(storedCover.value),
                  backgroundPosition: formatObjectPosition(coverPosition),
                }}
                aria-label={canEdit ? "Page cover — drag to reposition" : "Page cover"}
                onPointerDown={onCoverPointerDown}
                onPointerMove={onCoverPointerMove}
                onPointerUp={endCoverDrag}
                onPointerCancel={endCoverDrag}
              />
              {canEdit && (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 p-3 focus-within:opacity-100 group-hover/cover:opacity-100",
                    repositioning ? "opacity-100" : "opacity-0",
                  )}
                  style={{ transition: "opacity var(--dur-1) var(--ease-smooth)" }}
                >
                  <span className="pointer-events-none me-auto flex items-center gap-1 rounded-sm bg-bg/85 px-2 py-1 text-xs text-muted shadow-1">
                    <Move className="h-3.5 w-3.5" aria-hidden /> Drag to reposition
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowCover(true)}
                    className="focus-ring u-colors pointer-events-auto flex h-7 items-center gap-1 rounded-sm bg-bg/90 px-2 text-xs text-fg shadow-1 hover:bg-bg"
                  >
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden /> Change cover
                  </button>
                  <button
                    type="button"
                    aria-pressed={repositioning}
                    onClick={() => setRepositioning((value) => !value)}
                    className={cn(
                      "focus-ring u-colors pointer-events-auto flex h-7 items-center gap-1 rounded-sm bg-bg/90 px-2 text-xs text-fg shadow-1 hover:bg-bg",
                      repositioning && "text-accent",
                    )}
                  >
                    <Move className="h-3.5 w-3.5" aria-hidden /> Reposition
                  </button>
                  <button
                    type="button"
                    onClick={() => pickCover(null)}
                    className="focus-ring u-colors pointer-events-auto flex h-7 items-center gap-1 rounded-sm bg-bg/90 px-2 text-xs text-fg shadow-1 hover:bg-bg"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                  </button>
                </div>
              )}
            </div>
          ) : null
        }

        addCover={
          canEdit && !storedCover ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowCover(true)}
                className="focus-ring u-colors rounded px-1 py-0.5 text-sm text-muted hover:bg-surface-2"
              >
                <ImagePlus className="mr-1 inline h-4 w-4" aria-hidden /> Add cover
              </button>
            </div>
          ) : null
        }
      />
      {accessOpen && (
        <WhoHasAccess
          pageId={pageId}
          locale={locale}
          onClose={() => setAccessOpen(false)}
        />
      )}
      <ShareDialog
        open={shareOpen}
        pageId={pageId}
        token={shareToken}
        locale={locale}
        onTokenChange={setShareToken}
        onClose={() => setShareOpen(false)}
      />
      <NotionImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        workspaceId={workspaceId}
        slug={workspaceSlug}
        locale={locale}
      />
    </header>
  );
}
