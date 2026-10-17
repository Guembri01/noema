"use client";

import { useId, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Crown,
  LogOut,
  Mail,
  Send,
  ShieldCheck,
  UserMinus,
  Users,
  UserX,
} from "lucide-react";
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
import type { TagHue } from "@/lib/design-tokens";
import {
  ROLE_LABEL_KEYS,
  membersCapabilities,
  roleChangeMessage,
  roleLabelKey,
  toPersistedRole,
  validatePersistedRoleChange,
  type PersistedWorkspaceRole,
} from "@/lib/workspace-role-map";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tag } from "@/components/ui/tag";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

/* ------------------------------------------------------------------------- *
 * Pure domain helpers
 *
 * Everything the roster decides that does not touch the DOM lives here so it
 * can be unit-tested without a browser: the role → assignable-roles map (via
 * the shared engine), the member/guest partition, and the role → tag-hue map
 * the chips paint with. Nothing here mutates its input and nothing carries a
 * raw colour.
 * ------------------------------------------------------------------------- */

export type MemberRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
};

/** One invitation that has been sent but not yet accepted. */
export type PendingInviteRow = {
  id: string;
  email: string;
  role: string;
  /** ISO date the invite expires, when known. */
  expiresAt?: string | null;
};

/** Tag-palette hue per persisted role (gray guest → purple owner). */
export const ROLE_HUES: Record<PersistedWorkspaceRole, TagHue> = {
  OWNER: "purple",
  ADMIN: "blue",
  MEMBER: "green",
  GUEST: "gray",
};

/** The tag hue a role chip paints with; unknown roles fail closed to gray. */
export function roleHue(role: unknown): TagHue {
  const persisted = toPersistedRole(role);
  return persisted ? ROLE_HUES[persisted] : "gray";
}

/**
 * The persisted roles an actor may grant — the engine's decision, never a
 * hand-rolled comparison. Unknown/non-managing actors get an empty list.
 */
export function assignableRolesFor(actorRole: unknown): PersistedWorkspaceRole[] {
  return membersCapabilities(actorRole).assignable;
}

/** The already-localised picker options for an actor's role `Select`. */
export function roleSelectOptions(actorRole: unknown, locale: string): SelectOption[] {
  return assignableRolesFor(actorRole).map((role) => ({
    value: role,
    label: t(locale, ROLE_LABEL_KEYS[role]),
  }));
}

/** The two buckets the roster renders in separate sections. */
export type MemberGroups = { members: MemberRow[]; guests: MemberRow[] };

/**
 * Split the flat roster into members (owner/admin/member) and guests, in
 * encounter order. Rows without a usable id are dropped (they cannot be keyed);
 * an unknown role reads as a member rather than a guest.
 */
export function groupMembers(
  rows: readonly MemberRow[] | null | undefined,
): MemberGroups {
  const members: MemberRow[] = [];
  const guests: MemberRow[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.userId !== "string" || row.userId.trim() === "") continue;
    if (toPersistedRole(row.role) === "GUEST") guests.push(row);
    else members.push(row);
  }
  return { members, guests };
}

/* ------------------------------------------------------------------------- *
 * Local pieces
 * ------------------------------------------------------------------------- */

/** A layout-shaped loading placeholder for one roster section. */
function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-md border border-border"
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-border p-3 last:border-b-0"
        >
          <Skeleton variant="circle" width={28} height={28} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton variant="block" width="35%" height={12} />
            <Skeleton variant="block" width="55%" height={10} />
          </span>
          <Skeleton variant="block" width={72} height={24} />
        </div>
      ))}
    </div>
  );
}

function roleLabel(locale: string, role: unknown): string {
  return t(locale, roleLabelKey(role));
}

/** One directory row: avatar + identity, a role chip/picker, and the actions. */
function MemberRowItem({
  member,
  locale,
  isTargetOwner,
  isSelf,
  roleLocked,
  canManage,
  canTransfer,
  pending,
  roleOptions,
  onRoleChange,
  onRemove,
  onTransfer,
}: {
  member: MemberRow;
  locale: string;
  isTargetOwner: boolean;
  isSelf: boolean;
  roleLocked: boolean;
  canManage: boolean;
  canTransfer: boolean;
  pending: boolean;
  roleOptions: SelectOption[];
  onRoleChange: (member: MemberRow, role: PersistedWorkspaceRole) => void;
  onRemove: (member: MemberRow) => void;
  onTransfer: (member: MemberRow) => void;
}) {
  const persisted = toPersistedRole(member.role);
  const editable = canManage && !roleLocked && persisted !== null;

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <Avatar user={{ id: member.userId, name: member.name, email: member.email }} size={28} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate" title={member.name}>
            {member.name}
          </span>
          {isTargetOwner && <Crown className="h-3 w-3 text-warning" aria-hidden />}
          {isSelf && <span className="text-xs text-muted">(you)</span>}
        </span>
        <span className="block truncate text-xs text-muted" title={member.email}>
          {member.email}
        </span>
      </span>

      {editable ? (
        <span className="flex w-36 shrink-0">
          <Select
            options={roleOptions}
            value={persisted}
            onChange={(value) => onRoleChange(member, value as PersistedWorkspaceRole)}
            aria-label={`Role for ${member.name}`}
            searchable={false}
            allowClear={false}
            size="sm"
            disabled={pending}
          />
        </span>
      ) : (
        <Tag hue={roleHue(member.role)} size="sm">
          {roleLabel(locale, member.role)}
        </Tag>
      )}

      {/* Ownership only moves to a member or admin — a guest can never own. */}
      {canTransfer && !isSelf && !isTargetOwner && persisted !== "GUEST" && (
        <Tooltip label={t(locale, "transferOwnership")}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={pending}
            onClick={() => onTransfer(member)}
            aria-label={`Make ${member.name} the owner`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      )}

      {canManage && !isSelf && !isTargetOwner && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={pending}
          onClick={() => onRemove(member)}
          aria-label={`Remove ${member.name}`}
          className="text-muted hover:text-danger"
        >
          <UserMinus className="h-4 w-4" />
        </Button>
      )}
    </li>
  );
}

/** One pending invitation: identity, the role it grants and an awaiting spinner. */
function PendingInviteItem({ invite, locale }: { invite: PendingInviteRow; locale: string }) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <Avatar user={{ id: invite.id, name: invite.email }} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={invite.email}>
          {invite.email}
        </span>
        <span className="block text-xs text-muted">{t(locale, "pendingWord")}</span>
      </span>
      <Tag hue={roleHue(invite.role)} size="sm">
        {roleLabel(locale, invite.role)}
      </Tag>
      <Spinner size="sm" label={t(locale, "pendingWord")} className="text-muted" />
    </li>
  );
}

/* ------------------------------------------------------------------------- *
 * MembersManager
 * ------------------------------------------------------------------------- */

/**
 * Members and roles: change a role, remove someone, hand over ownership, invite
 * a teammate, or leave. Every rule mirrors the server (the server re-checks all
 * of them), so the UI never offers an action that would be refused.
 *
 * The roster is presented in three `Section`s — Members, Pending invites and
 * Guests — each with a loading skeleton and an actionable empty state, so a
 * workspace at any size has one predictable shape (docs/DESIGN_SYSTEM.md §8).
 */
export function MembersManager({
  workspaceId,
  workspaceName,
  ownerId,
  currentUserId,
  currentUserRole,
  locale,
  members,
  pendingInvites = [],
  loading = false,
  errorMessage = null,
}: {
  workspaceId: string;
  workspaceName: string;
  ownerId: string;
  currentUserId: string;
  currentUserRole: string;
  members: MemberRow[];
  locale: string;
  pendingInvites?: PendingInviteRow[];
  loading?: boolean;
  errorMessage?: string | null;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);
  const [transferTarget, setTransferTarget] = useState<MemberRow | null>(null);
  const [transferPassword, setTransferPassword] = useState("");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"GUEST" | "MEMBER" | "ADMIN">("MEMBER");
  const [inviteTouched, setInviteTouched] = useState(false);
  const inviteInputRef = useRef<HTMLInputElement | null>(null);

  // Gating comes from the workspace-role engine (through the persisted-enum
  // bridge), never from hand-rolled role comparisons, so the UI cannot drift
  // from the decision table the server re-checks.
  const caps = membersCapabilities(currentUserRole);
  const isOwner = currentUserId === ownerId || caps.persistedRole === "OWNER";
  const canManage = caps.canManageMembers;
  const refresh = () => router.refresh();

  const groups = groupMembers(members);
  const memberRoleOptions = roleSelectOptions(currentUserRole, locale);
  const inviteRoleOptions: SelectOption[] = (["ADMIN", "MEMBER", "GUEST"] as const)
    .filter((role) => caps.assignable.includes(role))
    .map((role) => ({
      value: role,
      label: t(
        locale,
        role === "ADMIN"
          ? "inviteRoleAdmin"
          : role === "MEMBER"
            ? "inviteRoleMember"
            : "inviteRoleGuest",
      ),
    }));

  // Live validation of the invite address via `@/lib/email-validation`: the same
  // helpers the server re-checks with. Errors stay hidden until the field is
  // blurred or submit is pressed so the form does not scold mid-typing; a typo
  // hint (`gmial.com` → `gmail.com`) is offered whenever the engine recognises
  // one, even while the address is still syntactically valid.
  const inviteValue = inviteEmail.trim();
  const inviteInputId = useId();
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

  /** Change a role, validated against the engine before touching the server. */
  const changeRole = (member: MemberRow, nextRole: PersistedWorkspaceRole) => {
    const validation = validatePersistedRoleChange({
      actorRole: currentUserRole,
      targetRole: member.role,
      newRole: nextRole,
      members: members.map((row) => ({ role: row.role })),
      self: member.userId === currentUserId,
    });
    if (!validation.ok) {
      toast.error(roleChangeMessage(validation.errors));
      return;
    }
    run(() => setMemberRoleAction(workspaceId, member.userId, nextRole), {
      success: `${member.name} is now ${t(locale, ROLE_LABEL_KEYS[nextRole])}`,
      onSuccess: refresh,
    });
  };

  const focusInvite = () => inviteInputRef.current?.focus();

  const inviteButton = canManage ? (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      leftIcon={<Send className="h-4 w-4" />}
      onClick={focusInvite}
    >
      {t(locale, "invite")}
    </Button>
  ) : undefined;

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
      {/* ---------------------------------------------------------------- */}
      <Section
        title={t(locale, "members")}
        description="People with access to this workspace."
        action={loading ? undefined : inviteButton}
      >
        {loading ? (
          <RowsSkeleton />
        ) : groups.members.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Users className="h-4 w-4" />}
            title={t(locale, "noMembers")}
            description="Invite a teammate to collaborate on pages and databases."
            primaryAction={
              canManage ? (
                <Button size="sm" leftIcon={<Send className="h-4 w-4" />} onClick={focusInvite}>
                  {t(locale, "invite")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Card variant="flat" padding="none">
            <ul className="divide-y divide-border">
              {groups.members.map((member) => {
                const isTargetOwner = member.userId === ownerId;
                const isSelf = member.userId === currentUserId;
                const roleLocked =
                  isTargetOwner || (!isOwner && member.role === "ADMIN") || isSelf;
                return (
                  <MemberRowItem
                    key={member.userId}
                    member={member}
                    locale={locale}
                    isTargetOwner={isTargetOwner}
                    isSelf={isSelf}
                    roleLocked={roleLocked}
                    canManage={canManage}
                    canTransfer={caps.canTransferOwnership}
                    pending={pending}
                    roleOptions={memberRoleOptions}
                    onRoleChange={changeRole}
                    onRemove={setRemoveTarget}
                    onTransfer={setTransferTarget}
                  />
                );
              })}
            </ul>
          </Card>
        )}

        {canManage && !loading && (
          <Card variant="flat" padding="md">
            <form
              className="flex flex-wrap items-end gap-3"
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
              <Field
                id={inviteInputId}
                label={t(locale, "inviteEmailAria")}
                className="min-w-56 flex-1"
                error={inviteError || undefined}
                hint={
                  inviteSuggestions.length > 0 ? (
                    <span>
                      Did you mean{" "}
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-auto px-1 py-0 align-baseline text-accent"
                        onClick={() => applyDomainFix(inviteSuggestions[0])}
                      >
                        {inviteSuggestions[0]}
                      </Button>
                      ?
                    </span>
                  ) : undefined
                }
              >
                <Input
                  ref={inviteInputRef}
                  type="email"
                  required
                  value={inviteEmail}
                  placeholder={t(locale, "clientEmailPlaceholder")}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  onBlur={() => setInviteTouched(true)}
                  disabled={pending}
                />
              </Field>

              <Field
                id={`${inviteInputId}-role`}
                label={t(locale, "inviteRoleAria")}
                className="w-48 shrink-0"
              >
                <Select
                  id={`${inviteInputId}-role`}
                  options={inviteRoleOptions}
                  value={inviteRole}
                  onChange={(value) => setInviteRole(value as typeof inviteRole)}
                  aria-label={t(locale, "inviteRoleAria")}
                  searchable={false}
                  allowClear={false}
                  disabled={pending}
                />
              </Field>

              <Button
                type="submit"
                disabled={pending || !inviteValue}
                loading={pending}
                leftIcon={<Send className="h-4 w-4" />}
              >
                {t(locale, "invite")}
              </Button>
            </form>
          </Card>
        )}
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Pending invites"
        description="Invitations that have been sent but not accepted yet."
      >
        {loading ? (
          <RowsSkeleton rows={2} />
        ) : pendingInvites.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Mail className="h-4 w-4" />}
            title="No pending invites"
            description="Invitations you send appear here until they are accepted."
          />
        ) : (
          <Card variant="flat" padding="none">
            <ul className="divide-y divide-border">
              {pendingInvites.map((invite) => (
                <PendingInviteItem key={invite.id} invite={invite} locale={locale} />
              ))}
            </ul>
          </Card>
        )}
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Guests"
        description="View-only clients attached to this workspace."
      >
        {loading ? (
          <RowsSkeleton rows={2} />
        ) : groups.guests.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<UserX className="h-4 w-4" />}
            title="No guests"
            description="Invite a client as a guest to share view-only access."
          />
        ) : (
          <Card variant="flat" padding="none">
            <ul className="divide-y divide-border">
              {groups.guests.map((member) => (
                <MemberRowItem
                  key={member.userId}
                  member={member}
                  locale={locale}
                  isTargetOwner={member.userId === ownerId}
                  isSelf={member.userId === currentUserId}
                  roleLocked
                  canManage={canManage}
                  canTransfer={caps.canTransferOwnership}
                  pending={pending}
                  roleOptions={memberRoleOptions}
                  onRoleChange={changeRole}
                  onRemove={setRemoveTarget}
                  onTransfer={setTransferTarget}
                />
              ))}
            </ul>
          </Card>
        )}
      </Section>

      {/* ---------------------------------------------------------------- */}
      {!isOwner && (
        <Card
          variant="flat"
          padding="md"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <p className="text-sm text-muted">{t(locale, "leaveWorkspaceConfirm")}</p>
          <Button
            type="button"
            variant="danger"
            tone="soft"
            size="sm"
            leftIcon={<LogOut className="h-4 w-4" />}
            disabled={pending}
            onClick={() => setLeaveOpen(true)}
          >
            {t(locale, "leaveWorkspaceTrigger")}
          </Button>
        </Card>
      )}

      {(errorMessage || error) && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage ?? error}
        </p>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        tone="danger"
        title={removeTarget ? `Remove ${removeTarget.name}?` : ""}
        description={
          removeTarget
            ? `${removeTarget.name} loses access to this workspace and its pages.`
            : undefined
        }
        confirmLabel={t(locale, "removeMember")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={() => {
          const target = removeTarget;
          if (!target) return;
          run(() => removeMemberAction(workspaceId, target.userId), {
            success: `${target.name} removed`,
            onSuccess: () => {
              setRemoveTarget(null);
              refresh();
            },
          });
        }}
      />

      <ConfirmDialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTransferTarget(null);
        }}
        tone="danger"
        title={transferTarget ? `Make ${transferTarget.name} the owner?` : ""}
        description="You become an admin and can no longer delete the workspace."
        confirmLabel={t(locale, "transferOwnership")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={() => {
          const target = transferTarget;
          if (!target) return;
          run(() => transferOwnershipAction(workspaceId, target.userId, transferPassword), {
            success: "Ownership transferred",
            onSuccess: () => {
              setTransferTarget(null);
              setTransferPassword("");
              refresh();
            },
          });
        }}
      >
        <label className="block text-sm">
          <span className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-muted" aria-hidden /> Your password
          </span>
          <input
            type="password"
            value={transferPassword}
            onChange={(event) => setTransferPassword(event.target.value)}
            placeholder="Your password"
            autoComplete="current-password"
            className="focus-ring mt-1 h-9 w-full rounded-sm border border-border bg-bg px-2 text-sm"
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        tone="danger"
        title={t(locale, "leaveWorkspace")}
        description={`${workspaceName} — ${t(locale, "leaveWorkspaceConfirm")}`}
        confirmLabel={t(locale, "leaveWorkspace")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={() =>
          run(() => leaveWorkspaceAction(workspaceId), {
            success: "You left the workspace",
            onSuccess: () => {
              setLeaveOpen(false);
              router.push("/app");
              router.refresh();
            },
          })
        }
      />
      </div>
    </TooltipProvider>
  );
}
