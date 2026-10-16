/**
 * Move pages *across workspaces* — the pure planning half of "Move pages across
 * workspaces" (docs/FEATURE_MATRIX.md §Workspaces row "Move pages across
 * workspaces"; docs/MISSING_FEATURES.md §8). Relocating content between whole
 * workspaces is an id-remap problem: the destination has its own id space, its
 * own members and its own titles, so nothing can be copied over verbatim.
 * Before any of this touches Prisma, the action needs to know what to write —
 * this module answers that, entirely in memory (no DB, no React):
 *
 * - {@link planWorkspaceMove} picks the subtree out of a flat page list, gives
 *   every moved page a fresh id, remaps internal parent links, rewrites the
 *   references its content carries and drops references to entities the target
 *   does not have — reporting each drop as a warning. Authors carried over from
 *   the source become `createMemberships` rows; authors unknown to both
 *   workspaces are dropped;
 * - {@link remapRefs} is the reference-level half: it walks mentions, page
 *   embeds and database relations, rewrites every id it knows and *flags* the
 *   ones it does not (optionally clearing them);
 * - {@link checkAccess} refuses a move the destination policy forbids;
 * - {@link collisionReport} finds title/path clashes in the destination;
 * - {@link summarizeMove} and {@link validateMove} describe and check a plan.
 *
 * Everything is pure: inputs are never mutated and returned trees are fully
 * independent.
 */

/** Allocates one fresh id per call. */
export type IdFactory = () => string;

/** A page reduced to what a cross-workspace move needs; extra fields are kept. */
export type MovePage = {
  id: string;
  /** `null`/absent = top level; otherwise the parent page id. */
  parentId?: string | null;
  title?: string;
  /** A logical path used for collision detection (`/work/roadmap`). */
  path?: string;
  /** Rich-text content; every ref-bearing node is remapped. */
  blocks?: unknown;
  content?: unknown;
  createdById?: string | null;
  updatedById?: string | null;
  [key: string]: unknown;
};

/** The three reference kinds a page body can carry. */
export type RefKind = "mention" | "relation" | "embed";

/** A reference that survived the move without a destination id. */
export type DanglingRef = {
  kind: RefKind;
  /** The id that could not be resolved. */
  id: string;
  /** Location of the reference inside the walked content (`blocks[0].attrs.pageId`). */
  path: string;
};

/** Options for {@link remapRefs}. */
export type RemapOptions = {
  /** Clear a reference (set it to `null`) instead of leaving it in place. Default `false`. */
  dropDangling?: boolean;
};

/** The rewritten content plus every reference it could not resolve. */
export type RemapResult = {
  content: unknown;
  dangling: DanglingRef[];
};

/** Why a move could not be carried out cleanly. */
export type MoveWarningCode =
  | "ref-dangling"
  | "parent-left-behind"
  | "member-missing"
  | "unknown-subtree-id";

/** One thing the caller should surface before committing a move. */
export type WorkspaceMoveWarning = {
  code: MoveWarningCode;
  message: string;
  /** The moved page (new id) the warning is about, when known. */
  pageId?: string;
  /** The source id that could not be resolved, when known. */
  refId?: string;
};

/** A membership that must be created in the target for the move to be faithful. */
export type MembershipToCreate = {
  workspaceId: string;
  userId: string;
  role: string;
};

/** A moved page's new identity: source id → destination id. */
export type WorkspaceMovePlan = {
  idMap: Map<string, string>;
  pages: MovePage[];
  createMemberships: MembershipToCreate[];
  warnings: WorkspaceMoveWarning[];
  fromWorkspaceId: string;
  toWorkspaceId: string;
};

/** Input for {@link planWorkspaceMove}. */
export type WorkspaceMoveInput = {
  /** The source workspace's pages (the move picks a subtree out of these). */
  pages: readonly MovePage[];
  /** Which pages move; omitted ⇒ every page, `[]` ⇒ none. */
  subtreeIds?: readonly string[];
  fromWorkspaceId: string;
  toWorkspaceId: string;
  /** User ids that are members of the source workspace. */
  membersFrom?: readonly string[];
  /** User ids that are already members of the target workspace. */
  membersTo?: readonly string[];
  /** Fresh-id allocator; defaults to `defaultIdFactory`. */
  idFactory?: IdFactory;
};

/** A destination page, used only for {@link collisionReport}. */
export type TargetPage = {
  id: string;
  title?: string;
  path?: string;
};

/** Which identity field a move would collide on. */
export type CollisionKind = "title" | "path";

/** One title/path collision a move would hit in the destination. */
export type CollisionReportEntry = {
  incomingId: string;
  kind: CollisionKind;
  existingId: string;
  /** The incoming value, un-normalised (safe to show in a prompt). */
  value: string;
};

/** A workspace role as a plain string, so the table stays DB-free. */
export type WorkspaceRoleLike = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";

/** What a destination workspace allows. */
export type TargetWorkspacePolicy = {
  /** Roles that may move pages in. Defaults to `OWNER`, `ADMIN`, `MEMBER`. */
  allowedRoles?: readonly WorkspaceRoleLike[];
  /** Roles incoming members may be given; omitted ⇒ no check. */
  allowedMemberRoles?: readonly string[];
  /** `read-only`/`archived` destinations refuse every move. */
  status?: "active" | "read-only" | "archived";
  /** Refuse moves larger than this. */
  maxPages?: number;
};

/** Input for {@link checkAccess}. */
export type AccessCheckInput = {
  role: WorkspaceRoleLike | null | undefined;
  targetWorkspacePolicy: TargetWorkspacePolicy;
  pageCount?: number;
  incomingMembers?: readonly MembershipToCreate[];
};

/** `allowed` is true exactly when `reasons` is empty. */
export type AccessCheckResult = { allowed: boolean; reasons: string[] };

/** The compact digest of a move plan. */
export type MoveSummary = {
  fromWorkspaceId: string;
  toWorkspaceId: string;
  pageCount: number;
  /** Moved pages that land at the top level of the destination. */
  rootIds: string[];
  membershipCount: number;
  warningCount: number;
  warningsByCode: Record<string, number>;
};

/** Outcome of {@link validateMove}; `errors` is empty exactly when `ok` is true. */
export type MoveValidation = { ok: boolean; errors: string[] };

const DEFAULT_ROLES: readonly WorkspaceRoleLike[] = ["OWNER", "ADMIN", "MEMBER"];

/** Node types that carry an id reference, mapped to their kind. */
const REF_KINDS: Record<string, RefKind> = {
  mention: "mention",
  relation: "relation",
  embed: "embed",
  pageEmbed: "embed",
};

/** `attrs` fields holding a single reference id. */
const SINGLE_REF_FIELDS = ["pageId", "targetId", "refId"] as const;

/** `attrs` fields holding a list of reference ids. */
const ARRAY_REF_FIELDS = ["pageIds", "targetIds", "refIds"] as const;

let defaultCounter = 0;

/**
 * Default id factory: fresh, collision-resistant ids. Randomised so two moves
 * in the same process never share an id, and prefixed so generated output is
 * recognisable. Callers that need determinism pass their own `IdFactory`.
 */
export function defaultIdFactory(): string {
  defaultCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `move_${defaultCounter.toString(36)}_${random}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function refKindOf(type: unknown): RefKind | undefined {
  return typeof type === "string" ? REF_KINDS[type] : undefined;
}

/** Rewrite one ref-bearing node's `attrs` in place (the object is already ours). */
function remapAttrs(
  attrs: Record<string, unknown>,
  kind: RefKind,
  path: string,
  idMap: ReadonlyMap<string, string>,
  dangling: DanglingRef[],
  drop: boolean,
): void {
  const prefix = path ? `${path}.` : "";
  const rewrite = (id: string, fieldPath: string): string | null => {
    const mapped = idMap.get(id);
    if (mapped !== undefined) return mapped;
    dangling.push({ kind, id, path: fieldPath });
    return null;
  };

  for (const field of SINGLE_REF_FIELDS) {
    const current = attrs[field];
    if (typeof current !== "string") continue;
    const rewritten = rewrite(current, `${prefix}attrs.${field}`);
    if (rewritten !== null) attrs[field] = rewritten;
    else if (drop) attrs[field] = null;
  }

  for (const field of ARRAY_REF_FIELDS) {
    const current = attrs[field];
    if (!Array.isArray(current)) continue;
    attrs[field] = current.map((entry, index) => {
      if (typeof entry !== "string") return entry;
      const rewritten = rewrite(entry, `${prefix}attrs.${field}[${index}]`);
      if (rewritten !== null) return rewritten;
      return drop ? null : entry;
    });
  }
}

function walkRefs(
  value: unknown,
  path: string,
  idMap: ReadonlyMap<string, string>,
  dangling: DanglingRef[],
  drop: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => walkRefs(item, `${path}[${index}]`, idMap, dangling, drop));
  }
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    next[key] = walkRefs(item, path ? `${path}.${key}` : key, idMap, dangling, drop);
  }

  const kind = refKindOf(record.type);
  if (kind) {
    const attrs = next.attrs;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      remapAttrs(attrs as Record<string, unknown>, kind, path, idMap, dangling, drop);
    }
  }
  return next;
}

/**
 * Rewrite every mention / relation / page-embed reference in `content` to its
 * destination id. `content` may be a node, an array of nodes or a whole page
 * body; it is deep-cloned and never mutated.
 *
 * A reference whose id is not a key of `idMap` has no destination counterpart:
 * it is left in place (or cleared when `options.dropDangling` is set) and
 * recorded in `dangling` with the kind, the id and where it was found.
 *
 * `attrs.id` is deliberately ignored — mention nodes reuse it for user ids,
 * which are not page references.
 */
export function remapRefs(
  content: unknown,
  idMap: ReadonlyMap<string, string>,
  options: RemapOptions = {},
): RemapResult {
  const dangling: DanglingRef[] = [];
  const map = idMap instanceof Map ? idMap : new Map<string, string>();
  const rewritten = walkRefs(content, "", map, dangling, options.dropDangling === true);
  return { content: rewritten, dangling };
}

/** Resolve a page author against both workspaces; queue a membership or drop it. */
function resolveAuthor(
  author: unknown,
  pageId: string,
  membersFrom: ReadonlySet<string>,
  membersTo: ReadonlySet<string>,
  toWorkspaceId: string,
  memberships: Map<string, MembershipToCreate>,
  warnings: WorkspaceMoveWarning[],
): string | null {
  if (!isNonEmptyString(author)) return null;
  if (membersTo.has(author)) return author;
  if (membersFrom.has(author)) {
    if (!memberships.has(author)) {
      memberships.set(author, { workspaceId: toWorkspaceId, userId: author, role: "MEMBER" });
    }
    return author;
  }
  warnings.push({
    code: "member-missing",
    pageId,
    refId: author,
    message: `author ${author} is not a member of either workspace; reference was dropped`,
  });
  return null;
}

/**
 * Plan a move of `subtreeIds` from `fromWorkspaceId` into `toWorkspaceId`.
 *
 * Every moved page gets a fresh id (allocation order follows the page list), its
 * internal parent links are remapped, a parent outside the move becomes `null`,
 * and its content references are remapped through {@link remapRefs} with
 * dangling refs dropped. References to entities the target lacks, parents left
 * behind, unknown authors and unknown subtree ids all surface as `warnings`.
 * Authors who are source members but not yet target members produce
 * `createMemberships` rows.
 */
export function planWorkspaceMove(input: WorkspaceMoveInput): WorkspaceMovePlan {
  const pages = Array.isArray(input?.pages) ? input.pages : [];
  const idFactory = input?.idFactory ?? defaultIdFactory;
  const fromWorkspaceId = typeof input?.fromWorkspaceId === "string" ? input.fromWorkspaceId : "";
  const toWorkspaceId = typeof input?.toWorkspaceId === "string" ? input.toWorkspaceId : "";
  const warnings: WorkspaceMoveWarning[] = [];

  const known = new Map<string, MovePage>();
  for (const page of pages) {
    if (isNonEmptyString(page?.id)) known.set(page.id, page);
  }

  const requested = input?.subtreeIds;
  const moveIds: string[] = [];
  if (requested === undefined) {
    moveIds.push(...known.keys());
  } else {
    const seen = new Set<string>();
    for (const id of requested) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (known.has(id)) moveIds.push(id);
      else {
        warnings.push({
          code: "unknown-subtree-id",
          refId: id,
          message: `subtree id ${id} names no page in the source workspace`,
        });
      }
    }
  }

  const idMap = new Map<string, string>();
  for (const id of moveIds) idMap.set(id, idFactory());

  const membersFrom = new Set(input?.membersFrom ?? []);
  const membersTo = new Set(input?.membersTo ?? []);
  const memberships = new Map<string, MembershipToCreate>();

  const moved: MovePage[] = [];
  for (const oldId of moveIds) {
    const page = known.get(oldId)!;
    const newId = idMap.get(oldId)!;
    const remapped = remapRefs(page, idMap, { dropDangling: true });
    const clone = remapped.content as MovePage;
    clone.id = newId;

    const oldParent = isNonEmptyString(page.parentId) ? page.parentId : null;
    if (oldParent === null) {
      clone.parentId = null;
    } else if (idMap.has(oldParent)) {
      clone.parentId = idMap.get(oldParent)!;
    } else {
      clone.parentId = null;
      warnings.push({
        code: "parent-left-behind",
        pageId: newId,
        refId: oldParent,
        message: `parent ${oldParent} is not part of the move; page was placed at the top level`,
      });
    }

    for (const ref of remapped.dangling) {
      warnings.push({
        code: "ref-dangling",
        pageId: newId,
        refId: ref.id,
        message: `dropped dangling ${ref.kind} reference to ${ref.id} (not present in the target workspace)`,
      });
    }

    if (page.createdById !== undefined) {
      clone.createdById = resolveAuthor(
        page.createdById,
        newId,
        membersFrom,
        membersTo,
        toWorkspaceId,
        memberships,
        warnings,
      );
    }
    if (page.updatedById !== undefined) {
      clone.updatedById = resolveAuthor(
        page.updatedById,
        newId,
        membersFrom,
        membersTo,
        toWorkspaceId,
        memberships,
        warnings,
      );
    }

    moved.push(clone);
  }

  return {
    idMap,
    pages: moved,
    createMemberships: [...memberships.values()],
    warnings,
    fromWorkspaceId,
    toWorkspaceId,
  };
}

/**
 * Decide whether `role` may move content into a destination governed by
 * `targetWorkspacePolicy`. Every reason a move is refused is collected, so the
 * UI can show them together; `allowed` is true exactly when there are none.
 */
export function checkAccess(input: AccessCheckInput): AccessCheckResult {
  const policy = input?.targetWorkspacePolicy ?? {};
  const reasons: string[] = [];

  if (policy.status && policy.status !== "active") {
    reasons.push(`target workspace is ${policy.status}`);
  }

  const role = input?.role;
  const allowedRoles = policy.allowedRoles ?? DEFAULT_ROLES;
  if (!isNonEmptyString(role)) {
    reasons.push("no role in the target workspace");
  } else if (!allowedRoles.includes(role as WorkspaceRoleLike)) {
    reasons.push(`role ${role} may not move pages into the target workspace`);
  }

  if (
    typeof policy.maxPages === "number" &&
    typeof input?.pageCount === "number" &&
    input.pageCount > policy.maxPages
  ) {
    reasons.push(`move of ${input.pageCount} pages exceeds the target limit of ${policy.maxPages}`);
  }

  if (policy.allowedMemberRoles) {
    for (const member of input?.incomingMembers ?? []) {
      if (!policy.allowedMemberRoles.includes(member.role)) {
        reasons.push(`member role ${member.role} is not allowed in the target workspace`);
      }
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

/** Normalise a title/path for comparison: trim, lowercase, blank ⇒ "". */
function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The collisions the move would hit in the destination: for each incoming page,
 * a `title` clash against a preview page with the same normalised title and a
 * `path` clash against one with the same normalised path, in that order. Blank
 * titles and paths never collide, and the incoming pages' own order is kept.
 */
export function collisionReport(
  pages: readonly MovePage[],
  targetTitles: readonly TargetPage[],
): CollisionReportEntry[] {
  const report: CollisionReportEntry[] = [];
  const titles = new Map<string, TargetPage>();
  const paths = new Map<string, TargetPage>();
  for (const target of targetTitles ?? []) {
    const title = normalizeKey(target?.title);
    if (title && !titles.has(title)) titles.set(title, target);
    const path = normalizeKey(target?.path);
    if (path && !paths.has(path)) paths.set(path, target);
  }

  for (const page of pages ?? []) {
    const titleKey = normalizeKey(page?.title);
    const titleMatch = titleKey ? titles.get(titleKey) : undefined;
    if (titleMatch) {
      report.push({
        incomingId: page.id,
        kind: "title",
        existingId: titleMatch.id,
        value: page.title ?? "",
      });
    }

    const pathKey = normalizeKey(page?.path);
    const pathMatch = pathKey ? paths.get(pathKey) : undefined;
    if (pathMatch) {
      report.push({
        incomingId: page.id,
        kind: "path",
        existingId: pathMatch.id,
        value: page.path ?? "",
      });
    }
  }

  return report;
}

/** A compact digest of a plan for confirm dialogs and logs. */
export function summarizeMove(plan: WorkspaceMovePlan): MoveSummary {
  const pages = Array.isArray(plan?.pages) ? plan.pages : [];
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings : [];

  const warningsByCode: Record<string, number> = {};
  for (const warning of warnings) {
    warningsByCode[warning.code] = (warningsByCode[warning.code] ?? 0) + 1;
  }

  const rootIds: string[] = [];
  for (const page of pages) {
    if (isNonEmptyString(page?.id) && !isNonEmptyString(page.parentId)) rootIds.push(page.id);
  }

  return {
    fromWorkspaceId: typeof plan?.fromWorkspaceId === "string" ? plan.fromWorkspaceId : "",
    toWorkspaceId: typeof plan?.toWorkspaceId === "string" ? plan.toWorkspaceId : "",
    pageCount: pages.length,
    rootIds,
    membershipCount: Array.isArray(plan?.createMemberships) ? plan.createMemberships.length : 0,
    warningCount: warnings.length,
    warningsByCode,
  };
}

/**
 * Check that `plan` is internally consistent before it is written:
 *
 * - every page id is unique and none was carried over from the source
 *   (`duplicate page id`, `page id reused from source`);
 * - every page is described by the id map and vice versa (`page not in id map`,
 *   `missing page for id map entry`);
 * - every non-null parent names a page in the plan (`orphaned parent`);
 * - no parent chain loops back on itself after remapping (`cycle detected`).
 *
 * `ok` is true exactly when the error list is empty.
 */
export function validateMove(plan: WorkspaceMovePlan): MoveValidation {
  const errors: string[] = [];
  const pages = Array.isArray(plan?.pages) ? plan.pages : [];
  const idMap = plan?.idMap instanceof Map ? plan.idMap : new Map<string, string>();
  const sourceIds = new Set(idMap.keys());
  const mappedIds = new Set(idMap.values());

  const counts = new Map<string, number>();
  for (const page of pages) {
    if (isNonEmptyString(page?.id)) counts.set(page.id, (counts.get(page.id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) errors.push(`duplicate page id: ${id}`);
    if (sourceIds.has(id)) errors.push(`page id reused from source: ${id}`);
  }

  const parentOf = new Map<string, string | null>();
  for (const page of pages) {
    if (!isNonEmptyString(page?.id)) continue;
    if (!mappedIds.has(page.id)) errors.push(`page not in id map: ${page.id}`);
    const parent = isNonEmptyString(page.parentId) ? page.parentId : null;
    if (parent !== null && !counts.has(parent)) {
      errors.push(`orphaned parent: ${page.id} -> ${parent}`);
    }
    parentOf.set(page.id, parent);
  }
  for (const mapped of mappedIds) {
    if (!counts.has(mapped)) errors.push(`missing page for id map entry: ${mapped}`);
  }

  // White (unvisited) ⇒ gray (on the current chain) ⇒ black (safe). Meeting a
  // gray node means a parent chain looped back: a detached cycle.
  const color = new Map<string, number>();
  for (const id of counts.keys()) {
    if ((color.get(id) ?? 0) !== 0) continue;
    const chain: string[] = [];
    let current: string | null = id;
    while (current !== null && counts.has(current)) {
      const seen = color.get(current) ?? 0;
      if (seen === 1) {
        errors.push(`cycle detected: ${current}`);
        break;
      }
      if (seen === 2) break;
      color.set(current, 1);
      chain.push(current);
      current = parentOf.get(current) ?? null;
    }
    for (const visited of chain) color.set(visited, 2);
  }

  return { ok: errors.length === 0, errors };
}
