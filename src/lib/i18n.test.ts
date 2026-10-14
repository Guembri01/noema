import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCALES, directionOf, isLocale, t, translationKeys, translationKeysFor } from "./i18n";

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

/**
 * B34 — i18n edge coverage: unknown-key fallback, interpolation boundaries,
 * locale inheritance, RTL flag exposure, duplicate-key detection.
 *
 * Red-first evidence (first run written against the batch brief's assumptions):
 * - unknown-key: 3/3 cases failed — the brief's "fallback" read as the usual
 *   key-string convention, actual is `undefined` (see the describe below).
 * - interpolation: params call failed in vitest ('Search' ≠ 'Search Noema')
 *   AND in tsc (TS2554 ×2, "Expected 2 arguments, but got 3") — there is no
 *   interpolation API (see the interpolation describe).
 */
describe("i18n unknown-key fallback", () => {
  const missing = "definitelyNotAKey" as never;

  // Red-first (B34): these three asserted `toBe("definitelyNotAKey")` and all
  // failed — `dict[key] ?? en[key]` terminates at `undefined` when the key is
  // unknown to EVERY catalogue, including English. Characterized, deliberately
  // NOT "fixed": `t` is typed `key: keyof Dict`, so the path is unreachable for
  // type-safe call sites (the one dynamic call site — the weekday headers in
  // view-renderers.tsx — uses an `as const` literal tuple). Editing i18n.ts is
  // reserved for genuine reachable bugs (B51 owns values concurrently).
  it("shipped locale + unknown key resolves to undefined", () => {
    expect(t("en", missing)).toBeUndefined();
  });

  it("non-English locale + unknown key resolves to undefined", () => {
    // The per-key `?? en[key]` inheritance fires first, then finds nothing.
    expect(t("ar", missing)).toBeUndefined();
  });

  it("unknown locale + unknown key resolves to undefined", () => {
    expect(t("xx", missing)).toBeUndefined();
  });
});

/**
 * Interpolation boundaries. Design read from i18n.ts before testing: there is
 * NO interpolation layer — `t` is (locale, key) => string and returns catalogue
 * text verbatim. Parameterized sentences are composed AT CALL SITES with
 * template literals, e.g.
 *   toast.error(`${t(locale, "noOptionNamed")} "${value}"`)
 * so `${param}` substitution and missing-param handling are call-site concerns;
 * the catalogue's side of the contract is that it never ships raw placeholder
 * tokens (which call sites would render literally) nor missing-param artifacts.
 */
describe("i18n interpolation boundaries", () => {
  it("exposes t with exactly two parameters — no params argument exists", () => {
    // Red-first (B34): v1 called t(locale, key, { q }) per the brief — vitest
    // showed the third argument silently ignored, tsc failed TS2554 ×2.
    // If a params API ever lands (3rd argument), this suite must grow
    // substitution + missing-param tests alongside it.
    expect(t.length).toBe(2);
  });

  it("no locale ships a placeholder token that call sites would render literally", () => {
    const token = /\$\{[^}]*\}|\{\{[^}]*\}\}|\{\d+\}|%[sd]/;
    for (const { code } of LOCALES) {
      for (const key of translationKeys()) {
        const value = t(code, key);
        expect({ code, key, token: value.match(token)?.[0] ?? null }).toEqual({
          code,
          key,
          token: null,
        });
      }
    }
  });

  it("no locale ships the literal artifact of a missing interpolation param", () => {
    // A template rendered with a missing param produces the word "undefined" —
    // that bug belongs to call sites; the catalogue itself must never contain it.
    for (const { code } of LOCALES) {
      for (const key of translationKeys()) {
        const value = t(code, key);
        expect({ code, key, artifact: value.includes("undefined") }).toEqual({
          code,
          key,
          artifact: false,
        });
      }
    }
  });
});

/**
 * Locale inheritance. Design read from i18n.ts before testing (per brief):
 * locales do NOT inherit wholesale from English — each of the five source
 * blocks is standalone. `t` falls back to `en` only (a) per key, via
 * `dict[key] ?? en[key]`, which is unreachable while parity keeps every block
 * complete (the parity describe above enforces exactly that), and (b) wholesale,
 * but only for locales outside LOCALES.
 */
describe("i18n locale inheritance", () => {
  it("shipped locales keep their own values — no wholesale English inheritance", () => {
    // A locale inheriting `en` wholesale would yield zero differing keys.
    // Relational on purpose: robust to B51's concurrent VALUE edits.
    for (const { code } of LOCALES) {
      if (code === "en") continue;
      const ownKeys = translationKeys().filter((key) => t(code, key) !== t("en", key));
      expect(ownKeys.length, `${code} would be inheriting English wholesale`).toBeGreaterThan(0);
    }
  });

  it("an unknown locale inherits the entire English catalogue, key for key", () => {
    // Wholesale inheritance fires only for locales outside LOCALES — never a
    // third catalogue, never undefined.
    for (const key of translationKeys()) {
      expect({ key, value: t("xx", key) }).toEqual({ key, value: t("en", key) });
    }
  });

  // Per-key ar→en inheritance (`dict[key] ?? en[key]`) is unreachable while the
  // parity describe above keeps every block complete — there is no key that ar
  // lacks — so it is characterized by the unknown-key case instead (the chain
  // runs through en and still finds nothing).
});

/**
 * RTL flag exposure: two paths must stay in sync — LOCALES[].dir (static list)
 * and directionOf() (used by app/layout.tsx).
 */
describe("i18n RTL flag exposure", () => {
  it("ships an RTL locale flag at all", () => {
    expect(LOCALES.some((locale) => locale.dir === "rtl")).toBe(true);
  });

  it("Arabic is flagged rtl in both exposure paths", () => {
    expect(LOCALES.find((locale) => locale.code === "ar")?.dir).toBe("rtl");
    expect(directionOf("ar")).toBe("rtl");
  });

  it("the four Latin-script locales are flagged ltr in both exposure paths", () => {
    for (const code of ["en", "fr", "es", "de"] as const) {
      expect({ code, dir: LOCALES.find((locale) => locale.code === code)?.dir }).toEqual({
        code,
        dir: "ltr",
      });
      expect({ code, fn: directionOf(code) }).toEqual({ code, fn: "ltr" });
    }
  });

  it("LOCALES[].dir and directionOf() never disagree for a shipped locale", () => {
    // Would go red if someone ships e.g. `he` with dir: "ltr", or flips a dir
    // without updating directionOf — the layout would disagree with the picker.
    for (const locale of LOCALES) {
      expect({ code: locale.code, fn: directionOf(locale.code) }).toEqual({
        code: locale.code,
        fn: locale.dir,
      });
    }
  });

  it("directionOf recognises the RTL language families beyond shipped locales", () => {
    expect({ codes: ["he", "fa"].map((value) => directionOf(value)) }).toEqual({
      codes: ["rtl", "rtl"],
    });
    expect(directionOf("")).toBe("ltr");
    expect(directionOf("xx")).toBe("ltr");
    expect(directionOf("AR")).toBe("ltr"); // exact, case-sensitive match
  });

  it("isLocale gates the selectable set exactly", () => {
    const codes = LOCALES.map((locale) => locale.code);
    expect(codes.every((code) => isLocale(code))).toBe(true);
    expect(["he", "fa", "EN", "xx", ""].some((value) => isLocale(value))).toBe(false);
  });
});

/**
 * Duplicate-key detection across the five source blocks of i18n.ts.
 *
 * Why source level: both existing detectors are blind to a key duplicated
 * INSIDE one block — the runtime parity test goes through Object.keys()
 * (last-wins, deduped) and scripts/i18n-insert.mjs extracts keys into a Set.
 * A duplicated `key:` line silently shadows the earlier translation.
 *
 * Red-first (B34): the fixture test was observed RED in the dev run with the
 * detector stubbed to return no duplicates — proving it discriminates.
 */
type BlockScan = {
  locale: string;
  present: boolean;
  keys: string[];
  duplicates: { key: string; count: number }[];
};

const BLOCK_LOCALES = ["en", "fr", "es", "de", "ar"] as const;

/** Mirror of the block anchors in scripts/i18n-insert.mjs, counting raw entries. */
function scanLocaleBlocks(source: string): BlockScan[] {
  const lines = source.split(/\r?\n/);
  return BLOCK_LOCALES.map((locale) => {
    const open = locale === "en" ? /^const en = \{$/ : new RegExp(`^  ${locale}: \\{$`);
    const close = locale === "en" ? /^\};$/ : /^  \},$/;
    const start = lines.findIndex((line) => open.test(line));
    const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && close.test(line));
    if (start < 0 || end < 0) return { locale, present: false, keys: [], duplicates: [] };
    const keys: string[] = [];
    for (let index = start + 1; index < end; index += 1) {
      const match = lines[index].match(/^\s+(\w+):/);
      if (match) keys.push(match[1]);
    }
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    const duplicates = [...counts]
      .filter(([, count]) => count > 1)
      .map(([key, count]) => ({ key, count }));
    return { locale, present: true, keys, duplicates };
  });
}

describe("i18n duplicate-key detection", () => {
  it("flags a key duplicated inside one block and stays quiet on clean blocks", () => {
    const fixture = [
      "const en = {",
      '  search: "Search",',
      '  home: "Home",',
      "};",
      "",
      "const DICTS = {",
      "  en,",
      "  fr: {",
      '    search: "Rechercher",',
      '    search: "Rech. (duplicated)",',
      '    home: "Accueil",',
      "  },",
      "};",
    ].join("\n");
    const scans = scanLocaleBlocks(fixture);
    expect(scans.find((scan) => scan.locale === "en")).toEqual({
      locale: "en",
      present: true,
      keys: ["search", "home"],
      duplicates: [],
    });
    expect(scans.find((scan) => scan.locale === "fr")).toEqual({
      locale: "fr",
      present: true,
      keys: ["search", "search", "home"],
      duplicates: [{ key: "search", count: 2 }],
    });
  });

  it("reports a locale block whose anchor is missing instead of silently skipping it", () => {
    const fixture = ['const en = {', '  search: "Search",', "};"].join("\n");
    const scans = scanLocaleBlocks(fixture);
    expect(scans.map((scan) => ({ locale: scan.locale, present: scan.locale === "en" }))).toEqual([
      { locale: "en", present: true },
      { locale: "fr", present: false },
      { locale: "es", present: false },
      { locale: "de", present: false },
      { locale: "ar", present: false },
    ]);
  });

  describe("the real catalogue", () => {
    const source = readFileSync(new URL("./i18n.ts", import.meta.url), "utf8");
    const scans = scanLocaleBlocks(source);

    it("defines all five blocks and every key exactly once in each", () => {
      expect(scans.map((scan) => ({ locale: scan.locale, present: scan.present }))).toEqual([
        { locale: "en", present: true },
        { locale: "fr", present: true },
        { locale: "es", present: true },
        { locale: "de", present: true },
        { locale: "ar", present: true },
      ]);
      expect(
        scans.flatMap((scan) => scan.duplicates.map((dup) => ({ locale: scan.locale, ...dup }))),
      ).toEqual([]);
    });

    it("parses each block in exactly the order the runtime dictionary exposes", () => {
      // Ties the source scanner to runtime truth: if the anchors or the entry
      // regex drift (reformat, CRLF, nested structure), this fails loudly.
      for (const { code } of LOCALES) {
        const scan = scans.find((entry) => entry.locale === code);
        expect({ locale: code, keys: scan?.keys }).toEqual({ locale: code, keys: translationKeysFor(code) });
      }
    });
  });
});
