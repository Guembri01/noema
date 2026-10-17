"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Crown, Loader2, UserPlus, Users } from "lucide-react";
import {
  listPagePermissionsAction,
  setPagePermissionAction,
} from "@/server/actions/page-permissions";
import { useAction } from "@/lib/actions-client";
import { resolveAvatar } from "@/lib/avatars";
import { tagClass, type TagHue, Z } from "@/lib/design-tokens";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  focusableSelector,
  resolveReturnTarget,
  trapPlan,
  type Focusable,
  type FocusPlan,
} from "@/lib/focus-trap";

/* ------------------------------------------------------------------------- *
 * Pure domain helpers
 *
 * The roster's decisions that do not touch the DOM live here, so they can be
 * unit-tested without a browser: how a permission level maps to a tag chip,
 * and how the flat member list folds into the Owner / Members / Guests /
 * Invited groups the panel renders. Everything reads only; no helper mutates
 * its input.
 * ------------------------------------------------------------------------- */

/** The bucket a row belongs to. Server rows that omit it read as members. */
export type MemberKind = "owner" | "member" | "guest" | "invited";

/** The groups in render order. */
export const MEMBER_KINDS: readonly MemberKind[] = ["owner", "member", "guest", "invited"];

/** Display label per group. Plain English until the i18n catalogue grows keys. */
export const GROUP_LABELS: Readonly<Record<MemberKind, string>> = {
  owner: "Owner",
  member: "Members",
  guest: "Guests",
  invited: "Invited",
};

/** One roster row. Extra fields (avatar, group kind) are optional. */
export type AccessRow = {
  userId: string;
  name: string;
  email: string;
  level: string | null;
  /** Group bucket; omitted rows read as `member`. */
  kind?: MemberKind;
  avatarUrl?: string | null;
};

/** One non-empty group, in {@link MEMBER_KINDS} order. */
export type MemberGroup = { kind: MemberKind; rows: AccessRow[] };

/** i18n keys a chip may surface (kept narrow so the mapping stays typed). */
export type RoleLabelKey =
  | "inheritRole"
  | "canView"
  | "canComment"
  | "canEdit"
  | "fullAccess";

/** A resolved role chip: the level key, its tag hue and its label key. */
export type RoleChip = { key: string; hue: TagHue; labelKey: RoleLabelKey };

/**
 * Tag palette per access level — the same hues the app already uses for
 * capability chips (gray lowest → purple highest). Keyed by the `SharePermission`
 * string plus `NONE` (inherit). An unknown level falls back to `NONE`.
 */
export const ROLE_CHIPS: Readonly<Record<string, { hue: TagHue; labelKey: RoleLabelKey }>> = {
  NONE: { hue: "gray", labelKey: "inheritRole" },
  READ: { hue: "gray", labelKey: "canView" },
  COMMENT: { hue: "teal", labelKey: "canComment" },
  EDIT: { hue: "blue", labelKey: "canEdit" },
  FULL: { hue: "purple", labelKey: "fullAccess" },
};

/** Resolve an access level to its chip. Never throws on junk input. */
export function roleChip(level: string | null | undefined): RoleChip {
  const key = typeof level === "string" && level in ROLE_CHIPS ? level : "NONE";
  const spec = ROLE_CHIPS[key];
  return { key, hue: spec.hue, labelKey: spec.labelKey };
}

/** Type guard for a persisted/raw group kind. */
export function isMemberKind(value: unknown): value is MemberKind {
  return typeof value === "string" && (MEMBER_KINDS as readonly string[]).includes(value);
}

/**
 * Fold a flat roster into its non-empty groups, in {@link MEMBER_KINDS} order.
 * Rows with no usable id are dropped (they cannot be keyed); a missing/unknown
 * `kind` reads as `member`. The input is never mutated.
 */
export function groupMemberRows(rows: readonly AccessRow[] | null | undefined): MemberGroup[] {
  const buckets = new Map<MemberKind, AccessRow[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.userId !== "string" || row.userId.trim() === "") continue;
    const kind = isMemberKind(row.kind) ? row.kind : "member";
    const list = buckets.get(kind);
    if (list) list.push(row);
    else buckets.set(kind, [row]);
  }
  return MEMBER_KINDS.filter((kind) => buckets.has(kind)).map((kind) => ({
    kind,
    rows: buckets.get(kind) as AccessRow[],
  }));
}

const LEVEL_KEYS: Record<string, RoleLabelKey> = {
  NONE: "inheritRole",
  READ: "canView",
  COMMENT: "canComment",
  EDIT: "canEdit",
  FULL: "fullAccess",
};
const LEVELS = ["NONE", "READ", "COMMENT", "EDIT", "FULL"];

/* ------------------------------------------------------------------------- *
 * Focus management (shared kernel: @/lib/focus-trap)
 *
 * The "Who has access" modal is hand-rolled — it bypasses `ui/dialog` — so it
 * owns its own Tab trap: the roster's level `<select>`s plus the footer button
 * are mapped to `Focusable` descriptors, `trapPlan` decides the next stop
 * (wrapping at the ends), and `resolveReturnTarget` restores focus to the
 * invoking control when the modal unmounts. Escape is intentionally untouched:
 * this overlay never closed on Escape, so adding it would change behaviour.
 * ------------------------------------------------------------------------- */

/**
 * Tab / Shift+Tab plan for the access modal, delegated to the shared
 * `@/lib/focus-trap` kernel. `activeId` is the focused stop's id (`null` when
 * focus is outside the ring, which enters at the first stop — last on
 * Shift+Tab). `null` means "nothing to trap".
 */
export function planWhoHasAccessTab(
  stops: readonly Focusable[],
  { activeId = null, shift = false }: { activeId?: string | null; shift?: boolean } = {},
): FocusPlan | null {
  return trapPlan(stops, {
    initial: activeId === null ? null : { id: activeId },
    shift,
  });
}

/** The modal's real tabbable elements, tagged with their index as the id. */
function accessStops(root: HTMLElement): {
  stops: Focusable[];
  nodes: HTMLElement[];
} {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
  const stops = nodes.map((element, index) => ({
    id: String(index),
    disabled:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true",
    hidden: element.hidden || element.getAttribute("aria-hidden") === "true",
    tabIndex: element.tabIndex,
  }));
  return { stops, nodes };
}

/** Initials/photo avatar for a roster row (delegated to `@/lib/avatars`). */
function MemberAvatar({ row }: { row: AccessRow }) {
  const avatar = resolveAvatar(
    { id: row.userId, name: row.name, email: row.email, avatarUrl: row.avatarUrl ?? null },
    { size: 32 },
  );
  return (
    <span
      aria-hidden
      className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-medium"
      style={{ backgroundColor: avatar.background, color: avatar.foreground }}
    >
      {avatar.kind === "image" && avatar.src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatar.src} alt="" className="h-full w-full object-cover" />
      ) : (
        avatar.initials
      )}
    </span>
  );
}

/** One member row: avatar + identity, a palette role chip and an inline picker. */
function MemberRow({
  row,
  locale,
  busy,
  disabled,
  onChange,
}: {
  row: AccessRow;
  locale: string;
  busy: boolean;
  disabled: boolean;
  onChange: (level: string) => void;
}) {
  const chip = roleChip(row.level);
  const current = row.level ?? "NONE";
  return (
    <li className="flex items-center gap-3 py-2">
      <MemberAvatar row={row} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm" title={row.name}>
          {row.name}
        </span>
        <span className="block truncate text-2xs text-muted" title={row.email}>
          {row.email}
        </span>
      </span>
      <span className="relative inline-flex shrink-0 items-center">
        <select
          value={current}
          aria-label={`${t(locale, "whoHasAccess")} — ${row.name}`}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            tagClass(chip.hue),
            "focus-ring cursor-pointer appearance-none pe-5 disabled:cursor-not-allowed",
            busy && "opacity-50",
          )}
        >
          {LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(locale, LEVEL_KEYS[level])}
            </option>
          ))}
        </select>
        {busy ? (
          <Loader2
            aria-hidden
            className="pointer-events-none absolute end-1.5 h-3 w-3 animate-spin"
          />
        ) : (
          <ChevronDown
            aria-hidden
            className="pointer-events-none absolute end-1.5 h-3 w-3 opacity-70"
          />
        )}
      </span>
    </li>
  );
}

/**
 * The member roster with per-person access levels — the shared body of both
 * share surfaces (the "Who has access" modal and the Share panel). Exported so
 * the Share dialog embeds exactly the same list instead of a second copy.
 *
 * The server answers guests and revoked users with an empty list, so this
 * renders an empty state rather than a roster they must not see. Rows are
 * folded into groups (`groupMemberRows`); a change shows an optimistic pending
 * spinner on that row and only commits the new level once the server accepts.
 */
export function AccessList({
  pageId,
  locale = "en",
}: {
  pageId: string;
  locale?: string;
}) {
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { run, pending, error } = useAction(locale);
  const wasPending = useRef(false);

  // Clear the per-row pending marker once the shared transition settles — on
  // success *and* on failure, so a rejected change never leaves a row spinning.
  useEffect(() => {
    if (wasPending.current && !pending) setPendingId(null);
    wasPending.current = pending;
  }, [pending]);

  useEffect(() => {
    let live = true;
    void listPagePermissionsAction(pageId)
      .then((list) => {
        if (live) setRows(list as AccessRow[]);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [pageId]);

  const change = (userId: string, level: string) => {
    setPendingId(userId);
    run(() => setPagePermissionAction(pageId, userId, level as "NONE"), {
      onSuccess: () =>
        setRows((current) =>
          current
            ? current.map((row) =>
                row.userId === userId ? { ...row, level: level === "NONE" ? null : level } : row,
              )
            : current,
        ),
    });
  };

  if (rows === null) {
    return (
      <div aria-busy="true" className="space-y-2 py-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 py-1">
            <span className="notion-skeleton h-8 w-8 rounded-full" />
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="notion-skeleton block h-3 w-1/3 rounded" />
              <span className="notion-skeleton block h-2.5 w-1/2 rounded" />
            </span>
            <span className="notion-skeleton h-6 w-20 rounded-sm" />
          </div>
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 px-1 py-6 text-center">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-2 text-muted">
          <Users className="h-4 w-4" aria-hidden />
        </span>
        <p className="text-sm text-fg">{t(locale, "noMembers")}</p>
        <p className="text-xs text-muted">
          People with access will appear here as you share this page.
        </p>
      </div>
    );
  }

  const groups = groupMemberRows(rows);
  return (
    <div className="max-h-80 overflow-y-auto scrollbar-thin">
      {groups.map((group) => (
        <div key={group.kind} className="py-1">
          <p className="flex items-center gap-1.5 px-1 py-1 text-2xs font-medium uppercase tracking-wide text-muted">
            {group.kind === "owner" && <Crown className="h-3 w-3" aria-hidden />}
            {group.kind === "invited" && <UserPlus className="h-3 w-3" aria-hidden />}
            {GROUP_LABELS[group.kind]}
          </p>
          <ul className="divide-y divide-border">
            {group.rows.map((row) => (
              <MemberRow
                key={row.userId}
                row={row}
                locale={locale}
                busy={pending && pendingId === row.userId}
                disabled={pending}
                onChange={(level) => change(row.userId, level)}
              />
            ))}
          </ul>
        </div>
      ))}

      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Who can open this page, member by member. Lists the effective explicit level
 * (or "inherit") and lets an editor change it — the capability the page menu was
 * missing even though the server could already answer it.
 */
export function WhoHasAccess({
  pageId,
  locale = "en",
  onClose,
}: {
  pageId: string;
  onClose: () => void;
  locale?: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  // Record the invoking control, move focus into the modal, and restore the
  // invoker on unmount (only while it is still connected).
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      invokerRef.current = active;
    }
    dialogRef.current?.focus();
    return () => {
      const invoker = invokerRef.current;
      invokerRef.current = null;
      const target = resolveReturnTarget({
        invoker: invoker
          ? { id: "access-invoker", connected: invoker.isConnected }
          : null,
      });
      if (target) invoker?.focus();
    };
  }, []);

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const { stops, nodes } = accessStops(event.currentTarget);
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? nodes.indexOf(active) : -1;
    const plan = planWhoHasAccessTab(stops, {
      activeId: activeIndex >= 0 ? String(activeIndex) : null,
      shift: event.shiftKey,
    });
    if (!plan) return;
    const target = nodes[Number(plan.target.id)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: Z.overlay }}
    >
      <button
        type="button"
        aria-label={t(locale, "close")}
        onClick={onClose}
        className="focus-ring absolute inset-0 bg-overlay"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={t(locale, "whoHasAccess")}
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        style={{ zIndex: Z.modal }}
        className="surface-raised-strong relative w-full max-w-lg p-4 outline-none"
      >
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Users className="h-4 w-4 text-muted" aria-hidden /> {t(locale, "whoHasAccess")}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {t(locale, "whoHasAccessIntro")}
        </p>

        <div className="mt-4">
          <AccessList pageId={pageId} locale={locale} />
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label={t(locale, "done")}
            className="focus-ring u-colors h-9 rounded-sm border border-border px-3 text-sm hover:bg-surface-2"
          >
            {t(locale, "done")}
          </button>
        </div>
      </div>
    </div>
  );
}
