"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createApiTokenAction,
  revokeApiTokenAction,
} from "@/server/actions/tokens";
import { useAction } from "@/lib/actions-client";
import { LocalTime } from "@/components/local-time";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { isTagHue, type TagHue } from "@/lib/design-tokens";
import { formatDuration, humanizeDuration } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  API_SCOPES,
  expandScopes,
  validateScopes,
} from "@/lib/api-token-scope";

/* ------------------------------------------------------------------------- *
 * Pure domain helpers
 *
 * The decisions that do not touch the DOM live here, so they can be unit-tested
 * without a browser: which palette hue a scope chip wears, how a token expiry
 * maps onto a badge tone (by proximity), and how an instant renders as a
 * relative phrase. Everything reads only; no helper mutates its input.
 * ------------------------------------------------------------------------- */

/**
 * The copy-control success window: the checkmark shows for exactly this long
 * before the copy affordance returns (docs/DESIGN_SYSTEM.md §6 motion).
 */
export const COPY_FEEDBACK_MS = 1500;

/** A token within this long of expiry gets the warning badge. */
export const TOKEN_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One palette hue per API resource (docs/DESIGN_SYSTEM.md "Tags"). Read and
 * write scopes for the same resource share a hue; the chip label (see
 * {@link scopeChipLabel}) carries the verb. Unknown resources fall back to gray.
 */
export const SCOPE_RESOURCE_HUES: Readonly<Record<string, TagHue>> = {
  pages: "blue",
  databases: "purple",
  tickets: "orange",
  comments: "teal",
  files: "brown",
  webhooks: "yellow",
  members: "pink",
  workspace: "red",
};

/** The `resource` half of an `"action:resource"` scope id, or `null`. */
function scopeResource(scope: string): string | null {
  if (typeof scope !== "string") return null;
  const parts = scope.split(":");
  return parts.length === 2 && parts[1] ? parts[1].trim().toLowerCase() : null;
}

/**
 * Deterministic tag hue for a scope id, keyed by its resource. Never returns an
 * unknown hue: a malformed id or an unrecognised resource is gray.
 */
export function scopeHue(scope: string): TagHue {
  const resource = scopeResource(scope);
  const hue = resource ? SCOPE_RESOURCE_HUES[resource] : undefined;
  return hue && isTagHue(hue) ? hue : "gray";
}

/** Short, human chip label for a scope id (`"read:pages"` → `"Read pages"`). */
export function scopeChipLabel(scope: string): string {
  if (typeof scope !== "string") return "";
  const [action, resource] = scope.split(":");
  if (!action || !resource) return scope;
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} ${resource}`;
}

/**
 * A relative phrase for an ISO instant measured against `now` (e.g. `"2 minutes
 * ago"`, `"in 3 hours"`, `"now"`). Blank/unparseable values render `""`.
 */
export function relativeTime(
  value: string | null | undefined,
  now: number,
): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return humanizeDuration(ms, { now });
}

/**
 * The badge tone for a token's expiry, by proximity to `now`:
 * no/invalid expiry → `neutral`; already expired → `danger`; within
 * {@link TOKEN_EXPIRY_WARN_MS} → `warning`; otherwise `success`.
 */
export function tokenExpiryTone(
  expiresAt: string | null | undefined,
  now: number,
): BadgeTone {
  if (!expiresAt) return "neutral";
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return "neutral";
  if (ms <= now) return "danger";
  if (ms - now <= TOKEN_EXPIRY_WARN_MS) return "warning";
  return "success";
}

/** Badge/column label for a token's expiry ("" when the token never expires). */
export function tokenExpiryLabel(
  expiresAt: string | null | undefined,
  now: number,
): string {
  if (!expiresAt) return "";
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return "";
  if (ms <= now) return "Expired";
  return formatDuration(ms - now, { style: "short" });
}

/**
 * Rendered only after mount so the server and first client render agree on
 * relative labels; a caller can pass `now` to pin the clock (determinism/tests).
 */
export function useMountedNow(injected?: number): number | null {
  const [mountedNow, setMountedNow] = useState<number | null>(null);
  useEffect(() => {
    setMountedNow(Date.now());
  }, []);
  return injected ?? mountedNow;
}

/* ------------------------------------------------------------------------- *
 * Shared presentation
 *
 * Both token surfaces (`ApiTokenManager` and `ApiTokensPanel`) render the exact
 * same body: the create form, scope picker, one-time reveal and token table.
 * They only differ in which action module they call, so the panel passes its
 * actions into this single body instead of keeping a second copy of the markup.
 * ------------------------------------------------------------------------- */

export type ApiTokenRow = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Scopes stored on the token; absent callers simply render no chips. */
  scopes?: readonly string[];
  /** ISO deadline, when the token carries one; absent = never expires. */
  expiresAt?: string | null;
};

export type TokenCreateResult = { token: string } | { error: string };
export type TokenRevokeResult = { ok: true } | { error: string };

export type TokenCreateAction = (
  name: string,
  scopes: string[],
) => Promise<TokenCreateResult>;
export type TokenRevokeAction = (id: string) => Promise<TokenRevokeResult>;

/** One hue-coded scope chip. */
export function ScopeChip({ scope, size = "sm" }: { scope: string; size?: "sm" | "md" }) {
  return (
    <Tag
      hue={scopeHue(scope)}
      size={size}
      dot
      title={scope}
      data-scope={scope}
    >
      {scopeChipLabel(scope)}
    </Tag>
  );
}

/** A wrapping row of scope chips; renders nothing for an empty grant list. */
export function ScopeChips({
  scopes,
  size = "sm",
  className,
}: {
  scopes: readonly string[];
  size?: "sm" | "md";
  className?: string;
}) {
  if (!Array.isArray(scopes) || scopes.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {scopes.map((scope) => (
        <ScopeChip key={scope} scope={scope} size={size} />
      ))}
    </span>
  );
}

/**
 * The scope picker: one checkbox per catalogue scope plus a live preview of the
 * effective grant (a write scope implies its read, admin implies everything).
 *
 * With nothing picked the preview is replaced by a hint: the token would carry
 * an empty grant, and every `/api/v1/*` route refuses such a token with
 * `403 insufficient_scope`. The hint says so before the token exists, so the
 * empty grant is never a surprise.
 */
export function ScopePicker({
  selected,
  onToggle,
  locale,
  disabled = false,
}: {
  selected: readonly string[];
  onToggle: (id: string) => void;
  locale: string;
  disabled?: boolean;
}) {
  const effective = expandScopes(selected);
  return (
    <fieldset
      className="rounded-md border border-border p-3"
      data-testid="token-scope-picker"
      disabled={disabled}
    >
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted">
        {t(locale, "generalAccess")}
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {API_SCOPES.map((scope) => (
          <Checkbox
            key={scope.id}
            checked={selected.includes(scope.id)}
            onCheckedChange={() => onToggle(scope.id)}
            disabled={disabled}
            label={scope.id}
            description={scope.description}
          />
        ))}
      </div>
      {effective.length > 0 ? (
        <div className="mt-3" data-testid="token-effective-scopes">
          <ScopeChips scopes={effective} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted" data-testid="token-scope-empty-hint">
          {t(locale, "tokenNoScopeHint")}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The created-token reveal: the plaintext, shown once, with a copy affordance
 * that checks off for {@link COPY_FEEDBACK_MS} after a successful copy.
 */
export function TokenReveal({ token, locale }: { token: string; locale: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    const finish = () => {
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    };
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(token).then(finish).catch(() => toast.error(t(locale, "couldNotCopy")));
      return;
    }
    toast.error(t(locale, "couldNotCopy"));
  };

  return (
    <Card padding="md" data-testid="token-reveal">
      <p className="text-xs text-muted">{t(locale, "copyTokenOnce")}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-surface-2 px-2 py-1.5 text-xs text-fg">
          {token}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={t(locale, "copyToken")}
          onClick={copy}
          leftIcon={
            copied ? (
              <Check className="h-3.5 w-3.5 text-success" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )
          }
        >
          {copied ? t(locale, "tokenCopied") : null}
        </Button>
      </div>
    </Card>
  );
}

/** One token row in the table. */
export function TokenRow({
  token,
  now,
  locale,
  pending = false,
  onRevoke,
}: {
  token: ApiTokenRow;
  now: number | null;
  locale: string;
  pending?: boolean;
  onRevoke: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const expiryLabel = now === null ? "" : tokenExpiryLabel(token.expiresAt, now);
  const expiryTone = tokenExpiryTone(token.expiresAt, now ?? 0);
  const scopes = token.scopes ?? [];

  return (
    <li
      data-testid="token-row"
      data-token-id={token.id}
      className="flex items-center gap-3 px-4 py-3 text-sm"
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-fg" title={token.name}>
            {token.name}
          </span>
          {expiryLabel ? (
            <Badge
              tone={expiryTone}
              size="sm"
              data-testid="token-expiry"
              title={token.expiresAt ?? undefined}
            >
              {expiryLabel}
            </Badge>
          ) : null}
        </span>
        {scopes.length > 0 ? (
          <ScopeChips scopes={scopes} className="mt-1" />
        ) : (
          // An empty grant is a real state, not an absence: the `/api/v1/*`
          // routes refuse such a token with 403 `insufficient_scope`, so the
          // row says so instead of rendering an empty line.
          <Badge
            tone="warning"
            size="sm"
            className="mt-1"
            data-testid="token-no-scopes"
          >
            {t(locale, "tokenNoScopes")}
          </Badge>
        )}
      </span>

      <span className="hidden w-24 shrink-0 text-xs text-muted sm:block">
        <LocalTime value={token.createdAt} mode="date" />
      </span>

      <span
        className="w-28 shrink-0 text-xs text-muted tabular-nums"
        data-testid="token-last-used"
      >
        {token.lastUsedAt
          ? now === null
            ? <LocalTime value={token.lastUsedAt} />
            : relativeTime(token.lastUsedAt, now)
          : t(locale, "neverUsed")}
      </span>

      <span className="shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t(locale, "revokeToken")}
          disabled={pending}
          onClick={() => setConfirmOpen(true)}
          className="text-muted hover:text-danger"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </span>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="danger"
        title={t(locale, "revokeToken")}
        description={token.name}
        confirmLabel={t(locale, "revokeToken")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={() => {
          setConfirmOpen(false);
          onRevoke(token.id);
        }}
      />
    </li>
  );
}

/**
 * The token table with all three list states: `loading` (a table skeleton that
 * matches the final geometry), `empty` (an actionable empty state) and the rows.
 */
export function TokenTable({
  tokens,
  now,
  locale,
  pending = false,
  loading = false,
  onRevoke,
  emptyAction,
}: {
  tokens: readonly ApiTokenRow[];
  now: number | null;
  locale: string;
  pending?: boolean;
  loading?: boolean;
  onRevoke: (id: string) => void;
  emptyAction?: ReactNode;
}) {
  if (loading) {
    return (
      <Skeleton
        variant="table"
        rows={3}
        cols={3}
        data-testid="token-table-skeleton"
      />
    );
  }

  if (tokens.length === 0) {
    return (
      <EmptyState
        variant="compact"
        data-testid="token-empty-state"
        icon={<KeyRound className="h-4 w-4" aria-hidden />}
        title={t(locale, "noApiTokens")}
        description="Create a token to call the REST API as you."
        primaryAction={emptyAction}
      />
    );
  }

  return (
    <Card padding="none" variant="flat" className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
        <span className="min-w-0 flex-1">{t(locale, "tokenName")}</span>
        <span className="hidden w-24 shrink-0 sm:block">
          {t(locale, "createdPrefix")}
        </span>
        <span className="w-28 shrink-0">{t(locale, "lastUsedPrefix")}</span>
        <span className="w-7 shrink-0" aria-hidden />
      </div>
      <ul className="divide-y divide-border" data-testid="token-list">
        {tokens.map((token) => (
          <TokenRow
            key={token.id}
            token={token}
            now={now}
            locale={locale}
            pending={pending}
            onRevoke={onRevoke}
          />
        ))}
      </ul>
    </Card>
  );
}

/**
 * The one token-management body both surfaces render. `create`/`revoke` are the
 * only difference between the settings panel and the dedicated page, so they are
 * injected here rather than duplicated.
 */
export function ApiTokenPanelBody({
  tokens,
  locale,
  now: injectedNow,
  loading = false,
  create,
  revoke,
  "data-testid": testId = "api-token-panel",
}: {
  tokens: readonly ApiTokenRow[];
  locale: string;
  now?: number;
  loading?: boolean;
  create: TokenCreateAction;
  revoke: TokenRevokeAction;
  "data-testid"?: string;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const now = useMountedNow(injectedNow);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);

  const toggleScope = (id: string) => {
    setScopes((current) =>
      current.includes(id)
        ? current.filter((scope) => scope !== id)
        : [...current, id],
    );
  };

  const submit = () => {
    const validation = validateScopes(scopes);
    if (!validation.ok) {
      toast.error(t(locale, "somethingWentWrong"));
      return;
    }
    run(() => create(name, scopes), {
      onSuccess: (value) => {
        if (value && typeof value === "object" && "token" in value) {
          setCreated(value.token);
          setName("");
          setScopes([]);
          router.refresh();
        }
      },
    });
  };

  return (
    <Section
      className="mt-10"
      data-testid={testId}
      title={t(locale, "apiTokens")}
      description={
        <>
          {t(locale, "apiTokensIntroA")}{" "}
          <code className="rounded-xs bg-surface-2 px-1">
            Authorization: Bearer &lt;token&gt;
          </code>{" "}
          {t(locale, "apiTokensIntroB")}{" "}
          <code className="rounded-xs bg-surface-2 px-1">/api/v1/*</code>.
        </>
      }
    >
      {created ? <TokenReveal token={created} locale={locale} /> : null}

      <Card padding="lg" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field
            id="api-token-name"
            label={t(locale, "tokenName")}
            className="flex-1"
          >
            <Input
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t(locale, "tokenNamePlaceholder")}
              disabled={pending}
            />
          </Field>
          <Button
            type="button"
            onClick={submit}
            disabled={pending}
            loading={pending}
            leftIcon={<Plus className="h-4 w-4" aria-hidden />}
          >
            {t(locale, "createToken")}
          </Button>
        </div>

        <ScopePicker
          selected={scopes}
          onToggle={toggleScope}
          locale={locale}
          disabled={pending}
        />
      </Card>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <TokenTable
        tokens={tokens}
        now={now}
        locale={locale}
        pending={pending}
        loading={loading}
        onRevoke={(id) =>
          run(() => revoke(id), {
            success: t(locale, "tokenRevoked"),
            onSuccess: () => router.refresh(),
          })
        }
        emptyAction={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            leftIcon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={() => nameRef.current?.focus()}
          >
            {t(locale, "createToken")}
          </Button>
        }
      />
    </Section>
  );
}

/**
 * Inline token manager (settings home). Kept for its original call site; it now
 * renders the shared {@link ApiTokenPanelBody}.
 */
export function ApiTokenManager({
  tokens,
  locale,
  now,
}: {
  tokens: ApiTokenRow[];
  locale: string;
  /** Injected clock (ms since epoch) for deterministic relative labels. */
  now?: number;
}) {
  return (
    <ApiTokenPanelBody
      tokens={tokens}
      locale={locale}
      now={now}
      create={createTokenWithScopes}
      revoke={revokeApiTokenAction}
      data-testid="api-token-manager"
    />
  );
}

/**
 * The settings-home entry point binds the token-create action to the
 * two-argument shape the shared body calls. The action validates the picked
 * scopes and stores them, so the token the picker creates carries exactly the
 * grant the user chose. A token created without a single picked scope carries
 * none — the `/api/v1/*` routes refuse such a grant with
 * `403 insufficient_scope`.
 */
const createTokenWithScopes: TokenCreateAction = createApiTokenAction;
