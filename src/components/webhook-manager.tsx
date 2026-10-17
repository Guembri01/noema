"use client";

import { useCallback, useId, useMemo, useState, useTransition } from "react";
import { guarded } from "@/lib/actions-client";
import { useRouter } from "next/navigation";
import { Inbox, Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { toast } from "sonner";
import {
  createWebhookAction as createWebhookActionRaw,
  deleteWebhookAction as deleteWebhookActionRaw,
} from "@/server/actions/webhooks";
import { t } from "@/lib/i18n";
import { WEBHOOK_EVENT_CATALOG } from "@/lib/webhook-events";
import { LocalTime } from "@/components/local-time";
import {
  WEBHOOK_EVENTS,
  isWebhookEventType,
  matchesSubscription,
  validateEventPayload,
} from "@/lib/webhook-event-catalog";
import {
  canAttempt,
  createBreaker,
  onFailure,
  onSuccess,
  stateName,
  type BreakerName,
} from "@/lib/circuit-breaker";
import type { TagHue } from "@/lib/design-tokens";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";

/** Transport-safe wrappers (F-09): a failed request now returns `{ error }`. */
const createWebhookAction = guarded(createWebhookActionRaw);
const deleteWebhookAction = guarded(deleteWebhookActionRaw);

export type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  hasSecret: boolean;
};

export type DeliveryRow = {
  id: string;
  event: string;
  ok: boolean;
  status: number | null;
  attempts: number;
  error: string | null;
  url: string;
  createdAt: string;
};

/** Stored subscriptions are raw wire ids; render them through the identity catalog. */
const EVENT_LABELS = new Map<string, string>(
  WEBHOOK_EVENT_CATALOG.map((event) => [event.id, event.label]),
);

/**
 * A wildcard subscription the picker offers on top of the exact event ids:
 * `*` for everything, or a namespace prefix (`page.*`, `row.*`, …) derived from
 * the catalog. `matchesSubscription` decides which events each one selects, and
 * the delivery path (`dispatchWebhooks`) already honours the stored pattern.
 */
type WildcardSubscription = {
  /** Wire pattern stored on the webhook. */
  readonly pattern: string;
  /** How many catalog events the pattern selects (a neutral count badge). */
  readonly matchCount: number;
  /** One-line description for the picker, naming how many events it selects. */
  readonly description: string;
};

/** The distinct namespaces in the catalog — the segment before the first dot. */
const EVENT_NAMESPACES = [
  ...new Set(
    WEBHOOK_EVENTS.map((event) =>
      event.type.slice(0, event.type.indexOf(".")),
    ),
  ),
].sort();

/** How many catalog events a subscription pattern selects — via the shared matcher. */
function matchedEventCount(pattern: string): number {
  return WEBHOOK_EVENTS.filter((event) =>
    matchesSubscription(event.type, pattern),
  ).length;
}

/** Wildcard patterns the picker offers: `*` first, then one per namespace. */
const WILDCARD_SUBSCRIPTIONS: readonly WildcardSubscription[] = [
  {
    pattern: "*",
    matchCount: matchedEventCount("*"),
    description: `Subscribe to every event (${matchedEventCount("*")}).`,
  },
  ...EVENT_NAMESPACES.map((namespace) => {
    const pattern = `${namespace}.*`;
    return {
      pattern,
      matchCount: matchedEventCount(pattern),
      description: `Subscribe to every ${namespace} event (${matchedEventCount(pattern)}).`,
    };
  }),
];

/* -------------------------------------------------------------------------- *
 * Pure mappings — event → tag hue, delivery → badge tone, form validation
 * -------------------------------------------------------------------------- */

/**
 * Event namespace → tag hue. Keys are bare namespaces (no dot) so the
 * event-vocabulary grep gate in `webhook-events.test.ts` still holds.
 */
const NAMESPACE_HUES: Readonly<Record<string, TagHue>> = {
  page: "blue",
  row: "green",
  comment: "purple",
  database: "teal",
  view: "orange",
  project: "pink",
  ticket: "yellow",
  user: "brown",
  member: "brown",
  workspace: "red",
  label: "yellow",
  cycle: "orange",
  property: "teal",
  discussion: "purple",
  template: "gray",
  calendar: "blue",
  oauth: "red",
  integration: "teal",
  credential: "red",
  status: "green",
  tag: "yellow",
};

/** The namespace of an event id (the segment before the first dot), or `""` when none. */
export function eventNamespace(eventType: string): string {
  const dot = eventType.indexOf(".");
  return dot > 0 ? eventType.slice(0, dot) : "";
}

/**
 * The tag hue an event id renders with. Derived from its namespace so a new
 * catalog event automatically inherits its family colour; unknown namespaces
 * fall back to gray (never an unstyled chip).
 */
export function eventTagHue(eventType: string): TagHue {
  return NAMESPACE_HUES[eventNamespace(eventType)] ?? "gray";
}

/** The tag hue for a stored subscription pattern (`*`, `page.*` or an exact id). */
export function subscriptionTagHue(pattern: string): TagHue {
  if (pattern === "*") return "gray";
  if (pattern.endsWith(".*")) {
    return NAMESPACE_HUES[pattern.slice(0, -2)] ?? "gray";
  }
  return eventTagHue(pattern);
}

/**
 * Badge tone for one delivery result. A 4xx is a `warning` (the endpoint
 * refused the payload) while a 5xx, a transport error or a missing status is a
 * `danger`; a success is the only `success`.
 */
export function deliveryStatusTone(ok: boolean, status: number | null): BadgeTone {
  if (ok) return "success";
  if (status !== null && status >= 400 && status < 500) return "warning";
  return "danger";
}

/** Badge tone for a webhook's folded delivery circuit. */
export function circuitTone(circuit: BreakerName): BadgeTone {
  if (circuit === "closed") return "success";
  if (circuit === "half-open") return "warning";
  return "danger";
}

/** The newest delivery in a set (by `createdAt`), or `null` when empty. */
export function latestDelivery(rows: readonly DeliveryRow[]): DeliveryRow | null {
  let latest: DeliveryRow | null = null;
  for (const row of rows) {
    if (!latest || Date.parse(row.createdAt) > Date.parse(latest.createdAt)) {
      latest = row;
    }
  }
  return latest;
}

/** Inline copy for this panel. Kept here (not scattered) for the i18n pass. */
export const WEBHOOK_MESSAGES = {
  urlRequired: "Enter a webhook URL.",
  urlInvalid: "Enter a valid URL.",
  urlProtocol: "Only http(s) webhook URLs are allowed.",
  secretRequired: "A signing secret is required.",
  secretOnEdit: "Re-enter the signing secret to save changes.",
  eventsLabel: "Events",
  editLabel: "Edit",
  fixFields: "Fix the highlighted fields.",
  testOnSave: "Send a test request after saving",
  testOk: (status: number) => `Test delivered (${status}).`,
  testFailed: (status: number) => `Test failed (${status}).`,
  testUnreachable: "Test request could not reach the endpoint.",
  lastDelivery: "Last delivery",
} as const;

/** Field-keyed errors for the create/edit form. Empty object means valid. */
export type WebhookFormErrors = {
  url?: string;
  secret?: string;
  events?: string;
};

/** Validate one webhook URL against the server's rules. `null` when valid. */
export function validateWebhookUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return WEBHOOK_MESSAGES.urlRequired;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return WEBHOOK_MESSAGES.urlInvalid;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return WEBHOOK_MESSAGES.urlProtocol;
  }
  return null;
}

/** Validate the whole create/edit form. Pure — mirrored by the server action. */
export function validateWebhookForm(input: {
  url: string;
  secret: string;
  events: readonly string[];
}): WebhookFormErrors {
  const errors: WebhookFormErrors = {};
  const urlError = validateWebhookUrl(input.url);
  if (urlError) errors.url = urlError;
  if (!input.secret.trim()) errors.secret = WEBHOOK_MESSAGES.secretRequired;
  const eventsError = validateEventSelection(input.events);
  if (eventsError) errors.events = eventsError;
  return errors;
}

/** Whether a validation result carries any problem. */
export function hasWebhookFormErrors(errors: WebhookFormErrors): boolean {
  return Boolean(errors.url || errors.secret || errors.events);
}

/** Outcome of a client-side "send test" probe. */
export type WebhookTestResult = {
  ok: boolean;
  /** HTTP status when the request completed, otherwise `null`. */
  status: number | null;
  message: string;
};

/**
 * Fire a realistic test POST at a webhook URL and classify the result. The
 * `fetch` implementation is injectable so the mapping is provable in node.
 *
 * A test delivery is deliberately unsigned — the signing secret never leaves
 * the server — so this proves reachability, not signature verification (see
 * the follow-up note in the PR description).
 */
export async function probeWebhookEndpoint(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookTestResult> {
  const invalid = validateWebhookUrl(url);
  if (invalid) return { ok: false, status: null, message: invalid };
  try {
    const response = await fetchImpl(url.trim(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noema-event": "webhook.test",
        "x-noema-test": "true",
      },
      body: JSON.stringify({ event: "webhook.test", at: new Date().toISOString() }),
    });
    return response.ok
      ? { ok: true, status: response.status, message: WEBHOOK_MESSAGES.testOk(response.status) }
      : {
          ok: false,
          status: response.status,
          message: WEBHOOK_MESSAGES.testFailed(response.status),
        };
  } catch {
    return { ok: false, status: null, message: WEBHOOK_MESSAGES.testUnreachable };
  }
}

/**
 * Join stored subscription patterns into picker labels: `*` renders as the
 * locale's "all events", namespace prefixes (`page.*`) render as themselves,
 * exact ids through the identity catalog, and anything else falls back verbatim.
 */
function subscriptionLabel(id: string, locale: string): string {
  const wildcard = WILDCARD_SUBSCRIPTIONS.find((option) => option.pattern === id);
  if (wildcard) {
    return wildcard.pattern === "*" ? t(locale, "allEvents") : wildcard.pattern;
  }
  return EVENT_LABELS.get(id) ?? id;
}

function subscriptionLabels(ids: readonly string[], locale: string): string {
  return ids.map((id) => subscriptionLabel(id, locale)).join(", ");
}

/**
 * Validate a picked subscription set against the B91 catalog before creating the
 * hook, mirroring the server's `WEBHOOK_EVENTS` filter in `createWebhookAction`.
 * Accepts exact event ids and the wildcard patterns the picker offers; returns
 * the first problem message, or `null` when every entry is known.
 */
function validateEventSelection(selected: readonly string[]): string | null {
  for (const pattern of selected) {
    if (isWebhookEventType(pattern)) continue;
    if (WILDCARD_SUBSCRIPTIONS.some((option) => option.pattern === pattern)) {
      continue;
    }
    return validateEventPayload(pattern, {})[0].message;
  }
  return null;
}

/** Per-webhook delivery health folded from its recent `WebhookDelivery` rows. */
type DeliveryHealth = {
  /** Effective circuit at the newest delivery instant: `closed`, `open`, or `half-open`. */
  circuit: BreakerName;
  /** Whether the circuit would let another attempt through right now. */
  attemptable: boolean;
  /** Retry attempts recorded by the webhook's newest delivery. */
  attempts: number;
};

/**
 * Replay a webhook's deliveries (any order) through the shared breaker so the
 * manager can surface an open/closed delivery circuit per webhook alongside the
 * newest retry count. Older rows are applied first; `now` is pinned to the
 * newest row's timestamp instead of `Date.now()`, so the reading is
 * deterministic and server/client renders agree.
 */
function deliveryHealth(rows: readonly DeliveryRow[]): DeliveryHealth | null {
  if (rows.length === 0) return null;
  const chronological = [...rows].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  let state = createBreaker();
  for (const row of chronological) {
    const at = Date.parse(row.createdAt);
    state = row.ok ? onSuccess(state, at) : onFailure(state, at);
  }
  const newest = chronological[chronological.length - 1];
  const now = Date.parse(newest.createdAt);
  return {
    circuit: stateName(state, now),
    attemptable: canAttempt(state, now),
    attempts: newest.attempts,
  };
}

/* -------------------------------------------------------------------------- *
 * Presentational pieces
 * -------------------------------------------------------------------------- */

/** How many event tags one endpoint row shows before collapsing to a `+N` badge. */
export const MAX_EVENT_TAGS = 4;

export type EndpointRowProps = {
  webhook: WebhookRow;
  health: DeliveryHealth | null;
  latest: DeliveryRow | null;
  locale: string;
  testing?: boolean;
  testResult?: WebhookTestResult | null;
  onTest: (webhook: WebhookRow) => void;
  onEdit: (webhook: WebhookRow) => void;
  onDelete: (webhook: WebhookRow) => void;
};

/**
 * One endpoint row. Pure presentation (all state lives in `WebhookManager`) so
 * it can be rendered in a node test without a router or a server action.
 */
export function EndpointRow({
  webhook,
  health,
  latest,
  locale,
  testing = false,
  testResult = null,
  onTest,
  onEdit,
  onDelete,
}: EndpointRowProps) {
  const events = webhook.events;
  const shown = events.slice(0, MAX_EVENT_TAGS);
  const overflow = events.length - shown.length;

  return (
    <li
      data-testid="webhook-endpoint-row"
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
    >
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs text-fg"
        title={webhook.url}
      >
        {webhook.url}
      </span>

      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {events.length === 0 ? (
          <Tag hue="gray" size="sm">
            {t(locale, "allEvents")}
          </Tag>
        ) : (
          <>
            {shown.map((pattern) => (
              <Tag
                key={pattern}
                hue={subscriptionTagHue(pattern)}
                size="sm"
                dot
              >
                {subscriptionLabel(pattern, locale)}
              </Tag>
            ))}
            {overflow > 0 ? (
              <Badge size="sm" tone="neutral" title={events.join(", ")}>
                {`+${overflow}`}
              </Badge>
            ) : null}
          </>
        )}
      </span>

      <span className="flex shrink-0 flex-wrap items-center gap-1">
        {latest ? (
          <Badge
            size="sm"
            tone={deliveryStatusTone(latest.ok, latest.status)}
            title={latest.error ?? undefined}
          >
            {latest.ok
              ? latest.status ?? t(locale, "done")
              : t(locale, "failedWord")}
          </Badge>
        ) : (
          <Badge size="sm" tone="neutral">
            {t(locale, "never")}
          </Badge>
        )}
        {health ? (
          <Badge
            size="sm"
            tone={circuitTone(health.circuit)}
            title={
              health.attemptable
                ? "Delivery circuit closed"
                : "Delivery circuit open"
            }
          >
            {`${health.circuit} · ${health.attempts} ${t(locale, "attemptUnit")}`}
          </Badge>
        ) : null}
        {webhook.hasSecret ? (
          <Badge size="sm" tone="neutral">
            {t(locale, "signedBadge")}
          </Badge>
        ) : null}
      </span>

      <span className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          loading={testing}
          leftIcon={<Send className="h-3.5 w-3.5" />}
          onClick={() => onTest(webhook)}
        >
          {t(locale, "testConnection")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={WEBHOOK_MESSAGES.editLabel}
          onClick={() => onEdit(webhook)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          tone="soft"
          className="text-muted hover:text-danger"
          aria-label={t(locale, "deleteWebhook")}
          onClick={() => onDelete(webhook)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </span>

      {testResult ? (
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "w-full text-xs sm:ms-auto sm:w-auto",
            testResult.ok ? "text-success" : "text-danger",
          )}
        >
          {testResult.message}
        </p>
      ) : null}
    </li>
  );
}

/** Three layout-shaped rows that hold the list height while data reloads. */
function EndpointListSkeleton() {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} variant="row" />
      ))}
    </div>
  );
}

type FormFeedback = { kind: "success" | "error"; message: string };

type FormMode = { kind: "create" } | { kind: "edit"; id: string } | null;

/* -------------------------------------------------------------------------- *
 * Container
 * -------------------------------------------------------------------------- */

export function WebhookManager({
  workspaceId,
  webhooks,
  deliveries,
  locale,
}: {
  workspaceId: string;
  webhooks: WebhookRow[];
  deliveries: DeliveryRow[];
  locale: string;
}) {
  const router = useRouter();
  const urlId = useId();
  const secretId = useId();
  const eventsId = useId();

  const [mode, setMode] = useState<FormMode>(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [testOnSave, setTestOnSave] = useState(false);
  const [errors, setErrors] = useState<WebhookFormErrors>({});
  const [feedback, setFeedback] = useState<FormFeedback | null>(null);
  const [pending, startTransition] = useTransition();
  const [testingUrl, setTestingUrl] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, WebhookTestResult>>(
    {},
  );
  const [deleting, setDeleting] = useState<WebhookRow | null>(null);

  const eventOptions = useMemo<SelectOption[]>(
    () => [
      ...WILDCARD_SUBSCRIPTIONS.map((option) => ({
        value: option.pattern,
        label: option.pattern === "*" ? t(locale, "allEvents") : option.pattern,
        description: option.description,
        tag: subscriptionTagHue(option.pattern),
      })),
      ...WEBHOOK_EVENTS.map((event) => ({
        value: event.type,
        label: event.label,
        description: event.description,
        tag: eventTagHue(event.type),
      })),
    ],
    [locale],
  );

  // Group the recent delivery log by webhook URL so each row can show its own
  // circuit and newest retry count. The RSC payload only carries the URL, so it
  // is the join key available to the manager.
  const deliveriesByUrl = useMemo(() => {
    const map = new Map<string, DeliveryRow[]>();
    for (const delivery of deliveries) {
      const rows = map.get(delivery.url);
      if (rows) rows.push(delivery);
      else map.set(delivery.url, [delivery]);
    }
    return map;
  }, [deliveries]);

  const resetForm = useCallback(() => {
    setMode(null);
    setUrl("");
    setSecret("");
    setEvents([]);
    setTestOnSave(false);
    setErrors({});
  }, []);

  const openCreate = useCallback(() => {
    setFeedback(null);
    setErrors({});
    setUrl("");
    setSecret("");
    setEvents([]);
    setMode({ kind: "create" });
  }, []);

  const openEdit = useCallback((webhook: WebhookRow) => {
    setFeedback(null);
    setErrors({});
    setUrl(webhook.url);
    setSecret("");
    setEvents(webhook.events);
    setMode({ kind: "edit", id: webhook.id });
  }, []);

  const runTest = useCallback(async (targetUrl: string) => {
    setTestingUrl(targetUrl);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[targetUrl];
      return next;
    });
    const result = await probeWebhookEndpoint(targetUrl);
    setTestResults((prev) => ({ ...prev, [targetUrl]: result }));
    setTestingUrl(null);
  }, []);

  const save = useCallback(() => {
    const nextErrors = validateWebhookForm({ url, secret, events });
    setErrors(nextErrors);
    if (hasWebhookFormErrors(nextErrors)) {
      setFeedback({ kind: "error", message: WEBHOOK_MESSAGES.fixFields });
      return;
    }
    const editing = mode?.kind === "edit" ? mode.id : null;
    startTransition(async () => {
      const trimmedUrl = url.trim();
      const result = await createWebhookAction({
        workspaceId,
        url: trimmedUrl,
        events,
        secret: secret.trim(),
      });
      if ("error" in result) {
        setFeedback({ kind: "error", message: result.error });
        return;
      }
      // No dedicated update action: editing replaces the endpoint. Create first,
      // then drop the old row so a failure can never lose the endpoint.
      if (editing) {
        const removed = await deleteWebhookAction(editing);
        if ("error" in removed) {
          setFeedback({ kind: "error", message: removed.error });
          return;
        }
      }
      toast.success(
        editing ? t(locale, "savedWord") : t(locale, "webhookAdded"),
      );
      setFeedback({
        kind: "success",
        message: editing ? t(locale, "savedWord") : t(locale, "webhookAdded"),
      });
      const shouldTest = testOnSave;
      resetForm();
      router.refresh();
      if (shouldTest) void runTest(trimmedUrl);
    });
  }, [events, locale, mode, resetForm, router, runTest, secret, testOnSave, url, workspaceId]);

  const confirmDelete = useCallback(() => {
    const target = deleting;
    if (!target) return;
    startTransition(async () => {
      const result = await deleteWebhookAction(target.id);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(t(locale, "webhookRemoved"));
      setDeleting(null);
      router.refresh();
    });
  }, [deleting, locale, router]);

  return (
    <div className="mt-10 flex flex-col gap-10">
      <Section
        title={t(locale, "webhooks")}
        description={
          <>
            {t(locale, "webhookIntroA")}{" "}
            <code className="rounded-xs bg-surface-2 px-1">
              x-noema-signature
            </code>{" "}
            {t(locale, "webhookIntroB")}
          </>
        }
        action={
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={openCreate}
            disabled={mode?.kind === "create"}
          >
            {t(locale, "addWebhook")}
          </Button>
        }
      >
        {mode ? (
          <div className="rounded-md border border-border bg-surface p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id={urlId}
                label={t(locale, "webhookUrlLabel")}
                error={errors.url}
                required
                className="sm:col-span-2"
              >
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/hooks/noema"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  invalid={Boolean(errors.url)}
                />
              </Field>

              <Field
                id={secretId}
                label={t(locale, "signingSecretLabel")}
                hint={
                  mode.kind === "edit"
                    ? WEBHOOK_MESSAGES.secretOnEdit
                    : undefined
                }
                error={errors.secret}
                required
              >
                <Input
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={t(locale, "signingSecretPlaceholder")}
                  autoComplete="off"
                  invalid={Boolean(errors.secret)}
                />
              </Field>

              <Field
                id={eventsId}
                label={WEBHOOK_MESSAGES.eventsLabel}
                hint={t(locale, "webhookNoEventsHint")}
              >
                <Select
                  multiple
                  options={eventOptions}
                  value={events}
                  onChange={setEvents}
                  invalid={Boolean(errors.events)}
                  errorMessage={errors.events}
                  locale={locale}
                  searchPlaceholder={t(locale, "search")}
                  noResultsLabel={t(locale, "noResults")}
                />
              </Field>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                loading={pending}
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={save}
              >
                {mode.kind === "edit"
                  ? t(locale, "saveChanges")
                  : t(locale, "addWebhook")}
              </Button>
              <Button variant="ghost" onClick={resetForm} disabled={pending}>
                {t(locale, "cancel")}
              </Button>
              <Switch
                checked={testOnSave}
                onCheckedChange={setTestOnSave}
                label={WEBHOOK_MESSAGES.testOnSave}
                disabled={pending}
              />
            </div>
          </div>
        ) : null}

        {feedback ? (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-xs",
              feedback.kind === "success" ? "text-success" : "text-danger",
            )}
          >
            {feedback.message}
          </p>
        ) : null}

        {webhooks.length === 0 ? (
          pending ? (
            <EndpointListSkeleton />
          ) : (
            <EmptyState
              variant="compact"
              icon={<WebhookIcon className="h-4 w-4" />}
              title={t(locale, "noWebhooks")}
              description={t(locale, "webhookIntroA")}
              primaryAction={
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Plus className="h-4 w-4" />}
                  onClick={openCreate}
                >
                  {t(locale, "addWebhook")}
                </Button>
              }
            />
          )
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {webhooks.map((webhook) => (
              <EndpointRow
                key={webhook.id}
                webhook={webhook}
                health={deliveryHealth(deliveriesByUrl.get(webhook.url) ?? [])}
                latest={latestDelivery(deliveriesByUrl.get(webhook.url) ?? [])}
                locale={locale}
                testing={testingUrl === webhook.url}
                testResult={testResults[webhook.url] ?? null}
                onTest={(target) => void runTest(target.url)}
                onEdit={openEdit}
                onDelete={setDeleting}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t(locale, "recentDeliveries")}
        level={2}
      >
        {deliveries.length === 0 ? (
          pending ? (
            <EndpointListSkeleton />
          ) : (
            <EmptyState
              variant="compact"
              icon={<Inbox className="h-4 w-4" />}
              title={t(locale, "noDataYet")}
              description={t(locale, "webhookNoEventsHint")}
            />
          )
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border text-sm">
            {deliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="flex items-center gap-3 px-4 py-2"
              >
                <Badge
                  size="sm"
                  tone={deliveryStatusTone(delivery.ok, delivery.status)}
                  title={delivery.error ?? undefined}
                >
                  {delivery.ok
                    ? delivery.status ?? t(locale, "done")
                    : t(locale, "failedWord")}
                </Badge>
                <span className="w-32 shrink-0 truncate font-mono text-xs text-fg" title={delivery.event}>
                  {delivery.event}
                </span>
                <span className="flex-1 truncate text-xs text-muted" title={delivery.url}>
                  {delivery.url}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {`${delivery.attempts} ${t(locale, "attemptUnit")}`}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  <LocalTime value={delivery.createdAt} mode="time" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        tone="danger"
        title={t(locale, "deleteWebhook")}
        description={deleting?.url}
        confirmLabel={t(locale, "delete")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
