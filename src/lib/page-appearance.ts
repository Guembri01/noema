/**
 * Page appearance — small text, page font and line spacing
 * (docs/MISSING_FEATURES.md §1 "Small text" / "Page fonts" / "Line spacing").
 *
 * PURE module: no prisma, no routes, no React. The page shell wires the class
 * list from {@link appearanceClasses} onto its wrapper, and the page settings
 * menu patches a value and stores it — both share the same sanitizing parser so
 * a corrupt or partial stored value can only narrow the styling, never break a
 * render.
 *
 * `parseAppearance` fails closed per field: an unknown enum member falls back to
 * that field's default (and a wholly unparseable input to
 * {@link DEFAULT_APPEARANCE}) and it never throws. The emitted class names match
 * the ones already shipped in `src/app/globals.css` (`noema-page-small`,
 * `noema-font-serif`, `noema-font-mono`) and the page route
 * (`src/app/w/[slug]/[pageId]/page.tsx`).
 *
 * Unit-pinned red-first by `src/lib/page-appearance.test.ts`.
 */

/** Body text size: `small` shrinks the editor, `default` keeps it at 16px. */
export type PageFontSize = "small" | "default";

/** Preset font family for the editor and read-only renderer. */
export type PageFont = "default" | "serif" | "mono";

/** Paragraph line-height rhythm. */
export type PageLineSpacing = "tight" | "normal" | "loose";

/** The persisted (JSON) page appearance. Read through `parseAppearance`. */
export type PageAppearance = {
  readonly fontSize: PageFontSize;
  readonly font: PageFont;
  readonly lineSpacing: PageLineSpacing;
};

/** Neutral baseline: no class is emitted, the shipped typography stands. */
export const DEFAULT_APPEARANCE: PageAppearance = {
  fontSize: "default",
  font: "default",
  lineSpacing: "normal",
};

const FONT_SIZES: readonly PageFontSize[] = ["small", "default"];
const FONTS: readonly PageFont[] = ["default", "serif", "mono"];
const LINE_SPACINGS: readonly PageLineSpacing[] = ["tight", "normal", "loose"];

/** Non-null, non-array object - the only input shape trusted as a record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFontSize(value: unknown): value is PageFontSize {
  return typeof value === "string" && FONT_SIZES.includes(value as PageFontSize);
}

function isFont(value: unknown): value is PageFont {
  return typeof value === "string" && FONTS.includes(value as PageFont);
}

function isLineSpacing(value: unknown): value is PageLineSpacing {
  return (
    typeof value === "string" &&
    LINE_SPACINGS.includes(value as PageLineSpacing)
  );
}

/**
 * Fill a (possibly corrupt, possibly partial) value into a complete
 * `PageAppearance`. Every unrecognized field falls back to its default, so
 * callers can hand raw JSON straight off a row or a form without risking a
 * broken render. Never throws.
 */
export function parseAppearance(raw: unknown): PageAppearance {
  const record = isPlainRecord(raw) ? raw : {};
  return {
    fontSize: isFontSize(record.fontSize)
      ? record.fontSize
      : DEFAULT_APPEARANCE.fontSize,
    font: isFont(record.font) ? record.font : DEFAULT_APPEARANCE.font,
    lineSpacing: isLineSpacing(record.lineSpacing)
      ? record.lineSpacing
      : DEFAULT_APPEARANCE.lineSpacing,
  };
}

/**
 * CSS classes describing an appearance, in font-size → font → line-spacing
 * order. The default appearance emits no classes so the base typography wins.
 */
export function appearanceClasses(appearance: PageAppearance): string[] {
  const classes: string[] = [];
  if (appearance.fontSize === "small") classes.push("noema-page-small");
  if (appearance.font === "serif") classes.push("noema-font-serif");
  else if (appearance.font === "mono") classes.push("noema-font-mono");
  if (appearance.lineSpacing === "tight") classes.push("noema-line-tight");
  else if (appearance.lineSpacing === "loose") classes.push("noema-line-loose");
  return classes;
}

/**
 * Immutable merge: returns a new appearance with `patch`'s *valid* members
 * applied. Missing (`undefined`) and unknown members are ignored so a partial
 * UI patch can never reset or corrupt the current value; `current` is
 * normalized first, so junk still yields a complete result.
 */
export function patchAppearance(
  current: PageAppearance,
  patch: Partial<PageAppearance>,
): PageAppearance {
  const base = parseAppearance(current);
  const next = { ...base };
  if (isFontSize(patch.fontSize)) next.fontSize = patch.fontSize;
  if (isFont(patch.font)) next.font = patch.font;
  if (isLineSpacing(patch.lineSpacing)) next.lineSpacing = patch.lineSpacing;
  return next;
}

/** Stable JSON for storage: sanitized first, so only known members persist. */
export function serializeAppearance(appearance: unknown): string {
  return JSON.stringify(parseAppearance(appearance));
}

/**
 * Parse a stored JSON string (or an already-parsed object) back into a complete
 * appearance. Malformed JSON, `null` and non-string garbage all normalize to
 * {@link DEFAULT_APPEARANCE}; unknown enum members fall back per field.
 */
export function deserializeAppearance(raw: unknown): PageAppearance {
  if (typeof raw !== "string") return parseAppearance(raw);
  try {
    return parseAppearance(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/**
 * Whether an appearance has nothing to store — the neutral baseline. Unparseable
 * input counts as default, so a row full of garbage reads as "unset".
 */
export function isDefaultAppearance(appearance: unknown): boolean {
  const parsed = parseAppearance(appearance);
  return (
    parsed.fontSize === DEFAULT_APPEARANCE.fontSize &&
    parsed.font === DEFAULT_APPEARANCE.font &&
    parsed.lineSpacing === DEFAULT_APPEARANCE.lineSpacing
  );
}
