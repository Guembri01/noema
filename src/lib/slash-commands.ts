/**
 * Pure ranking / filtering model for the slash (/) command menu (F6).
 *
 * The editor's `components/editor/slash-menu.tsx` currently carries its own
 * inline tiered match; this module lifts that policy into a side-effect-free
 * shape (no React, no editor, no DOM) so the ordering, recency, enable/disable
 * and grouping rules can be unit-tested directly and reused by a future
 * command palette. Callers compose the pieces:
 *
 *   groupCommands(rankCommands(filterCommands(catalog, { context }), query, { recentIds }))
 *
 * Ranking and filtering are deliberately separate: `rankCommands` never looks
 * at `enabled`, so a disabled command can still be searched (it is the
 * `filterCommands` step that removes it) — that keeps each function's contract
 * small and lets a caller show disabled-with-a-reason rows later.
 */

/** One slash-menu entry. `keywords` are extra search terms beyond the title. */
export type SlashCommand = {
  id: string;
  title: string;
  keywords: string[];
  /** Group id; first appearance in the input drives group order. */
  group: string;
  /** Defaults to enabled; `false` hides the command from `filterCommands`. */
  enabled?: boolean;
};

export type RankOptions = {
  /** Maximum number of matches to return; omitted means no cap. */
  limit?: number;
  /** Command ids ordered most-recent-first; a soft tiebreak within a tier. */
  recentIds?: readonly string[];
};

/** Viewer/session state that can force individual commands on or off. */
export type FilterContext = {
  /** Ids to re-enable even when the catalog marks them `enabled: false`. */
  enabled?: readonly string[];
  /** Ids to hide even when the catalog leaves them enabled. */
  disabled?: readonly string[];
};

export type FilterOptions = { context?: FilterContext };

export type CommandGroup = { group: string; items: SlashCommand[] };

/**
 * Match quality: lower is better. `0` title prefix, `1` word prefix (any title
 * or keyword word starts with the query), `2` substring anywhere in the title
 * or keywords. `null` means no match.
 */
type MatchTier = 0 | 1 | 2;

const WORD_BOUNDARY = /[^a-z0-9]+/;

/** Lowercased alphanumeric words of a title/keyword ("To-do list" → to, do, list). */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(WORD_BOUNDARY)
    .filter((word) => word.length > 0);
}

/** Trim, lowercase, and drop a single leading slash so "/head" == "head". */
function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^\//, "");
}

function matchTier(command: SlashCommand, query: string): MatchTier | null {
  const title = command.title.toLowerCase();
  if (title.startsWith(query)) return 0;

  if (words(command.title).some((word) => word.startsWith(query))) return 1;
  const keywords = command.keywords.map((keyword) => keyword.toLowerCase());
  for (const keyword of keywords) {
    if (words(keyword).some((word) => word.startsWith(query))) return 1;
  }

  if (title.includes(query)) return 2;
  for (const keyword of keywords) {
    if (keyword.includes(query)) return 2;
  }
  return null;
}

/** Locale-independent title ordering (then id) so ties are fully stable. */
function compareTitle(left: SlashCommand, right: SlashCommand): number {
  const a = left.title.toLowerCase();
  const b = right.title.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/**
 * Rank a catalog against a query.
 *
 * Order: match tier (title-prefix → word-prefix → substring), then recency
 * (`recentIds`, earlier = stronger), then title (case-insensitive, id as the
 * final tiebreak). An empty/slash-only query skips matching and returns the
 * catalog in its original order. The input is never mutated.
 */
export function rankCommands(
  catalog: readonly SlashCommand[],
  query: string,
  options: RankOptions = {},
): SlashCommand[] {
  const cap = options.limit ?? Number.POSITIVE_INFINITY;
  if (cap <= 0) return [];

  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return catalog.slice(0, cap);

  const recentIndex = new Map<string, number>();
  for (const [position, id] of (options.recentIds ?? []).entries()) {
    if (!recentIndex.has(id)) recentIndex.set(id, position);
  }

  const scored: { command: SlashCommand; tier: MatchTier }[] = [];
  for (const command of catalog) {
    const tier = matchTier(command, normalized);
    if (tier !== null) scored.push({ command, tier });
  }

  scored.sort((left, right) => {
    if (left.tier !== right.tier) return left.tier - right.tier;
    const leftRecent = recentIndex.get(left.command.id) ?? Number.POSITIVE_INFINITY;
    const rightRecent = recentIndex.get(right.command.id) ?? Number.POSITIVE_INFINITY;
    if (leftRecent !== rightRecent) return leftRecent - rightRecent;
    return compareTitle(left.command, right.command);
  });

  return scored.slice(0, cap).map((entry) => entry.command);
}

/**
 * Apply the enable/disable rules and return the commands a viewer may run.
 * A command is visible when it is not in `context.disabled`, and either it is
 * in `context.enabled` or the catalog leaves it `enabled !== false`. An
 * explicit disable beats an explicit enable. Input order is preserved.
 */
export function filterCommands(
  catalog: readonly SlashCommand[],
  options: FilterOptions = {},
): SlashCommand[] {
  const context = options.context ?? {};
  const forcedEnabled = new Set(context.enabled ?? []);
  const forcedDisabled = new Set(context.disabled ?? []);
  return catalog.filter((command) => {
    if (forcedDisabled.has(command.id)) return false;
    if (forcedEnabled.has(command.id)) return true;
    return command.enabled !== false;
  });
}

/**
 * Bucket commands by `group`, in first-appearance order, without emitting empty
 * groups — so a search that narrows to one group renders no stray separators.
 */
export function groupCommands(items: readonly SlashCommand[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  const byId = new Map<string, CommandGroup>();
  for (const item of items) {
    let group = byId.get(item.group);
    if (!group) {
      group = { group: item.group, items: [] };
      byId.set(item.group, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** The single best-ranked command for a query, or `undefined` when none match. */
export function topMatch(
  catalog: readonly SlashCommand[],
  query: string,
  options: RankOptions = {},
): SlashCommand | undefined {
  const ranked = rankCommands(catalog, query, { ...options, limit: 1 });
  return ranked.length > 0 ? ranked[0] : undefined;
}
