"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  type UIEvent,
} from "react";
import {
  ChevronRight,
  CircleDot,
  Copy,
  CornerUpRight,
  FileText,
  FolderKanban,
  Home,
  Link2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import type { PageTreeNode } from "@/server/queries";
import {
  archivePageAction,
  movePageAction,
  toggleFavoriteAction,
  updatePageAction,
} from "@/server/actions/pages";
import { duplicatePageSubtreeAction } from "@/server/actions/page-duplicate";
import { ticketFromPageAction } from "@/server/actions/tickets";
import { setPageTeamspaceAction } from "@/server/actions/teamspaces";
import { setPageProjectAction } from "@/server/actions/projects";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  groupByParent,
  moveCandidates,
  toggleExpanded,
  visibleChildren,
} from "@/lib/page-tree";
import {
  anchorForScroll,
  buildRenderPlan,
  scrollToIndex,
  shouldVirtualize,
  visibleRange,
  type PageTreeRenderPlan,
  type PageTreeWindowOptions,
  type PageTreeWindowRange,
} from "@/lib/page-tree-window";
import {
  canDrop,
  dropIndicatorStyle,
  resolveDropTarget,
  type DropMode,
  type DropRect,
} from "@/lib/drag-drop-targets";
import { truncateEnd } from "@/lib/truncate";
import {
  MAX_RECENT_PAGES,
  recentPages,
  recordVisit,
  type RecentPage,
} from "@/lib/recent-pages";
import { toast } from "sonner";
import { safeAction } from "@/lib/actions-client";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

type StartTransition = (callback: () => void) => void;

type PageTreeProps = {
  tree: PageTreeNode[];
  teamspaces: { id: string; name: string; icon: string | null }[];
  projects: { id: string; name: string; icon: string | null }[];
  workspace: { id: string; slug: string };
  locale: string;
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  pending: boolean;
  addPage: (parentId: string | null, type: "PAGE" | "DATABASE") => void;
  discuss: (pageId: string) => void;
  startTransition: StartTransition;
  children?: ReactNode;
};

/**
 * Longest page title the tree row renders, in code points. The row keeps its
 * `truncate` class (CSS still elides to the available width); this bounds the
 * *computed* string too, so a deep title stays short and a surrogate pair is
 * never sliced. See `@/lib/truncate`.
 */
const SIDEBAR_TITLE_MAX = 48;

/**
 * Longest entity label (page, teamspace or project name) rendered inside the
 * row/context menus, in code points. A menu's width is driven by its content,
 * so a long target title in the "Move to" submenu would stretch it past the
 * sidebar. Bounding the *computed* label with `truncateEnd` keeps the popover
 * compact; the head is kept, matching the sidebar rows, and a surrogate pair is
 * never sliced. See `@/lib/truncate`.
 */
const MENU_LABEL_MAX = 40;

/**
 * Longest teamspace name rendered as a section header above its branch tree, in
 * code points. Unlike the tree rows, the header `<p>` has no width budget of its
 * own, so a long teamspace name would wrap onto a second line or push the nav
 * wide. Bounding the *computed* label with `truncateEnd` (paired with the
 * `truncate` class for CSS elision) keeps it to one line; the head is kept,
 * matching the rows and menus, and a surrogate pair is never sliced. See
 * `@/lib/truncate`.
 */
const SECTION_LABEL_MAX = 32;

/**
 * How many recently visited pages the sidebar "Recent" section renders. The
 * history itself is capped at `MAX_RECENT_PAGES`; the sidebar shows a shorter
 * "top N" slice of it.
 */
const RECENT_SECTION_LIMIT = 5;

/** localStorage key holding one workspace's most-recent-first visit log. */
const recentStorageKey = (workspaceId: string) =>
  `notion:recent-pages:${workspaceId}`;

/** Narrow one parsed storage entry to a `RecentPage` without trusting disk. */
function isRecentEntry(value: unknown): value is RecentPage {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.pageId === "string" && typeof entry.visitedAt === "number"
  );
}

/**
 * Load a workspace's persisted visit log, tolerating absent, blocked
 * (private mode) or corrupt storage by falling back to an empty history.
 */
function readRecent(workspaceId: string): RecentPage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentStorageKey(workspaceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: unknown[] = parsed;
    return entries.filter(isRecentEntry).slice(0, MAX_RECENT_PAGES);
  } catch {
    return [];
  }
}

/**
 * Pure page-tree helpers (moveCandidates, grouping, expand toggles, the
 * visible-rows plan) live in `@/lib/page-tree` — extracted verbatim by B66 so
 * they are unit-testable without a DOM.
 *
 * W10 wires the un-wired `@/lib/page-tree-window` engine into this sidebar: the
 * big-tree path renders only the rows inside the viewport window, while a short
 * tree keeps the exact nested markup it always had. The mapping from the
 * windowing engine's plan to the props this component renders (section headers
 * plus page rows, each with an absolute `top`/`height`) is pure and exported
 * below, so it is provable in a node test without a DOM. See
 * `page-tree.test.ts`.
 */

/** Fixed row pitch of the virtualized sidebar, in px (matches the classic row). */
export const SIDEBAR_ROW_HEIGHT = 28;

/** Extra rows rendered above and below the viewport window. */
const SIDEBAR_OVERSCAN = 4;

/**
 * Assumed nav height (px) before the first client measurement, so the server
 * renders a plausible window instead of an empty one; the first layout effect
 * replaces it with the measured height.
 */
const SIDEBAR_VIEWPORT_FALLBACK = 600;

/**
 * Synthetic id prefix for a section-header row in the plan tree. Page ids are
 * cuids, so a collision with a real id is impossible.
 */
const SECTION_ID_PREFIX = "__sidebar_section__:";

/** A teamspace the sidebar groups root pages under. */
export type SidebarTeamspace = { id: string; name: string; icon: string | null };

/** A section header turned into a virtualizable row. */
export type SidebarHeaderRow = {
  /** Synthetic id in the plan tree; never a real page id. */
  id: string;
  kind: "teamspace" | "private";
  label: string;
  icon: string | null;
};

/**
 * One item the virtualizer draws: a section header or a page row, positioned
 * absolutely in the full scroll content. `height` is the plan's row height for
 * every item, so the DOM stays in sync with the windowing math.
 */
export type SidebarRenderItem =
  | {
      kind: "header";
      id: string;
      header: SidebarHeaderRow;
      top: number;
      height: number;
    }
  | {
      kind: "row";
      id: string;
      node: PageTreeNode;
      depth: number;
      top: number;
      height: number;
      expanded: boolean;
      hasChildren: boolean;
    };

/** The sidebar's virtualization plan, mapped to render props. */
export type SidebarRenderPlan = {
  /** The raw windowing plan (full height + the rendered slice). */
  plan: PageTreeRenderPlan;
  /** `visibleRange(plan)` — the half-open rendered window. */
  window: PageTreeWindowRange;
  /** Only the windowed items, positioned for absolute rendering. */
  items: SidebarRenderItem[];
  /** Header rows by synthetic id, for the item mapping. */
  headers: ReadonlyMap<string, SidebarHeaderRow>;
  /** Real page ids in visible order (headers removed) — keyboard-nav order. */
  rowIds: string[];
  /** Visible item count (headers + rows) — the virtualization input. */
  count: number;
  /** Whether this many items warrant virtualization. */
  virtualized: boolean;
};

/** A `PageTreeNode` stand-in for a section header, so it rides the same plan. */
function headerNode(header: SidebarHeaderRow): PageTreeNode {
  return {
    id: header.id,
    parentId: null,
    teamspaceId: null,
    title: header.label,
    icon: header.icon,
    type: "PAGE",
    position: -1,
    isFavorite: false,
  };
}

/**
 * Flatten the sidebar into windowed render items.
 *
 * The component's visual order is *sectioned* (each teamspace's roots, then the
 * private roots) rather than the raw `position` order `flattenTree` walks. To
 * feed that order through the fixed-height `buildRenderPlan`, each section's
 * header becomes a synthetic root and the section's roots are re-parented under
 * it; descendants are untouched. `flattenTree` then emits header → rows →
 * header → rows, exactly the order the nested renderer produced, and the whole
 * thing — headers included — windows uniformly. The resulting plan row `depth`
 * is one deeper than the visual indent, so `depth - 1` is what a row renders
 * with.
 *
 * Pure and deterministic; no DOM, no clock, no mutation of `tree`.
 */
export function buildSidebarRenderPlan(
  tree: readonly PageTreeNode[],
  teamspaces: readonly SidebarTeamspace[],
  options: PageTreeWindowOptions,
): SidebarRenderPlan {
  const roots = tree.filter((node) => node.parentId === null);
  const headers = new Map<string, SidebarHeaderRow>();
  const planTree: PageTreeNode[] = [];

  const addSection = (header: SidebarHeaderRow, sectionRoots: PageTreeNode[]) => {
    headers.set(header.id, header);
    planTree.push(headerNode(header));
    for (const root of sectionRoots) {
      planTree.push({ ...root, parentId: header.id });
    }
  };

  for (const teamspace of teamspaces) {
    const sectionRoots = roots.filter((node) => node.teamspaceId === teamspace.id);
    if (sectionRoots.length === 0) continue;
    addSection(
      {
        id: `${SECTION_ID_PREFIX}teamspace:${teamspace.id}`,
        kind: "teamspace",
        label: teamspace.name,
        icon: teamspace.icon,
      },
      sectionRoots,
    );
  }

  // The private section header always renders (even with no roots), matching the
  // nested renderer, so it is part of the plan whenever the tree is non-empty.
  addSection(
    { id: `${SECTION_ID_PREFIX}private`, kind: "private", label: "", icon: null },
    roots.filter((node) => !node.teamspaceId),
  );

  for (const node of tree) {
    if (node.parentId !== null) planTree.push(node);
  }

  // A header is always open (its children are the section).
  const expandedIds = new Set(options.expandedIds ?? []);
  for (const id of headers.keys()) expandedIds.add(id);

  const plan = buildRenderPlan(planTree, { ...options, expandedIds });
  const byId = new Map(tree.map((node) => [node.id, node]));

  const items: SidebarRenderItem[] = [];
  for (const row of plan.rows) {
    const header = headers.get(row.id);
    if (header) {
      items.push({ kind: "header", id: row.id, header, top: row.top, height: row.height });
      continue;
    }
    const node = byId.get(row.id);
    if (!node) continue;
    items.push({
      kind: "row",
      id: row.id,
      node,
      depth: Math.max(0, row.depth - 1),
      top: row.top,
      height: row.height,
      expanded: row.expanded,
      hasChildren: row.hasChildren,
    });
  }

  return {
    plan,
    window: visibleRange(plan),
    items,
    headers,
    rowIds: plan.visibleIds.filter((id) => !headers.has(id)),
    count: plan.visibleIds.length,
    virtualized: shouldVirtualize(plan.visibleIds.length),
  };
}

export function PageTree({
  tree,
  teamspaces,
  projects,
  workspace,
  locale,
  expanded,
  setExpanded,
  pending,
  addPage,
  discuss,
  startTransition,
  children,
}: PageTreeProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Most-recently-visited pages (most recent first), hydrated from
  // localStorage after mount so SSR and the first client render agree.
  const [recent, setRecent] = useState<RecentPage[]>([]);
  const [recentLoaded, setRecentLoaded] = useState(false);

  // Virtualization geometry (W10). `viewportHeight` starts at a plausible
  // fallback so SSR draws a window, then the first layout effect measures the
  // real nav; `scrollTop` mirrors the nav's scroll offset; `pendingFocusId`
  // re-focuses a row that had to be scrolled into the window first.
  const [viewportHeight, setViewportHeight] = useState(SIDEBAR_VIEWPORT_FALLBACK);
  const [scrollTop, setScrollTop] = useState(0);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  const byParent = useMemo(() => groupByParent(tree), [tree]);

  /**
   * The sidebar's render plan: section headers + visible rows, windowed to the
   * viewport. Recomputed as the tree, expand state, size or scroll changes; the
   * pure mapping lives in {@link buildSidebarRenderPlan}.
   */
  const geometry = useMemo(
    () =>
      buildSidebarRenderPlan(tree, teamspaces, {
        expandedIds: expanded,
        rowHeight: SIDEBAR_ROW_HEIGHT,
        viewportHeight,
        scrollTop,
        overscan: SIDEBAR_OVERSCAN,
      }),
    [tree, teamspaces, expanded, viewportHeight, scrollTop],
  );

  /** Above the threshold the tree renders as a windowed flat list. */
  const virtualizing = geometry.virtualized;

  const toggle = (id: string) =>
    setExpanded((prev) => toggleExpanded(prev, id));

  const remote = (fn: () => Promise<unknown>, message?: string) =>
    startTransition(async () => {
      const outcome = await safeAction(fn);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if (message) toast.success(message);
      router.refresh();
    });

  /**
   * Duplicate a page and its subtree (`duplicatePageSubtreeAction` plans the
   * copy via `@/lib/page-duplicate`), then land on the copy. Unlike `remote`
   * this navigates instead of refreshing, so the new branch is in view.
   */
  const duplicate = (node: PageTreeNode) =>
    startTransition(async () => {
      const outcome = await safeAction(() => duplicatePageSubtreeAction(node.id));
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      toast.success("Page duplicated");
      router.push(`/w/${workspace.slug}/${value.id}`);
      router.refresh();
    });

  /** id → node, for the drag helpers' parent lookups. */
  const byId = useMemo(() => new Map(tree.map((node) => [node.id, node])), [tree]);

  /** The page currently open in the route, when it is a bare page URL. */
  const pagePrefix = `/w/${workspace.slug}/`;
  const activePageId =
    pathname.startsWith(pagePrefix) &&
    !pathname.slice(pagePrefix.length).includes("/")
      ? pathname.slice(pagePrefix.length)
      : null;

  // Hydrate the visit log once per workspace. Declared before the persistence
  // effect so a fresh load can never overwrite stored history with `[]`.
  useEffect(() => {
    setRecent(readRecent(workspace.id));
    setRecentLoaded(true);
  }, [workspace.id]);

  // Persist every change so "Recent" survives reloads. Storage being
  // unavailable (private mode / quota) leaves the in-memory log intact.
  useEffect(() => {
    if (!recentLoaded) return;
    try {
      window.localStorage.setItem(
        recentStorageKey(workspace.id),
        JSON.stringify(recent),
      );
    } catch {
      // Ignore — the session keeps rendering from state.
    }
  }, [recentLoaded, workspace.id, recent]);

  // Navigating to a page (a tree link or browser history) stamps a visit,
  // moving that page to the front of the log. `recordVisit` dedupes and caps.
  useEffect(() => {
    if (!activePageId || !byId.has(activePageId)) return;
    setRecent((prev) => recordVisit(prev, activePageId, Date.now()));
  }, [activePageId, byId]);

  /** The recent log ranked and resolved to live nodes for display. */
  const recentNodes = useMemo(() => {
    const ranked = recentPages(recent, {
      limit: RECENT_SECTION_LIMIT,
      now: Date.now(),
    });
    return ranked
      .map((entry) => byId.get(entry.pageId))
      .filter((node): node is PageTreeNode => node !== undefined);
  }, [recent, byId]);

  /**
   * Direct child pages of the page currently open in the route, for the
   * sidebar "Sub-pages" section. Empty when no bare page URL is active or the
   * open page has no children, so the section only appears when it has content.
   */
  const subPages = useMemo(
    () => (activePageId ? byParent.get(activePageId) ?? [] : []),
    [activePageId, byParent],
  );

  // Drag-and-drop intention (docs "Drag & drop"): the pointer is hit-tested by
  // `resolveDropTarget` over the rows currently laid out in the nav and gated by
  // `canDrop`, so no ad-hoc edge/indent math lives here. `draggingId` is the row
  // being dragged and `dropTarget` the resolved `{ id, mode }` the indicator
  // draws. The drop still goes through `movePageAction` (server permission +
  // cycle checks) via `remote`, so this only decides *where* a drop would land.
  const navRef = useRef<HTMLElement | null>(null);
  const dragStartX = useRef(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; mode: DropMode } | null>(null);

  // Keep the plan's viewport in sync with the real nav height. A layout effect
  // runs before paint, so the window is sized correctly with no visible flash;
  // a ResizeObserver follows sidebar/show-hide changes.
  useLayoutEffect(() => {
    const container = navRef.current;
    if (!container) return;
    const measure = () => setViewportHeight(container.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Mirror the nav's scroll offset into the plan so the window follows it.
  const handleScroll = (event: UIEvent<HTMLElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  // Re-pin the row at the viewport top across expand/collapse: when the visible
  // id list changes (not merely the scroll), `anchorForScroll` maps the old
  // scrollTop onto the new list so the same row stays put.
  const prevPlanRef = useRef<PageTreeRenderPlan | null>(null);
  useEffect(() => {
    const previous = prevPlanRef.current;
    prevPlanRef.current = geometry.plan;
    if (!previous || !virtualizing) return;
    const nextIds = geometry.plan.visibleIds;
    if (
      previous.visibleIds.length === nextIds.length &&
      previous.visibleIds.every((id, index) => id === nextIds[index])
    ) {
      return;
    }
    const container = navRef.current;
    if (!container) return;
    container.scrollTop = anchorForScroll(previous, geometry.plan, container.scrollTop);
  }, [geometry.plan, virtualizing]);

  // Focus a row that had to be scrolled into the window on the previous frame.
  useEffect(() => {
    if (!pendingFocusId) return;
    const container = navRef.current;
    if (!container) return;
    const rows = container.querySelectorAll<HTMLElement>("[data-page-row]");
    for (const row of rows) {
      if (row.dataset.pageId !== pendingFocusId) continue;
      const link = row.querySelector<HTMLAnchorElement>("a[href]");
      (link ?? row).focus();
      setPendingFocusId(null);
      return;
    }
  }, [pendingFocusId, geometry.plan]);

  /** The laid-out rows, measured fresh so scroll/collapse stay in sync. */
  const dropRects = (): DropRect[] => {
    const container = navRef.current;
    if (!container) return [];
    const rects: DropRect[] = [];
    container.querySelectorAll<HTMLElement>("[data-page-row]").forEach((element) => {
      const id = element.dataset.pageId;
      if (!id) return;
      const box = element.getBoundingClientRect();
      rects.push({ id, top: box.top, height: box.height });
    });
    return rects;
  };

  const parentOf = (id: string) => byId.get(id)?.parentId ?? null;

  const handleDragStart = (event: DragEvent<HTMLDivElement>, id: string) => {
    setDraggingId(id);
    setDropTarget(null);
    dragStartX.current = event.clientX;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!draggingId) return;
    const rects = dropRects();
    if (rects.length === 0) return;
    // Rightward travel promotes the hover to `inside` (re-parent) — the
    // drag-right-to-nest gesture handled by `resolveDropTarget`.
    const resolved = resolveDropTarget(rects, event.clientY, {
      indentOffset: event.clientX - dragStartX.current,
    });
    const resolvedId = rects[resolved.index]?.id;
    if (!resolvedId || !canDrop(draggingId, resolvedId, parentOf)) {
      setDropTarget(null);
      return;
    }
    // Only a valid target accepts the drop (preventDefault enables it).
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ id: resolvedId, mode: resolved.mode });
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDropTarget(null);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const draggedId = draggingId;
    const target = dropTarget;
    setDraggingId(null);
    setDropTarget(null);
    if (!draggedId || !target) return;
    const draggedNode = byId.get(draggedId);
    const targetNode = byId.get(target.id);
    if (!draggedNode || !targetNode) return;
    if (!canDrop(draggedId, targetNode.id, parentOf)) return;
    // `inside` re-parents under the row; `before`/`after` join the row's parent.
    // The action only takes a parent id (it appends at that level's end), so
    // exact sibling ordering is a follow-up, not ad-hoc math here.
    const parentId = target.mode === "inside" ? targetNode.id : targetNode.parentId;
    if (target.mode === "inside" && draggedNode.parentId === parentId) return;
    remote(
      () => movePageAction(draggedId, parentId),
      target.mode === "inside"
        ? `Moved into ${targetNode.title || "Untitled"}`
        : "Moved page",
    );
  };

  /**
   * Move DOM focus to a tree row's link (fallback: the row container itself).
   * When virtualizing, a row outside the window is not in the DOM: centre it
   * with `scrollToIndex` and let the pending-focus effect land on it once the
   * window re-renders.
   */
  const focusRow = (id: string) => {
    const container = navRef.current;
    if (!container) return;
    const rows = container.querySelectorAll<HTMLElement>("[data-page-row]");
    for (const row of rows) {
      if (row.dataset.pageId !== id) continue;
      const link = row.querySelector<HTMLAnchorElement>("a[href]");
      (link ?? row).focus();
      return;
    }
    if (!virtualizing) return;
    const index = geometry.plan.visibleIds.indexOf(id);
    if (index < 0) return;
    container.scrollTop = scrollToIndex(geometry.plan, index);
    setPendingFocusId(id);
  };

  /**
   * Roving keyboard navigation for the visible page tree (WAI-ARIA tree
   * pattern): Up/Down step between the visible rows in render order, Home/End
   * jump to the ends, Right expands a collapsed row or steps into its first
   * child, and Left collapses an open row or steps out to its parent. The order
   * comes from the render plan's `rowIds` (section order, headers removed), so
   * navigation keeps working once virtualization has laid out only a window of
   * rows — focusing an off-window row scrolls it in first. Typing in the inline
   * rename field and modifier-key combos are left to the browser (the rename
   * input and menus keep their own key handling).
   */
  const handleTreeKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    id: string,
  ) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const element = event.target as HTMLElement | null;
    if (element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA")) {
      return;
    }
    const navIds = geometry.rowIds;
    const index = navIds.indexOf(id);
    if (index === -1) return;
    const children = byParent.get(id) ?? [];
    const isOpen = expanded.has(id);
    const parentId = byId.get(id)?.parentId ?? null;
    const focusAt = (next: number) => {
      const nextId = navIds[next];
      if (nextId) focusRow(nextId);
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(Math.min(index + 1, navIds.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(navIds.length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        // Closed parent: open it (a second Right then steps into the child).
        if (children.length > 0) {
          if (isOpen) focusAt(index + 1);
          else toggle(id);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (children.length > 0 && isOpen) toggle(id);
        else if (parentId) focusRow(parentId);
        break;
      default:
        break;
    }
  };

  /** One page row: expand toggle, link, inline rename, menus and drag handlers. */
  const renderRow = (node: PageTreeNode, depth: number) => {
    const children = byParent.get(node.id) ?? [];
    const isOpen = expanded.has(node.id);
    const href = `/w/${workspace.slug}/${node.id}`;
    const active = pathname === href;
    const indicator =
      dropTarget && dropTarget.id === node.id
        ? dropIndicatorStyle({ index: 0, mode: dropTarget.mode })
        : null;
    return (
              <ContextMenu>
                <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group flex items-center rounded-md pr-0.5 hover:bg-surface-2 focus-within:bg-surface-2",
                  active && "bg-surface-2",
                  draggingId === node.id && "opacity-50",
                )}
                data-page-row
                data-page-id={node.id}
                tabIndex={-1}
                onKeyDown={(event) => handleTreeKeyDown(event, node.id)}
                draggable
                onDragStart={(event) => handleDragStart(event, node.id)}
                onDragEnd={handleDragEnd}
                style={{ paddingLeft: depth * 14, ...(indicator ?? {}) }}
              >
                <button
                  type="button"
                  aria-label={isOpen ? "Collapse" : "Expand"}
                  aria-expanded={children.length > 0 ? isOpen : undefined}
                  onClick={() => toggle(node.id)}
                  className={cn(
                    "flex h-7 w-5 shrink-0 items-center justify-center text-muted",
                    children.length === 0 && "invisible",
                  )}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                </button>
                <Link
                  href={href}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 py-1 text-sm",
                    renamingId === node.id && "hidden",
                  )}
                >
                  <span className="w-4 shrink-0 text-center text-sm">
                    {node.icon ?? (node.type === "DATABASE" ? "🗂️" : "📄")}
                  </span>
                  <span className="truncate">
                    {truncateEnd(node.title || "Untitled", SIDEBAR_TITLE_MAX)}
                  </span>
                </Link>
                {renamingId === node.id && (
                  <input
                    autoFocus
                    value={renameValue}
                    aria-label="Page name"
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => {
                      const value = renameValue;
                      setRenamingId(null);
                      startTransition(async () => {
                        const outcome = await safeAction(() =>
                          updatePageAction(node.id, { title: value }),
                        );
                        if (!outcome.ok) toast.error(outcome.error);
                        router.refresh();
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-border bg-bg px-1 py-0.5 text-sm outline-none focus:border-accent"
                  />
                )}
                <div className="flex items-center opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  <Tooltip label="Add a sub-page">
                    <button
                      type="button"
                      aria-label="Add a sub-page"
                      onClick={() => addPage(node.id, "PAGE")}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Page options"
                        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start">
                      <DropdownMenuItem
                        onSelect={() =>
                          remote(
                            () => toggleFavoriteAction(workspace.id, node.id),
                            "Favorites updated",
                          )
                        }
                      >
                        <Star className="h-4 w-4 text-muted" /> Add to favorites
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          const url = `${window.location.origin}/w/${workspace.slug}/${node.id}`;
                          navigator.clipboard
                            .writeText(url)
                            .then(() => toast.success("Link copied"))
                            .catch(() => toast.error("Could not copy link"));
                        }}
                      >
                        <FileText className="h-4 w-4 text-muted" /> Copy link
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => duplicate(node)}>
                        <Copy className="h-4 w-4 text-muted" /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          remote(
                            () => archivePageAction(node.id),
                            "Moved to trash",
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4 text-muted" /> Move to trash
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => router.push(href)}>
                    <FileText className="h-4 w-4 text-muted" /> Open
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => window.open(href, "_blank", "noopener")}
                  >
                    <FileText className="h-4 w-4 text-muted" /> Open in new tab
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => discuss(node.id)}>
                    <MessagesSquare className="h-4 w-4 text-muted" /> Discuss in chat
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      startTransition(async () => {
                        const outcome = await safeAction(() => ticketFromPageAction(node.id));
                        const value = outcome.ok ? outcome.value : { error: outcome.error };
                        if ("error" in value) {
                          toast.error(value.error);
                          return;
                        }
                        toast.success(`Created ticket ${value.key}`);
                        router.push(`/w/${workspace.slug}/tickets`);
                        router.refresh();
                      })
                    }
                  >
                    <CircleDot className="h-4 w-4 text-muted" /> Create ticket from page
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => {
                      setRenameValue(node.title);
                      setRenamingId(node.id);
                    }}
                  >
                    <Pencil className="h-4 w-4 text-muted" /> Rename
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      remote(
                        () => toggleFavoriteAction(workspace.id, node.id),
                        "Favorites updated",
                      )
                    }
                  >
                    <Star className="h-4 w-4 text-muted" /> Toggle favorite
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => {
                      const url = `${window.location.origin}/w/${workspace.slug}/${node.id}`;
                      navigator.clipboard
                        .writeText(url)
                        .then(() => toast.success("Link copied"))
                        .catch(() => toast.error("Could not copy link"));
                    }}
                  >
                    <Link2 className="h-4 w-4 text-muted" /> Copy link
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => duplicate(node)}>
                    <Copy className="h-4 w-4 text-muted" /> Duplicate
                  </ContextMenuItem>
                  {teamspaces.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        <Users className="h-4 w-4 text-muted" /> Move to teamspace
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        {teamspaces.map((teamspace) => (
                          <ContextMenuItem
                            key={teamspace.id}
                            onSelect={() =>
                              remote(
                                () => setPageTeamspaceAction(node.id, teamspace.id),
                                `Moved to ${teamspace.name}`,
                              )
                            }
                          >
                            {teamspace.icon ?? "👥"} {truncateEnd(teamspace.name, MENU_LABEL_MAX)}
                          </ContextMenuItem>
                        ))}
                        <ContextMenuItem
                          onSelect={() =>
                            remote(() => setPageTeamspaceAction(node.id, null), "Removed from teamspace")
                          }
                        >
                          None
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                  {projects.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        <FolderKanban className="h-4 w-4 text-muted" /> Add to project
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        {projects.map((project) => (
                          <ContextMenuItem
                            key={project.id}
                            onSelect={() =>
                              remote(
                                () => setPageProjectAction(node.id, project.id),
                                `Added to ${project.name}`,
                              )
                            }
                          >
                            {project.icon ?? "🚀"} {truncateEnd(project.name, MENU_LABEL_MAX)}
                          </ContextMenuItem>
                        ))}
                        <ContextMenuItem
                          onSelect={() => remote(() => setPageProjectAction(node.id, null), "Removed from project")}
                        >
                          Remove from project
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <CornerUpRight className="h-4 w-4 text-muted" /> Move to
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem
                        onSelect={() => remote(() => movePageAction(node.id, null), "Moved to top level")}
                      >
                        <Home className="h-4 w-4 text-muted" /> Top level
                      </ContextMenuItem>
                      {moveCandidates(tree, node).map((target) => (
                        <ContextMenuItem
                          key={target.id}
                          onSelect={() =>
                            remote(
                              () => movePageAction(node.id, target.id),
                              `Moved into ${target.title || "Untitled"}`,
                            )
                          }
                        >
                          {target.icon ?? "📄"} {truncateEnd(target.title || "Untitled", MENU_LABEL_MAX)}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    destructive
                    onSelect={() => remote(() => archivePageAction(node.id), "Moved to trash")}
                  >
                    <Trash2 className="h-4 w-4" /> Move to trash
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
    );
  };

  /**
   * The classic nested renderer, used below the virtualization threshold so a
   * short tree keeps its exact markup (nested `<ul>`, `space-y-px`, section
   * spacing). Above the threshold the windowed flat list takes over instead.
   */
  const renderNodes = (
    parentId: string | null,
    depth: number,
    rootFilter?: (node: PageTreeNode) => boolean,
  ) => {
    const nodes = visibleChildren(byParent, parentId, rootFilter);
    if (nodes.length === 0) return null;
    return (
      <ul className="space-y-px">
        {nodes.map((node) => (
          <li key={node.id}>
            {renderRow(node, depth)}
            {expanded.has(node.id) && renderNodes(node.id, depth + 1)}
          </li>
        ))}
      </ul>
    );
  };

  /**
   * The virtualized tree: only the plan's windowed items are materialised, each
   * absolutely positioned at its plan `top` inside a spacer of the full visible
   * height. Headers and rows both use the plan's row height, so the DOM pitch
   * always matches the windowing math. The classic markup is untouched below
   * the threshold.
   */
  const renderVirtual = () => (
    <div className="relative" style={{ height: geometry.plan.totalHeight }}>
      {geometry.items.map((item) =>
        item.kind === "header" ? (
          <div
            key={item.id}
            className="absolute left-0 right-0"
            style={{ top: item.top, height: item.height }}
          >
            <p className="truncate px-1 pt-1 text-[11px] font-medium text-muted/90">
              {item.header.kind === "teamspace" ? `${item.header.icon ?? "👥"} ` : ""}
              {truncateEnd(
                item.header.kind === "private"
                  ? t(locale, "privatePages")
                  : item.header.label,
                SECTION_LABEL_MAX,
              )}
            </p>
          </div>
        ) : (
          <div
            key={item.id}
            className="absolute left-0 right-0"
            style={{ top: item.top, height: item.height }}
          >
            {renderRow(item.node, item.depth)}
          </div>
        ),
      )}
    </div>
  );

  return (
    <>
    <div className="mt-4 flex items-center justify-between px-3">
      <p className="px-1 text-[11px] font-medium text-muted/90">
        {t(locale, "pages")}
      </p>
      <Tooltip label="New page">
        <button
          type="button"
          disabled={pending}
          onClick={() => addPage(null, "PAGE")}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <Plus className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>

    <nav
      ref={navRef}
      aria-label={t(locale, "pages")}
      className="mt-1 flex-1 overflow-y-auto px-2 pb-3"
      onScroll={handleScroll}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {(byParent.get(null) ?? []).length === 0 && teamspaces.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">No pages yet.</p>
      ) : virtualizing ? (
        renderVirtual()
      ) : (
        <>
          {teamspaces.map((teamspace) => {
            const roots = (byParent.get(null) ?? []).filter(
              (node) => node.teamspaceId === teamspace.id,
            );
            if (roots.length === 0) return null;
            return (
              <div key={teamspace.id} className="mt-3">
                <p className="truncate px-1 pb-1 text-[11px] font-medium text-muted/90">
                  {teamspace.icon ?? "👥"}{" "}
                  {truncateEnd(teamspace.name, SECTION_LABEL_MAX)}
                </p>
                {renderNodes(null, 0, (node) => node.teamspaceId === teamspace.id)}
              </div>
            );
          })}
          <div className="mt-4">
            <p className="px-1 pb-1 text-[11px] font-medium text-muted/90">
              {t(locale, "privatePages")}
            </p>
            {renderNodes(null, 0, (node) => !node.teamspaceId)}
          </div>
        </>
      )}
      {subPages.length > 0 && (
        <div className="mt-4">
          <p className="px-1 pb-1 text-[11px] font-medium text-muted/90">
            Sub-pages
          </p>
          <ul className="space-y-px">
            {subPages.map((node) => {
              const href = `/w/${workspace.slug}/${node.id}`;
              return (
                <li key={node.id}>
                  <Link
                    href={href}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-surface-2",
                      pathname === href && "bg-surface-2",
                    )}
                  >
                    <span className="w-4 shrink-0 text-center text-sm">
                      {node.icon ?? (node.type === "DATABASE" ? "🗂️" : "📄")}
                    </span>
                    <span className="truncate">
                      {truncateEnd(node.title || "Untitled", SIDEBAR_TITLE_MAX)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {recentNodes.length > 0 && (
        <div className="mt-4">
          <p className="px-1 pb-1 text-[11px] font-medium text-muted/90">
            Recent
          </p>
          <ul className="space-y-px">
            {recentNodes.map((node) => {
              const href = `/w/${workspace.slug}/${node.id}`;
              return (
                <li key={node.id}>
                  <Link
                    href={href}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-surface-2",
                      pathname === href && "bg-surface-2",
                    )}
                  >
                    <span className="w-4 shrink-0 text-center text-sm">
                      {node.icon ?? (node.type === "DATABASE" ? "🗂️" : "📄")}
                    </span>
                    <span className="truncate">
                      {truncateEnd(node.title || "Untitled", SIDEBAR_TITLE_MAX)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {children}
    </nav>
    </>
  );
}
