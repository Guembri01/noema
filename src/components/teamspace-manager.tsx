"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Copy, Link2, Mail, Plus, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import {
  addTeamspaceMemberAction,
  createTeamspaceAction,
  deleteTeamspaceAction,
  removeTeamspaceMemberAction,
} from "@/server/actions/teamspaces";
import {
  inviteTeamspaceMemberAction,
  revokeTeamspaceInviteAction,
} from "@/server/actions/teamspace-invites";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { can, describeRole, type PermissionAction } from "@/lib/permission-matrix";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";

export type TeamspaceInviteRow = {
  id: string;
  email: string;
  role: string;
};

export type TeamspaceRow = {
  id: string;
  name: string;
  icon: string | null;
  memberIds: string[];
  invites: TeamspaceInviteRow[];
};

/* ------------------------------------------------------------------------- *
 * Pure mappings — the row view model, the member count and the loading shape.
 * DOM-free so the node tests can pin them (docs/DESIGN_SYSTEM.md §10).
 * ------------------------------------------------------------------------- */

export type TeamspaceRowMeta = {
  icon: string;
  label: string;
  memberCount: number;
};

/** Unique member count (a defensive dedupe; the DB already enforces one row each). */
export function teamspaceMemberCount(teamspace: {
  memberIds?: readonly string[] | null;
}): number {
  const ids = teamspace?.memberIds;
  if (!Array.isArray(ids)) return 0;
  return new Set(ids.filter((id) => typeof id === "string" && id !== "")).size;
}

/** The row's glyph, display label and member count. */
export function teamspaceRowMeta(teamspace: TeamspaceRow): TeamspaceRowMeta {
  const name = typeof teamspace?.name === "string" ? teamspace.name.trim() : "";
  return {
    icon:
      typeof teamspace?.icon === "string" && teamspace.icon.trim() !== ""
        ? teamspace.icon
        : "👥",
    label: name || "Teamspace",
    memberCount: teamspaceMemberCount(teamspace),
  };
}

/** Upper bound on the loading skeleton rows, so a bad count cannot flood the DOM. */
export const TEAMSPACE_SKELETON_MAX = 4;

/** How many skeleton rows to draw while the list loads (1–4). */
export function teamspaceSkeletonCount(known: number): number {
  if (!Number.isFinite(known) || known <= 0) return 1;
  return Math.min(TEAMSPACE_SKELETON_MAX, Math.max(1, Math.trunc(known)));
}

/**
 * The actions a guest may hold inside a teamspace, paired with the label key
 * the "who has access" surfaces already use. Read from the permission matrix
 * (`can`) rather than hard-coded, so this card can never advertise access the
 * server would deny — teamspace membership lets a guest open and comment the
 * teamspace's pages (`guest-access.ts`), nothing more.
 */
const GUEST_SCOPE_ACTIONS: readonly {
  action: PermissionAction;
  label: "canView" | "canComment" | "canEdit";
}[] = [
  { action: "read", label: "canView" },
  { action: "comment", label: "canComment" },
  { action: "edit", label: "canEdit" },
];

export function TeamspaceManager({
  workspaceId,
  teamspaces,
  members,
  locale,
  loading = false,
  error = null,
  onRetry,
}: {
  workspaceId: string;
  teamspaces: TeamspaceRow[];
  members: { id: string; name: string; email: string }[];
  locale: string;
  /** Show skeleton rows while the list is (re)loading. */
  loading?: boolean;
  /** A list-level error to surface with a retry control. */
  error?: string | null;
  onRetry?: () => void;
}) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [pending, startTransition] = useTransition();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState<TeamspaceRow | null>(null);
  const [inviteEmail, setInviteEmail] = useState<Record<string, string>>({});
  const [inviteRole, setInviteRole] = useState<Record<string, "MEMBER" | "ADMIN">>({});
  const [inviteLink, setInviteLink] = useState<Record<string, string>>({});

  const fail = (message: string) => toast.error(message);

  // What a guest gets in any teamspace, read straight from the permission
  // matrix so the summary tracks the enforced role table instead of drifting.
  const guestScope = GUEST_SCOPE_ACTIONS.filter(({ action }) => can("guest", action))
    .map(({ label }) => t(locale, label))
    .join(" · ");
  const guestScopeTitle = describeRole("guest");

  const create = () => {
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    startTransition(async () => {
      const outcome = await safeAction(() => createTeamspaceAction(workspaceId, name, icon));
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("ok" in value) {
        setName("");
        setIcon("");
        toast.success(t(locale, "teamspaceCreated"));
        router.refresh();
      } else {
        fail(value.error);
      }
    });
  };

  const remove = (teamspace: TeamspaceRow) => {
    startTransition(async () => {
      const outcome = await safeAction(() => deleteTeamspaceAction(teamspace.id));
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("ok" in value) {
        toast.success(t(locale, "teamspaceDeleted"));
        setDeleting(null);
        router.refresh();
      } else {
        fail(value.error);
      }
    });
  };

  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <Users className="h-4 w-4" aria-hidden />
        {t(locale, "teamspaces")}
      </h2>
      <p className="mb-3 text-sm text-muted">{t(locale, "teamspacesIntro")}</p>

      <form
        className="mb-4 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <Input
          value={icon}
          aria-label={t(locale, "teamspaceIconAria")}
          onChange={(event) => setIcon(event.target.value)}
          placeholder="👥"
          maxLength={4}
          size="sm"
          className="w-14 text-center"
          disabled={pending}
        />
        <Input
          ref={nameRef}
          value={name}
          aria-label={t(locale, "teamspaceNameLabel")}
          onChange={(event) => setName(event.target.value)}
          placeholder={t(locale, "teamspaceNameLabel")}
          size="sm"
          className="w-56"
          disabled={pending}
        />
        <Button type="submit" size="sm" loading={pending} leftIcon={<Plus className="h-4 w-4" />}>
          {t(locale, "create")}
        </Button>
      </form>

      {loading ? (
        <ul className="space-y-4" aria-busy="true">
          {Array.from({ length: teamspaceSkeletonCount(teamspaces.length) }, (_, index) => (
            <li key={`teamspace-skeleton-${index}`}>
              <Skeleton variant="row" className="rounded-lg border border-border" />
            </li>
          ))}
        </ul>
      ) : error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
        >
          <p className="text-sm text-danger">{error}</p>
          {onRetry ? (
            <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
              {t(locale, "retry")}
            </Button>
          ) : null}
        </div>
      ) : teamspaces.length === 0 ? (
        <EmptyState
          variant="compact"
          icon={<Users className="h-4 w-4" aria-hidden />}
          title={t(locale, "noTeamspaces")}
          description={t(locale, "teamspacesIntro")}
          primaryAction={
            <Button type="button" variant="secondary" size="sm" onClick={() => nameRef.current?.focus()}>
              {t(locale, "add")}
            </Button>
          }
        />
      ) : (
        <ul className="space-y-4">
          {teamspaces.map((teamspace) => {
            const meta = teamspaceRowMeta(teamspace);
            const expanded = !collapsed.has(teamspace.id);
            return (
              <li
                key={teamspace.id}
                className="group/team rounded-lg border border-border u-colors hover:border-border-strong"
              >
                <div className="flex items-center gap-2 p-3">
                  <span aria-hidden className="text-base">
                    {meta.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={meta.label}>
                    {meta.label}
                  </span>
                  <Badge size="sm" count={meta.memberCount} />
                  <Tag hue="gray" size="sm" title={guestScopeTitle}>
                    {t(locale, "guest")} · {guestScope}
                  </Tag>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/team:opacity-100">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-expanded={expanded}
                      aria-label={`Edit ${meta.label}`}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(teamspace.id)) next.delete(teamspace.id);
                          else next.add(teamspace.id);
                          return next;
                        })
                      }
                    >
                      {expanded ? (
                        <ChevronDown className="h-4 w-4" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t(locale, "delete")} ${meta.label}`}
                      onClick={() => setDeleting(teamspace)}
                    >
                      <Trash2 className="h-4 w-4 text-danger" aria-hidden />
                    </Button>
                  </div>
                </div>

                {expanded ? (
                  <div className="border-t border-border p-3">
                    {/* Members */}
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {members.map((member) => {
                        const inTeam = teamspace.memberIds.includes(member.id);
                        return (
                          <button
                            key={member.id}
                            type="button"
                            title={member.email}
                            aria-pressed={inTeam}
                            disabled={pending}
                            onClick={() =>
                              startTransition(async () => {
                                const outcome = await safeAction(() =>
                                  inTeam
                                    ? removeTeamspaceMemberAction(teamspace.id, member.id)
                                    : addTeamspaceMemberAction(teamspace.id, member.id),
                                );
                                if (!outcome.ok) {
                                  fail(outcome.error);
                                  return;
                                }
                                if ("error" in outcome.value) fail(outcome.value.error);
                                router.refresh();
                              })
                            }
                            className={cn(
                              "rounded-control border px-2 py-0.5 text-xs u-colors focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                              inTeam
                                ? "border-transparent bg-action text-action-fg"
                                : "border-border text-muted hover:bg-surface-2",
                            )}
                          >
                            {member.name}
                          </button>
                        );
                      })}
                    </div>

                    {/* Email invitation */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-muted" aria-hidden />
                      <Input
                        value={inviteEmail[teamspace.id] ?? ""}
                        aria-label={`${t(locale, "inviteByEmailTo")} ${teamspace.name}`}
                        placeholder={t(locale, "emailPlaceholder")}
                        size="sm"
                        className="w-56"
                        disabled={pending}
                        onChange={(event) =>
                          setInviteEmail((current) => ({
                            ...current,
                            [teamspace.id]: event.target.value,
                          }))
                        }
                      />
                      <select
                        value={inviteRole[teamspace.id] ?? "MEMBER"}
                        aria-label={`${t(locale, "inviteRoleFor")} ${teamspace.name}`}
                        disabled={pending}
                        onChange={(event) =>
                          setInviteRole((current) => ({
                            ...current,
                            [teamspace.id]: event.target.value as "MEMBER" | "ADMIN",
                          }))
                        }
                        className="h-8 rounded-control border-control bg-bg px-2 text-sm text-fg focus-ring u-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="MEMBER">{t(locale, "member")}</option>
                        <option value="ADMIN">{t(locale, "admin")}</option>
                      </select>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!(inviteEmail[teamspace.id] ?? "").trim()}
                        loading={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const email = inviteEmail[teamspace.id] ?? "";
                            const outcome = await safeAction(() =>
                              inviteTeamspaceMemberAction({
                                teamspaceId: teamspace.id,
                                email,
                                role: inviteRole[teamspace.id] ?? "MEMBER",
                              }),
                            );
                            const value = outcome.ok ? outcome.value : { error: outcome.error };
                            if ("error" in value) {
                              fail(value.error);
                              return;
                            }
                            setInviteEmail((current) => ({ ...current, [teamspace.id]: "" }));
                            if (value.added) {
                              toast.success(`${value.email} ${t(locale, "addedToTeamspace")}`);
                            } else if (value.link) {
                              const absolute = `${window.location.origin}${value.link}`;
                              setInviteLink((current) => ({ ...current, [teamspace.id]: absolute }));
                              void navigator.clipboard?.writeText(absolute);
                              toast.success(`${t(locale, "inviteLinkFor")} ${value.email} ${t(locale, "copiedTail")}`);
                            }
                            router.refresh();
                          })
                        }
                      >
                        {t(locale, "invite")}
                      </Button>
                    </div>

                    {inviteLink[teamspace.id] && (
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                        <Link2 className="h-3 w-3" aria-hidden />
                        <span className="truncate">{inviteLink[teamspace.id]}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t(locale, "copyInviteLink")}
                          onClick={() => {
                            void navigator.clipboard?.writeText(inviteLink[teamspace.id]);
                            toast.success(t(locale, "copied"));
                          }}
                        >
                          <Copy className="h-3 w-3" aria-hidden />
                        </Button>
                      </p>
                    )}

                    {teamspace.invites.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t border-border pt-2">
                        {teamspace.invites.map((invite) => (
                          <li key={invite.id} className="flex items-center gap-2 text-xs text-muted">
                            <span className="flex-1 truncate">
                              {invite.email} · {invite.role.toLowerCase()} · {t(locale, "pendingWord")}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`${t(locale, "revokeInviteAria")} ${invite.email}`}
                              disabled={pending}
                              onClick={() =>
                                startTransition(async () => {
                                  const outcome = await safeAction(() =>
                                    revokeTeamspaceInviteAction(invite.id),
                                  );
                                  const value = outcome.ok ? outcome.value : { error: outcome.error };
                                  if ("ok" in value) toast.success(t(locale, "inviteRevoked"));
                                  else fail(value.error);
                                  router.refresh();
                                })
                              }
                            >
                              <X className="h-3.5 w-3.5" aria-hidden />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                <ConfirmDialog
                  open={deleting?.id === teamspace.id}
                  onOpenChange={(next) => setDeleting(next ? teamspace : null)}
                  tone="danger"
                  title={`${t(locale, "delete")} ${meta.label}`}
                  description={t(locale, "teamspacesIntro")}
                  confirmLabel={t(locale, "delete")}
                  cancelLabel={t(locale, "cancel")}
                  pending={pending}
                  onConfirm={() => remove(teamspace)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
