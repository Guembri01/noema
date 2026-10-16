/**
 * Slack + GitHub integration — linkifier (docs/FEATURE_MATRIX.md
 * "Slack integration" / "GitHub integration").
 *
 * PURE module: no `fetch`, no prisma, no `node:*`. It only turns plain
 * markdown text into the same markdown text with GitHub and Slack references
 * replaced by links, and pulls a small unfurl summary out of a payload the
 * caller already fetched. Nothing here talks to GitHub or Slack — fetching is
 * the caller's job.
 *
 * Three jobs, all deterministic:
 *
 *  1. `parseGithubRefs` / `parseSlackRefs` detect references in free text —
 *     `owner/repo#123`, `#123`, 7–40 hex commit SHAs, `owner/repo@sha`, PR/
 *     issue/commit URLs, Slack `#channel`, `@user` and `*.slack.com/archives/…`
 *     permalinks. Longest, most specific match wins so `owner/repo#1` is one
 *     issue ref, never an issue plus a bare `#1`.
 *  2. `buildGithubLink` / `buildSlackLink` build a canonical link from a ref
 *     against an optional base URL / workspace URL.
 *  3. `linkify` applies the enabled providers to text a single time, skipping
 *     fenced code blocks (``` / ~~~) and inline code spans so a sample command
 *     is never rewritten. `unfurlPayload` reads `title` / `state` / `author`
 *     out of a fetched JSON payload, tolerating anything.
 *
 * Unit-pinned red-first by `src/lib/integration-links.test.ts`.
 */

/** Canonical GitHub host; every ref URL is rendered against this by default. */
export const DEFAULT_GITHUB_BASE_URL = "https://github.com";

/** Slack web app host used when no workspace URL is configured. */
export const DEFAULT_SLACK_WORKSPACE_URL = "https://app.slack.com";

/** GitHub references are one of these three shapes. */
export type GithubRefKind = "issue" | "pr" | "commit";

/** A detected GitHub reference. `owner`/`repo` are empty for context-free tokens. */
export interface GithubRef {
  readonly kind: GithubRefKind;
  readonly owner: string;
  readonly repo: string;
  readonly id: string;
  readonly url: string;
  readonly raw: string;
}

/** Optional repository context so a bare `#123` / SHA can be resolved. */
export interface GithubParseOptions {
  readonly owner?: string;
  readonly repo?: string;
}

/** Slack references are one of these three shapes. */
export type SlackRefKind = "channel" | "user" | "permalink";

/** A detected Slack reference. `channel`/`ts` are only set for permalinks. */
export interface SlackRef {
  readonly kind: SlackRefKind;
  readonly id: string;
  readonly channel?: string;
  readonly ts?: string;
  readonly url: string;
  readonly raw: string;
}

/** Optional workspace URL so `#channel` / `@user` can be linked. */
export interface SlackParseOptions {
  readonly workspaceUrl?: string;
}

/** Options for {@link buildGithubLink}. */
export interface BuildGithubLinkOptions {
  readonly baseUrl?: string;
}

/** Options for {@link buildSlackLink}. */
export interface BuildSlackLinkOptions {
  readonly workspaceUrl?: string;
}

/** Per-provider configuration for {@link linkify}; presence enables the provider. */
export interface LinkifyGithubProvider extends GithubParseOptions {
  readonly baseUrl?: string;
}

export interface LinkifySlackProvider {
  readonly workspaceUrl?: string;
}

export interface LinkifyProviders {
  readonly github?: LinkifyGithubProvider;
  readonly slack?: LinkifySlackProvider;
}

export interface LinkifyOptions {
  readonly providers?: LinkifyProviders;
}

/** The summary pulled from a fetched payload for a hover card / unfurl. */
export interface UnfurledRef {
  readonly title: string;
  readonly state: string | null;
  readonly author: string | null;
  readonly url: string;
}

/* ------------------------------------------------------------------ *
 * Guards and small helpers.
 * ------------------------------------------------------------------ */

const HTTP_URL = /^https?:\/\//i;

function isHttpUrl(value: string): boolean {
  return HTTP_URL.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed, non-empty string, else `null`. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** GitHub's path segment for a ref kind. */
function githubSegment(kind: GithubRefKind): string {
  if (kind === "commit") return "commit";
  if (kind === "pr") return "pull";
  return "issues";
}

function githubBase(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_GITHUB_BASE_URL).replace(/\/+$/, "");
}

function slackBase(workspaceUrl: string | undefined): string {
  return (workspaceUrl ?? DEFAULT_SLACK_WORKSPACE_URL).replace(/\/+$/, "");
}

/** A positioned match is only used internally to resolve overlaps. */
interface Span<T> {
  readonly start: number;
  readonly end: number;
  readonly ref: T;
}

/**
 * Keep the longest match at each position and drop anything that overlaps an
 * already-kept span, so a single source token never yields two refs.
 */
function resolveOverlaps<T extends { readonly start: number; readonly end: number }>(
  items: readonly T[],
): T[] {
  const sorted = [...items].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const kept: T[] = [];
  let cursor = -1;
  for (const item of sorted) {
    if (item.start >= cursor) {
      kept.push(item);
      cursor = item.end;
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ *
 * GitHub parsing.
 * ------------------------------------------------------------------ */

function makeGithubRef(
  kind: GithubRefKind,
  owner: string,
  repo: string,
  id: string,
  raw: string,
): GithubRef {
  const o = owner.trim();
  const r = repo.trim();
  const url =
    o !== "" && r !== ""
      ? `${DEFAULT_GITHUB_BASE_URL}/${o}/${r}/${githubSegment(kind)}/${id}`
      : raw;
  return { kind, owner: o, repo: r, id, url, raw };
}

function scanGithubUrls(text: string): Span<GithubRef>[] {
  const spans: Span<GithubRef>[] = [];
  const re =
    /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull|commit)\/([0-9A-Za-z]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const kind: GithubRefKind =
      match[3] === "pull" ? "pr" : match[3] === "commit" ? "commit" : "issue";
    const raw = match[0];
    spans.push({
      start: match.index,
      end: match.index + raw.length,
      ref: makeGithubRef(kind, match[1], match[2], match[4], raw),
    });
  }
  return spans;
}

function scanGithub(text: string, options: GithubParseOptions): Span<GithubRef>[] {
  const contextOwner = options.owner?.trim() ?? "";
  const contextRepo = options.repo?.trim() ?? "";
  const spans: Span<GithubRef>[] = [...scanGithubUrls(text)];

  // owner/repo@sha → commit
  {
    const re =
      /(?<![\w.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([0-9a-fA-F]{7,40})(?![\w.-])/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0];
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        ref: makeGithubRef("commit", match[1], match[2], match[3], raw),
      });
    }
  }

  // owner/repo#123 → issue (GitHub numbers issues and PRs from one space)
  {
    const re = /(?<![\w.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)(?![\w-])/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0];
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        ref: makeGithubRef("issue", match[1], match[2], match[3], raw),
      });
    }
  }

  // bare #123 → issue, resolved against the supplied context when present
  {
    const re = /(?<![\w/#])#(\d+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0];
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        ref: makeGithubRef("issue", contextOwner, contextRepo, match[1], raw),
      });
    }
  }

  // bare commit SHA — 7–40 hex, at least one a–f so plain numbers are ignored
  {
    const re =
      /(?<![0-9A-Za-z])(?=[0-9a-fA-F]{7,40}(?![0-9a-fA-F]))(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}(?![0-9A-Za-z])/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0];
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        ref: makeGithubRef("commit", contextOwner, contextRepo, raw, raw),
      });
    }
  }

  return resolveOverlaps(spans);
}

/** Detect GitHub issue/PR/commit references in `text`, in the order they appear. */
export function parseGithubRefs(
  text: string,
  options: GithubParseOptions = {},
): GithubRef[] {
  return scanGithub(typeof text === "string" ? text : "", options).map(
    (span) => span.ref,
  );
}

/**
 * Build the canonical link for a ref. `issue` → `/issues/<id>`,
 * `pr` → `/pull/<id>`, `commit` → `/commit/<id>`. A ref without owner/repo
 * (a context-free bare token) yields its raw text unchanged.
 */
export function buildGithubLink(
  ref: GithubRef,
  options: BuildGithubLinkOptions = {},
): string {
  if (ref.owner === "" || ref.repo === "") return ref.raw;
  return `${githubBase(options.baseUrl)}/${ref.owner}/${ref.repo}/${githubSegment(
    ref.kind,
  )}/${ref.id}`;
}

/* ------------------------------------------------------------------ *
 * Slack parsing.
 * ------------------------------------------------------------------ */

/** Slack permalinks encode an ISO-ish `ts` as `p<seconds><micros>`. */
function permalinkTs(digits: string): string | undefined {
  if (digits.length <= 10) return undefined;
  return `${digits.slice(0, 10)}.${digits.slice(10)}`;
}

function makeSlackChannel(id: string, raw: string, options: SlackParseOptions): SlackRef {
  return {
    kind: "channel",
    id,
    url: `${slackBase(options.workspaceUrl)}/channels/${id}`,
    raw,
  };
}

function makeSlackUser(id: string, raw: string, options: SlackParseOptions): SlackRef {
  return {
    kind: "user",
    id,
    url: `${slackBase(options.workspaceUrl)}/team/${id}`,
    raw,
  };
}

/** Detect Slack `#channel`, `@user` and `*.slack.com/archives/…` refs in `text`. */
function scanSlack(text: string, options: SlackParseOptions): Span<SlackRef>[] {
  const source = typeof text === "string" ? text : "";
  const spans: Span<SlackRef>[] = [];

  // permalink: https://<workspace>.slack.com/archives/<channel>[/p<ts>]
  {
    const re =
      /(https?:\/\/([A-Za-z0-9-]+)\.slack\.com\/archives\/([A-Za-z0-9]+)(?:\/p(\d+))?)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const raw = match[1];
      const channel = match[3];
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        ref: {
          kind: "permalink",
          id: channel,
          channel,
          ts: match[4] ? permalinkTs(match[4]) : undefined,
          url: raw,
          raw,
        },
      });
    }
  }

  // #channel — at least one lowercase letter so a GitHub `#123` stays GitHub
  {
    const re = /(?<![\w#/])#(?=[a-z0-9_-]*[a-z])[a-z0-9][a-z0-9_-]*/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const raw = match[0];
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        ref: makeSlackChannel(raw.slice(1), raw, options),
      });
    }
  }

  // @user — the lookbehind keeps `a@b.com` from matching
  {
    const re = /(?<![\w@])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const raw = match[0];
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        ref: makeSlackUser(match[1], raw, options),
      });
    }
  }

  return resolveOverlaps(spans);
}

/** Detect Slack references in `text`, in the order they appear. */
export function parseSlackRefs(
  text: string,
  options: SlackParseOptions = {},
): SlackRef[] {
  return scanSlack(text, options).map((span) => span.ref);
}

/**
 * Build the canonical link for a Slack ref. A permalink keeps its absolute URL;
 * `#channel` / `@user` become `<workspace>/channels/<id>` and
 * `<workspace>/team/<id>`, defaulting to {@link DEFAULT_SLACK_WORKSPACE_URL}.
 */
export function buildSlackLink(
  ref: SlackRef,
  options: BuildSlackLinkOptions = {},
): string {
  const base = slackBase(options.workspaceUrl);
  if (ref.kind === "channel") return `${base}/channels/${ref.id}`;
  if (ref.kind === "user") return `${base}/team/${ref.id}`;
  if (isHttpUrl(ref.url)) return ref.url;
  const channel = ref.channel ?? ref.id;
  const suffix = ref.ts ? `/p${ref.ts.replace(".", "")}` : "";
  return `${base}/archives/${channel}${suffix}`;
}

/* ------------------------------------------------------------------ *
 * Code-aware linkification.
 * ------------------------------------------------------------------ */

interface Segment {
  readonly code: boolean;
  readonly value: string;
}

/** Split text into plain and fenced-code segments, keeping newlines intact. */
function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split("\n");
  let buffer = "";
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  const flush = (): void => {
    if (buffer !== "") {
      segments.push({ code: inFence, value: buffer });
      buffer = "";
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const suffix = i < lines.length - 1 ? "\n" : "";
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

    if (!inFence) {
      if (opener) {
        flush();
        inFence = true;
        fenceChar = opener[1][0];
        fenceLen = opener[1].length;
        buffer = line + suffix;
      } else {
        buffer += line + suffix;
      }
    } else {
      buffer += line + suffix;
      if (opener && opener[1][0] === fenceChar && opener[1].length >= fenceLen) {
        flush();
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
    }
  }
  flush();
  return segments;
}

/** Split a plain segment into plain and inline-code (`…`) segments. */
function splitInlineCode(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /`[^`\n]*`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ code: false, value: text.slice(last, match.index) });
    }
    segments.push({ code: true, value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ code: false, value: text.slice(last) });
  }
  return segments;
}

interface LinkSpan {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly url: string;
}

/** Collect the linkable spans from both providers inside one plain segment. */
function linkSpans(segment: string, providers: LinkifyProviders): LinkSpan[] {
  const spans: LinkSpan[] = [];

  if (providers.github) {
    const github = providers.github;
    for (const span of scanGithub(segment, github)) {
      const url = buildGithubLink(span.ref, { baseUrl: github.baseUrl });
      if (!isHttpUrl(url)) continue;
      spans.push({ start: span.start, end: span.end, label: span.ref.raw, url });
    }
  }

  if (providers.slack) {
    const slack = providers.slack;
    for (const span of scanSlack(segment, { workspaceUrl: slack.workspaceUrl })) {
      const url = buildSlackLink(span.ref, { workspaceUrl: slack.workspaceUrl });
      if (!isHttpUrl(url)) continue;
      spans.push({ start: span.start, end: span.end, label: span.ref.raw, url });
    }
  }

  return resolveOverlaps(spans);
}

function linkifyPlain(segment: string, providers: LinkifyProviders): string {
  const spans = linkSpans(segment, providers);
  if (spans.length === 0) return segment;
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += segment.slice(last, span.start);
    out += `[${span.label}](${span.url})`;
    last = span.end;
  }
  out += segment.slice(last);
  return out;
}

/**
 * Replace GitHub / Slack references with markdown links for every enabled
 * provider. Fenced code blocks and inline code spans are never touched, and
 * each source character is rewritten at most once.
 */
export function linkify(text: string, options: LinkifyOptions = {}): string {
  const source = typeof text === "string" ? text : "";
  const providers = options.providers ?? {};
  if (!providers.github && !providers.slack) return source;

  return splitFences(source)
    .map((segment) => {
      if (segment.code) return segment.value;
      return splitInlineCode(segment.value)
        .map((part) => (part.code ? part.value : linkifyPlain(part.value, providers)))
        .join("");
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Unfurl.
 * ------------------------------------------------------------------ */

function pickAuthor(record: Record<string, unknown>): string | null {
  for (const key of ["user", "author"]) {
    const value = record[key];
    const direct = str(value);
    if (direct) return direct;
    if (isRecord(value)) {
      const nested = str(value.login) ?? str(value.name) ?? str(value.username);
      if (nested) return nested;
    }
  }
  return str(record.username) ?? str(record.author_name);
}

/**
 * Read `title`, `state` and `author` out of a fetched payload for a ref,
 * tolerating any shape. A closed-and-merged PR reports `state: "merged"`, a
 * commit's title is its message's first line, and missing fields fall back to
 * the ref itself.
 */
export function unfurlPayload(
  ref: GithubRef | SlackRef,
  meta: unknown,
): UnfurledRef {
  const record = isRecord(meta) ? meta : {};

  let title = str(record.title);
  if (!title && isRecord(record.commit)) {
    const message = str(record.commit.message);
    if (message) title = message.split(/\r?\n/, 1)[0].trim() || null;
  }
  if (!title) title = str(record.text) ?? str(record.summary) ?? ref.raw;

  let state = str(record.state);
  const merged =
    record.merged === true ||
    (isRecord(record.pull_request) && str(record.pull_request.merged_at) !== null);
  if (merged) state = "merged";

  const url =
    str(record.html_url) ?? str(record.url) ?? str(record.permalink) ?? ref.url;

  return {
    title,
    state: state ?? null,
    author: pickAuthor(record),
    url,
  };
}
