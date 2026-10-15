/**
 * Pure token-bucket rate limiter.
 *
 * A token bucket smooths bursts: it holds up to `capacity` tokens and refills
 * at `refillPerSecond`, so a caller may spend a burst down to empty and then is
 * throttled to the steady refill rate. Unlike the fixed/sliding windows in
 * `rate-limit.ts` (which only *count* requests in a time box), a bucket also
 * models sustained throughput.
 *
 * Every function is pure and immutable: it returns a fresh bucket and never
 * mutates the one it was given. **No clock is read here** — the caller injects
 * `now` (milliseconds), so a request sequence is fully reproducible in tests.
 *
 * The `TokenBucket` value is the whole state:
 *
 *  - `capacity` — the ceiling; `tokens` never exceeds it.
 *  - `refillPerSecond` — tokens added per second of elapsed `now`.
 *  - `tokens` — the currently available balance (may be fractional).
 *  - `lastRefillAt` — the timestamp the balance was last topped up from; the
 *    refill accrues from this anchor, and it starts at `0`.
 */

/** Immutable token-bucket state. */
export type TokenBucket = {
  /** Maximum tokens the bucket can hold (a finite number ≥ 0). */
  readonly capacity: number;
  /** Tokens replenished per second (a finite number ≥ 0; 0 means never). */
  readonly refillPerSecond: number;
  /** Available tokens, from 0 up to `capacity` (fractional is allowed). */
  readonly tokens: number;
  /** Timestamp the balance is accrued from; starts at 0. */
  readonly lastRefillAt: number;
};

/** Options for `createBucket`. */
export type TokenBucketConfig = {
  /** Maximum tokens the bucket can hold. */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSecond: number;
};

/** Options for `tryConsume`. */
export type TryConsumeOptions = {
  /** Timestamp of the attempt, in milliseconds (injected — never read). */
  now: number;
  /** Tokens to spend; defaults to 1. Non-positive values are a no-op. */
  tokens?: number;
};

/** Result of `tryConsume`. */
export type ConsumeResult = {
  /** Whether the request was served. */
  allowed: boolean;
  /** The state after the attempt (unchanged balance when denied). */
  bucket: TokenBucket;
  /**
   * Milliseconds until the request could be retried, or `Infinity` when it can
   * never be served (zero refill rate, or more tokens than the bucket holds).
   * `0` when allowed.
   */
  retryAfterMs: number;
};

/** A usable magnitude: a finite number ≥ 0, else 0. */
function normalize(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** A usable timestamp: a finite number, else `fallback`. */
function normalizeNow(now: number, fallback: number): number {
  return typeof now === "number" && Number.isFinite(now) ? now : fallback;
}

/**
 * Create a full bucket, anchored at `t = 0`. Invalid config (negative, `NaN`,
 * infinite) is normalized to an empty, non-refilling bucket.
 */
export function createBucket({ capacity, refillPerSecond }: TokenBucketConfig): TokenBucket {
  const normalizedCapacity = normalize(capacity);
  return {
    capacity: normalizedCapacity,
    refillPerSecond: normalize(refillPerSecond),
    tokens: normalizedCapacity,
    lastRefillAt: 0,
  };
}

/**
 * Accrue tokens for the time elapsed since `lastRefillAt`, capped at
 * `capacity`. A non-positive elapsed (a replayed or backwards `now`) is a no-op
 * that returns the same bucket unchanged.
 */
export function refill(bucket: TokenBucket, now: number): TokenBucket {
  const at = normalizeNow(now, bucket.lastRefillAt);
  const elapsed = at - bucket.lastRefillAt;
  if (elapsed <= 0) return bucket;
  const added = (elapsed / 1000) * bucket.refillPerSecond;
  const tokens = Math.min(bucket.capacity, bucket.tokens + added);
  return {
    capacity: bucket.capacity,
    refillPerSecond: bucket.refillPerSecond,
    tokens,
    lastRefillAt: at,
  };
}

/**
 * How long until `needed` more tokens are available, rounded up to whole
 * milliseconds. `Infinity` when the bucket refills too slowly (or never) to
 * ever reach the request.
 */
function waitForTokens(bucket: TokenBucket, needed: number): number {
  if (needed <= 0) return 0;
  if (!(bucket.refillPerSecond > 0)) return Infinity;
  return Math.ceil((needed / bucket.refillPerSecond) * 1000);
}

/**
 * Try to spend `tokens` (default 1) at time `now`.
 *
 * The bucket is refilled to `now` first, then debited if it has enough tokens.
 * A denied attempt never consumes budget: the returned bucket is the refilled
 * state, and `retryAfterMs` says how long until the spend would succeed.
 */
export function tryConsume(bucket: TokenBucket, { now, tokens = 1 }: TryConsumeOptions): ConsumeResult {
  const refilled = refill(bucket, normalizeNow(now, bucket.lastRefillAt));
  const requested = normalize(tokens);
  if (requested <= 0 || refilled.tokens >= requested) {
    const next = requested > 0 ? requested : 0;
    return {
      allowed: true,
      bucket:
        next === 0
          ? refilled
          : {
              capacity: refilled.capacity,
              refillPerSecond: refilled.refillPerSecond,
              tokens: refilled.tokens - next,
              lastRefillAt: refilled.lastRefillAt,
            },
      retryAfterMs: 0,
    };
  }
  // More tokens than the bucket can ever hold → unreachable.
  if (requested > refilled.capacity) {
    return { allowed: false, bucket: refilled, retryAfterMs: Infinity };
  }
  return {
    allowed: false,
    bucket: refilled,
    retryAfterMs: waitForTokens(refilled, requested - refilled.tokens),
  };
}

/**
 * Available tokens at `now`, after refilling, without consuming any. A
 * read-only convenience over `refill(bucket, now).tokens`.
 */
export function peek(bucket: TokenBucket, now: number): number {
  return refill(bucket, now).tokens;
}
