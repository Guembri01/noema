import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_USES,
  DEFAULT_TOKEN_BYTES,
  MAX_TOKEN_BYTES,
  MIN_TOKEN_BYTES,
  canRedeem,
  generateInviteToken,
  hashToken,
  isExpired,
  isWellFormedToken,
  maskToken,
} from "./invite-token";
import type { RedeemableInvite } from "./invite-token";

/**
 * Invite tokens — pure helpers over Node `crypto` for issuing, storing and
 * gating self-serve invite links.
 *
 * Red-first: `src/lib/invite-token.ts` did not exist when this file was
 * written. A raw token is generated once and emailed; only its SHA-256 hex
 * digest is persisted. Redeemability is decided from an invite's expiry, a
 * used marker and a redemption budget. No DB, routes, React or clock — every
 * time input is passed in explicitly.
 */

// 43 base64url chars: a fixed, well-formed token (32 bytes of entropy).
const FIXED_TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";

describe("generateInviteToken", () => {
  it("returns a base64url token with DEFAULT_TOKEN_BYTES of entropy", () => {
    const token = generateInviteToken({});
    expect(isWellFormedToken(token)).toBe(true);
    expect(Buffer.from(token, "base64url")).toHaveLength(DEFAULT_TOKEN_BYTES);
    // 32 bytes -> ceil(256 / 6) = 43 unpadded base64url chars.
    expect(token).toHaveLength(43);
  });

  it("honours an explicit byte count", () => {
    const token = generateInviteToken({ bytes: 24 });
    expect(Buffer.from(token, "base64url")).toHaveLength(24);
    expect(token).toHaveLength(32); // matches the legacy randomToken(24) length
  });

  it("stays well-formed across the accepted byte range", () => {
    const min = generateInviteToken({ bytes: MIN_TOKEN_BYTES });
    const max = generateInviteToken({ bytes: MAX_TOKEN_BYTES });
    expect(isWellFormedToken(min)).toBe(true);
    expect(isWellFormedToken(max)).toBe(true);
    expect(min).toHaveLength(22);
    expect(max).toHaveLength(171);
  });

  it("never emits padding or standard-base64 characters", () => {
    for (let i = 0; i < 25; i += 1) {
      expect(generateInviteToken({ bytes: 16 })).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("produces distinct tokens on each call", () => {
    expect(generateInviteToken({})).not.toBe(generateInviteToken({}));
  });

  it("rejects out-of-range and non-integer byte counts", () => {
    expect(() => generateInviteToken({ bytes: 0 })).toThrow();
    expect(() => generateInviteToken({ bytes: MIN_TOKEN_BYTES - 1 })).toThrow();
    expect(() => generateInviteToken({ bytes: MAX_TOKEN_BYTES + 1 })).toThrow();
    expect(() => generateInviteToken({ bytes: 12.5 })).toThrow();
  });
});

describe("hashToken", () => {
  it("is the lowercase SHA-256 hex digest of the token", () => {
    expect(hashToken("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashToken("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic and shaped as 64 hex chars", () => {
    expect(hashToken(FIXED_TOKEN)).toBe(hashToken(FIXED_TOKEN));
    expect(hashToken(FIXED_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps different tokens to different digests", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("never stores the token itself", () => {
    expect(hashToken(FIXED_TOKEN)).not.toContain(FIXED_TOKEN);
  });
});

describe("isWellFormedToken", () => {
  it("accepts a fixed base64url token", () => {
    expect(isWellFormedToken(FIXED_TOKEN)).toBe(true);
    expect(isWellFormedToken("A".repeat(22))).toBe(true);
  });

  it("rejects empty, padded and standard-base64 input", () => {
    expect(isWellFormedToken("")).toBe(false);
    expect(isWellFormedToken(`${FIXED_TOKEN}=`)).toBe(false);
    expect(isWellFormedToken("abc+def/ghijklmnopqrstuvwx")).toBe(false);
  });

  it("rejects whitespace and out-of-range lengths", () => {
    expect(isWellFormedToken(` ${FIXED_TOKEN}`)).toBe(false);
    expect(isWellFormedToken("short")).toBe(false);
    expect(isWellFormedToken("A".repeat(300))).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken(null)).toBe(false);
    expect(isWellFormedToken(42)).toBe(false);
  });
});

describe("isExpired", () => {
  const now = Date.UTC(2026, 0, 1);

  it("is false for a future expiry and true for a past one", () => {
    expect(isExpired(now + 1000, now)).toBe(false);
    expect(isExpired(now - 1000, now)).toBe(true);
  });

  it("treats the exact boundary instant as expired (fail closed)", () => {
    expect(isExpired(now, now)).toBe(true);
  });

  it("treats a missing expiry as never expiring", () => {
    expect(isExpired(null, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
  });

  it("accepts ISO strings, epoch millis and Dates", () => {
    expect(isExpired("2026-06-01T00:00:00.000Z", now)).toBe(false);
    expect(isExpired(new Date(now + 1), now)).toBe(false);
  });

  it("fails closed on an unparseable expiry", () => {
    expect(isExpired("not-a-date", now)).toBe(true);
  });
});

describe("canRedeem", () => {
  const now = Date.UTC(2026, 0, 1);
  const fresh: RedeemableInvite = {
    expiresAt: now + 86_400_000,
    usedCount: 0,
  };

  it("allows a fresh, unexpired, unused invite", () => {
    const decision = canRedeem(fresh, { now });
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.remainingUses).toBe(DEFAULT_MAX_USES);
  });

  it("blocks an expired invite", () => {
    const decision = canRedeem({ ...fresh, expiresAt: now - 1 }, { now });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("expired");
  });

  it("blocks an invite with a used marker", () => {
    const decision = canRedeem({ ...fresh, usedAt: now - 10 }, { now });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("already_used");
  });

  it("blocks an exhausted invite and reports no uses left", () => {
    const decision = canRedeem({ ...fresh, usedCount: 3, maxUses: 3 }, { now });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("exhausted");
    expect(decision.remainingUses).toBe(0);
  });

  it("allows a multi-use invite while budget remains", () => {
    const decision = canRedeem({ ...fresh, usedCount: 2, maxUses: 5 }, { now });
    expect(decision.ok).toBe(true);
    expect(decision.remainingUses).toBe(3);
  });

  it("prefers the expired reason over a used marker", () => {
    const decision = canRedeem(
      { ...fresh, expiresAt: now - 1, usedAt: now - 2 },
      { now },
    );
    expect(decision.reason).toBe("expired");
  });

  it("defaults maxUses to a single redemption", () => {
    expect(canRedeem({ ...fresh, usedCount: 1 }, { now }).ok).toBe(false);
    expect(canRedeem({ expiresAt: null }, { now }).ok).toBe(true);
  });

  it("re-reads the clock from the injected now", () => {
    const invite: RedeemableInvite = { expiresAt: now + 500, usedCount: 0 };
    expect(canRedeem(invite, { now }).ok).toBe(true);
    expect(canRedeem(invite, { now: now + 500 }).reason).toBe("expired");
  });
});

describe("maskToken", () => {
  it("shows only the ends of a long token", () => {
    expect(maskToken(FIXED_TOKEN)).toBe("abcde…BCDE");
  });

  it("fully redacts short values", () => {
    expect(maskToken("abc")).toBe("••••");
    expect(maskToken("abcdefgh")).toBe("••••");
  });

  it("returns null for empty input", () => {
    expect(maskToken("")).toBeNull();
    expect(maskToken(null)).toBeNull();
    expect(maskToken(undefined)).toBeNull();
  });
});
