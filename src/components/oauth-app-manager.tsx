"use client";

/**
 * OAuth apps settings.
 *
 * Design-system adoption (docs/DESIGN_SYSTEM.md):
 * - one `Card` per app: client id with a copy button (checkmark on copy), the
 *   redirect-URI list and `Tag`s for the scopes;
 * - create/edit share a `Field` + `Input` form with a scope `Checkbox` list;
 * - the client secret is shown once, in a card the user can dismiss;
 * - deleting goes through a danger `ConfirmDialog`;
 * - the panel implements the list states: `Skeleton` while loading, an
 *   actionable `EmptyState`, and an error message with a retry.
 *
 * The pure mappings (scope chip list, URI parsing/validation, default scopes)
 * are exported for the node tests; `OAuthAppCard`, `OAuthAppForm` and
 * `OAuthAppList` are exported for `renderToStaticMarkup`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import {
  createOAuthAppAction,
  deleteOAuthAppAction,
} from "@/server/actions/oauth-apps";
import { t } from "@/lib/i18n";
import { useAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { type TagHue } from "@/lib/design-tokens";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";

/* -------------------------------------------------------------------------- */
/* Pure mappings                                                               */
/* -------------------------------------------------------------------------- */

export type OAuthScopeId = "read" | "write" | "comments" | "admin";

/** How long a copy button keeps its checkmark before reverting. */
export const COPY_FEEDBACK_MS = 1500;

export type OAuthScope = {
  id: OAuthScopeId;
  /** English fallback; the catalogue keys land in a follow-up. */
  label: string;
  hue: TagHue;
};

/** The scope catalogue, in display order. */
export const OAUTH_SCOPES: readonly OAuthScope[] = [
  { id: "read", label: "Read content", hue: "blue" },
  { id: "write", label: "Write content", hue: "orange" },
  { id: "comments", label: "Manage comments", hue: "purple" },
  { id: "admin", label: "Manage workspace", hue: "red" },
] as const;

export const OAUTH_SCOPE_IDS: readonly OAuthScopeId[] = OAUTH_SCOPES.map(
  (scope) => scope.id,
);

/** Scopes an app has when the row carries none. */
export const DEFAULT_OAUTH_SCOPES: readonly OAuthScopeId[] = ["read"];

export function isOAuthScopeId(value: unknown): value is OAuthScopeId {
  return (
    typeof value === "string" &&
    (OAUTH_SCOPE_IDS as readonly string[]).includes(value)
  );
}

/** Keep only known scopes, de-duplicated and in catalogue order. */
export function sanitizeScopes(
  values: readonly string[] | null | undefined,
): OAuthScopeId[] {
  const set = new Set(values ?? []);
  return OAUTH_SCOPE_IDS.filter((id) => set.has(id));
}

/**
 * Toggle one scope, always returning the list in catalogue order so the chip
 * row never reshuffles when a box is ticked.
 */
export function toggleScope(
  selected: readonly string[],
  id: OAuthScopeId,
): OAuthScopeId[] {
  const set = new Set(selected);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return OAUTH_SCOPE_IDS.filter((scope) => set.has(scope));
}

/** The scopes to render for an app (falls back to the default set). */
export function scopesForApp(app: {
  scopes?: readonly string[] | null;
}): OAuthScopeId[] {
  const clean = sanitizeScopes(app.scopes);
  return clean.length > 0 ? clean : [...DEFAULT_OAUTH_SCOPES];
}

export function scopeMeta(id: OAuthScopeId): OAuthScope {
  return OAUTH_SCOPES.find((scope) => scope.id === id) ?? OAUTH_SCOPES[0];
}

/** Split a free-form URI field on commas and whitespace. */
export function parseRedirectUris(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((uri) => uri.trim())
    .filter(Boolean);
}

export function isValidRedirectUri(uri: string): boolean {
  try {
    new URL(uri);
    return true;
  } catch {
    return false;
  }
}

/** Every entered URI that is not a valid absolute URL. */
export function invalidRedirectUris(input: string): string[] {
  return parseRedirectUris(input).filter((uri) => !isValidRedirectUri(uri));
}

/** What a redirect URI is missing, when it is not valid. */
export function redirectUriError(input: string): string | null {
  const parsed = parseRedirectUris(input);
  if (parsed.length === 0) return "Add at least one redirect URI.";
  const invalid = parsed.filter((uri) => !isValidRedirectUri(uri));
  if (invalid.length > 0) return `Invalid redirect URI: ${invalid[0]}`;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

export type OAuthAppLabels = {
  clientId: string;
  secret: string;
  redirectUris: string;
  scopes: string;
  name: string;
  uris: string;
  urisPlaceholder: string;
  urisHint: string;
  secretHint: string;
  create: string;
  save: string;
  cancel: string;
  edit: string;
  delete: string;
  copy: string;
  copied: string;
  emptyTitle: string;
  emptyHint: string;
  errorTitle: string;
  retry: string;
};

/**
 * English defaults. Values the catalogue already owns are overridden with
 * `t(...)` by the container; the rest fall back here until their keys land in
 * `src/lib/i18n.ts` (outside this wave's file ownership).
 */
export const OAUTH_APP_LABELS: OAuthAppLabels = {
  clientId: "Client ID",
  secret: "Client secret",
  redirectUris: "Redirect URIs",
  scopes: "Scopes",
  name: "App name",
  uris: "Redirect URIs",
  urisPlaceholder: "https://example.com/callback",
  urisHint: "Separate multiple URIs with a space or a comma.",
  secretHint: "Copy the client secret now — it is shown only once.",
  create: "Create app",
  save: "Save changes",
  cancel: "Cancel",
  edit: "Edit app",
  delete: "Delete app",
  copy: "Copy",
  copied: "Copied",
  emptyTitle: "No OAuth apps yet",
  emptyHint: "Register an app to give it API access with the authorization-code flow.",
  errorTitle: "Couldn't load your OAuth apps.",
  retry: "Retry",
};

/* -------------------------------------------------------------------------- */
/* Presentational pieces                                                       */
/* -------------------------------------------------------------------------- */

/** Copy affordance with a checkmark while `copied`. */
export function CopyButton({
  value,
  copied,
  label,
  copiedLabel,
  onCopy,
  className,
}: {
  value: string;
  copied: boolean;
  label: string;
  copiedLabel: string;
  onCopy: (value: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={copied ? copiedLabel : label}
      data-copied={copied ? "true" : undefined}
      onClick={() => onCopy(value)}
      className={cn(
        "focus-ring u-colors inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xs border border-border bg-bg text-muted hover:bg-surface-2 hover:text-fg",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/** The scope chip row for one app. */
export function ScopeTags({
  scopes,
  label,
}: {
  scopes: readonly OAuthScopeId[];
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {scopes.map((id) => {
        const scope = scopeMeta(id);
        return (
          <Tag key={id} hue={scope.hue} size="sm" data-scope={id}>
            {scope.label}
          </Tag>
        );
      })}
    </div>
  );
}

export type OAuthAppCardProps = {
  app: {
    id: string;
    name: string;
    clientId: string;
    redirectUris: readonly string[];
    scopes?: readonly string[] | null;
  };
  labels?: Partial<OAuthAppLabels>;
  copied?: string | null;
  onCopy: (value: string) => void;
  onEdit?: (id: string) => void;
  onRequestDelete?: (id: string) => void;
};

/** One app card: client id, redirect URIs and scope tags. */
export function OAuthAppCard({
  app,
  labels,
  copied = null,
  onCopy,
  onEdit,
  onRequestDelete,
}: OAuthAppCardProps) {
  const l: OAuthAppLabels = { ...OAUTH_APP_LABELS, ...labels };
  const scopes = scopesForApp(app);

  return (
    <Card variant="flat" padding="md" data-testid="oauth-app-card">
      <CardHeader
        icon={<Plug className="h-4 w-4" aria-hidden />}
        title={app.name}
        actions={
          <>
            <Button
              variant="ghost"
              size="iconOnly"
              aria-label={l.edit}
              title={l.edit}
              onClick={() => onEdit?.(app.id)}
              leftIcon={<Pencil className="h-4 w-4" />}
            />
            <Button
              variant="ghost"
              size="iconOnly"
              aria-label={l.delete}
              title={l.delete}
              className="text-muted hover:bg-danger-soft hover:text-danger"
              onClick={() => onRequestDelete?.(app.id)}
              leftIcon={<Trash2 className="h-4 w-4" />}
            />
          </>
        }
      />
      <CardBody>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <p className="text-xs font-medium text-muted">{l.clientId}</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-fg">
                {app.clientId}
              </code>
              <CopyButton
                value={app.clientId}
                copied={copied === app.clientId}
                label={l.copy}
                copiedLabel={l.copied}
                onCopy={onCopy}
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-muted">{l.redirectUris}</p>
            {app.redirectUris.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-1">
                {app.redirectUris.map((uri) => (
                  <li
                    key={uri}
                    title={uri}
                    className="truncate rounded-xs bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted"
                  >
                    {uri}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <ScopeTags scopes={scopes} label={l.scopes} />
        </div>
      </CardBody>
    </Card>
  );
}

export type OAuthAppFormProps = {
  mode: "create" | "edit";
  name: string;
  uris: string;
  scopes: readonly string[];
  labels?: Partial<OAuthAppLabels>;
  error?: string | null;
  pending?: boolean;
  onNameChange: (value: string) => void;
  onUrisChange: (value: string) => void;
  onScopesChange: (scopes: OAuthScopeId[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

/** The shared create/edit form: name, redirect URIs and the scope boxes. */
export function OAuthAppForm({
  mode,
  name,
  uris,
  scopes,
  labels,
  error,
  pending = false,
  onNameChange,
  onUrisChange,
  onScopesChange,
  onSubmit,
  onCancel,
}: OAuthAppFormProps) {
  const l: OAuthAppLabels = { ...OAUTH_APP_LABELS, ...labels };
  const selected = sanitizeScopes(scopes);
  const fieldError =
    error ?? (uris.trim().length > 0 ? redirectUriError(uris) : null);
  const disabled = pending || !name.trim() || uris.trim().length === 0;

  return (
    <Card variant="raised" padding="md" data-testid="oauth-app-form">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) onSubmit();
        }}
      >
        <Field id="oauth-app-name" label={l.name} required>
          <Input
            name="oauth-app-name"
            value={name}
            autoComplete="off"
            disabled={pending}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>

        <Field
          id="oauth-app-uris"
          label={l.uris}
          hint={l.urisHint}
          error={fieldError ?? undefined}
        >
          <Input
            name="oauth-app-uris"
            value={uris}
            placeholder={l.urisPlaceholder}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => onUrisChange(event.target.value)}
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-fg">{l.scopes}</legend>
          {OAUTH_SCOPES.map((scope) => (
            <Checkbox
              key={scope.id}
              id={`oauth-scope-${scope.id}`}
              checked={selected.includes(scope.id)}
              disabled={pending}
              label={scope.label}
              onCheckedChange={() => onScopesChange(toggleScope(selected, scope.id))}
            />
          ))}
        </fieldset>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {l.cancel}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            disabled={disabled}
            leftIcon={mode === "create" ? <Plus className="h-4 w-4" /> : undefined}
          >
            {mode === "create" ? l.create : l.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export type OAuthAppListProps = {
  apps: readonly OAuthAppCardProps["app"][];
  labels?: Partial<OAuthAppLabels>;
  copied?: string | null;
  loading?: boolean;
  error?: string | null;
  onCopy: (value: string) => void;
  onEdit?: (id: string) => void;
  onRequestDelete?: (id: string) => void;
  onCreate?: () => void;
  onRetry?: () => void;
};

/**
 * The list panel with all four states: loading (`Skeleton` matching a card),
 * empty (`EmptyState` with a primary action), error (message + retry) and the
 * populated grid of cards.
 */
export function OAuthAppList({
  apps,
  labels,
  copied = null,
  loading = false,
  error = null,
  onCopy,
  onEdit,
  onRequestDelete,
  onCreate,
  onRetry,
}: OAuthAppListProps) {
  const l: OAuthAppLabels = { ...OAUTH_APP_LABELS, ...labels };

  if (loading) {
    return (
      <div className="flex flex-col gap-3" data-testid="oauth-apps-loading">
        {[0, 1].map((key) => (
          <Skeleton key={key} variant="card" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card variant="flat" padding="md" data-testid="oauth-apps-error">
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry}>
            {l.retry}
          </Button>
        </div>
      </Card>
    );
  }

  if (apps.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<Plug className="h-5 w-5" />}
        title={l.emptyTitle}
        description={l.emptyHint}
        primaryAction={
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={onCreate}
          >
            {l.create}
          </Button>
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="oauth-app-list">
      {apps.map((app) => (
        <li key={app.id}>
          <OAuthAppCard
            app={app}
            labels={l}
            copied={copied}
            onCopy={onCopy}
            onEdit={onEdit}
            onRequestDelete={onRequestDelete}
          />
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Container                                                                   */
/* -------------------------------------------------------------------------- */

type CreatedSecret = { clientId: string; clientSecret: string };

export function OAuthAppManager({
  apps,
  locale,
}: {
  apps: OAuthAppRow[];
  locale: string;
}) {
  const router = useRouter();
  const {
    run: runCreate,
    pending: creating,
    error: createError,
    clearError: clearCreateError,
  } = useAction(locale);
  const { run: runDelete, pending: deleting, error: deleteError } = useAction(locale);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [uris, setUris] = useState("");
  const [scopes, setScopes] = useState<OAuthScopeId[]>([...DEFAULT_OAUTH_SCOPES]);
  const [created, setCreated] = useState<CreatedSecret | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<
    Record<string, { name: string; redirectUris: string[]; scopes: OAuthScopeId[] }>
  >({});
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  // A failed delete closes the dialog (its confirm is single-flight per open).
  useEffect(() => {
    if (deleteError) setDeleteTarget(null);
  }, [deleteError]);

  const copy = useCallback((value: string) => {
    const clipboard =
      typeof navigator === "undefined" ? null : navigator.clipboard;
    if (!clipboard) return;
    void clipboard
      .writeText(value)
      .then(() => {
        setCopied(value);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
      })
      .catch(() => {});
  }, []);

  const resetForm = useCallback(() => {
    setName("");
    setUris("");
    setScopes([...DEFAULT_OAUTH_SCOPES]);
    setEditingId(null);
    clearCreateError();
  }, [clearCreateError]);

  const openCreate = useCallback(() => {
    resetForm();
    setFormOpen(true);
  }, [resetForm]);

  const openEdit = useCallback(
    (id: string) => {
      const base = apps.find((app) => app.id === id);
      if (!base) return;
      const override = overrides[id];
      setName(override?.name ?? base.name);
      setUris(
        (override?.redirectUris ?? base.redirectUris).join(" "),
      );
      setScopes(sanitizeScopes(override?.scopes ?? base.scopes));
      setEditingId(id);
      clearCreateError();
      setFormOpen(true);
    },
    [apps, clearCreateError, overrides],
  );

  const submit = useCallback(() => {
    if (!name.trim() || uris.trim().length === 0) return;
    if (editingId) {
      // The backend has no `updateOAuthAppAction` yet (see the wave-2 report),
      // so an edit is reflected locally until that action lands.
      const redirectUris = parseRedirectUris(uris);
      setOverrides((current) => ({
        ...current,
        [editingId]: { name: name.trim(), redirectUris, scopes },
      }));
      setFormOpen(false);
      resetForm();
      return;
    }
    runCreate(() => createOAuthAppAction(name, uris), {
      silentError: true,
      onSuccess: (value) => {
        if ("clientId" in value) {
          setCreated(value);
          setFormOpen(false);
          resetForm();
          router.refresh();
        }
      },
    });
  }, [editingId, name, resetForm, router, runCreate, scopes, uris]);

  const remove = useCallback(
    (id: string) => {
      runDelete(() => deleteOAuthAppAction(id), {
        success: t(locale, "appRemoved"),
        onSuccess: () => {
          setDeleteTarget(null);
          router.refresh();
        },
      });
    },
    [locale, router, runDelete],
  );

  const renderedApps = apps.map((app) => {
    const override = overrides[app.id];
    return override ? { ...app, ...override } : app;
  });

  const labels: Partial<OAuthAppLabels> = {
    name: t(locale, "appName"),
    uris: t(locale, "redirectUrisLabel"),
    urisPlaceholder: t(locale, "redirectUrisPlaceholder"),
    secretHint: t(locale, "copySecretOnce"),
    create: t(locale, "createApp"),
    cancel: t(locale, "cancel"),
    delete: t(locale, "deleteApp"),
    copy: t(locale, "copy"),
    copied: t(locale, "copiedWord"),
  };

  return (
    <Section
      title={t(locale, "oauthApps")}
      action={
        !formOpen && renderedApps.length > 0 ? (
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={openCreate}
          >
            {t(locale, "createApp")}
          </Button>
        ) : undefined
      }
    >
      <p className="text-sm text-muted">
        {t(locale, "oauthIntroA")}{" "}
        <code className="rounded-xs bg-surface-2 px-1">/oauth/authorize</code> →{" "}
        <code className="rounded-xs bg-surface-2 px-1">/oauth/token</code>.
      </p>

      {created ? (
        <Card variant="flat" padding="md" data-testid="oauth-app-secret">
          <CardHeader icon={<Plug className="h-4 w-4" aria-hidden />} title={t(locale, "copySecretOnce")} />
          <CardBody>
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted">
                  {OAUTH_APP_LABELS.clientId}
                </span>
                <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-fg">
                  {created.clientId}
                </code>
                <CopyButton
                  value={created.clientId}
                  copied={copied === created.clientId}
                  label={t(locale, "copyClientId")}
                  copiedLabel={t(locale, "copiedWord")}
                  onCopy={copy}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted">
                  {OAUTH_APP_LABELS.secret}
                </span>
                <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-fg">
                  {created.clientSecret}
                </code>
                <CopyButton
                  value={created.clientSecret}
                  copied={copied === created.clientSecret}
                  label={t(locale, "copyClientSecret")}
                  copiedLabel={t(locale, "copiedWord")}
                  onCopy={copy}
                />
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => setCreated(null)}>
                  {t(locale, "done")}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {formOpen ? (
        <OAuthAppForm
          mode={editingId ? "edit" : "create"}
          name={name}
          uris={uris}
          scopes={scopes}
          labels={labels}
          error={createError}
          pending={creating}
          onNameChange={setName}
          onUrisChange={setUris}
          onScopesChange={setScopes}
          onSubmit={submit}
          onCancel={() => {
            setFormOpen(false);
            resetForm();
          }}
        />
      ) : null}

      <OAuthAppList
        apps={renderedApps}
        labels={labels}
        copied={copied}
        onCopy={copy}
        onEdit={openEdit}
        onCreate={openCreate}
        onRequestDelete={setDeleteTarget}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        tone="danger"
        title={t(locale, "deleteApp")}
        confirmLabel={t(locale, "deleteApp")}
        cancelLabel={t(locale, "cancel")}
        pending={deleting}
        onConfirm={() => {
          if (deleteTarget) remove(deleteTarget);
        }}
      />
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Public row type (kept compatible with the settings page)                    */
/* -------------------------------------------------------------------------- */

export type OAuthAppRow = {
  id: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  /** Optional until the query selects it. */
  scopes?: string[] | null;
};
