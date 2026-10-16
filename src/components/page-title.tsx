"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  ImagePlus,
  Link as LinkIcon,
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
  COVERS,
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
import { isImageIcon, pageIconToCss, parsePageIcon } from "@/lib/page-icon";
import {
  BREADCRUMB_ELLIPSIS_ID,
  buildBreadcrumb,
  truncateBreadcrumb,
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

/** Header crumbs beyond this budget collapse their middle into an ellipsis. */
const HEADER_BREADCRUMB_MAX = 4;

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

/**
 * Decode a persisted cover string through the page-cover engine, or `null` for
 * an absent/unrecognised value. Gradients match the catalog by CSS value and
 * images must pass `isImageIcon`, so a hostile string never reaches the
 * renderer as a banner.
 */
function decodeCover(raw: string | null): StoredCover | null {
  if (!raw) return null;
  const { css, position } = splitCoverCss(raw);
  const gradientId = GRADIENT_ID_BY_CSS.get(css);
  if (gradientId) return { value: { type: "gradient", gradientId }, position };
  if (isImageIcon(css)) return { value: { type: "image", url: css }, position };
  return null;
}

/**
 * Encode a validated cover plus focal point back into the single `coverUrl`
 * column the save path persists. The centred default is omitted so a plain
 * preset round-trips byte-for-byte.
 */
function encodeCover(value: CoverValue, position: CoverPosition): string {
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
  const [titleEl, setTitleEl] = useState<HTMLTextAreaElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
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
  // so the renderer shows text for the former and a CSS background for the
  // latter, instead of spilling a raw URL into the heading.
  const pageIcon = parsePageIcon(icon);
  const iconStyle = pageIconToCss(pageIcon);

  // Ancestor header trail: only the route-supplied ancestors are chained; with
  // no trail the render falls back to the workspace/title crumbs. The engine
  // walk is cycle-safe and fail-closed, and a deep chain collapses its middle.
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
    return truncateBreadcrumb(buildBreadcrumb(pages, pageId), {
      max: HEADER_BREADCRUMB_MAX,
    });
  }, [breadcrumbTrail, pageId, title]);

  const notifyKey = `noema:page-notify:${pageId}`;
  const [notifyLevel, setNotifyLevel] = useState<NotifyLevel>("all");

  // Notion keeps the page's action bar visible and reveals a hairline only
  // once the content moves under it.
  useEffect(() => {
    const container = document.getElementById("main");
    if (!container) return;
    const onScroll = () => setScrolled(container.scrollTop > 12);
    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
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
  // client) is reflected without a remount.
  useEffect(() => {
    setCoverPosition(
      decodeCover(cover)?.position ?? { ...DEFAULT_COVER_POSITION },
    );
  }, [cover]);

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
      <div
        className={cn(
          "sticky top-0 z-20 -mx-12 mb-2 flex items-center justify-between gap-2 bg-bg/85 px-12 py-2 backdrop-blur-sm transition-[border-color,box-shadow] duration-150",
          scrolled ? "border-b border-border" : "border-b border-transparent",
        )}
      >
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-muted">
          <a
            href={`/w/${workspaceSlug}`}
            className="truncate rounded hover:text-fg"
          >
            {workspaceName}
          </a>
          {crumbs.length > 0 ? (
            crumbs.map((crumb) => (
              <span key={crumb.id} className="flex min-w-0 items-center gap-1">
                <span aria-hidden className="shrink-0 px-0.5">/</span>
                {crumb.id === BREADCRUMB_ELLIPSIS_ID ? (
                  <span aria-hidden className="shrink-0">
                    {crumb.label}
                  </span>
                ) : crumb.id === pageId ? (
                  <span aria-current="page" className="truncate text-fg">
                    {crumb.label}
                  </span>
                ) : (
                  <a
                    href={`/w/${workspaceSlug}/${crumb.id}`}
                    className="truncate rounded hover:text-fg"
                  >
                    {crumb.label}
                  </a>
                )}
              </span>
            ))
          ) : (
            <>
              <span aria-hidden className="px-0.5">/</span>
              <span aria-current="page" className="truncate text-fg">{title || "Untitled"}</span>
            </>
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

        <div className="flex items-center gap-1">
          {edited && (
            <span className="hidden whitespace-nowrap text-xs text-muted md:inline" suppressHydrationWarning>
              {lastEditedLabel(edited, members, new Date())}
            </span>
          )}
          <button
            type="button"
            aria-label={following ? "Unfollow page" : "Follow page"}
            title={following ? "Following" : "Follow"}
            onClick={() =>
              startTransition(async () => {
                const result = await toggleFollowAction(workspaceId, pageId);

                if ("ok" in result) {
                  setFollowing(result.following);
                  toast.success(result.following ? "Following page" : "Unfollowed");
                }
                router.refresh();
              })
            }
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2",
              following && "text-accent",
            )}
          >
            <Bell className={cn("h-4 w-4", following && "fill-current")} />
          </button>
          <button
            type="button"
            aria-label="Share"
            onClick={() => setShareOpen(true)}
            className="flex h-7 items-center gap-1 rounded px-2 text-sm text-muted hover:bg-surface-2"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span>Share</span>
          </button>
          <button
            type="button"
            aria-label="Copy link"
            onClick={() => void copyLink()}
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <LinkIcon className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
            onClick={() =>
              startTransition(async () => {
                const result = await toggleFavoriteAction(workspaceId, pageId);

                if ("ok" in result) setFavorite(result.favorite);
                router.refresh();
              })
            }
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2",
              favorite && "text-amber-500",
            )}
          >
            <Star className={cn("h-4 w-4", favorite && "fill-current")} />
          </button>
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
              className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={redoGlobal}
              className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
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
          <AvatarStack users={avatarUsers} className="ms-1" />
        </div>
      </div>

      {storedCover && (
        <div className="group relative -mx-12 mb-4">
          <div
            className={cn(
              "h-44 bg-cover bg-center",
              canEdit && "cursor-grab touch-none active:cursor-grabbing",
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
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 p-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <span className="pointer-events-none me-auto flex items-center gap-1 rounded bg-bg/85 px-2 py-1 text-xs text-muted shadow-sm">
                <Move className="h-3.5 w-3.5" aria-hidden /> Drag to reposition
              </span>
              <button
                type="button"
                onClick={() => setShowCover(true)}
                className="pointer-events-auto flex h-7 items-center gap-1 rounded bg-bg/90 px-2 text-xs text-fg shadow hover:bg-bg"
              >
                <ImagePlus className="h-3.5 w-3.5" aria-hidden /> Change cover
              </button>
              <button
                type="button"
                onClick={() => pickCover(null)}
                className="pointer-events-auto flex h-7 items-center gap-1 rounded bg-bg/90 px-2 text-xs text-fg shadow hover:bg-bg"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
              </button>
            </div>
          )}
        </div>
      )}

      <div className="relative px-0">
        {pageIcon.kind !== "none" ? (
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setShowEmoji((v) => !v)}
            aria-label="Change icon"
            className={cn(
              "mb-1 block leading-none",
              pageIcon.kind === "emoji" && "text-6xl",
              pageIcon.kind === "image" &&
                "h-16 w-16 rounded bg-cover bg-center bg-no-repeat",
            )}
            style={iconStyle}
          >
            {pageIcon.kind === "emoji" ? pageIcon.value : null}
          </button>
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => setShowEmoji((v) => !v)}
            className="mb-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm text-muted hover:bg-surface-2"
          >
            <Smile className="h-4 w-4" /> Add icon
          </button>
        ) : null}

        {(showEmoji || showCover) && (
          <div className="absolute z-30 mt-1 w-72 rounded-lg border border-border bg-bg p-2 shadow-xl">
            {showEmoji && (
              <div className="grid grid-cols-8 gap-1">
                {EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => pickIcon(emoji)}
                    className="grid h-8 w-8 place-items-center rounded text-lg hover:bg-surface-2"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            {showCover && (
              <div className="grid grid-cols-4 gap-2">
                {COVERS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label="Choose cover"
                    onClick={() => pickCover(c)}
                    className="h-12 rounded"
                    style={{ background: c }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <h1 className="sr-only">{title.trim() || "Untitled"}</h1>
        <textarea
          ref={setTitleEl}
          aria-label="Page title"
          value={title}
          readOnly={!canEdit}
          placeholder="Untitled"
          rows={1}
          onChange={(e) => {
            setTitle(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              titleEl?.blur();
            }
          }}
          className="w-full resize-none overflow-hidden bg-transparent text-[40px] font-bold leading-[1.2] tracking-[-0.02em] outline-none placeholder:text-muted/40"
        />

        {canEdit && !storedCover && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowCover(true)}
              className="rounded px-1 py-0.5 text-sm text-muted hover:bg-surface-2"
            >
              <ImagePlus className="mr-1 inline h-4 w-4" /> Add cover
            </button>
          </div>
        )}
      </div>
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
