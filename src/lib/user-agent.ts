/**
 * User-agent parsing.
 *
 * Every request that reaches the app may carry a `User-Agent` header, and a
 * handful of features (device-aware rendering, bot filtering, session/audit
 * display) want a small, stable set of facts about it rather than the raw
 * string. This module is the single place that turns that string into those
 * facts:
 *
 *  - `parseUserAgent(ua)`    - the full `UserAgentInfo` record
 *  - `isBot(ua)`             - is this a crawler or an HTTP client?
 *  - `formatUserAgent(info)` - a human-readable, versioned description
 *  - `summarizeUserAgent(ua)`- a compact label for logs and badges
 *
 * The parser is pure, total, and regex-based: any string - including `""` and
 * arbitrary garbage - yields a well-formed record and never throws. Detection
 * is best-effort by design; when nothing matches, the fallbacks are
 * `browser: "unknown"`, `os: "unknown"`, `device: "desktop"`, `isBot: false`.
 */

/** The three form factors the UI distinguishes. */
export type UserAgentDevice = "desktop" | "mobile" | "tablet";

/** A parsed user agent. `browserVersion`/`osVersion` are absent when unknown. */
export type UserAgentInfo = {
  /** Product name, e.g. `Chrome`, `Safari`, `Googlebot`, or `unknown`. */
  browser: string;
  /** Product version when it could be read from the string. */
  browserVersion?: string;
  /** Platform name, e.g. `Windows`, `macOS`, `iOS`, `Android`, or `unknown`. */
  os: string;
  /** Platform version when it could be read from the string. */
  osVersion?: string;
  /** Best-effort form factor; defaults to `desktop`. */
  device: UserAgentDevice;
  /** True for crawlers, previewers, and programmatic HTTP clients. */
  isBot: boolean;
};

/** A dotted numeric version, as it appears in the major token of a UA. */
const VERSION = "(\\d+(?:\\.\\d+)*)";

/** `unknown` is the shared sentinel for "nothing matched". */
const UNKNOWN = "unknown";

/**
 * Crawler / client catalog. Order matters: the first match wins, so specific
 * product tokens precede programmatic clients, and the generic keyword rule
 * (which would otherwise swallow `Googlebot`, `MaybeBot`, ...) comes last.
 * A pattern's first capture group, when present, is the version.
 */
const BOTS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Googlebot", pattern: /Googlebot(?:-[\w-]+)?\/([\d.]+)/i },
  { name: "Bingbot", pattern: /Bingbot\/([\d.]+)/i },
  { name: "DuckDuckBot", pattern: /DuckDuckBot\/([\d.]+)/i },
  { name: "YandexBot", pattern: /Yandex(?:Bot)?\/([\d.]+)/i },
  { name: "Baiduspider", pattern: /Baiduspider\/([\d.]+)/i },
  { name: "Applebot", pattern: /Applebot\/([\d.]+)/i },
  { name: "Twitterbot", pattern: /Twitterbot\/([\d.]+)/i },
  { name: "FacebookBot", pattern: /facebookexternalhit\/([\d.]+)/i },
  { name: "LinkedInBot", pattern: /LinkedInBot\/([\d.]+)/i },
  { name: "Slackbot", pattern: /Slackbot(?:-LinkExpanding)?[ /]([\d.]+)/i },
  { name: "Discordbot", pattern: /Discordbot\/([\d.]+)/i },
  { name: "WhatsApp", pattern: /WhatsApp\/([\d.]+)/i },
  { name: "SemrushBot", pattern: /SemrushBot\/([\d.]+)/i },
  { name: "AhrefsBot", pattern: /AhrefsBot\/([\d.]+)/i },
  { name: "PetalBot", pattern: /PetalBot/i },
  { name: "MJ12bot", pattern: /MJ12bot\/v?([\d.]+)/i },
  { name: "TelegramBot", pattern: /TelegramBot/i },
  { name: "UptimeRobot", pattern: /UptimeRobot/i },
  { name: "Pingdom", pattern: /Pingdom/i },
  { name: "Lighthouse", pattern: /Lighthouse/i },
  { name: "HeadlessChrome", pattern: /HeadlessChrome\/([\d.]+)/i },
  { name: "PhantomJS", pattern: /PhantomJS\/([\d.]+)/i },
  { name: "curl", pattern: /\bcurl\/([\d.]+)/i },
  { name: "wget", pattern: /\bWget\/([\d.]+)/i },
  { name: "python-requests", pattern: /python-requests\/([\d.]+)/i },
  { name: "Go-http-client", pattern: /Go-http-client\/([\d.]+)/i },
  { name: "axios", pattern: /axios\/([\d.]+)/i },
  { name: "node-fetch", pattern: /node-fetch\/([\d.]+)/i },
  { name: "okhttp", pattern: /okhttp\/([\d.]+)/i },
  { name: "Scrapy", pattern: /Scrapy\/([\d.]+)/i },
  // Catch-all for anything that describes itself as a bot but is not in the
  // product list above; `detectBot` renames it to the neutral "Bot".
  { name: "generic-bot", pattern: /\b(bot|crawler|spider|scrapy)\b/i },
];

/** A browser rule: the product `name`, its `pattern`, and an optional guard. */
type BrowserRule = {
  name: string;
  pattern: RegExp;
  /** When set, the rule only applies if this also matches (e.g. Trident => IE). */
  requires?: RegExp;
};

/**
 * Browser catalog, most-specific first. Edge, Opera, and Samsung Internet all
 * embed a `Chrome/` token, and every Chromium build embeds a `Chrome/` token,
 * so they must be tested before the generic Chrome rule.
 */
const BROWSERS: readonly BrowserRule[] = [
  { name: "Edge", pattern: new RegExp(`Edg(?:e|A|iOS)?\\/${VERSION}`) },
  { name: "Opera", pattern: new RegExp(`(?:OPR|OPiOS|Opera)\\/${VERSION}`) },
  { name: "Samsung Internet", pattern: new RegExp(`SamsungBrowser\\/${VERSION}`) },
  { name: "Chromium", pattern: new RegExp(`Chromium\\/${VERSION}`) },
  { name: "Chrome", pattern: new RegExp(`(?:Chrome|CriOS)\\/${VERSION}`) },
  { name: "Firefox", pattern: new RegExp(`(?:Firefox|FxiOS)\\/${VERSION}`) },
  {
    name: "Internet Explorer",
    pattern: /(?:MSIE |rv:)([\d.]+)/,
    requires: /Trident|MSIE/,
  },
];

/** Read group 1 of `pattern` against `ua`, or `undefined` when it is absent. */
function capture(ua: string, pattern: RegExp): string | undefined {
  const match = ua.match(pattern);
  return match && match[1] ? match[1] : undefined;
}

/** Match the first entry of `catalog` whose pattern hits; returns undefined otherwise. */
function firstMatch(
  ua: string,
  catalog: ReadonlyArray<{ name: string; pattern: RegExp }>,
): { name: string; version?: string } | undefined {
  for (const entry of catalog) {
    const match = ua.match(entry.pattern);
    if (match) {
      const version = capture(ua, entry.pattern);
      return version === undefined ? { name: entry.name } : { name: entry.name, version };
    }
  }
  return undefined;
}

/** Detect the browser and its version. */
function detectBrowser(ua: string): { name: string; version?: string } {
  for (const entry of BROWSERS) {
    if (entry.requires && !entry.requires.test(ua)) continue;
    const match = ua.match(entry.pattern);
    if (match) {
      const version = capture(ua, entry.pattern);
      return version === undefined ? { name: entry.name } : { name: entry.name, version };
    }
  }
  if (/Safari\//.test(ua)) {
    const version = capture(ua, /Version\/([\d.]+)/);
    return version === undefined ? { name: "Safari" } : { name: "Safari", version };
  }
  return { name: UNKNOWN };
}

/** Detect the crawler / client, if any, and its version. */
function detectBot(ua: string): { name: string; version?: string } | undefined {
  const hit = firstMatch(ua, BOTS);
  if (!hit) return undefined;
  // The generic keyword rule has no meaningful product name; keep it neutral.
  if (hit.name === "generic-bot") return { name: "Bot" };
  return hit;
}

/** Detect the operating system and its version. Windows Phone precedes Android. */
function detectOs(ua: string): { name: string; version?: string } {
  let version = capture(ua, /Windows Phone(?: OS)?\s*([\d.]+)/i);
  if (/Windows Phone/i.test(ua)) {
    return version === undefined ? { name: "Windows Phone" } : { name: "Windows Phone", version };
  }
  version = capture(ua, /Android[ /]([\d.]+)/i);
  if (version !== undefined) return { name: "Android", version };
  if (/Android/i.test(ua)) return { name: "Android" };

  version = capture(ua, /(?:CPU (?:iPhone )?OS|CPU OS) ([\d_]+)/i);
  if (/(?:iPhone|iPad|iPod)/i.test(ua) || /CPU OS [\d_]+/i.test(ua)) {
    const normalized = version?.replace(/_/g, ".");
    return normalized === undefined ? { name: "iOS" } : { name: "iOS", version: normalized };
  }

  version = capture(ua, /Mac OS X ([\d_.]+)/);
  if (version !== undefined) return { name: "macOS", version: version.replace(/_/g, ".") };

  version = capture(ua, /CrOS \S+ ([\d.]+)/);
  if (version !== undefined) return { name: "Chrome OS", version };
  if (/CrOS/.test(ua)) return { name: "Chrome OS" };

  version = capture(ua, /Windows NT ([\d.]+)/);
  if (version !== undefined) return { name: "Windows", version };
  if (/Windows/.test(ua)) return { name: "Windows" };

  if (/\bLinux\b/i.test(ua)) return { name: "Linux" };
  return { name: UNKNOWN };
}

/** Classify the form factor. Tablet rules precede mobile ones. */
function detectDevice(ua: string): UserAgentDevice {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "tablet";
  // iPadOS 13+ masquerades as a desktop Macintosh, distinguishable by `Mobile`.
  if (/Macintosh/i.test(ua) && /Mobile/i.test(ua)) return "tablet";
  // An Android UA without a `Mobile` token is a tablet.
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

/** Is `ua` a crawler, previewer, or programmatic HTTP client? */
export function isBot(ua: string): boolean {
  return detectBot(typeof ua === "string" ? ua : "") !== undefined;
}

/** Parse any user-agent string into a total `UserAgentInfo` record. */
export function parseUserAgent(ua: string): UserAgentInfo {
  const input = typeof ua === "string" ? ua : "";
  const bot = detectBot(input);
  const browser = bot ?? detectBrowser(input);
  const os = detectOs(input);

  const info: UserAgentInfo = {
    browser: browser.name,
    os: os.name,
    device: detectDevice(input),
    isBot: bot !== undefined,
  };
  if (browser.version !== undefined) info.browserVersion = browser.version;
  if (os.version !== undefined) info.osVersion = os.version;
  return info;
}

/** Render a versioned, human-readable description of a parsed user agent. */
export function formatUserAgent(info: UserAgentInfo): string {
  const browser = info.browserVersion
    ? `${info.browser} ${info.browserVersion}`
    : info.browser;
  const os = info.osVersion ? `${info.os} ${info.osVersion}` : info.os;
  const bot = info.isBot ? " [bot]" : "";
  return `${browser} on ${os} (${info.device})${bot}`;
}

/** A compact, version-less label suitable for logs and UI badges. */
export function summarizeUserAgent(ua: string): string {
  const info = parseUserAgent(ua);
  const bot = info.isBot ? " [bot]" : "";
  return `${info.browser} on ${info.os} (${info.device})${bot}`;
}
