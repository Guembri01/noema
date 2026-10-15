/**
 * Database view config schema
 * (docs/FEATURE_MATRIX.md rows "Per-view configuration", "Show/hide
 * properties" and "Column resize/reorder"; docs/specs/database-deep.md
 * R89.1/R89.5/R89.13).
 *
 * A database view keeps its settings in the untyped JSON `config` column of
 * `DatabaseView`: its view type, filter, sort, group, which properties are
 * hidden or shown, per-column widths, conditional-formatting colour rules and
 * whether cells wrap. That JSON round-trips through the DB and the browser, so
 * on the way back in it is untrusted — a key from an older build, a property
 * that was since deleted, a hand-edited value.
 *
 * This module is the pure schema for that blob. It queries and renders nothing
 * and does not import the query engine (`@/lib/database-query` and friends own
 * evaluation); it is the shape contract a view renderer and its settings UI can
 * share.
 *
 * - `normalizeViewConfig` is the tolerant read path: it keeps every key this
 *   build knows, drops the ones it does not, drops references to properties the
 *   schema no longer declares, and defaults the rest.
 * - `validateViewConfig` is the strict path a save can gate on: it reports every
 *   shape problem in one pass with a stable code.
 * - `mergeViewConfig` layers a partial patch over a base config immutably.
 *
 * View type names match the app's source of truth — the Prisma `ViewType` enum,
 * `updateViewAction` (`src/server/actions/database.ts`) and the view picker
 * (`src/components/database/database-view.tsx`): TABLE, BOARD, LIST, GALLERY,
 * CALENDAR, TIMELINE, CHART.
 */

/** The canonical view types, in the order a picker offers them. */
export const VIEW_TYPES = [
  "TABLE",
  "BOARD",
  "LIST",
  "GALLERY",
  "CALENDAR",
  "TIMELINE",
  "CHART",
] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

/** The view type a config with no usable `viewType` falls back to. */
export const DEFAULT_VIEW_TYPE: ViewType = "TABLE";

/** A property definition as the schema needs it: an id, plus optional type. */
export type ViewProperty = {
  id: string;
  /** Property type, e.g. `"select"`, `"date"`. Loose on purpose. */
  type?: string;
};

/**
 * A filter node, accepted loosely: a leaf condition or an `and`/`or` group.
 * The exact shape is owned by the query layer, not here, so it is treated as
 * an opaque JSON object that survives a round-trip unchanged.
 */
export type ViewFilterNode = Record<string, unknown>;

/** A sort rule; a missing/unknown direction means ascending. */
export type ViewSort = {
  propertyId: string;
  direction: "asc" | "desc";
};

/**
 * A conditional-formatting rule. Only `color` is required — a rule without one
 * paints nothing — and every other field is optional so a partially-configured
 * rule is kept rather than dropped. Field meanings match `@/lib/row-color-rules`
 * (`target` defaults to `"row"` downstream).
 */
export type ViewColorRule = {
  /** Stable id used to edit/reorder the rule. */
  id?: string;
  /** The cell a `"cell"` rule paints; ignored by `"row"` rules. */
  propertyId?: string;
  /** The rule condition, opaque to this module. */
  filter?: ViewFilterNode;
  /** Background tint name; the only required field. */
  color: string;
  /** Optional two-tone text tint name. */
  textColor?: string;
  target?: "row" | "cell";
};

/**
 * The normalized view configuration.
 *
 * `viewType` is always present (defaulting to `"TABLE"`); every other key is
 * omitted when unset, so an empty config is exactly `DEFAULT_VIEW_CONFIG`.
 */
export type ViewConfig = {
  viewType: ViewType;
  filter?: ViewFilterNode;
  sort?: ViewSort[];
  group?: string;
  hiddenPropertyIds?: string[];
  visiblePropertyIds?: string[];
  /** Per-property column widths in px, keyed by property id. */
  columnWidths?: Record<string, number>;
  rowColorRules?: ViewColorRule[];
  wrapCells?: boolean;
};

/** The config every failure path degrades to, and the zero state of a view. */
export const DEFAULT_VIEW_CONFIG: ViewConfig = Object.freeze({ viewType: DEFAULT_VIEW_TYPE });

/** Stable, machine-readable codes `validateViewConfig` reports. */
export type ViewConfigIssueCode =
  | "not_an_object"
  | "invalid_view_type"
  | "invalid_filter"
  | "invalid_sort"
  | "invalid_group"
  | "invalid_hidden_property_ids"
  | "invalid_visible_property_ids"
  | "invalid_column_widths"
  | "invalid_row_color_rules"
  | "invalid_wrap_cells";

/** One problem found by `validateViewConfig`. */
export type ViewConfigIssue = {
  /** The config key at fault, e.g. `"sort"`; empty for a whole-object error. */
  path: string;
  code: ViewConfigIssueCode;
  message: string;
};

/** A JSON object (not an array, not null), or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A trimmed non-empty string, or `undefined`. */
function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Whether `value` names one of the canonical view types. */
export function isViewType(value: unknown): value is ViewType {
  return typeof value === "string" && (VIEW_TYPES as readonly string[]).includes(value);
}

/** The known property ids, as a set, discarding blank entries. */
function knownIds(props: readonly ViewProperty[]): Set<string> {
  const ids = new Set<string>();
  for (const property of props) {
    const id = trimmedString(property?.id);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Unique, known ids from a raw list, preserving first-seen order; `undefined`
 * when nothing survives (so an empty list is omitted from the config).
 */
function normalizeIds(input: unknown, known: Set<string>): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const ids: string[] = [];
  for (const entry of input) {
    const id = trimmedString(entry);
    if (id && known.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

/** Drop sorts without a known property id; default the direction to `"asc"`; first wins. */
function normalizeSorts(input: unknown, known: Set<string>): ViewSort[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const sorts: ViewSort[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    if (!record) continue;
    const propertyId = trimmedString(record.propertyId);
    if (!propertyId || !known.has(propertyId)) continue;
    if (sorts.some((sort) => sort.propertyId === propertyId)) continue;
    sorts.push({ propertyId, direction: record.direction === "desc" ? "desc" : "asc" });
  }
  return sorts.length > 0 ? sorts : undefined;
}

/** Keep positive, finite widths for known properties only; `undefined` when none. */
function normalizeWidths(
  input: unknown,
  known: Set<string>,
): Record<string, number> | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  const widths: Record<string, number> = {};
  let count = 0;
  for (const [id, value] of Object.entries(record)) {
    if (!known.has(id)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    widths[id] = value;
    count += 1;
  }
  return count > 0 ? widths : undefined;
}

/**
 * Normalize one colour rule: keep every known field, drop unknown keys and an
 * unknown `propertyId`, and drop the rule entirely when it has no colour (a
 * colourless rule can never paint anything).
 */
function normalizeColorRule(input: unknown, known: Set<string>): ViewColorRule | null {
  const record = asRecord(input);
  if (!record) return null;
  const color = trimmedString(record.color);
  if (!color) return null;

  const rule: ViewColorRule = { color };

  const id = trimmedString(record.id);
  if (id) rule.id = id;

  const propertyId = trimmedString(record.propertyId);
  if (propertyId && known.has(propertyId)) rule.propertyId = propertyId;

  const filter = asRecord(record.filter);
  if (filter) rule.filter = { ...filter };

  const textColor = trimmedString(record.textColor);
  if (textColor) rule.textColor = textColor;

  if (record.target === "row" || record.target === "cell") rule.target = record.target;

  return rule;
}

/** Normalize a colour-rule list; `undefined` when nothing survives. */
function normalizeColorRules(
  input: unknown,
  known: Set<string>,
): ViewColorRule[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const rules: ViewColorRule[] = [];
  for (const entry of input) {
    const rule = normalizeColorRule(entry, known);
    if (rule) rules.push(rule);
  }
  return rules.length > 0 ? rules : undefined;
}

/**
 * Read a stored/patched view config into the shape this build understands.
 *
 * Tolerant by contract: a JSON string, `null`, a non-object or a malformed
 * field all resolve to a valid config — never a throw. Unknown top-level keys
 * are dropped; a `viewType` that is not one of `VIEW_TYPES` falls back to
 * `"TABLE"`; sort/group/hidden/visible/width/colour-rule references to property
 * ids the schema does not declare are dropped (so deleting a property never
 * leaves a dangling reference). The `filter` and each rule's condition are
 * opaque and copied through unchanged. Inputs are never mutated.
 */
export function normalizeViewConfig(raw: unknown, props: readonly ViewProperty[]): ViewConfig {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { viewType: DEFAULT_VIEW_TYPE };
    }
  }

  const record = asRecord(value);
  const config: ViewConfig = {
    viewType: isViewType(record?.viewType) ? record.viewType : DEFAULT_VIEW_TYPE,
  };
  if (!record) return config;

  const known = knownIds(props);

  const filter = asRecord(record.filter);
  if (filter) config.filter = { ...filter };

  const sort = normalizeSorts(record.sort, known);
  if (sort) config.sort = sort;

  const group = trimmedString(record.group);
  if (group && known.has(group)) config.group = group;

  const hidden = normalizeIds(record.hiddenPropertyIds, known);
  if (hidden) config.hiddenPropertyIds = hidden;

  const visible = normalizeIds(record.visiblePropertyIds, known);
  if (visible) config.visiblePropertyIds = visible;

  const widths = normalizeWidths(record.columnWidths, known);
  if (widths) config.columnWidths = widths;

  const rules = normalizeColorRules(record.rowColorRules, known);
  if (rules) config.rowColorRules = rules;

  if (typeof record.wrapCells === "boolean") config.wrapCells = record.wrapCells;

  return config;
}

function isIdArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => trimmedString(entry) !== undefined)
  );
}

function isSortArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      const record = asRecord(entry);
      return (
        record !== null &&
        trimmedString(record.propertyId) !== undefined &&
        (record.direction === undefined ||
          record.direction === "asc" ||
          record.direction === "desc")
      );
    })
  );
}

function isWidthRecord(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).every(
    (width) => typeof width === "number" && Number.isFinite(width) && width > 0,
  );
}

function isColorRuleArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      const record = asRecord(entry);
      if (!record) return false;
      if (trimmedString(record.color) === undefined) return false;
      if (record.id !== undefined && trimmedString(record.id) === undefined) return false;
      if (record.propertyId !== undefined && trimmedString(record.propertyId) === undefined) {
        return false;
      }
      if (record.filter !== undefined && asRecord(record.filter) === null) return false;
      if (record.textColor !== undefined && trimmedString(record.textColor) === undefined) {
        return false;
      }
      if (
        record.target !== undefined &&
        record.target !== "row" &&
        record.target !== "cell"
      ) {
        return false;
      }
      return true;
    })
  );
}

/**
 * Check a view config's shape, reporting every problem in one pass.
 *
 * This is the property-agnostic half of validation: it never throws and never
 * checks property ids (a caller with a schema runs `normalizeViewConfig` for
 * that). An empty array means the config is well-formed. Absent optional keys
 * are always valid; a `viewType` that is missing or unknown is not.
 */
export function validateViewConfig(config: unknown): ViewConfigIssue[] {
  const record = asRecord(config);
  if (!record) {
    return [
      {
        path: "",
        code: "not_an_object",
        message: "View config is not a JSON object.",
      },
    ];
  }

  const issues: ViewConfigIssue[] = [];
  const report = (path: string, code: ViewConfigIssueCode, message: string) => {
    issues.push({ path, code, message });
  };

  if (!isViewType(record.viewType)) {
    report(
      "viewType",
      "invalid_view_type",
      `viewType ${JSON.stringify(record.viewType)} is not one of the ${VIEW_TYPES.length} view types.`,
    );
  }
  if (record.filter !== undefined && asRecord(record.filter) === null) {
    report("filter", "invalid_filter", "filter must be a filter node object.");
  }
  if (record.sort !== undefined && !isSortArray(record.sort)) {
    report("sort", "invalid_sort", "sort must be a list of { propertyId, direction? }.");
  }
  if (record.group !== undefined && trimmedString(record.group) === undefined) {
    report("group", "invalid_group", "group must be a non-empty property id.");
  }
  if (record.hiddenPropertyIds !== undefined && !isIdArray(record.hiddenPropertyIds)) {
    report(
      "hiddenPropertyIds",
      "invalid_hidden_property_ids",
      "hiddenPropertyIds must be a list of non-empty property ids.",
    );
  }
  if (record.visiblePropertyIds !== undefined && !isIdArray(record.visiblePropertyIds)) {
    report(
      "visiblePropertyIds",
      "invalid_visible_property_ids",
      "visiblePropertyIds must be a list of non-empty property ids.",
    );
  }
  if (record.columnWidths !== undefined && !isWidthRecord(record.columnWidths)) {
    report(
      "columnWidths",
      "invalid_column_widths",
      "columnWidths must map property ids to positive, finite numbers.",
    );
  }
  if (record.rowColorRules !== undefined && !isColorRuleArray(record.rowColorRules)) {
    report(
      "rowColorRules",
      "invalid_row_color_rules",
      "rowColorRules must be a list of rules with a colour.",
    );
  }
  if (record.wrapCells !== undefined && typeof record.wrapCells !== "boolean") {
    report("wrapCells", "invalid_wrap_cells", "wrapCells must be a boolean.");
  }

  return issues;
}

/**
 * Layer `patch` over `base`, returning a new config.
 *
 * A patch field that is present replaces the base's value (an explicit empty
 * list clears the field); a field the patch leaves unset keeps the base's.
 * `viewType` always falls back to the base's, since it is never optional. Every
 * array and object is copied, so neither input is mutated or aliased and the
 * caller can hold the previous config in React state while computing the next.
 */
export function mergeViewConfig(base: ViewConfig, patch: Partial<ViewConfig>): ViewConfig {
  const merged: ViewConfig = { viewType: patch.viewType ?? base.viewType };

  const filter = patch.filter !== undefined ? patch.filter : base.filter;
  if (filter !== undefined) merged.filter = { ...filter };

  const sort = patch.sort !== undefined ? patch.sort : base.sort;
  if (sort !== undefined) merged.sort = sort.map((rule) => ({ ...rule }));

  const group = patch.group !== undefined ? patch.group : base.group;
  if (group !== undefined) merged.group = group;

  const hidden = patch.hiddenPropertyIds !== undefined ? patch.hiddenPropertyIds : base.hiddenPropertyIds;
  if (hidden !== undefined) merged.hiddenPropertyIds = [...hidden];

  const visible =
    patch.visiblePropertyIds !== undefined ? patch.visiblePropertyIds : base.visiblePropertyIds;
  if (visible !== undefined) merged.visiblePropertyIds = [...visible];

  const widths = patch.columnWidths !== undefined ? patch.columnWidths : base.columnWidths;
  if (widths !== undefined) merged.columnWidths = { ...widths };

  const rules = patch.rowColorRules !== undefined ? patch.rowColorRules : base.rowColorRules;
  if (rules !== undefined) {
    merged.rowColorRules = rules.map((rule) => ({
      ...rule,
      ...(rule.filter !== undefined ? { filter: { ...rule.filter } } : {}),
    }));
  }

  const wrapCells = patch.wrapCells !== undefined ? patch.wrapCells : base.wrapCells;
  if (wrapCells !== undefined) merged.wrapCells = wrapCells;

  return merged;
}
