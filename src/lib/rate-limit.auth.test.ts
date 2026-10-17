import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_IP_LIMIT,
  AUTH_LOCKOUT_BASE_MS,
  AUTH_LOCKOUT_MAX_MS,
  AUTH_LOCKOUT_THRESHOLD,
  AUTH_TWO_FACTOR_LIMIT,
  DEFAULT_RATE_TIERS,
  authLimitMessage,
  authLockoutMessage,
  authLockoutMs,
  checkAuthLimit,
  checkTwoFactorLimit,
  clientKeyFromHeaders,
  resetAuthLimits,
} from "@/lib/rate-limit";

/**
 * B03 — the auth surface had no rate limit at all: the sign-in, sign-up
 * and 2FA actions are server actions, so they never reached the API
 * guard. These tests pin the budgets that close the gap:
 *
 *   - one per client address and one per account (the submitted e-mail,
 *     which a client cannot forge) for every auth attempt;
 *   - one per account for 2FA code guesses, whose code space is far too
 *     small to search without a bound;
 *   - the exponential lockout the persisted failure counter feeds.
 */
describe("authentication limits", () => {
  beforeEach(() => resetAuthLimits());

  describe("client key", () => {
    it("ignores the forwarding headers when no proxy is declared", () => {
      // Without `TRUSTED_PROXY_HOPS` the headers are written by the client
      // itself, so they must not decide the address — every caller of the
      // scope shares one bucket.
      delete process.env.TRUSTED_PROXY_HOPS;
      expect(
        clientKeyFromHeaders(
          new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
          "auth",
        ),
      ).toBe("auth:local");
      expect(
        clientKeyFromHeaders(new Headers({ "x-real-ip": "9.9.9.9" }), "auth"),
      ).toBe("auth:local");
      expect(clientKeyFromHeaders(new Headers(), "auth")).toBe("auth:local");
    });

    it("derives the address from the forwarding headers when a proxy is declared", () => {
      // With one trusted proxy the last hop of the chain is the real client.
      process.env.TRUSTED_PROXY_HOPS = "1";
      try {
        expect(
          clientKeyFromHeaders(
            new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
            "auth",
          ),
        ).toBe("auth:5.6.7.8");
        expect(
          clientKeyFromHeaders(new Headers({ "x-real-ip": "9.9.9.9" }), "auth"),
        ).toBe("auth:9.9.9.9");
        expect(clientKeyFromHeaders(new Headers(), "auth")).toBe("auth:local");
      } finally {
        delete process.env.TRUSTED_PROXY_HOPS;
      }
    });
  });

  describe("per-account and per-address budget", () => {
    it("allows an attempt that is under both budgets", () => {
      expect(
        checkAuthLimit({ email: "a@b.test", ip: "auth:1.1.1.1", now: 0 }),
      ).toEqual({ allowed: true, scope: null, retryAfterMs: 0 });
    });

    it("spends the AUTH tier's budget per account", () => {
      for (let i = 0; i < DEFAULT_RATE_TIERS.AUTH.limit; i++) {
        expect(
          checkAuthLimit({ email: "a@b.test", ip: "auth:1.1.1.1", now: 0 }).allowed,
        ).toBe(true);
      }
      const denied = checkAuthLimit({
        email: "a@b.test",
        ip: "auth:1.1.1.1",
        now: 0,
      });
      expect(denied.allowed).toBe(false);
      expect(denied.scope).toBe("account");
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it("keeps the account budgets apart", () => {
      for (let i = 0; i < DEFAULT_RATE_TIERS.AUTH.limit; i++) {
        checkAuthLimit({ email: "a@b.test", ip: "auth:1.1.1.1", now: 0 });
      }
      expect(
        checkAuthLimit({ email: "a@b.test", ip: "auth:1.1.1.1", now: 0 }).allowed,
      ).toBe(false);
      // a different account on the same address still has its own budget
      expect(
        checkAuthLimit({ email: "c@d.test", ip: "auth:1.1.1.1", now: 0 }).allowed,
      ).toBe(true);
    });

    it("spends a separate budget per client address", () => {
      for (let i = 0; i < AUTH_IP_LIMIT.limit; i++) {
        checkAuthLimit({ email: `u${i}@b.test`, ip: "auth:5.5.5.5", now: 0 });
      }
      const denied = checkAuthLimit({
        email: "zz@b.test",
        ip: "auth:5.5.5.5",
        now: 0,
      });
      expect(denied.allowed).toBe(false);
      expect(denied.scope).toBe("ip");
      // another address is unaffected
      expect(
        checkAuthLimit({ email: "zz@b.test", ip: "auth:6.6.6.6", now: 0 }).allowed,
      ).toBe(true);
    });

    it("frees the account budget once its window has passed", () => {
      for (let i = 0; i < DEFAULT_RATE_TIERS.AUTH.limit; i++) {
        checkAuthLimit({ email: "a@b.test", ip: "auth:1.1.1.1", now: 0 });
      }
      expect(
        checkAuthLimit({ email: "a@b.test", ip: "auth:1.1.1.1", now: 0 }).allowed,
      ).toBe(false);
      const later = DEFAULT_RATE_TIERS.AUTH.windowMs;
      expect(
        checkAuthLimit({ email: "a@b.test", ip: "auth:1.1.1.1", now: later })
          .allowed,
      ).toBe(true);
    });
  });

  describe("two-factor guess budget", () => {
    it("bounds the guesses per account", () => {
      for (let i = 0; i < AUTH_TWO_FACTOR_LIMIT.limit; i++) {
        expect(checkTwoFactorLimit({ key: "a@b.test", now: 0 }).allowed).toBe(true);
      }
      const denied = checkTwoFactorLimit({ key: "a@b.test", now: 0 });
      expect(denied.allowed).toBe(false);
      expect(denied.scope).toBe("twoFactor");
      // another account keeps its own budget
      expect(checkTwoFactorLimit({ key: "c@d.test", now: 0 }).allowed).toBe(true);
    });

    it("frees the budget once its window has passed", () => {
      for (let i = 0; i < AUTH_TWO_FACTOR_LIMIT.limit; i++) {
        checkTwoFactorLimit({ key: "a@b.test", now: 0 });
      }
      expect(checkTwoFactorLimit({ key: "a@b.test", now: 0 }).allowed).toBe(false);
      expect(
        checkTwoFactorLimit({ key: "a@b.test", now: AUTH_TWO_FACTOR_LIMIT.windowMs })
          .allowed,
      ).toBe(true);
    });
  });

  describe("lockout backoff", () => {
    it("locks nothing below the threshold", () => {
      expect(authLockoutMs(0)).toBe(0);
      expect(authLockoutMs(AUTH_LOCKOUT_THRESHOLD - 1)).toBe(0);
    });

    it("doubles with every further consecutive failure", () => {
      expect(authLockoutMs(AUTH_LOCKOUT_THRESHOLD)).toBe(AUTH_LOCKOUT_BASE_MS);
      expect(authLockoutMs(AUTH_LOCKOUT_THRESHOLD + 1)).toBe(
        AUTH_LOCKOUT_BASE_MS * 2,
      );
      expect(authLockoutMs(AUTH_LOCKOUT_THRESHOLD + 2)).toBe(
        AUTH_LOCKOUT_BASE_MS * 4,
      );
    });

    it("caps the lock", () => {
      expect(authLockoutMs(1000)).toBe(AUTH_LOCKOUT_MAX_MS);
    });
  });

  describe("messages", () => {
    it("quotes the wait a caller has to observe", () => {
      expect(
        authLimitMessage({ allowed: false, scope: "account", retryAfterMs: 65_000 }),
      ).toBe("Too many attempts. Try again in 65 seconds.");
      expect(
        authLimitMessage({ allowed: false, scope: "ip", retryAfterMs: 500 }),
      ).toBe("Too many attempts. Try again in 1 second.");
    });

    it("quotes the remaining lock of a locked account", () => {
      expect(authLockoutMessage(new Date(90_000), new Date(0))).toBe(
        "This account is temporarily locked. Try again in 90 seconds.",
      );
      expect(authLockoutMessage(new Date(1_000), new Date(0))).toBe(
        "This account is temporarily locked. Try again in 1 second.",
      );
    });
  });
});
