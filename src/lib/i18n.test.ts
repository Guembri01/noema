import { describe, expect, it } from "vitest";
import { LOCALES, t, translationKeys, translationKeysFor } from "./i18n";

/**
 * Locale key parity: every locale must expose exactly the same key set as the
 * English catalogue, with no empty values. Written red-first in batch B07 —
 * adding keys to `en` alone must fail here until the other four locales land.
 */
describe("i18n locale parity", () => {
  it("every locale has exactly the same key set as English", () => {
    const reference = translationKeys();
    for (const { code } of LOCALES) {
      const keys = translationKeysFor(code);
      const missing = reference.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !reference.includes(key));
      expect({ locale: code, missing, extra }).toEqual({
        locale: code,
        missing: [],
        extra: [],
      });
    }
  });

  it("no locale ships an empty translation", () => {
    for (const { code } of LOCALES) {
      for (const key of translationKeys()) {
        expect({ locale: code, key, value: t(code, key) }).toEqual({
          locale: code,
          key,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("falls back to English for unknown locales", () => {
    expect(t("xx", "settings")).toBe(t("en", "settings"));
    expect(translationKeysFor("xx")).toEqual(translationKeysFor("en"));
  });
});
