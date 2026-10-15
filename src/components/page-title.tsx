"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, ImagePlus, Link as LinkIcon, Lock, Smile, Star } from "lucide-react";
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
import { formatEditedLabel } from "@/lib/actions-menu";
import {
  appearanceClasses,
  parseAppearance,
  patchAppearance,
  type PageAppearance,
} from "@/lib/page-appearance";
import { pageIconToCss, parsePageIcon } from "@/lib/page-icon";
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
  workspaces = [],
  teamspaces = [],
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
  workspaces?: { id: string; name: string; slug: string }[];
  /** Accepted for the route; member permissions live in WhoHasAccess. */
  members?: { id: string; name: string }[];
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

  // A stored icon is either an emoji glyph or an http(s) image URL; classify it
  // so the renderer shows text for the former and a CSS background for the
  // latter, instead of spilling a raw URL into the heading.
  const pageIcon = parsePageIcon(icon);
  const iconStyle = pageIconToCss(pageIcon);

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

  // Line spacing is server-backed (`Page.lineSpacing`) and seeded through the
  // appearance state above; no localStorage layer remains. A server
  // `initialAppearance` still wins when present.

  const save = (patch: Record<string, unknown>, revalidate = true) =>
    startTransition(async () => {
      await updatePageAction(pageId, patch);
      if (revalidate) router.refresh();
    });

  const saveTitle = () => {
    if (!editable || title === initialTitle) return;
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
          <span className="truncate">{workspaceName}</span>
          <span aria-hidden className="px-0.5">/</span>
          <span aria-current="page" className="truncate text-fg">{title || "Untitled"}</span>
        </nav>

        <div className="flex items-center gap-1">
          {edited && (
            <span className="hidden whitespace-nowrap text-xs text-muted md:inline">
              {formatEditedLabel(edited.updatedAt, new Date())}
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
        </div>
      </div>

      {cover && (
        <div className="relative -mx-12 mb-4" style={{ background: cover }}>
          <div className="h-44" />
        </div>
      )}

      <div className="relative px-0">
        {pageIcon.kind !== "none" ? (
          <button
            type="button"
            disabled={!editable}
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
        ) : editable ? (
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
          readOnly={!editable}
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

        {editable && !cover && (
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
