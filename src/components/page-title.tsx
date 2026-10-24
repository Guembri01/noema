"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
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
import { UndoHistoryControl } from "@/components/undo-history";
import {
  archivePageAction,
  getPageContentAction,
  movePageAction,
  restorePageAction,
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
import { NavHistory } from "@/components/nav-history";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { contentDirProps } from "@/lib/bidi";
import { toast } from "sonner";

import {
  mapTextBlocks,
  collectTextBlocks,
  BreadcrumbTrail,
  EMPTY_BREADCRUMB_TRAIL,
  HEADER_BREADCRUMB_MAX,
  HEADER_CRUMB_FONT_PX,
  HEADER_CRUMB_GAP_PX,
  HEADER_BREADCRUMB_MIN,
  HEADER_BREADCRUMB_WIDTH_PX,
  crumbWidthPx,
  headerBreadcrumbBudget,
  splitBreadcrumbOverflow,
  layoutHeaderBreadcrumbs,
  stickyTitleVisible,
  StoredCover,
  GRADIENT_ID_BY_CSS,
  splitCoverCss,
  COVER_URL_CSS,
  decodeCover,
  encodeCover,
  lastEditedLabel,
  HEADER_SCROLL_HAIRLINE,
} from "./page-title-model";
export * from "./page-title-model";

const ShareDialog = dynamic(
  () => import("@/components/share-dialog").then((mod) => ({ default: mod.ShareDialog })),
  { ssr: false },
);
const NotionImportDialog = dynamic(
  () => import("@/components/notion-import-dialog").then((mod) => ({ default: mod.NotionImportDialog })),
  { ssr: false },
);
const WhoHasAccess = dynamic(
  () => import("@/components/who-has-access").then((mod) => ({ default: mod.WhoHasAccess })),
  { ssr: false },
);

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
  /** UI locale for the row's own labels; defaults to English (SSR + tests). */
  locale?: string;
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
  /** Accessible name for the icon/cover picker popover. */
  iconMenuLabel?: string;
  /** Dismiss the icon/cover picker when the shared Popover closes. */
  onCloseIconMenu?: () => void;
  undoRedo?: ReactNode;
  actions?: ReactNode;
  /** Back/forward controls, injected so the row stays a pure function of props. */
  navHistory?: ReactNode;
  avatars?: ReactNode;
  cover?: ReactNode;
  addCover?: ReactNode;
  /** Classes for the cover/title group; the bar stays outside it so it can stick. */
  headerClassName?: string;
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
  locale = "en",
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
  iconMenuLabel,
  onCloseIconMenu,
  undoRedo,
  actions,
  navHistory,
  avatars,
  cover,
  addCover,
  headerClassName = "mb-4",
}: PageTitleRowProps) {
  const { visible, overflow } = layoutHeaderBreadcrumbs(crumbs, breadcrumbWidth);
  const displayTitle = title.trim() || "Untitled";
  // The title is user-authored: lay it out on its own base direction so a
  // Hebrew/Arabic name in an English page (or a Latin name in `ar`) keeps its
  // punctuation on the correct side. An empty title stays `auto` and follows
  // the document direction.
  const titleDirection = contentDirProps(title);
  const iconStyle = pageIconToCss(icon);

  return (
    <>
      <div
        className={cn(
          // The bar is a sibling of the cover/title group, so sticky can hold it
          // below the page-tab strip for the whole page instead of being clipped
          // by the header's own box. The shell publishes the strip height; `0`
          // keeps the bar at the top when no tab strip is mounted.
          "sticky top-[var(--workspace-tabbar-height,0rem)] -mx-5 mb-2 flex items-center justify-between gap-2 bg-bg/85 px-5 py-2 backdrop-blur-sm u-colors sm:-mx-8 sm:px-8 lg:-mx-12 lg:px-12",
          scrolled ? "border-b border-border" : "border-b border-transparent",
        )}
        style={{ zIndex: Z.sticky }}
        data-testid="page-title-bar"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {navHistory ? (
            <div
              className={cn(
                "flex shrink-0 items-center",
                // At the narrowest phone widths the two history arrows would
                // leave the compact title only a few characters. They come back
                // as soon as the viewport can hold both.
                showStickyTitle && "max-[380px]:hidden",
              )}
            >
              {navHistory}
            </div>
          ) : null}
          <nav
            aria-label={t(locale, "blockBreadcrumb")}
            className={cn(
              "min-w-0 items-center gap-1 text-sm text-muted",
              // Phones have the workspace name in the app bar, and while the
              // h1 is on screen the trail adds little. Show it from `sm` up at
              // the top of the page; once the sticky title takes over, the
              // current page is the more useful label at every width.
              showStickyTitle ? "hidden" : "hidden sm:flex",
            )}
          >
            <a
              href={`/w/${workspaceSlug}`}
              className="focus-ring u-colors truncate rounded-sm px-0.5 hover:text-fg"
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
                    className="focus-ring u-colors truncate rounded-sm px-0.5 hover:text-fg"
                    title={crumb.label}
                  >
                    {crumb.label}
                  </a>
                )}
              </span>
            ))}
            {overflow.length > 0 && (
              /* The overflow menu uses the shared Popover placement engine:
                 collision-aware, portalled, and keyboard/Escape handled by
                 Radix instead of a hand-built absolute panel. */
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="breadcrumb-overflow"
                    aria-label={`Show ${overflow.length} more ${
                      overflow.length === 1 ? "page" : "pages"
                    }`}
                    className="focus-ring u-colors flex shrink-0 items-center rounded-control px-1 text-muted hover:bg-surface-2 hover:text-fg"
                  >
                    …
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-auto min-w-40 max-w-64 p-0 py-1 text-sm text-fg"
                >
                  <ul>
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
                </PopoverContent>
              </Popover>
            )}
            {locked && (
              <span
                className="flex shrink-0 items-center rounded-sm px-1 text-muted"
                role="img"
                aria-label={t(locale, "pageLocked")}
                title={t(locale, "pageLockedHint")}
              >
                <Lock className="h-3.5 w-3.5" aria-hidden />
              </span>
            )}
          </nav>
          {showStickyTitle && (
            <span
              data-testid="sticky-title"
              // The compact title is the current location; the breadcrumb is
              // already hidden while it is showing. Let the title truncate on
              // very narrow screens rather than overflow into the actions.
              className="animate-fade flex min-w-0 items-center gap-1.5 ps-2"
            >
              {icon.kind === "emoji" && (
                <span aria-hidden className="shrink-0 text-base leading-none">
                  {icon.value}
                </span>
              )}
              <span
                dir={titleDirection.dir}
                className={cn(
                  "truncate text-sm font-semibold tracking-title text-fg",
                  titleDirection.className,
                )}
              >
                {displayTitle}
              </span>
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {editedLabel && (
            <span
              // Below `lg` the sticky title and actions need the row more than
              // the relative timestamp does. It remains in the page body and on
              // wide screens.
              className="hidden whitespace-nowrap text-xs text-muted lg:inline"
              suppressHydrationWarning
            >
              {editedLabel}
            </span>
          )}
          <button
            type="button"
            aria-label={following ? t(locale, "unfollowPage") : t(locale, "followPage")}
            aria-pressed={following}
            aria-busy={followPending || undefined}
            title={following ? t(locale, "following") : t(locale, "follow")}
            disabled={followPending}
            onClick={onToggleFollow}
            className={cn(
              "focus-ring u-interactive flex h-8 w-8 items-center justify-center rounded-control text-muted sm:h-7 sm:w-7 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50",
              following && "text-fg",
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
            aria-label={t(locale, "share")}
            onClick={onShare}
            className="focus-ring u-interactive flex h-8 items-center gap-1 rounded-control px-2 sm:h-7 text-sm text-muted hover:bg-surface-2"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Share</span>
          </button>
          <button
            type="button"
            aria-label={t(locale, "copyLink")}
            title={t(locale, "copyLink")}
            onClick={onCopyLink}
            className="focus-ring u-interactive hidden h-8 w-8 items-center justify-center rounded-control text-muted hover:bg-surface-2 sm:flex sm:h-7 sm:w-7"
          >
            <LinkIcon className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={favorite ? t(locale, "removeFromFavorites") : t(locale, "addToFavorites")}
            aria-pressed={favorite}
            title={favorite ? t(locale, "removeFromFavorites") : t(locale, "addToFavorites")}
            onClick={onToggleFavorite}
            className={cn(
              "focus-ring u-interactive flex h-8 w-8 items-center justify-center rounded-control text-muted sm:h-7 sm:w-7 hover:bg-surface-2",
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
          {undoRedo ? (
            <div
              className={cn(
                "flex items-center",
                // While the sticky title is showing on a narrow screen, undo/
                // redo is still in the actions menu (and in the editor's own
                // floating bar while writing), so the duplicate pair yields the
                // row to the title. It returns at `lg`, where there is room.
                showStickyTitle && "max-lg:hidden",
              )}
            >
              {undoRedo}
            </div>
          ) : null}
          {actions}
          {avatars ? (
            <div className="hidden items-center sm:flex">{avatars}</div>
          ) : null}
        </div>
      </div>

      <header className={headerClassName}>
        {cover}

        <div className="group/title relative mb-3">
          <div className="relative mb-1 flex h-8 items-center gap-1">
            <Popover
              open={Boolean(iconMenu)}
              onOpenChange={(open) => {
                if (!open) onCloseIconMenu?.();
              }}
            >
              <PopoverAnchor asChild>
                <span className="inline-flex items-center">
                  {icon.kind !== "none" ? (
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={onToggleIcon}
                      aria-label={t(locale, "changeIcon")}
                      className={cn(
                        "focus-ring u-interactive rounded-control p-0.5 leading-none hover:bg-surface-2 disabled:cursor-not-allowed",
                        // The page icon reads as an icon, not a logo: at `text-5xl`/`h-14` a filled
                        // emoji such as ✅ became a 48–56px tile that dominated the header. These
                        // are deliberately calm against the 28px title (`text-title`).
                        icon.kind === "emoji" && "text-4xl",
                        icon.kind === "image" && "h-10 w-10 bg-cover bg-center bg-no-repeat",
                      )}
                      style={iconStyle}
                    >
                      {icon.kind === "emoji" ? icon.value : null}
                    </button>
                  ) : canEdit ? (
                    <button
                      type="button"
                      onClick={onToggleIcon}
                      aria-label={t(locale, "addIcon")}
                      className="focus-ring u-colors flex items-center gap-1 rounded-control px-1 py-0.5 text-sm text-muted opacity-0 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 group-hover/title:opacity-100"
                    >
                      <Smile className="h-4 w-4" aria-hidden /> Add icon
                    </button>
                  ) : null}
                </span>
              </PopoverAnchor>
              {iconMenu && (
                <PopoverContent
                  align="start"
                  sideOffset={12}
                  aria-label={iconMenuLabel}
                  className="w-72 p-2"
                >
                  {iconMenu}
                </PopoverContent>
              )}
            </Popover>
          </div>
          <h1 ref={h1Ref} className="scroll-mt-16">
            <textarea
              ref={titleRef}
              aria-label={t(locale, "pageTitle")}
              aria-roledescription={t(locale, "pageTitleRoleDescription")}
              value={title}
              dir={titleDirection.dir}
              readOnly={!canEdit}
              placeholder={t(locale, "untitled")}
              rows={1}
              spellCheck={false}
              onChange={(event) => {
                onTitleChange(event.target.value);
                event.target.style.height = "auto";
                event.target.style.height = `${event.target.scrollHeight}px`;
              }}
              onBlur={onTitleBlur}
              onKeyDown={onTitleKeyDown}
              className="noema-page-title w-full resize-none overflow-hidden bg-transparent text-page-title font-semibold tracking-title text-fg outline-none placeholder:text-muted/40"
            />
          </h1>
          {addCover}
        </div>
      </header>
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
  // A new page is stamped with the literal placeholder title (`createPageAction`).
  // Showing that string as a value makes the writer select-and-delete it before
  // naming the page, so an untouched placeholder starts empty instead and lets the
  // placeholder do its job; `saveTitle` never writes an empty title back, so the
  // page keeps the name it was created with until something real is typed.
  const [title, setTitle] = useState(initialTitle === t(locale, "untitled") ? "" : initialTitle);
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
  /** Draft link for the cover's image field. */
  const [coverUrlDraft, setCoverUrlDraft] = useState("");
  /** A cover upload in flight (the button shows the pending state and cannot re-fire). */
  const [coverUploading, setCoverUploading] = useState(false);
  /** Why the last cover attempt was refused - shown inline, cleared on success. */
  const [coverError, setCoverError] = useState<string | null>(null);
  const coverFileRef = useRef<HTMLInputElement | null>(null);
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
  const [shareLoaded, setShareLoaded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importLoaded, setImportLoaded] = useState(false);
  const [edited, setEdited] = useState<PageEditedInfo | null>(null);
  const [menuData, setMenuData] = useState<PageMenuData | null>(null);
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);

  // The two legacy booleans now read through the appearance engine.
  const smallText = appearance.fontSize === "small";
  const font = appearance.font;

  // Global undo/redo (mounted by the root layout) drives the topbar controls.
  const {
    canUndo,
    canRedo,
    history,
    undo: undoGlobal,
    redo: redoGlobal,
    undoTo: undoGlobalTo,
    redoTo: redoGlobalTo,
    push: pushGlobal,
  } = useUndoRedo();

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

  /**
   * The caret starts in the title of a page that has no name yet — the first
   * thing anybody writes on a new page. The placeholder title (`""` in state) is
   * the signal; `autofocusedPage` keeps it to one attempt per page, so leaving
   * the field is permanent and a re-render never steals focus back.
   */
  const autofocusedPage = useRef<string | null>(null);
  useEffect(() => {
    if (!canEdit || autofocusedPage.current === pageId) return;
    autofocusedPage.current = pageId;
    if (title !== "") return;
    const field = titleRef.current;
    if (!field) return;
    field.focus();
    // Caret at the end of the (empty) value, so typing appends.
    field.setSelectionRange(field.value.length, field.value.length);
  }, [canEdit, pageId, title]);

  // The title is a one-row textarea that grows with its content. Resize before
  // paint (including on first mount and when the server sends a long title), so
  // the larger display type never clips a wrapped line.
  useLayoutEffect(() => {
    const field = titleRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [title]);

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

  const recordEffectUndo = (
    label: string,
    onUndo: () => void | Promise<void>,
    onRedo: () => void | Promise<void>,
  ) =>
    pushGlobal({
      id: crypto.randomUUID(),
      label,
      apply: (state) => state,
      invert: (state) => state,
      at: Date.now(),
      onUndo,
      onRedo,
    });

  const recordPageUndo = (
    label: string,
    undoPatch: Record<string, unknown>,
    redoPatch: Record<string, unknown>,
  ) =>
    recordEffectUndo(
      label,
      async () => {
        await updatePageAction(pageId, undoPatch);
        router.refresh();
      },
      async () => {
        await updatePageAction(pageId, redoPatch);
        router.refresh();
      },
    );

  const save = (
    patch: Record<string, unknown>,
    revalidate = true,
    after?: () => void,
  ) =>
    startTransition(async () => {
      const result = await updatePageAction(pageId, patch);
      if (!("error" in result)) after?.();
      if (revalidate) router.refresh();
    });

  const saveTitle = () => {
    const previous = initialTitle === t(locale, "untitled") ? "" : initialTitle;
    if (!canEdit || title === previous) return;
    // A page is never nameless: abandoning the field leaves the placeholder (and
    // the stored name) alone rather than writing an empty title, which would also
    // mark the page as edited for a keystroke that never happened.
    if (!title.trim()) return;
    const next = title;
    save({ title: next }, true, () =>
      recordPageUndo("Rename page", { title: previous }, { title: next }),
    );
  };

  const pickIcon = (emoji: string) => {
    const previous = icon;
    setIcon(emoji);
    setShowEmoji(false);
    save({ icon: emoji }, true, () =>
      recordPageUndo("Change page icon", { icon: previous }, { icon: emoji }),
    );
  };

  const pickCover = (value: string | null) => {
    const previous = cover;
    setCover(value);
    setShowCover(false);
    save({ coverUrl: value }, true, () =>
      recordPageUndo("Change page cover", { coverUrl: previous }, { coverUrl: value }),
    );
  };

  /**
   * Cover images. The model has always supported `{ type: "image", url }` (and
   * Unsplash), but the menu only ever offered gradients, so an image cover was
   * unreachable from the UI. Both paths below end at the same `validateCover` gate the
   * persisted value passes through, so a hostile string still cannot become a banner.
   */
  const applyCoverImage = (url: string) => {
    const trimmed = url.trim();
    if (!validateCover({ type: "image", url: trimmed }).valid) {
      setCoverError(t(locale, "coverInvalidUrl"));
      return;
    }
    setCoverError(null);
    setCoverUrlDraft("");
    pickCover(coverCss({ type: "image", url: trimmed }));
  };

  const onCoverFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // Let the same file be picked twice in a row.
    event.target.value = "";
    if (!chosen) return;
    if (!isImage(chosen)) {
      setCoverError(t(locale, "coverInvalidUrl"));
      return;
    }
    setCoverUploading(true);
    setCoverError(null);
    try {
      const asset = await uploadFile(chosen, workspaceId);
      applyCoverImage(asset.url);
    } catch {
      // The route answers with its own message; either way the cover is unchanged.
      setCoverError(t(locale, "coverUploadFailed"));
    } finally {
      setCoverUploading(false);
    }
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
      if ("ok" in result) {
        setFavorite(result.favorite);
        recordEffectUndo(
          "Favorite page",
          async () => {
            await toggleFavoriteAction(workspaceId, pageId);
            router.refresh();
          },
          async () => {
            await toggleFavoriteAction(workspaceId, pageId);
            router.refresh();
          },
        );
      } else toast.error(result.error);
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
      const previousParent = breadcrumbTrail.at(-1)?.id ?? null;
      const result = await movePageAction(pageId, targetId);
      if ("ok" in result) {
        recordEffectUndo(
          "Move page",
          async () => {
            await movePageAction(pageId, previousParent);
            router.refresh();
          },
          async () => {
            await movePageAction(pageId, targetId);
            router.refresh();
          },
        );
        toast.success("Page moved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const trash = () =>
    startTransition(async () => {
      const result = await archivePageAction(pageId);
      if (!("error" in result)) {
        recordEffectUndo(
          "Move page to trash",
          async () => {
            await restorePageAction(pageId);
            router.refresh();
          },
          async () => {
            await archivePageAction(pageId);
            router.refresh();
          },
        );
      }
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
      save({ fullWidth: next }, true, () =>
        recordPageUndo("Page width", { fullWidth }, { fullWidth: next }),
      );
    } else {
      const next = !locked;
      setLocked(next);
      save({ locked: next }, true, () =>
        recordPageUndo("Page lock", { locked }, { locked: next }),
      );
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
    <>
      <PageTitleRow
        headerClassName={cn("mb-4", ...appearanceClasses(appearance))}
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
        locale={locale}
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
        onCloseIconMenu={() => {
          setShowEmoji(false);
          setShowCover(false);
        }}
        onToggleFavorite={toggleFavorite}
        onToggleFollow={toggleFollow}
        onCopyLink={() => void copyLink()}
        onShare={() => {
          setShareLoaded(true);
          setShareOpen(true);
        }}
        navHistory={<NavHistory locale={locale} />}
        iconMenuLabel={
          showEmoji ? t(locale, "pickAnIcon") : t(locale, "pickACover")
        }
        iconMenu={
          showEmoji || showCover ? (
            <div>
              {showEmoji && (
                <div className="grid grid-cols-8 gap-1">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`${t(locale, "setIcon")} ${emoji}`}
                      onClick={() => pickIcon(emoji)}
                      className="focus-ring grid h-8 w-8 place-items-center rounded text-lg hover:bg-surface-2"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
              {showCover && (
                
                <>
                  <div className="mb-2 flex items-center gap-1">
                    <input
                      type="url"
                      value={coverUrlDraft}
                      onChange={(event) => setCoverUrlDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          applyCoverImage(coverUrlDraft);
                        }
                      }}
                      placeholder={t(locale, "coverImageUrl")}
                      aria-label={t(locale, "coverImageUrl")}
                      aria-invalid={coverError ? true : undefined}
                      className="focus-ring h-8 min-w-0 flex-1 rounded-control border-control bg-bg px-2 text-xs text-fg outline-none placeholder:text-muted/60"
                    />
                    <button
                      type="button"
                      onClick={() => applyCoverImage(coverUrlDraft)}
                      disabled={coverUrlDraft.trim() === ""}
                      className="focus-ring u-interactive h-8 shrink-0 rounded-control bg-action px-2 text-xs font-medium text-action-fg disabled:opacity-40"
                    >
                      {t(locale, "useImage")}
                    </button>
                  </div>
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => coverFileRef.current?.click()}
                      disabled={coverUploading || !canEdit}
                      className="focus-ring u-interactive flex h-8 items-center gap-1.5 rounded-control border border-border px-2 text-xs text-fg hover:bg-surface-2 disabled:opacity-50"
                    >
                      <Upload className="h-3.5 w-3.5" aria-hidden />
                      {coverUploading ? t(locale, "uploading") : t(locale, "uploadImage")}
                    </button>
                    <input ref={coverFileRef} type="file" accept="image/*" onChange={onCoverFile} className="hidden" aria-hidden tabIndex={-1} />
                    {coverError ? (
                      <span role="alert" className="text-3xs text-danger">
                        {coverError}
                      </span>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {(Object.keys(GRADIENTS) as GradientId[]).map((id) => (
                      <button
                        key={id}
                        type="button"
                        aria-label={`${t(locale, "setCover")} ${id}`}
                        aria-pressed={
                          storedCover?.value.type === "gradient" &&
                          storedCover.value.gradientId === id
                        }
                        onClick={() => pickCover(GRADIENTS[id])}
                        className="focus-ring h-12 rounded-control bg-cover"
                        style={{
                          backgroundImage: coverCss({
                            type: "gradient",
                            gradientId: id,
                          }),
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null
        }
        undoRedo={
          <div
            role="group"
            aria-label={t(locale, "undoAndRedo")}
            className="flex items-center gap-0.5"
          >
            <button
              type="button"
              aria-label={t(locale, "undo")}
              title={`${t(locale, "undo")} (Ctrl+Z)`}
              disabled={!canUndo}
              onClick={undoGlobal}
              className="focus-ring u-interactive flex h-8 w-8 items-center justify-center rounded text-muted sm:h-7 sm:w-7 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t(locale, "redo")}
              title={`${t(locale, "redo")} (Ctrl+Shift+Z)`}
              disabled={!canRedo}
              onClick={redoGlobal}
              className="focus-ring u-interactive flex h-8 w-8 items-center justify-center rounded text-muted sm:h-7 sm:w-7 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" aria-hidden />
            </button>
            <UndoHistoryControl
              entries={history}
              locale={locale}
              onUndoTo={undoGlobalTo}
              onRedoTo={redoGlobalTo}
            />
          </div>
        }
        actions={
          <ActionsMenu
            pageId={pageId}
            title={title || t(locale, "untitled")}
            editable={editable}
            locale={locale}
            font={font}
            fullWidth={fullWidth}
            smallText={smallText}
            locked={locked}
            cover={cover}
            data={menuData}
            notifyLevel={notifyLevel}
            workspaceId={workspaceId}
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
            onImport={() => {
              setImportLoaded(true);
              setImportOpen(true);
            }}
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
        avatars={<AvatarStack users={avatarUsers} locale={locale} className="ms-1" />}
        cover={
          storedCover ? (
            <div className="group/cover relative -mx-12 mb-4">
              <div
                // Keyed on the image so *changing* the cover crossfades the new one in
                // (spec: "cover changes — crossfade the image"). Repositioning by drag
                // does not change the key, so this never fights the pointer.
                key={coverKey(storedCover.value)}
                className={cn(
                  "animate-fade aspect-[16/6] max-h-64 w-full bg-cover bg-center bg-no-repeat",
                  canEdit && "cursor-grab touch-none active:cursor-grabbing",
                  draggingCover && "u-no-transition",
                )}
                style={{
                  animationDuration: "var(--dur-2)",
                  backgroundImage: coverCss(storedCover.value),
                  backgroundPosition: formatObjectPosition(coverPosition),
                }}
                aria-label={canEdit ? t(locale, "pageCoverDragHint") : t(locale, "pageCover")}
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
                    className="focus-ring u-colors pointer-events-auto flex h-7 items-center gap-1 rounded-control bg-bg/90 px-2 text-xs text-fg shadow-1 hover:bg-bg"
                  >
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden /> Change cover
                  </button>
                  <button
                    type="button"
                    aria-pressed={repositioning}
                    onClick={() => setRepositioning((value) => !value)}
                    className={cn(
                      "focus-ring u-colors pointer-events-auto flex h-7 items-center gap-1 rounded-control bg-bg/90 px-2 text-xs text-fg shadow-1 hover:bg-bg",
                      repositioning && "bg-surface-2 text-fg",
                    )}
                  >
                    <Move className="h-3.5 w-3.5" aria-hidden /> Reposition
                  </button>
                  <button
                    type="button"
                    onClick={() => pickCover(null)}
                    className="focus-ring u-colors pointer-events-auto flex h-7 items-center gap-1 rounded-control bg-bg/90 px-2 text-xs text-fg shadow-1 hover:bg-bg"
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
      {shareLoaded && (
        <ShareDialog
          open={shareOpen}
          pageId={pageId}
          token={shareToken}
          locale={locale}
          onTokenChange={setShareToken}
          onClose={() => setShareOpen(false)}
        />
      )}
      {importLoaded && (
        <NotionImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          workspaceId={workspaceId}
          slug={workspaceSlug}
          locale={locale}
        />
      )}
    </>
  );
}
