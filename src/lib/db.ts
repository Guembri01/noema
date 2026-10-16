import { PrismaClient, type Prisma } from "@prisma/client";
import {
  TenancyError,
  assertAllScoped,
  assertScoped,
  filterScoped,
  scopeWhere,
  type ScopedWhere,
  type TenancyOffense,
  type TenantScope,
} from "@/lib/tenancy";
import {
  resolveAccess as guardResolveAccess,
  runAtomicWrites,
  type AtomicExecutor,
  type AtomicWriteOutcome,
  type GuardedWriteStep,
} from "@/lib/tenant-guard";
import type { AccessLevel, AccessUser } from "@/lib/access-inheritance";
import type { TransactionOperation } from "@/lib/tenant-scope";
import type { RetryOptions, WriteResult } from "@/lib/atomic-writes";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * A single PrismaClient per process. In development, Next.js hot-reloads
 * modules, so we cache the client on `globalThis` to avoid exhausting the
 * Postgres connection pool.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/* -------------------------------------------------------------------------- *
 * Scoped Prisma access layer (wires `tenancy.ts` into every DB call)
 *
 * `scopeWhere` / `assertScoped` / `filterScoped` are the canonical fail-closed
 * scoping engine. `scopedPrisma(scope)` packages them so a caller can build a
 * workspace-pinned `where`, assert that a fetched row belongs to the workspace,
 * filter a page of rows, and (in development) audit a page with
 * `assertAllScoped`. Cross-workspace access fails closed: a blank scope throws
 * up front, and a foreign/missing `workspaceId` never slips through.
 * -------------------------------------------------------------------------- */

/** One write step of {@link atomicTransaction}, typed to a Prisma tx handle. */
export type AtomicStep<T = unknown> = {
  /** Stable id used by `dependsOn` and to correlate results. */
  id: string;
  /** Prisma delegate name, e.g. `"page"`. */
  model: string;
  /** The write verb (validated against the tenant-scope operation set). */
  operation: TransactionOperation;
  /** Defaults to the transaction's scope workspace when omitted. */
  workspaceId?: string;
  /** Ids of steps that must commit first. */
  dependsOn?: readonly string[];
  /** A write allowed to fail without aborting the batch (lone steps only). */
  bestEffort?: boolean;
  /** Runs the step against the active transaction handle. */
  run: (tx: Prisma.TransactionClient) => Promise<T>;
};

/** The tenant-scoped access helper returned by {@link scopedPrisma}. */
export type ScopedPrisma = {
  readonly scope: TenantScope;
  /** A Prisma `where` pinned to the scope's workspace (plus any extra keys). */
  where(extra?: Record<string, unknown>): ScopedWhere & Record<string, unknown>;
  /** Return a row when it belongs to the scope, else throw `TenancyError`. */
  assert<T>(record: T): T;
  /** Keep only the scope's rows, in input order. */
  filter<T>(rows: readonly T[]): T[];
  /**
   * Audit a page of rows. In development it throws on the first out-of-scope
   * row; in production it is a no-op (the check is a development guard rail).
   */
  audit(rows: readonly unknown[]): readonly TenancyOffense[];
  /** Run a multi-step write atomically within the scope. */
  atomic<T = unknown>(
    steps: readonly AtomicStep<T>[],
    options?: RetryOptions,
  ): Promise<AtomicWriteOutcome>;
};

/**
 * Build a workspace-scoped accessor over the shared Prisma client. Additive to
 * the raw {@link prisma} export: callers that need tenant isolation opt in,
 * everyone else is unaffected. Throws immediately on a blank/unknown scope.
 */
export function scopedPrisma(scope: TenantScope): ScopedPrisma {
  scopeWhere(scope);
  return {
    scope,
    where: (extra) =>
      ({ ...(extra ?? {}), ...scopeWhere(scope) }) as ScopedWhere & Record<string, unknown>,
    assert: <T,>(record: T) => assertScoped(record, scope),
    filter: <T,>(rows: readonly T[]) => filterScoped(rows, scope),
    audit: (rows) => {
      if (process.env.NODE_ENV === "production") return [];
      const offenses = assertAllScoped(rows, scope);
      if (offenses.length > 0) {
        throw new TenancyError(
          `Tenant audit found ${offenses.length} out-of-scope row(s): ${offenses
            .map((offense) => `#${offense.index} ${offense.reason}`)
            .join(", ")}.`,
          scope.workspaceId,
        );
      }
      return offenses;
    },
    atomic: <T,>(steps: readonly AtomicStep<T>[], options?: RetryOptions) =>
      atomicTransaction(scope, steps, options),
  };
}

/**
 * Run `steps` as one atomic, single-workspace write. Delegates to
 * {@link runAtomicWrites}, which plans the batch (`planAtomicWrites`), refuses
 * any cross-workspace op (`withTransaction`), runs it through `withRetry`, and
 * audits the results (`assertNoPartialWrite`). The executor here is Prisma's
 * interactive `$transaction`, so a thrown step rolls the whole batch back.
 */
export async function atomicTransaction<T = unknown>(
  scope: TenantScope,
  steps: readonly AtomicStep<T>[],
  options: RetryOptions = {},
): Promise<AtomicWriteOutcome> {
  const workspaceId = scopeWhere(scope).workspaceId;

  const guarded: GuardedWriteStep[] = steps.map((step) => {
    const next: GuardedWriteStep = {
      id: step.id,
      model: step.model,
      operation: step.operation,
      workspaceId: step.workspaceId ?? workspaceId,
      run: (tx) => step.run(tx as Prisma.TransactionClient),
    };
    if (step.dependsOn) next.dependsOn = step.dependsOn;
    if (step.bestEffort !== undefined) next.bestEffort = step.bestEffort;
    return next;
  });

  const byId = new Map(guarded.map((step) => [step.id, step]));
  const execute: AtomicExecutor = (statements) =>
    prisma.$transaction(async (tx) => {
      const results: WriteResult[] = [];
      for (const statement of statements) {
        const step = byId.get(statement.id);
        if (!step) {
          results.push({ id: statement.id, ok: false });
          continue;
        }
        await step.run(tx);
        results.push({ id: statement.id, ok: true });
      }
      return results;
    });

  return runAtomicWrites(scope, guarded, execute, options);
}

/* -------------------------------------------------------------------------- *
 * Page access resolution (wires `access-inheritance.ts` into the DB layer)
 *
 * Fetches the page's ancestry, its `PagePermission` grants and its `ShareLink`
 * rows, then routes the decision through the canonical `effectiveAccess`
 * engine (via the tenant guard). `notFound()`/deny callers get `null`.
 * -------------------------------------------------------------------------- */

const MAX_ANCESTRY_DEPTH = 100;

/** Walk `parentId` links up from `pageId`, nearest parent first. */
async function pageAncestry(pageId: string | null): Promise<string[]> {
  const ancestry: string[] = [];
  let cursor = pageId;
  while (cursor && ancestry.length < MAX_ANCESTRY_DEPTH) {
    ancestry.push(cursor);
    const parent = await prisma.page.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    cursor = parent?.parentId ?? null;
  }
  return ancestry;
}

export type PageAccessQuery = {
  /** The viewer's user id, or `null` for an anonymous visitor. */
  userId: string | null;
  /** The viewer's workspace role, or `null` when not a member. */
  role: AccessUser["role"];
  /** The page being opened. */
  pageId: string;
  /** Evaluation instant for link expiry; defaults to now. */
  now?: Date;
};

/**
 * The effective access a viewer holds on `pageId`, resolved through the
 * inheritance engine. Returns `null` (fail closed) when the page does not
 * exist or nothing grants access.
 */
export async function resolvePageAccess(
  query: PageAccessQuery,
): Promise<AccessLevel | null> {
  const page = await prisma.page.findUnique({
    where: { id: query.pageId },
    select: { id: true, parentId: true },
  });
  if (!page) return null;

  const ancestry = await pageAncestry(page.parentId);
  const chain = [page.id, ...ancestry];

  const [grants, linkShares] = await Promise.all([
    prisma.pagePermission.findMany({
      where: { pageId: { in: chain } },
      select: { pageId: true, userId: true, level: true },
    }),
    prisma.shareLink.findMany({
      where: { pageId: page.id },
      select: { pageId: true, permission: true, expiresAt: true },
    }),
  ]);

  const user: AccessUser | null =
    query.userId === null ? null : { id: query.userId, role: query.role };

  return guardResolveAccess({
    user,
    page: { id: page.id },
    ancestry,
    grants,
    linkShares,
    now: query.now,
  });
}
