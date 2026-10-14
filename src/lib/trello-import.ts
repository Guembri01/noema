import type { DBProperty, DBRow } from "@/components/database/database-types";

/**
 * Pure Trello board JSON → Noema database shape parser (spec
 * `MISSING_FEATURES.md` §12 "Import Trello").
 *
 * Output deliberately reuses the app's own model (`DBProperty` / `DBRow`) and
 * the stored property-value shapes documented in
 * `src/server/actions/database.ts` (`{ optionId }`, `{ optionIds }`,
 * `{ start }`, `{ text }`, `{ names }`) so the import route can persist the
 * result without any translation. No I/O, no throwing on malformed input.
 */

export type TrelloImportMeta = {
  /** Board title (falls back to "Trello board"). */
  boardName: string;
  /** Open lists, i.e. STATUS options derived. */
  lists: number;
  /** Rows produced (non-closed cards on open lists). */
  cards: number;
  /** MULTI_SELECT label options derived. */
  labels: number;
  /** Lists skipped because `closed: true`. */
  skippedClosedLists: number;
  /** Cards skipped because `closed: true`. */
  skippedClosedCards: number;
  /** Cards whose `idList` matched no open list (includes cards on closed lists). */
  skippedOrphanCards: number;
  /** Card entries that were not objects at all. */
  skippedMalformedCards: number;
  /** `idMembers` ids with no matching entry in the board's `members` array. */
  unmappedMemberIds: string[];
};

export type TrelloImportResult = {
  properties: DBProperty[];
  rows: DBRow[];
  meta: TrelloImportMeta;
};

type RawLabel = { id?: unknown; name?: unknown; color?: unknown };
type RawCard = {
  id?: unknown;
  name?: unknown;
  desc?: unknown;
  idList?: unknown;
  labels?: unknown;
  idMembers?: unknown;
  due?: unknown;
  shortUrl?: unknown;
  closed?: unknown;
};
type RawList = { id?: unknown; name?: unknown; closed?: unknown };
type RawMember = { id?: unknown; fullName?: unknown; name?: unknown; username?: unknown };
type RawBoard = {
  name?: unknown;
  lists?: unknown;
  cards?: unknown;
  labels?: unknown;
  members?: unknown;
};

/** Deterministic property ids; the import route may re-key them on insert. */
const PROPERTY_IDS = {
  name: "name",
  list: "list",
  labels: "labels",
  url: "url",
  due: "due",
  members: "members",
  description: "description",
} as const;

/** Same cycle the existing Trello import action uses for list options. */
const STATUS_COLORS = ["gray", "blue", "green", "yellow", "orange", "purple", "pink", "red"];

const NOEMA_COLORS = new Set(STATUS_COLORS.concat("brown"));

/** Trello colour names that need folding onto Noema's palette. */
const COLOR_ALIASES: Record<string, string> = {
  black: "gray",
  sky: "blue",
  lime: "green",
};

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeColor(color: unknown): string {
  const raw = nonEmptyString(color);
  if (!raw) return "gray";
  if (NOEMA_COLORS.has(raw)) return raw;
  return COLOR_ALIASES[raw] ?? "gray";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

type LabelOption = { id: string; name: string; color: string };

/** Board-level labels first, then card labels in first-seen order; ids deduped. */
function collectLabelOptions(board: RawBoard, cards: RawCard[]): LabelOption[] {
  const options: LabelOption[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown, index: number): void => {
    const label = asObject(raw) as RawLabel | null;
    if (!label) return;
    const color = normalizeColor(label.color);
    const id = nonEmptyString(label.id) ?? `label-${index}`;
    if (seen.has(id)) return;
    seen.add(id);
    options.push({
      id,
      name: nonEmptyString(label.name) ?? (label.color ? capitalize(color) : `Label ${index + 1}`),
      color,
    });
  };
  asArray(board.labels).forEach(push);
  cards.forEach((card) => asArray(card.labels).forEach(push));
  return options;
}

/** Member id → display name (Trello exports use `fullName`, some use `name`). */
function collectMemberNames(board: RawBoard): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of asArray(board.members)) {
    const member = asObject(entry) as RawMember | null;
    if (!member) continue;
    const id = nonEmptyString(member.id);
    const name = nonEmptyString(member.fullName) ?? nonEmptyString(member.name) ?? nonEmptyString(member.username);
    if (id && name) names.set(id, name);
  }
  return names;
}

/**
 * Parse a Trello board JSON export into Noema's database shape.
 *
 * Fail-safe: any non-object / list-less input yields an empty result instead of
 * throwing; closed lists and closed cards are skipped; list and label order are
 * preserved.
 */
export function parseTrelloBoard(json: unknown): TrelloImportResult {
  const emptyMeta = (boardName: string): TrelloImportMeta => ({
    boardName,
    lists: 0,
    cards: 0,
    labels: 0,
    skippedClosedLists: 0,
    skippedClosedCards: 0,
    skippedOrphanCards: 0,
    skippedMalformedCards: 0,
    unmappedMemberIds: [],
  });

  const board = asObject(json) as RawBoard | null;
  if (!board) return { properties: [], rows: [], meta: emptyMeta("") };

  const boardName = nonEmptyString(board.name) ?? "Trello board";

  const meta = emptyMeta(boardName);
  const rawLists = asArray(board.lists);
  const rawCards = asArray(board.cards);

  // Open lists, in export order → STATUS options.
  const openListIds = new Map<string, string>();
  for (const entry of rawLists) {
    const list = asObject(entry) as RawList | null;
    if (!list) continue;
    if (list.closed === true) {
      meta.skippedClosedLists += 1;
      continue;
    }
    const id = nonEmptyString(list.id);
    if (!id || openListIds.has(id)) continue;
    openListIds.set(id, nonEmptyString(list.name) ?? `List ${openListIds.size + 1}`);
  }
  meta.lists = openListIds.size;

  if (openListIds.size === 0) return { properties: [], rows: [], meta };

  const cards: RawCard[] = [];
  for (const entry of rawCards) {
    const card = asObject(entry) as RawCard | null;
    if (!card) {
      meta.skippedMalformedCards += 1;
      continue;
    }
    if (card.closed === true) {
      meta.skippedClosedCards += 1;
      continue;
    }
    cards.push(card);
  }

  const labelOptions = collectLabelOptions(board, cards);
  meta.labels = labelOptions.length;

  const memberNames = collectMemberNames(board);
  const unmappedMembers = new Set<string>();

  const properties: DBProperty[] = [
    { id: PROPERTY_IDS.name, name: "Name", type: "TEXT", config: { primary: true } },
    {
      id: PROPERTY_IDS.list,
      name: "List",
      type: "STATUS",
      config: {
        options: [...openListIds].map(([id, name], index) => ({
          id,
          name,
          color: STATUS_COLORS[index % STATUS_COLORS.length],
        })),
      },
    },
    {
      id: PROPERTY_IDS.labels,
      name: "Labels",
      type: "MULTI_SELECT",
      config: { options: labelOptions },
    },
    { id: PROPERTY_IDS.url, name: "URL", type: "URL", config: null },
    { id: PROPERTY_IDS.due, name: "Due", type: "DATE", config: null },
    { id: PROPERTY_IDS.members, name: "Members", type: "PEOPLE", config: null },
    { id: PROPERTY_IDS.description, name: "Description", type: "TEXT", config: null },
  ];

  const labelById = new Map(labelOptions.map((option) => [option.id, option]));
  const rows: DBRow[] = [];

  cards.forEach((card, index) => {
    const listId = nonEmptyString(card.idList);
    if (!listId || !openListIds.has(listId)) {
      meta.skippedOrphanCards += 1;
      return;
    }

    const title = nonEmptyString(card.name) ?? "Untitled card";
    const propertyValues: DBRow["propertyValues"] = [
      { propertyId: PROPERTY_IDS.name, value: { text: title } },
      { propertyId: PROPERTY_IDS.list, value: { optionId: listId } },
    ];

    const optionIds = asArray(card.labels)
      .map((entry) => nonEmptyString(asObject(entry)?.id))
      .filter((id): id is string => id !== null && labelById.has(id));
    if (optionIds.length > 0) {
      propertyValues.push({ propertyId: PROPERTY_IDS.labels, value: { optionIds } });
    }

    const due = nonEmptyString(card.due);
    if (due) propertyValues.push({ propertyId: PROPERTY_IDS.due, value: { start: due } });

    const shortUrl = nonEmptyString(card.shortUrl);
    if (shortUrl) propertyValues.push({ propertyId: PROPERTY_IDS.url, value: { text: shortUrl } });

    const memberIds = asArray(card.idMembers)
      .map((entry) => (typeof entry === "string" && entry.trim() ? entry.trim() : null))
      .filter((id): id is string => id !== null);
    const names: string[] = [];
    for (const id of memberIds) {
      const name = memberNames.get(id);
      if (name) {
        if (!names.includes(name)) names.push(name);
      } else {
        unmappedMembers.add(id);
      }
    }
    if (names.length > 0) {
      propertyValues.push({ propertyId: PROPERTY_IDS.members, value: { names } });
    }

    const description = typeof card.desc === "string" ? card.desc.trim() : "";
    if (description) {
      propertyValues.push({ propertyId: PROPERTY_IDS.description, value: { text: description } });
    }

    rows.push({
      id: nonEmptyString(card.id) ?? `card-${index + 1}`,
      title,
      icon: null,
      propertyValues,
    });
  });

  meta.cards = rows.length;
  meta.unmappedMemberIds = [...unmappedMembers];

  return { properties, rows, meta };
}
