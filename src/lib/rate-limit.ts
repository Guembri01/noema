/**
 * Tiny in-memory fixed-window rate limiter. Good enough for a single-node
 * self-hosted deployment; swap for Redis in a multi-instance setup.
 * Pure core so it can be unit-tested with an injected clock.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
};

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

/** Derive a stable client key from forwarding headers (falls back to loopback). */
export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";
  return `${scope}:${ip}`;
}

/** Test/ops helper. */
export function resetRateLimits(): void {
  buckets.clear();
}

/* ------------------------------------------------------------------ *
 * Sliding-window limiter with tiers (docs/MISSING_FEATURES.md §17).
 * Additive to the fixed-window helpers above so existing middleware
 * and API-guard callers keep working unchanged.
 * ------------------------------------------------------------------ */

/** A request class with its own limit + window. */
export type RateTier = "READ" | "WRITE" | "AUTH" | "AI";

export type RateTierPolicy = {
  limit: number;
  windowMs: number;
};

/** Default tier table; override per-instance via `new RateLimiter({...})`. */
export const DEFAULT_RATE_TIERS: Readonly<Record<RateTier, RateTierPolicy>> = {
  READ: { limit: 300, windowMs: 60_000 },
  WRITE: { limit: 120, windowMs: 60_000 },
  AUTH: { limit: 10, windowMs: 60_000 },
  AI: { limit: 20, windowMs: 60_000 },
};

/** Structured limiter result. */
export type SlidingRateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
  resetAt: number;
};

/** Hit timestamps (ascending, non-decreasing `now` per key) + that key's window. */
export type SlidingEntry = { hits: number[]; windowMs: number };

export type SlidingState = Map<string, SlidingEntry>;

/**
 * Drop hits that have slid out of the window and delete keys with no hits
 * left, so the in-memory state can't grow unbounded. Mutates `state` in
 * place and returns the number of keys removed.
 *
 * `windowMs` (optional) overrides every entry's own window; when omitted,
 * each entry is pruned with the window it was recorded under.
 */
export function pruneExpired(
  state: SlidingState,
  now: number,
  windowMs?: number,
): number {
  let removed = 0;
  for (const [key, entry] of state) {
    const cutoff = now - (windowMs ?? entry.windowMs);
    const kept = entry.hits.filter((t) => t > cutoff);
    if (kept.length === entry.hits.length) continue;
    if (kept.length === 0) {
      state.delete(key);
      removed += 1;
    } else {
      entry.hits = kept;
    }
  }
  return removed;
}

/**
 * In-memory sliding-window rate limiter. Exact per-hit timestamps, so a
 * client cannot burst 2x across a fixed-window boundary: old hits keep
 * counting until they age out of the window. Deterministic under an
 * injected clock — callers pass `now`; the limiter never reads the wall
 * clock itself.
 *
 * Assumes `now` is non-decreasing per key (true for wall-clock or
 * event-ordered injection). Good enough for a single-node self-hosted
 * deployment; swap for Redis in a multi-instance setup.
 */
export class RateLimiter {
  private readonly state: SlidingState = new Map();
  private readonly tiers: Record<RateTier, RateTierPolicy>;

  constructor(tiers?: Partial<Record<RateTier, RateTierPolicy>>) {
    this.tiers = { ...DEFAULT_RATE_TIERS };
    if (tiers) {
      for (const tier of Object.keys(DEFAULT_RATE_TIERS) as RateTier[]) {
        const override = tiers[tier];
        if (override) this.tiers[tier] = override;
      }
    }
  }

  /**
   * Apply the tier's policy for `key`. Tiers keep independent counters, so
   * exhausting e.g. WRITE does not consume the same key's READ budget.
   */
  hit(args: { key: string; tier: RateTier; now: number }): SlidingRateLimitResult {
    const policy = this.tiers[args.tier];
    return this.slidingHit(`${args.tier}:${args.key}`, args.now, policy);
  }

  /**
   * Record a hit against an explicit policy. Allowed hits append `now` to
   * the window; denied hits consume nothing.
   */
  slidingHit(
    key: string,
    now: number,
    opts: { limit: number; windowMs: number },
  ): SlidingRateLimitResult {
    const { limit, windowMs } = opts;
    let entry = this.state.get(key);
    if (!entry) {
      entry = { hits: [], windowMs };
      this.state.set(key, entry);
    }
    const cutoff = now - windowMs;
    // Hits are recorded in non-decreasing `now` order, so expired ones are a
    // prefix of the array.
    let firstLive = 0;
    while (firstLive < entry.hits.length && entry.hits[firstLive]! <= cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) entry.hits = entry.hits.slice(firstLive);

    if (entry.hits.length >= limit) {
      const resetAt = entry.hits[0]! + windowMs; // oldest hit expires → a slot frees
      return { allowed: false, remaining: 0, retryAfterMs: resetAt - now, limit, resetAt };
    }
    entry.hits.push(now);
    return {
      allowed: true,
      remaining: limit - entry.hits.length,
      retryAfterMs: 0,
      limit,
      resetAt: now + windowMs,
    };
  }

  /** Prune every key using its own recorded window. Returns keys removed. */
  prune(now: number): number {
    return pruneExpired(this.state, now);
  }

  /** Number of keys currently tracked (test/ops helper). */
  size(): number {
    return this.state.size;
  }

  /** Test/ops helper. */
  reset(): void {
    this.state.clear();
  }
}
