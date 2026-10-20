/**
 * Tiny in-memory fixed-window rate limiter. Good enough for a single-node
 * self-hosted deployment; swap for Redis in a multi-instance setup.
 * Pure core so it can be unit-tested with an injected clock.
 */
import { createLru, LruCache } from "./lru";
import { createBucket, tryConsume, type ConsumeResult, type TokenBucket } from "./token-bucket";
import { normalizeIp } from "./ip-allowlist";
import {
  parseTrustedProxyHops,
  resolveClientIp,
  TRUSTED_PROXY_HOPS_ENV,
} from "./tenant-guard";

type Bucket = { count: number; resetAt: number };

/**
 * Hard cap on the number of tracked buckets **per store**. A flood of unique
 * client keys must not grow the map without bound: beyond the cap the
 * least-recently-used bucket is evicted. Mirrors `DEFAULT_MAX_KEYS`, the
 * sliding limiter's cap.
 */
const MAX_BUCKETS = 10_000;

/**
 * How often expired buckets are swept out of the map.
 *
 * The sweep runs *before* the LRU is asked to make room, so an expired bucket
 * is dropped before a live one can be evicted. One second keeps that lag
 * small while bounding the cleanup cost at a single pass over the store per
 * second (the pass is O(n) in the number of tracked buckets).
 */
const SWEEP_INTERVAL_MS = 1_000;

/**
 * The client-address buckets (`scope:<ip>`) live in **their own** store.
 *
 * This is the part of the key space an *unauthenticated* caller controls: a
 * request can mint one address bucket per source address, so this is the
 * store a flood of forged addresses fills.
 */
const addressBuckets = createLru<string, Bucket>({ capacity: MAX_BUCKETS });

/**
 * The per-user buckets (`scope:user:<id>`) live in a **separate** store.
 *
 * The user id comes from the session or the API token, so it cannot be
 * spoofed — but that is worth nothing if the budget can be reset from the
 * outside. In one shared store the user bucket is the *oldest* key (it is
 * created at the user's first request) and therefore the LRU's preferred
 * victim: a flood of 10 000 forged client addresses evicted it, the exhausted
 * window started over and the caller was answered 200 instead of 429. The
 * separate store makes that structurally impossible — an address flood never
 * touches the user bucket.
 *
 * The residual that remains is named, not hidden: the user store has its own
 * cap (`MAX_BUCKETS`), so more than 10 000 *distinct authenticated users*
 * holding a live budget in the same window would sacrifice the coldest of
 * them and that user's window would start over. That needs a real
 * installation with that many concurrent users, not a flood.
 */
const userBuckets = createLru<string, Bucket>({ capacity: MAX_BUCKETS });

/** Timestamp of the last TTL sweep (0 = never swept yet). */
let lastSweepAt = 0;

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
};

/**
 * Drop buckets whose window has closed from one store. The LRU cap bounds the
 * map on its own; the sweep only releases the memory earlier.
 *
 * The sweep runs **before** the LRU is asked to make room, so an expired
 * bucket goes first and the LRU only has to evict a *live* one when the store
 * genuinely holds `MAX_BUCKETS` live buckets. It cannot be a full guarantee:
 * a bucket can linger expired for up to `SWEEP_INTERVAL_MS`, and the LRU's
 * victim is the coldest entry by *recency*, not the one that expires first.
 *
 * The residual is a memory bound, not a hole: with more than `MAX_BUCKETS`
 * distinct keys live inside a single window, the coldest live bucket is
 * evicted and that caller's window starts over — the same trade-off the
 * sliding limiter makes at `DEFAULT_MAX_KEYS` (see `RateLimiter`'s doc
 * comment). Reaching it needs more than 10 000 distinct client keys in one
 * window; with the default configuration (`TRUSTED_PROXY_HOPS` unset) every
 * caller of a scope shares the `scope:local` bucket, so the key space cannot
 * grow that way at all.
 */
function sweepStore(store: LruCache<string, Bucket>, now: number): void {
  // `keys()` is most-recently-used first; walking it in the opposite order
  // keeps the LRU's recency order intact, because every `get` promotes the
  // key it touches to the most-recent end.
  for (const key of store.keys().reverse()) {
    const bucket = store.get(key);
    if (bucket && bucket.resetAt <= now) store.delete(key);
  }
}

/**
 * Sweep every store whose window has closed. Runs at most once per
 * `SWEEP_INTERVAL_MS`; both stores are always swept together, so they never
 * drift apart.
 */
function sweepExpiredBuckets(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  sweepStore(addressBuckets, now);
  sweepStore(userBuckets, now);
}

/**
 * The fixed-window rule, applied to one store. The caller picks the store, so
 * the address key space and the per-user key space cannot evict each other.
 */
function checkBucket(
  store: LruCache<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): RateLimitResult {
  const bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

/**
 * Charge the **client-address** budget of `key` (see `clientKey`). The bucket
 * lives in the address store, whose key space a flood of forged addresses can
 * fill — see {@link checkUserRateLimit} for the budget that a flood cannot
 * touch.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  sweepExpiredBuckets(now);
  return checkBucket(addressBuckets, key, limit, windowMs, now);
}

/**
 * Charge the **per-user** budget of `key` (see `userKey`).
 *
 * The bucket lives in its own store, so the address flood — the part of the
 * key space an unauthenticated caller controls — cannot evict it and cannot
 * reset an exhausted window. Only a store full of *authenticated* users can
 * (see the note on `userBuckets`).
 */
export function checkUserRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  sweepExpiredBuckets(now);
  return checkBucket(userBuckets, key, limit, windowMs, now);
}

/**
 * How many reverse-proxy hops in front of the app may set the forwarding
 * headers, from `TRUSTED_PROXY_HOPS`. 0 (the default) means: trust no
 * forwarding header at all.
 */
export function trustedProxyHops(): number {
  return parseTrustedProxyHops(process.env[TRUSTED_PROXY_HOPS_ENV]);
}

/**
 * Derive a stable client key from a `Headers` object.
 *
 * Server actions never see a `Request`, they read the request headers through
 * `next/headers`. The client IP is only read from `X-Forwarded-For` /
 * `X-Real-IP` when a trusted proxy is configured (`TRUSTED_PROXY_HOPS`);
 * otherwise those headers are written by the client itself and are ignored —
 * every direct caller shares the `"local"` bucket, so a spoofed header cannot
 * buy a fresh allowance.
 *
 * The address is canonicalized before it becomes a key. A value that is not an
 * IP literal cannot be attributed and falls back to the shared bucket, so a
 * proxy that forwards garbage cannot mint one bucket per garbage value.
 */
export function clientKeyFromHeaders(
  headers: Headers,
  scope: string,
  hops: number = trustedProxyHops(),
): string {
  const ip = resolveClientIp((name) => headers.get(name), hops);
  const canonical = ip === null ? null : normalizeIp(ip);
  return `${scope}:${canonical ?? "local"}`;
}

/**
 * Derive a stable client key from the request. See
 * {@link clientKeyFromHeaders}; this is the `Request`-shaped convenience
 * wrapper used by the route helpers.
 */
export function clientKey(
  request: Request,
  scope: string,
  hops: number = trustedProxyHops(),
): string {
  return clientKeyFromHeaders(request.headers, scope, hops);
}

/**
 * Key for the per-user budget. The user id comes from the session, so it is
 * not spoofable — a caller cannot dodge its limit by changing its IP. The
 * bucket lives in its own store, so it is not evictable by an address flood
 * either (see `userBuckets`).
 */
export function userKey(scope: string, userId: string): string {
  return `${scope}:user:${userId}`;
}

/** Number of client-address buckets currently tracked (test/ops helper). */
export function rateLimitBucketCount(): number {
  return addressBuckets.size();
}

/** Number of per-user buckets currently tracked (test/ops helper). */
export function userRateLimitBucketCount(): number {
  return userBuckets.size();
}

/** Test/ops helper. */
export function resetRateLimits(): void {
  addressBuckets.clear();
  userBuckets.clear();
  lastSweepAt = 0;
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
 * Default cap on distinct keys a stateful limiter tracks. A bounded key space
 * keeps a flood of unique clients from growing memory without limit; the
 * least-recently-used key is evicted when the cap is exceeded (its window
 * simply restarts, the same trade-off a Redis `MAXMEMORY` policy makes).
 */
export const DEFAULT_MAX_KEYS = 10_000;

/** Options accepted by {@link RateLimiter} and {@link TokenBucketLimiter}. */
export type RateLimiterOptions = {
  /** Maximum distinct keys tracked before LRU eviction. Defaults to 10_000. */
  maxKeys?: number;
};

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
  /**
   * Keyed sliding windows, bounded by an LRU so a flood of distinct keys
   * cannot grow memory without limit. Recency tracks the last `hit`/`get`,
   * so the coldest key is the eviction victim.
   */
  private readonly state: LruCache<string, SlidingEntry>;
  private readonly tiers: Record<RateTier, RateTierPolicy>;

  constructor(
    tiers?: Partial<Record<RateTier, RateTierPolicy>>,
    options: RateLimiterOptions = {},
  ) {
    this.tiers = { ...DEFAULT_RATE_TIERS };
    if (tiers) {
      for (const tier of Object.keys(DEFAULT_RATE_TIERS) as RateTier[]) {
        const override = tiers[tier];
        if (override) this.tiers[tier] = override;
      }
    }
    this.state = createLru<string, SlidingEntry>({
      capacity: options.maxKeys ?? DEFAULT_MAX_KEYS,
    });
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

  /**
   * Prune every key using its own recorded window. Returns keys removed.
   * Walks the LRU's live keys (each `get` refreshes recency, harmless here).
   */
  prune(now: number): number {
    let removed = 0;
    for (const key of this.state.keys()) {
      const entry = this.state.get(key);
      if (!entry) continue;
      const cutoff = now - entry.windowMs;
      const kept = entry.hits.filter((t) => t > cutoff);
      if (kept.length === entry.hits.length) continue;
      if (kept.length === 0) {
        this.state.delete(key);
        removed += 1;
      } else {
        entry.hits = kept;
      }
    }
    return removed;
  }

  /** Number of keys currently tracked (test/ops helper). */
  size(): number {
    return this.state.size();
  }

  /** Test/ops helper. */
  reset(): void {
    this.state.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Token-bucket limiter (sustained throughput, burst smoothing).
 * `token-bucket.ts` is the pure, immutable rule set; this class is the
 * stateful, keyed wrapper that owns one bucket per client. Additive to
 * the fixed/sliding windows above — a caller that needs to allow a burst
 * but cap the long-run rate picks this instead of a time box.
 * ------------------------------------------------------------------ */

/** Options for {@link TokenBucketLimiter}. */
export type TokenBucketLimiterOptions = RateLimiterOptions & {
  /** Maximum tokens a bucket holds (the burst size). */
  capacity: number;
  /** Tokens replenished per second (the sustained rate). */
  refillPerSecond: number;
};

/**
 * Keyed token-bucket limiter. Each key owns a bucket (grown lazily on first
 * `hit`), refilled from the injected `now` — nothing reads the wall clock.
 * The key space is LRU-bounded like the sliding limiter above.
 */
export class TokenBucketLimiter {
  private readonly buckets: LruCache<string, TokenBucket>;
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(options: TokenBucketLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.buckets = createLru<string, TokenBucket>({
      capacity: options.maxKeys ?? DEFAULT_MAX_KEYS,
    });
  }

  /**
   * Spend `tokens` (default 1) from `key`'s bucket at `now`, returning the
   * pure {@link ConsumeResult}: `allowed`, the persisted next bucket and the
   * `retryAfterMs` a denied caller should wait.
   */
  hit(key: string, now: number, tokens = 1): ConsumeResult {
    const existing =
      this.buckets.get(key) ??
      createBucket({ capacity: this.capacity, refillPerSecond: this.refillPerSecond });
    const result = tryConsume(existing, { now, tokens });
    this.buckets.set(key, result.bucket);
    return result;
  }

  /** Number of buckets currently tracked (test/ops helper). */
  size(): number {
    return this.buckets.size();
  }

  /** Test/ops helper. */
  reset(): void {
    this.buckets.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Authentication limits (login / signup / 2FA).
 *
 * Server actions never reach `api-guard.ts` — that helper is only
 * called from route handlers — so the auth surface gets its own budgets
 * here. Two of them are charged per attempt:
 *
 *   - one per client address: the coarse backstop against a flood;
 *   - one per account, keyed on the submitted e-mail address. A client
 *     cannot forge that one, so it is the budget that holds even when
 *     the forwarding headers are spoofed.
 *
 * A third budget bounds 2FA code guesses: the code space (10^6 codes,
 * three of them valid per 30 s window) is far too small to search
 * without one.
 *
 * The lockout that belongs to the account itself is *persisted* by the
 * caller (the auth actions keep the failure counter on the user row);
 * {@link authLockoutMs} holds the pure rule both sides agree on.
 * ------------------------------------------------------------------ */

/** Sliding-window budget for one client address (any auth attempt). */
export const AUTH_IP_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** Sliding-window budget for 2FA code guesses, charged per account. */
export const AUTH_TWO_FACTOR_LIMIT = { limit: 5, windowMs: 15 * 60_000 } as const;

/** Consecutive failed sign-ins that are tolerated before the account locks. */
export const AUTH_LOCKOUT_THRESHOLD = 5;

/** Length of the first lock; doubles with every further consecutive failure. */
export const AUTH_LOCKOUT_BASE_MS = 15_000;

/** Upper bound of a lock. */
export const AUTH_LOCKOUT_MAX_MS = 15 * 60_000;

/**
 * How long an account stays locked after its `failures`-th consecutive
 * failure. Below {@link AUTH_LOCKOUT_THRESHOLD} nothing is locked; from
 * the threshold on the lock doubles (15 s, 30 s, 60 s, …) up to
 * {@link AUTH_LOCKOUT_MAX_MS}. The counter is reset by a successful
 * sign-in, so the backoff only ever grows while the account is under
 * attack.
 */
export function authLockoutMs(failures: number): number {
  if (!Number.isFinite(failures) || failures < AUTH_LOCKOUT_THRESHOLD) return 0;
  const step = Math.min(Math.floor(failures) - AUTH_LOCKOUT_THRESHOLD, 30);
  return Math.min(AUTH_LOCKOUT_BASE_MS * 2 ** step, AUTH_LOCKOUT_MAX_MS);
}

/** Which budget rejected an authentication attempt. */
export type AuthLimitScope = "ip" | "account" | "twoFactor";

/** Outcome of an authentication budget check. */
export type AuthLimitResult = {
  /** Whether the attempt may proceed. */
  allowed: boolean;
  /** The budget that rejected the attempt (`null` when it was allowed). */
  scope: AuthLimitScope | null;
  /** How long the caller has to wait before the budget frees up. */
  retryAfterMs: number;
};

/**
 * Limiter for the auth surface. The account budget uses the AUTH tier
 * (10 attempts per minute by default); the address and the 2FA budgets
 * carry their own, explicit policies. The key prefixes keep the three
 * budgets apart inside the one key space.
 */
const authLimiter = new RateLimiter();

/**
 * Charge one authentication attempt against the address and the account
 * budget. The account budget is the AUTH tier's; the address budget is
 * looser, because one address can serve several legitimate users.
 */
export function checkAuthLimit(args: {
  /** The submitted e-mail address (already normalised by the schema). */
  email: string;
  /** The client address key (see {@link clientKeyFromHeaders}). */
  ip: string;
  /** Evaluation instant; defaults to the wall clock. */
  now?: number;
}): AuthLimitResult {
  const now = args.now ?? Date.now();
  const address = authLimiter.slidingHit(`ip:${args.ip}`, now, AUTH_IP_LIMIT);
  if (!address.allowed) {
    return { allowed: false, scope: "ip", retryAfterMs: address.retryAfterMs };
  }
  const account = authLimiter.hit({
    key: `account:${args.email}`,
    tier: "AUTH",
    now,
  });
  if (!account.allowed) {
    return { allowed: false, scope: "account", retryAfterMs: account.retryAfterMs };
  }
  return { allowed: true, scope: null, retryAfterMs: 0 };
}

/**
 * Charge one 2FA code guess against the account's guess budget. The key
 * is opaque to the limiter: the sign-in path passes the account e-mail,
 * the settings path the user id.
 */
export function checkTwoFactorLimit(args: {
  /** The account the guess belongs to. */
  key: string;
  /** Evaluation instant; defaults to the wall clock. */
  now?: number;
}): AuthLimitResult {
  const now = args.now ?? Date.now();
  const guess = authLimiter.slidingHit(`2fa:${args.key}`, now, AUTH_TWO_FACTOR_LIMIT);
  if (guess.allowed) return { allowed: true, scope: null, retryAfterMs: 0 };
  return { allowed: false, scope: "twoFactor", retryAfterMs: guess.retryAfterMs };
}

/** "1 second" / "42 seconds" — the wait a caller has to observe. */
function secondsPhrase(seconds: number): string {
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/**
 * The message a caller sees when a budget is exhausted. Shared by the
 * sign-in, sign-up and 2FA actions so the wording — and the wait it
 * quotes — is identical everywhere.
 */
export function authLimitMessage(result: AuthLimitResult): string {
  const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return `Too many attempts. Try again in ${secondsPhrase(seconds)}.`;
}

/** The message shown while an account is locked out. */
export function authLockoutMessage(
  lockedUntil: Date,
  now: Date = new Date(),
): string {
  const seconds = Math.max(
    1,
    Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000),
  );
  return `This account is temporarily locked. Try again in ${secondsPhrase(seconds)}.`;
}

/** Test/ops helper: forget every authentication budget. */
export function resetAuthLimits(): void {
  authLimiter.reset();
}
