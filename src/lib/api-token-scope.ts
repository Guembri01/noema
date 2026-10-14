/**
 * API token scopes — the permission vocabulary a personal API token carries.
 *
 * A token is issued with a small list of scopes such as `read:pages` or
 * `write:databases`. Scopes form a shallow hierarchy: a `write:<resource>`
 * scope always implies the matching `read:<resource>`, and the single
 * administrative scope `admin:workspace` sits at the top and implies every
 * other scope (transitively). Callers therefore reason about *effective*
 * permissions by expanding a granted list once (`expandScopes`) and testing
 * membership (`hasScope`) rather than threading the hierarchy through every
 * route.
 *
 * Everything here is pure and deterministic: a frozen catalogue, no DB, no
 * requests, no clock, no mutation of inputs. Stored scope lists arrive as
 * untrusted JSON, so the helpers normalise case/whitespace, ignore unknown
 * entries defensively (`expandScopes`), and report problems in full when a
 * caller wants to block a save (`validateScopes`).
 */

/** The verb half of a scope id. `"admin"` only appears on `admin:workspace`. */
export type ApiScopeAction = "read" | "write" | "admin";

/** A catalogue entry: one grantable scope and what it implies. */
export interface ApiScope {
  /** Stable catalogue id of the form `"<action>:<resource>"`. */
  readonly id: string;
  /** The verb this scope grants. */
  readonly action: ApiScopeAction;
  /** The noun this scope applies to, e.g. `"pages"`. */
  readonly resource: string;
  /** One-line, human-facing description for a picker or consent screen. */
  readonly description: string;
  /** Catalogue ids this scope also grants (direct edges; see `impliedScopes`). */
  readonly implies: readonly string[];
}

/** A read/write pair for one resource, in picker order. */
type ResourceSpec = {
  resource: string;
  read: string;
  write: string;
};

/**
 * The resources a token can address, each with a read and a write scope. The
 * order here is the order the catalogue (and every derived list) is presented
 * in, so a scope picker and `expandScopes` can never disagree.
 */
const RESOURCE_SPECS: readonly ResourceSpec[] = [
  { resource: "pages", read: "Read pages and their content", write: "Create, edit and delete pages" },
  {
    resource: "databases",
    read: "Read databases and their rows",
    write: "Create, edit and delete databases and rows",
  },
  { resource: "tickets", read: "Read tickets", write: "Create, edit and delete tickets" },
  { resource: "comments", read: "Read comments", write: "Post and delete comments" },
  { resource: "files", read: "Read files and attachments", write: "Upload and delete files" },
  { resource: "webhooks", read: "Read webhook configurations", write: "Manage webhooks" },
  {
    resource: "members",
    read: "Read workspace members",
    write: "Invite and remove workspace members",
  },
];

/**
 * Build the catalogue. Read/write pairs come from {@link RESOURCE_SPECS}; the
 * single `admin:workspace` scope is appended last and implies every pair, its
 * transitive closure following from the `write ⇒ read` edges.
 */
function buildCatalog(): ApiScope[] {
  const scopes: ApiScope[] = [];
  const inherited: string[] = [];
  for (const spec of RESOURCE_SPECS) {
    const readId = `read:${spec.resource}`;
    const writeId = `write:${spec.resource}`;
    scopes.push({
      id: readId,
      action: "read",
      resource: spec.resource,
      description: spec.read,
      implies: [],
    });
    scopes.push({
      id: writeId,
      action: "write",
      resource: spec.resource,
      description: spec.write,
      implies: [readId],
    });
    inherited.push(readId, writeId);
  }
  scopes.push({
    id: "admin:workspace",
    action: "admin",
    resource: "workspace",
    description: "Manage workspace settings, members and every resource",
    implies: inherited,
  });
  return scopes;
}

/** The full scope catalogue, in picker order. */
export const API_SCOPES: readonly ApiScope[] = buildCatalog();

/** Every catalogue id, in the same order as {@link API_SCOPES}. */
export const API_SCOPE_IDS: readonly string[] = API_SCOPES.map((scope) => scope.id);

const BY_ID = new Map<string, ApiScope>(API_SCOPES.map((scope) => [scope.id, scope]));
const IDS = API_SCOPE_IDS;

/** Trim and lowercase a raw scope; non-strings collapse to the empty string. */
function normalize(scope: unknown): string {
  return typeof scope === "string" ? scope.trim().toLowerCase() : "";
}

/** Order a set of ids by their catalogue position, de-duplicated. */
function orderScopes(ids: Iterable<string>): string[] {
  const wanted = new Set(ids);
  return IDS.filter((id) => wanted.has(id));
}

/** Whether `scope` names a catalogue entry (case- and whitespace-insensitive). */
export function isKnownScope(scope: unknown): boolean {
  return BY_ID.has(normalize(scope));
}

/**
 * The transitive closure of scopes that granting `scope` also confers, in
 * catalogue order and excluding `scope` itself. A `write:*` implies its
 * `read:*`; `admin:workspace` implies the whole catalogue. Unknown scopes
 * imply nothing.
 */
export function impliedScopes(scope: string): string[] {
  const start = BY_ID.get(normalize(scope));
  if (!start) return [];

  const seen = new Set<string>([start.id]);
  const reached: string[] = [];
  const queue: string[] = [...start.implies];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    reached.push(id);
    const entry = BY_ID.get(id);
    if (entry) queue.push(...entry.implies);
  }
  return orderScopes(reached);
}

/**
 * The effective permission set of a granted list: each known scope plus
 * everything it implies, de-duplicated, in catalogue order. Unknown or blank
 * entries are ignored (they grant nothing), so malformed stored data degrades
 * to the most restrictive result rather than throwing.
 */
export function expandScopes(list: readonly string[]): string[] {
  const granted = new Set<string>();
  const entries = Array.isArray(list) ? list : [];
  for (const raw of entries) {
    const entry = BY_ID.get(normalize(raw));
    if (!entry) continue;
    granted.add(entry.id);
    for (const implied of impliedScopes(entry.id)) granted.add(implied);
  }
  return orderScopes(granted);
}

/**
 * Whether a granted list confers `required`, after hierarchy expansion. An
 * unknown or blank `required` is never granted — a typo fails closed.
 */
export function hasScope(granted: readonly string[], required: string): boolean {
  const need = normalize(required);
  if (!BY_ID.has(need)) return false;
  return expandScopes(granted).includes(need);
}

/** A stable diagnostic code for one entry of a candidate scope list. */
export type ScopeIssueCode =
  | "not_a_string"
  | "empty_scope"
  | "malformed_scope"
  | "unknown_scope"
  | "duplicate_scope";

/** One problem found by {@link validateScopes}. */
export interface ScopeIssue {
  /** Stable code a UI can map to a message. */
  readonly code: ScopeIssueCode;
  /** The offending entry, as given (or stringified for non-strings). */
  readonly scope: string;
}

/** The full result of validating a candidate scope list. */
export interface ScopeValidation {
  /** `true` when there are no issues. */
  readonly ok: boolean;
  /** Every problem, in first-seen order. */
  readonly issues: ScopeIssue[];
  /** Unrecognised scope strings (unknown or malformed), de-duplicated. */
  readonly unknown: string[];
}

/**
 * Validate a candidate scope list before a token is stored. Reports every
 * problem in one pass with stable codes: `not_a_string`, `empty_scope`,
 * `malformed_scope` (no `action:resource` shape), `unknown_scope` (well-formed
 * but absent from the catalogue) and `duplicate_scope`. Unrecognised entries
 * are also collected in `unknown`. A non-array input is a single
 * `not_a_string` issue.
 */
export function validateScopes(list: unknown): ScopeValidation {
  if (!Array.isArray(list)) {
    return { ok: false, issues: [{ code: "not_a_string", scope: "" }], unknown: [] };
  }

  const issues: ScopeIssue[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (typeof entry !== "string") {
      issues.push({ code: "not_a_string", scope: String(entry) });
      continue;
    }

    const value = entry.trim();
    if (value === "") {
      issues.push({ code: "empty_scope", scope: entry });
      continue;
    }

    const id = value.toLowerCase();
    if (!BY_ID.has(id)) {
      issues.push({ code: /^[a-z]+:[a-z]+$/.test(id) ? "unknown_scope" : "malformed_scope", scope: value });
      if (!unknown.includes(value)) unknown.push(value);
      continue;
    }

    if (seen.has(id)) {
      issues.push({ code: "duplicate_scope", scope: id });
      continue;
    }
    seen.add(id);
  }

  return { ok: issues.length === 0, issues, unknown };
}

/**
 * The scopes both grant lists confer, after expansion and in catalogue order.
 * `["write:pages"]` against `["read:pages"]` shares `read:pages`, because the
 * write scope confers the read one.
 */
export function intersectScopes(a: readonly string[], b: readonly string[]): string[] {
  const left = new Set(expandScopes(a));
  const right = new Set(expandScopes(b));
  return IDS.filter((id) => left.has(id) && right.has(id));
}

/** The catalogue description for a single scope, or `undefined` if unknown. */
export function describeScope(scope: string): string | undefined {
  return BY_ID.get(normalize(scope))?.description;
}

/**
 * A comma-separated, human sentence for a granted list: each effective scope's
 * description, in catalogue order. Unknown entries are ignored, so an empty or
 * wholly unrecognised list renders as the empty string.
 */
export function describeScopes(list: readonly string[]): string {
  const parts: string[] = [];
  for (const id of expandScopes(list)) {
    const entry = BY_ID.get(id);
    if (entry) parts.push(entry.description);
  }
  return parts.join(", ");
}
