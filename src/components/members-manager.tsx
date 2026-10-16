"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Crown, LogOut, ShieldCheck, UserMinus } from "lucide-react";
import { toast } from "sonner";
import {
  leaveWorkspaceAction,
  removeMemberAction,
  setMemberRoleAction,
  transferOwnershipAction,
} from "@/server/actions/workspaces";
import { sendWorkspaceInviteAction } from "@/server/actions/email";
import { useAction } from "@/lib/actions-client";
import {
  isDisposableDomain,
  isValidEmail,
  normalizeEmail,
  suggestDomainFixes,
} from "@/lib/email-validation";
import { t } from "@/lib/i18n";
import {
  membersCapabilities,
  roleChangeMessage,
  validatePersistedRoleChange,
} from "@/lib/workspace-role-map";

export type MemberRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
};

/** Workspace roles map onto catalogue keys for translation. */
const ROLE_KEYS: Record<string, "owner" | "admin" | "member" | "guest"> = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  GUEST: "guest",
};



/**
 * Members and roles: change a role, remove someone, hand over ownership, or leave.
 * Every rule mirrors the server (the server re-checks all of them), so the UI
 * never offers an action that would be refused.
 */
export function MembersManager({
  workspaceId,
  workspaceName,
  ownerId,
  currentUserId,
  currentUserRole,
  locale,
  members,
}: {
  workspaceId: string;
  workspaceName: string;
  ownerId: string;
  currentUserId: string;
  currentUserRole: string;
  members: MemberRow[];
  locale: string;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [transferring, setTransferring] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"GUEST" | "MEMBER" | "ADMIN">("MEMBER");
  const [inviteTouched, setInviteTouched] = useState(false);

  // Gating comes from the workspace-role engine (through the persisted-enum
  // bridge), never from hand-rolled role comparisons, so the UI cannot drift
  // from the decision table the server re-checks.
  const caps = membersCapabilities(currentUserRole);
  const isOwner = currentUserId === ownerId || caps.persistedRole === "OWNER";
  const canManage = caps.canManageMembers;
  const refresh = () => router.refresh();

  // Live validation of the invite address via `@/lib/email-validation`: the same
  // helpers the server re-checks with. Errors stay hidden until the field is
  // blurred or submit is pressed so the form does not scold mid-typing; a typo
  // hint (`gmial.com` → `gmail.com`) is offered whenever the engine recognises
  // one, even while the address is still syntactically valid.
  const inviteValue = inviteEmail.trim();
  const inviteInputId = useId();
  const inviteHintId = `${inviteInputId}-hint`;
  const inviteSuggestions = inviteValue ? suggestDomainFixes(inviteValue) : [];
  const inviteError =
    inviteTouched && inviteValue
      ? !isValidEmail(inviteValue)
        ? "Enter a valid email address."
        : isDisposableDomain(inviteValue)
          ? "Disposable email addresses are not allowed."
          : ""
      : "";

  /** Swap a recognised typo domain in while keeping the local part untouched. */
  const applyDomainFix = (domain: string) => {
    const at = inviteEmail.lastIndexOf("@");
    const local = at > 0 ? inviteEmail.slice(0, at) : "";
    setInviteEmail(local ? `${local}@${domain}` : domain);
  };

  /** Invite by email: existing members join instantly, everyone else gets a link. */
  const invite = (email: string) =>
    run(
      () =>
        sendWorkspaceInviteAction({
          workspaceId,
          email,
          role: inviteRole,
        }),
      {
        onSuccess: (result) => {
          if ("error" in result) return;
          setInviteEmail("");
          void navigator.clipboard?.writeText(result.link).catch(() => undefined);
          const detail = result.emailed
            ? t(locale, "emailed")
            : result.warning?.includes("not configured")
              ? t(locale, "linkCopiedNotConfigured")
              : t(locale, "linkCopiedFailed");
          toast.success(`${t(locale, "inviteCreated")} — ${detail}`);
          refresh();
        },
      },
    );

  return (
    <div className="space-y-3">
      {/* No directory for guests: render nothing until the leave block below. */}
      {members.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {members.map((member) => {
          const isTargetOwner = member.userId === ownerId;
          const isSelf = member.userId === currentUserId;
          const roleLocked =
            isTargetOwner || (!isOwner && member.role === "ADMIN") || isSelf;
          return (
            <li key={member.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface text-[11px] font-medium">
                {member.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{member.name}</span>
                  {isTargetOwner && <Crown className="h-3 w-3 text-amber-500" aria-hidden />}
                  {isSelf && <span className="text-[10px] text-muted">(you)</span>}
                </span>
                <span className="block truncate text-[11px] text-muted">{member.email}</span>
              </span>

              {canManage && !roleLocked ? (
                <select
                  value={member.role}
                  aria-label={`Role for ${member.name}`}
                  disabled={pending}
                  onChange={(event) => {
                    const nextRole = event.target.value;
                    // Validate against the engine before touching the server, so a
                    // refused change never leaves the select showing a role it will
                    // not take.
                    const validation = validatePersistedRoleChange({
                      actorRole: currentUserRole,
                      targetRole: member.role,
                      newRole: nextRole,
                      members: members.map((row) => ({ role: row.role })),
                      self: isSelf,
                    });
                    if (!validation.ok) {
                      toast.error(roleChangeMessage(validation.errors));
                      return;
                    }
                    run(() => setMemberRoleAction(workspaceId, member.userId, nextRole), {
                      success: `${member.name} is now ${t(locale, ROLE_KEYS[nextRole] ?? "member")}`,
                      onSuccess: refresh,
                    });
                  }}
                  className="h-8 rounded border border-border bg-bg px-1.5 text-xs disabled:opacity-50"
                >
                  {caps.assignable.map((role) => (
                    <option key={role} value={role}>
                      {t(locale, ROLE_KEYS[role] ?? "member")}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="rounded bg-surface px-2 py-0.5 text-[11px] text-muted">
                  {t(locale, ROLE_KEYS[member.role] ?? "member")}
                </span>
              )}

              {/* Ownership only moves to a member or admin — a guest can never own. */}
              {caps.canTransferOwnership &&
                !isSelf &&
                !isTargetOwner &&
                member.role !== "GUEST" &&
                confirming !== `transfer:${member.userId}` && (
                <button
                  type="button"
                  aria-label={`Make ${member.name} the owner`}
                  title={t(locale, "transferOwnership")}
                  disabled={pending}
                  onClick={() => setTransferring(member.userId)}
                  className="flex h-8 items-center gap-1 rounded px-2 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> {t(locale, "transferOwnership")}
                </button>
              )}

              {canManage && !isSelf && !isTargetOwner && (
                <>
                  {confirming === member.userId ? (
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(() => removeMemberAction(workspaceId, member.userId), {
                            success: `${member.name} removed`,
                            onSuccess: () => {
                              setConfirming(null);
                              refresh();
                            },
                          })
                        }
                        className="h-8 rounded bg-red-600 px-2 text-xs text-white hover:bg-red-500 disabled:opacity-50"
                      >
                        {t(locale, "removeMember")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="h-8 rounded px-2 text-xs text-muted hover:bg-surface-2"
                      >
                        {t(locale, "cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove ${member.name}`}
                      disabled={pending}
                      onClick={() => setConfirming(member.userId)}
                      className="flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-red-500"
                    >
                      <UserMinus className="h-4 w-4" />
                    </button>
                  )}
                </>
              )}
            </li>
          );
          })}
        </ul>
      )}

      {canManage && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            setInviteTouched(true);
            // Submit the canonical form (trimmed, domain lowercased); refuse
            // anything the engine rejects or flags as throwaway.
            const email = normalizeEmail(inviteEmail);
            if (!email || isDisposableDomain(email)) return;
            void invite(email);
          }}
        >
          <input
            id={inviteInputId}
            type="email"
            required
            value={inviteEmail}
            aria-label={t(locale, "inviteEmailAria")}
            aria-invalid={inviteError ? true : undefined}
            aria-describedby={
              inviteError || inviteSuggestions.length > 0 ? inviteHintId : undefined
            }
            placeholder="client@example.com"
            onChange={(event) => setInviteEmail(event.target.value)}
            onBlur={() => setInviteTouched(true)}
            className="h-8 min-w-44 flex-1 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <select
            value={inviteRole}
            aria-label={t(locale, "inviteRoleAria")}
            onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
            className="h-8 rounded border border-border bg-bg px-1.5 text-xs"
          >
            {caps.assignable.includes("ADMIN") && (
              <option value="ADMIN">{t(locale, "inviteRoleAdmin")}</option>
            )}
            {caps.assignable.includes("MEMBER") && (
              <option value="MEMBER">{t(locale, "inviteRoleMember")}</option>
            )}
            {caps.assignable.includes("GUEST") && (
              <option value="GUEST">{t(locale, "inviteRoleGuest")}</option>
            )}
          </select>
          <button
            type="submit"
            disabled={pending || !inviteValue}
            className="h-8 rounded bg-accent px-3 text-xs text-accent-fg disabled:opacity-50"
          >
            {t(locale, "invite")}
          </button>
          {(inviteError || inviteSuggestions.length > 0) && (
            <div id={inviteHintId} className="w-full space-y-0.5">
              {inviteError && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {inviteError}
                </p>
              )}
              {inviteSuggestions.length > 0 && (
                <p className="text-xs text-muted">
                  Did you mean{" "}
                  <button
                    type="button"
                    onClick={() => applyDomainFix(inviteSuggestions[0])}
                    className="font-medium text-accent underline-offset-2 hover:underline"
                  >
                    {inviteSuggestions[0]}
                  </button>
                  ?
                </p>
              )}
            </div>
          )}
        </form>
      )}

      {transferring && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p>
            Make{" "}
            <strong>{members.find((m) => m.userId === transferring)?.name ?? "this member"}</strong>{" "}
            the owner? You become an admin and can no longer delete the workspace.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() => transferOwnershipAction(workspaceId, transferring), {
                  success: "Ownership transferred",
                  onSuccess: () => {
                    setTransferring(null);
                    refresh();
                  },
                })
              }
              className="h-8 rounded bg-accent px-2.5 text-xs text-accent-fg disabled:opacity-50"
            >
              Transfer ownership
            </button>
            <button
              type="button"
              onClick={() => setTransferring(null)}
              className="h-8 rounded px-2 text-xs text-muted hover:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!isOwner && (
        <div className="rounded-lg border border-border p-3">
          {leaving ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>\n                <strong className="font-medium">{workspaceName}</strong> — {t(locale, "leaveWorkspaceConfirm")}\n              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(() => leaveWorkspaceAction(workspaceId), {
                    success: "You left the workspace",
                    onSuccess: () => {
                      setLeaving(false);
                      router.push("/app");
                      router.refresh();
                    },
                  })
                }
                className="h-8 rounded bg-red-600 px-2.5 text-xs text-white hover:bg-red-500 disabled:opacity-50"
              >
                {t(locale, "leaveWorkspace")}
              </button>
              <button
                type="button"
                onClick={() => setLeaving(false)}
                className="h-8 rounded px-2 text-xs text-muted hover:bg-surface-2"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setLeaving(true)}
              className="flex items-center gap-1.5 text-sm text-muted hover:text-red-500"
            >
              <LogOut className="h-4 w-4" /> {t(locale, "leaveWorkspaceTrigger")}
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
