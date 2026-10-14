"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  ChevronRight,
  CircleDot,
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
import { ticketFromPageAction } from "@/server/actions/tickets";
import { setPageTeamspaceAction } from "@/server/actions/teamspaces";
import { setPageProjectAction } from "@/server/actions/projects";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
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
 * Candidate parents for "Move to": every page except the moved page and its own
 * descendants (the server also guards cycles — this just hides impossible choices).
 */
function moveCandidates(tree: PageTreeNode[], node: PageTreeNode) {
  const blocked = new Set<string>([node.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of tree) {
      if (candidate.parentId && blocked.has(candidate.parentId) && !blocked.has(candidate.id)) {
        blocked.add(candidate.id);
        grew = true;
      }
    }
  }
  return tree.filter((candidate) => !blocked.has(candidate.id)).slice(0, 12);
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

  const byParent = useMemo(() => {
    const map = new Map<string | null, PageTreeNode[]>();
    for (const node of tree) {
      const key = node.parentId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(node);
    }
    return map;
  }, [tree]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const renderNodes = (
    parentId: string | null,
    depth: number,
    rootFilter?: (node: PageTreeNode) => boolean,
  ) => {
    const nodes = (byParent.get(parentId) ?? []).filter(
      (node) => parentId !== null || !rootFilter || rootFilter(node),
    );
    if (nodes.length === 0) return null;
    return (
      <ul className="space-y-px">
        {nodes.map((node) => {
          const children = byParent.get(node.id) ?? [];
          const isOpen = expanded.has(node.id);
          const href = `/w/${workspace.slug}/${node.id}`;
          const active = pathname === href;
          return (
            <li key={node.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group flex items-center rounded-md pr-0.5 hover:bg-surface-2",
                  active && "bg-surface-2",
                )}
                style={{ paddingLeft: depth * 14 }}
              >
                <button
                  type="button"
                  aria-label={isOpen ? "Collapse" : "Expand"}
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
                  <span className="truncate">{node.title || "Untitled"}</span>
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
                            {teamspace.icon ?? "👥"} {teamspace.name}
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
                            {project.icon ?? "🚀"} {project.name}
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
                          {target.icon ?? "📄"} {target.title || "Untitled"}
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
              {isOpen && renderNodes(node.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  };

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

    <nav aria-label={t(locale, "pages")} className="mt-1 flex-1 overflow-y-auto px-2 pb-3">
      {(byParent.get(null) ?? []).length === 0 && teamspaces.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">No pages yet.</p>
      ) : (
        <>
          {teamspaces.map((teamspace) => {
            const roots = (byParent.get(null) ?? []).filter(
              (node) => node.teamspaceId === teamspace.id,
            );
            if (roots.length === 0) return null;
            return (
              <div key={teamspace.id} className="mt-3">
                <p className="px-1 pb-1 text-[11px] font-medium text-muted/90">
                  {teamspace.icon ?? "👥"} {teamspace.name}
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
      {children}
    </nav>
    </>
  );
}
