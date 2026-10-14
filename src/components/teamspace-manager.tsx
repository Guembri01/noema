"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Link2, Mail, Plus, Trash2, Users, X } from "lucide-react";
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

export function TeamspaceManager({
  workspaceId,
  teamspaces,
  members,
  locale,
}: {
  workspaceId: string;
  teamspaces: TeamspaceRow[];
  members: { id: string; name: string; email: string }[];
  locale: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [pending, startTransition] = useTransition();
  const [inviteEmail, setInviteEmail] = useState<Record<string, string>>({});
  const [inviteRole, setInviteRole] = useState<Record<string, "MEMBER" | "ADMIN">>({});
  const [inviteLink, setInviteLink] = useState<Record<string, string>>({});

  const fail = (error: string) => toast.error(error);

  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <Users className="h-4 w-4" />
        {t(locale, "teamspaces")}
      </h2>
      <p className="mb-3 text-sm text-muted">
        {t(locale, "teamspacesIntro")}
      </p>

      <div className="mb-4 flex items-center gap-2">
        <input
          value={icon}
          aria-label={t(locale, "teamspaceIconAria")}
          onChange={(event) => setIcon(event.target.value)}
          placeholder="👥"
          maxLength={4}
          className="h-9 w-14 rounded border border-border bg-bg px-2 text-center text-sm outline-none focus:border-accent"
        />
        <input
          value={name}
          aria-label={t(locale, "teamspaceNameLabel")}
          onChange={(event) => setName(event.target.value)}
          placeholder={t(locale, "teamspaceNameLabel")}
          className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={() =>
            startTransition(async () => {
              const outcome = await safeAction(() =>
                createTeamspaceAction(workspaceId, name, icon),
              );
              const value = outcome.ok ? outcome.value : { error: outcome.error };
              if ("ok" in value) {
                setName("");
                setIcon("");
                toast.success(t(locale, "teamspaceCreated"));
                router.refresh();
              } else fail(value.error);
            })
          }
          className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> {t(locale, "create")}
        </button>
      </div>

      {teamspaces.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noTeamspaces")}</p>
      ) : (
        <ul className="space-y-4">
          {teamspaces.map((teamspace) => (
            <li key={teamspace.id} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <span aria-hidden>{teamspace.icon ?? "👥"}</span>
                <span className="flex-1 truncate text-sm font-medium">
                  {teamspace.name}
                </span>
                <button
                  type="button"
                  aria-label={`${t(locale, "delete")} ${teamspace.name}`}
                  onClick={() =>
                    startTransition(async () => {
                      const outcome = await safeAction(() =>
                        deleteTeamspaceAction(teamspace.id),
                      );
                      const value = outcome.ok ? outcome.value : { error: outcome.error };
                      if ("ok" in value) {
                        toast.success(t(locale, "teamspaceDeleted"));
                        router.refresh();
                      } else fail(value.error);
                    })
                  }
                  className="text-muted hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {/* Members */}
              <div className="mb-3 flex flex-wrap gap-1.5">
                {members.map((member) => {
                  const inTeam = teamspace.memberIds.includes(member.id);
                  return (
                    <button
                      key={member.id}
                      type="button"
                      title={member.email}
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
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        inTeam
                          ? "border-transparent bg-accent text-accent-fg"
                          : "border-border text-muted"
                      }`}
                    >
                      {member.name}
                    </button>
                  );
                })}
              </div>

              {/* Email invitation */}
              <div className="flex flex-wrap items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-muted" />
                <input
                  value={inviteEmail[teamspace.id] ?? ""}
                  aria-label={`${t(locale, "inviteByEmailTo")} ${teamspace.name}`}
                  placeholder="teammate@example.com"
                  onChange={(event) =>
                    setInviteEmail((current) => ({
                      ...current,
                      [teamspace.id]: event.target.value,
                    }))
                  }
                  className="h-8 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
                />
                <select
                  value={inviteRole[teamspace.id] ?? "MEMBER"}
                  aria-label={`${t(locale, "inviteRoleFor")} ${teamspace.name}`}
                  onChange={(event) =>
                    setInviteRole((current) => ({
                      ...current,
                      [teamspace.id]: event.target.value as "MEMBER" | "ADMIN",
                    }))
                  }
                  className="h-8 rounded border border-border bg-bg px-2 text-sm outline-none"
                >
                  <option value="MEMBER">{t(locale, "member")}</option>
                  <option value="ADMIN">{t(locale, "admin")}</option>
                </select>
                <button
                  type="button"
                  disabled={pending || !(inviteEmail[teamspace.id] ?? "").trim()}
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
                  className="h-8 rounded border border-border px-2 text-xs hover:bg-surface-2 disabled:opacity-50"
                >
                  {t(locale, "invite")}
                </button>
              </div>

              {inviteLink[teamspace.id] && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  <Link2 className="h-3 w-3" />
                  <span className="truncate">{inviteLink[teamspace.id]}</span>
                  <button
                    type="button"
                    aria-label={t(locale, "copyInviteLink")}
                    onClick={() => {
                      void navigator.clipboard?.writeText(inviteLink[teamspace.id]);
                      toast.success(t(locale, "copied"));
                    }}
                    className="shrink-0 hover:text-fg"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </p>
              )}

              {teamspace.invites.length > 0 && (
                <ul className="mt-2 space-y-1 border-t border-border pt-2">
                  {teamspace.invites.map((invite) => (
                    <li
                      key={invite.id}
                      className="flex items-center gap-2 text-xs text-muted"
                    >
                      <span className="flex-1 truncate">
                        {invite.email} · {invite.role.toLowerCase()} · {t(locale, "pendingWord")}
                      </span>
                      <button
                        type="button"
                        aria-label={`${t(locale, "revokeInviteAria")} ${invite.email}`}
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
                        className="shrink-0 hover:text-red-500"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
