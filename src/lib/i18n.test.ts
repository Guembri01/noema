import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCALES, directionOf, isLocale, t, translationKeys, translationKeysFor } from "./i18n";

/**
 * Locale key parity: every locale must expose exactly the same key set as the
 * English catalogue, with no empty values. Written red-first in B07 —
 * adding keys to `en` alone must fail here until the other four locales land.
 *
 * The parity sweep walks every locale × every key (pure CPU over the
 * catalogues) and stretched past vitest's 5 s default under full-suite
 * contention (8.5 s, P3-T09).
 */
describe("i18n locale parity", { timeout: 60_000 }, () => {
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
 * Red-first evidence (first run written against the original assumptions):
 * - unknown-key: 3/3 cases failed — "fallback" read as the usual
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
    // Red-first (B34): v1 called t(locale, key, { q }) — vitest
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
 * Locale inheritance. Design read from i18n.ts before testing:
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
 * (last-wins, deduped) and the i18n key inserter extracts keys into a Set.
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

/** Mirror of the block anchors in the i18n key inserter, counting raw entries. */
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

/**
 * P2.1 — editor-surface strings. Keys extracted from the editor toolbar, the
 * bubble menu, the slash-command menu, the block context menu, the mention
 * menu and the equation editor. Written red-first in the i18n tranche: these
 * assertions fail until the keys land in all five catalogues.
 */
type I18nKey = Parameters<typeof t>[1];

const EDITOR_SURFACE_KEYS = [
  "blockText",
  "blockHeading1",
  "blockHeading2",
  "blockHeading3",
  "blockHeading4",
  "blockHeading5",
  "blockHeading6",
  "blockBulletedList",
  "blockNumberedList",
  "blockTodoList",
  "blockToggleList",
  "blockToggle",
  "blockQuote",
  "blockCallout",
  "blockColumns",
  "blockTable",
  "blockImage",
  "blockBookmark",
  "blockEmbed",
  "blockBreadcrumb",
  "blockSyncedView",
  "blockLinkedDatabase",
  "blockTemplateButton",
  "blockEquation",
  "blockTableOfContents",
  "blockDivider",
  "paragraphHint",
  "heading1Hint",
  "heading2Hint",
  "heading3Hint",
  "heading4Hint",
  "heading5Hint",
  "heading6Hint",
  "bulletedListHint",
  "numberedListHint",
  "todoListHint",
  "calloutHint",
  "toggleHint",
  "columnsHint",
  "quoteHint",
  "codeBlockHint",
  "tableHint",
  "imageHint",
  "bookmarkHint",
  "embedHint",
  "breadcrumbHint",
  "syncedViewHint",
  "linkedDatabaseHint",
  "templateButtonHint",
  "askAiHint",
  "equationHint",
  "tocHint",
  "dividerHint",
  "slashBasicBlocks",
  "mentionHeading",
  "turnInto",
  "colorLabel",
  "backgroundLabel",
  "clearHighlight",
  "editEquation",
  "moveUp",
  "moveDown",
  "copyLinkToBlock",
  "blockDuplicated",
  "blockDeleted",
  "nothingToWorkWith",
  "colorDefault",
  "colorGray",
  "colorBrown",
  "colorOrange",
  "colorYellow",
  "colorGreen",
  "colorBlue",
  "colorPurple",
  "colorPink",
  "colorRed",
  "colorNone",
  "selectTextFirst",
  "linkPastePlaceholder",
  "equationTitle",
  "blockEquationTitle",
  "latexSyntaxHint",
  "latexSourceAria",
  "apply",
  "saving",
  "saveFailed",
  "retry",
  "liveWord",
  "uploadedPrefix",
  "uploadFailed",
] as const satisfies readonly I18nKey[];

describe("editor-surface catalogue keys", () => {
  it("defines every editor-surface key in every locale, with no empty value", () => {
    for (const key of EDITOR_SURFACE_KEYS) {
      expect({ key, present: translationKeys().includes(key) }).toEqual({ key, present: true });
      for (const { code } of LOCALES) {
        expect({ key, code, value: t(code, key).trim() }).toEqual({
          key,
          code,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("translates each editor-surface key in at least one shipped locale", () => {
    // Guards against copying the English value into every catalogue: for each
    // key, at least one non-English shipped locale must differ from English.
    for (const key of EDITOR_SURFACE_KEYS) {
      const localised = LOCALES.some(
        ({ code }) => code !== "en" && t(code, key) !== t("en", key),
      );
      expect({ key, localised }).toEqual({ key, localised: true });
    }
  });
});

/**
 * P2.2 — editor node-view strings. Keys extracted from the React node views
 * rendered inside the editor surface: code block language picker, callout,
 * toggle, table of contents, image block, linked database, template button,
 * Ask AI block and breadcrumb. Written red-first: these assertions fail until
 * the keys land in all five catalogues.
 */
const NODE_VIEW_KEYS = [
  "codeFilterLanguages",
  "codeFilterLanguagesAria",
  "codeLanguagesAria",
  "codeNoMatches",
  "calloutChangeIcon",
  "toggleCollapse",
  "toggleExpand",
  "tocEmpty",
  "imageAlignLeft",
  "imageAlignCenter",
  "imageAlignRight",
  "imageResizeAria",
  "imageCaptionPlaceholder",
  "imageCaptionAria",
  "imageAlignmentAria",
  "imageAltText",
  "imageAltPlaceholder",
  "linkedLinkPlaceholder",
  "linkedNoDatabases",
  "linkedDatabaseFallback",
  "linkedOpenAria",
  "linkedChangeAria",
  "linkedRemoveAria",
  "linkedLoadFailed",
  "chooseTemplate",
  "insertWord",
  "templateRemoveAria",
  "templateBuiltinGroup",
  "templateSavedGroup",
  "templateMissing",
  "templateLoading",
  "templateLoadFailed",
  "blockButton",
  "buttonHint",
  "buttonStyleAria",
  "buttonStyleDefault",
  "buttonStylePrimary",
  "buttonStyleDanger",
  "buttonKindOpenUrl",
  "buttonKindInsertTemplate",
  "buttonKindSetProperty",
  "buttonKindNotify",
  "buttonNotifyUnsupported",
  "buttonSetPropertyHint",
  "buttonRunSuccess",
  "buttonRunFailed",
  "buttonOpenInNewTab",
  "askAiPlaceholder",
  "askWord",
  "askSummarizePage",
  "askAiMode",
  "askAiOutput",
  "askAiOutputAnswer",
  "askAiOutputInsert",
  "askAiOutputReplace",
  "askAiUsePage",
  "askAiStale",
  "breadcrumbNoParents",
] as const satisfies readonly I18nKey[];

describe("editor node-view catalogue keys", () => {
  it("defines every node-view key in every locale, with no empty value", () => {
    for (const key of NODE_VIEW_KEYS) {
      expect({ key, present: translationKeys().includes(key) }).toEqual({ key, present: true });
      for (const { code } of LOCALES) {
        expect({ key, code, value: t(code, key).trim() }).toEqual({
          key,
          code,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("translates each node-view key in at least one shipped locale", () => {
    for (const key of NODE_VIEW_KEYS) {
      const localised = LOCALES.some(
        ({ code }) => code !== "en" && t(code, key) !== t("en", key),
      );
      expect({ key, localised }).toEqual({ key, localised: true });
    }
  });
});

/**
 * P2.3 — suggestions (track-changes) surface strings. Keys extracted from the
 * editor chrome that owns the "Suggesting" toggle, the pending count and the
 * accept/reject controls (`page-editor.tsx`). Written red-first: these
 * assertions fail until the keys land in all five catalogues. The kind labels
 * reuse the existing `pendingWord` / `deletedPrefix` keys where a literal is
 * already shipped.
 */
const SUGGESTION_KEYS = [
  "suggestingWord",
  "suggestionsWord",
  "reviewSuggestions",
  "acceptSuggestion",
  "rejectSuggestion",
  "acceptAllSuggestions",
  "rejectAllSuggestions",
  "suggestionInserted",
  "suggestionReplaced",
] as const satisfies readonly I18nKey[];

describe("editor suggestions catalogue keys", () => {
  it("defines every suggestion key in every locale, with no empty value", () => {
    for (const key of SUGGESTION_KEYS) {
      expect({ key, present: translationKeys().includes(key) }).toEqual({ key, present: true });
      for (const { code } of LOCALES) {
        expect({ key, code, value: t(code, key).trim() }).toEqual({
          key,
          code,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("translates each suggestion key in at least one shipped locale", () => {
    for (const key of SUGGESTION_KEYS) {
      const localised = LOCALES.some(
        ({ code }) => code !== "en" && t(code, key) !== t("en", key),
      );
      expect({ key, localised }).toEqual({ key, localised: true });
    }
  });
});

/**
 * Page-route wiring — the "Unlinked mentions" reference section heading.
 * `Backlinks` previously reused the editor's `mentionHeading` ("Mention") for
 * this section; it now carries its own key so the label can read as a full
 * phrase and translate independently of the inline mention menu. Written
 * red-first (B-slice on the page route): `t` resolves to `undefined` for the
 * unknown key until it lands in all five catalogues. Source-key order is pinned
 * by the block scanner above (`unlinkedMentions` follows `linkedReferences`).
 */
const REFERENCE_KEYS = ["unlinkedMentions"] as const satisfies readonly I18nKey[];

describe("page reference catalogue keys", () => {
  it("defines every reference key in every locale, with no empty value", () => {
    for (const key of REFERENCE_KEYS) {
      expect({ key, present: translationKeys().includes(key) }).toEqual({ key, present: true });
      for (const { code } of LOCALES) {
        expect({ key, code, value: t(code, key).trim() }).toEqual({
          key,
          code,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("translates each reference key in at least one shipped locale", () => {
    for (const key of REFERENCE_KEYS) {
      const localised = LOCALES.some(
        ({ code }) => code !== "en" && t(code, key) !== t("en", key),
      );
      expect({ key, localised }).toEqual({ key, localised: true });
    }
  });
});

/**
 * R22 — catalogue additions: the sidebar "Recent" section, "Copy as Markdown",
 * the comment resolved-filter chips, the code-block line-number/caption
 * toggles, the share "Short link", the chart shape/aggregate controls, the
 * gallery preview property, named-version labels, the one-level reply notice,
 * board WIP limits and the group-summary aggregation property. Written
 * red-first: the keys land in `en` first, so the parity assertions below fail
 * until all four other catalogues carry the same keys, in the same order, with
 * real translations.
 */
const R22_KEYS = [
  "recent",
  "copyAsMarkdown",
  "commentFilterAll",
  "commentFilterOpen",
  "commentFilterResolved",
  "codeLineNumbers",
  "codeCaption",
  "shortLink",
  "chartType",
  "chartAggregate",
  "galleryPreview",
  "versionName",
  "versionRename",
  "linkLimitOneLevel",
  "wipLimits",
  "aggregationProperty",
] as const satisfies readonly I18nKey[];

describe("R22 catalogue keys", () => {
  it("defines every R22 key in every locale, with no empty value", () => {
    for (const key of R22_KEYS) {
      expect({ key, present: translationKeys().includes(key) }).toEqual({ key, present: true });
      for (const { code } of LOCALES) {
        expect({ key, code, value: t(code, key).trim() }).toEqual({
          key,
          code,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("translates each R22 key in at least one shipped locale", () => {
    // Guards against copying the English value into every catalogue: for each
    // key, at least one non-English shipped locale must differ from English.
    for (const key of R22_KEYS) {
      const localised = LOCALES.some(
        ({ code }) => code !== "en" && t(code, key) !== t("en", key),
      );
      expect({ key, localised }).toEqual({ key, localised: true });
    }
  });

  it("keeps the R22 additions in an identical order across every locale", () => {
    // Additive on purpose: the new keys are appended to each block in the same
    // sequence, so filtering any locale's key list down to the R22 set must
    // reproduce this suite's order exactly.
    for (const { code } of LOCALES) {
      const ordered = translationKeysFor(code).filter((key) =>
        (R22_KEYS as readonly string[]).includes(key),
      );
      expect({ code, keys: ordered }).toEqual({ code, keys: [...R22_KEYS] });
    }
  });
});

/**
 * Y11 — catalogue additions for the workspace-settings and database surfaces:
 * the locked-schema banner, duplicate-option toggle, search-indexing and
 * export-restriction notes, the sub-page / mark-both / verify-property row
 * actions, AI autofill, calendar subscription, the four additional importers
 * (Asana, Evernote, Google Docs, Confluence), the PDF preview and the map
 * block. Written red-first: the keys land in `en` first, so the parity
 * assertions below fail until all four other catalogues carry the same keys, in
 * the same order, with real translations.
 */
const Y11_KEYS = [
  "schemaLocked",
  "schemaLockedHint",
  "allowDuplicate",
  "searchIndexing",
  "exportRestricted",
  "subPages",
  "markBoth",
  "verifyProperty",
  "aiAutofill",
  "subscribeCalendar",
  "importAsana",
  "importEvernote",
  "importGoogleDocs",
  "importConfluence",
  "pdfPreview",
  "mapBlock",
] as const satisfies readonly I18nKey[];

describe("Y11 catalogue keys", () => {
  it("defines every Y11 key in every locale, with no empty value", () => {
    for (const key of Y11_KEYS) {
      expect({ key, present: translationKeys().includes(key) }).toEqual({ key, present: true });
      for (const { code } of LOCALES) {
        expect({ key, code, value: t(code, key).trim() }).toEqual({
          key,
          code,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("translates each Y11 key in at least one shipped locale", () => {
    // Guards against copying the English value into every catalogue: for each
    // key, at least one non-English shipped locale must differ from English.
    for (const key of Y11_KEYS) {
      const localised = LOCALES.some(
        ({ code }) => code !== "en" && t(code, key) !== t("en", key),
      );
      expect({ key, localised }).toEqual({ key, localised: true });
    }
  });

  it("keeps the Y11 additions in an identical order across every locale", () => {
    // Additive on purpose: the new keys are appended to each block in the same
    // sequence, so filtering any locale's key list down to the Y11 set must
    // reproduce this suite's order exactly.
    for (const { code } of LOCALES) {
      const ordered = translationKeysFor(code).filter((key) =>
        (Y11_KEYS as readonly string[]).includes(key),
      );
      expect({ code, keys: ordered }).toEqual({ code, keys: [...Y11_KEYS] });
    }
  });
});

/**
 * DW01 — design-system literals. Keys covering the English literals that
 * shipped across the visual-design work: common actions, settings labels,
 * security, empty states, validation and relative-time. Appended to every
 * catalogue block after `mapBlock` in one stable documented order. Written
 * red-first: the keys land in `en` first, so the parity assertions below fail
 * until all four other catalogues carry the same keys, in the same order, with
 * real translations. The source-level duplicate guard reuses `scanLocaleBlocks`.
 */
const DW01_KEYS = [
  "deletePermanently",
  "selectAll",
  "restoreSelected",
  "refresh",
  "clearSearch",
  "wrap",
  "addColumn",
  "deleteColumn",
  "resizeSidebar",
  "hideSidebar",
  "showSidebar",
  "currentWorkspace",
  "slug",
  "rowHeight",
  "properties",
  "description",
  "events",
  "edit",
  "encryption",
  "provider",
  "models",
  "budget",
  "promptLibrary",
  "dataBoundaries",
  "configured",
  "missingKey",
  "local",
  "notSetUp",
  "twoFactor",
  "recoveryCodes",
  "scopes",
  "clientId",
  "clientSecret",
  "nothingHereYet",
  "noTicketsYet",
  "noCommentsYet",
  "nothingInTheTrash",
  "noProjectsYet",
  "requiredField",
  "invalidUrl",
  "invalidEmail",
  "nameTooLong",
  "dueBeforeStart",
  "today",
  "yesterday",
  "thisWeek",
  "nextWeek",
  "thisMonth",
] as const satisfies readonly I18nKey[];

describe("DW01 catalogue keys", () => {
  it("lists every new key exactly once — the DW01 set itself has no duplicate", () => {
    expect(new Set(DW01_KEYS).size).toBe(DW01_KEYS.length);
  });

  it("adds each DW01 key exactly once per source block — duplicate-key guard", () => {
    const source = readFileSync(new URL("./i18n.ts", import.meta.url), "utf8");
    for (const scan of scanLocaleBlocks(source)) {
      for (const key of DW01_KEYS) {
        expect({
          locale: scan.locale,
          key,
          count: scan.keys.filter((entry) => entry === key).length,
        }).toEqual({ locale: scan.locale, key, count: 1 });
      }
    }
  });

  it("defines every DW01 key in every locale, with no empty value", () => {
    for (const key of DW01_KEYS) {
      expect({ key, present: translationKeys().includes(key) }).toEqual({ key, present: true });
      for (const { code } of LOCALES) {
        expect({ key, code, value: t(code, key).trim() }).toEqual({
          key,
          code,
          value: expect.any(String),
        });
        expect(t(code, key).trim()).not.toBe("");
      }
    }
  });

  it("translates each DW01 key in at least one shipped locale", () => {
    // Guards against copying the English value into every catalogue: for each
    // key, at least one non-English shipped locale must differ from English.
    for (const key of DW01_KEYS) {
      const localised = LOCALES.some(
        ({ code }) => code !== "en" && t(code, key) !== t("en", key),
      );
      expect({ key, localised }).toEqual({ key, localised: true });
    }
  });

  it("keeps the DW01 additions in an identical order across every locale", () => {
    // Additive on purpose: the new keys are appended to each block in the same
    // sequence, so filtering any locale's key list down to the DW01 set must
    // reproduce this suite's order exactly.
    for (const { code } of LOCALES) {
      const ordered = translationKeysFor(code).filter((key) =>
        (DW01_KEYS as readonly string[]).includes(key),
      );
      expect({ code, keys: ordered }).toEqual({ code, keys: [...DW01_KEYS] });
    }
  });
});
