/**
 * F9 — the formula function catalog.
 *
 * A PURE, side-effect-free description of every function the formula language
 * exposes: its `name`, `category`, human-readable `signature`, argument `arity`
 * bounds and `description`. It exists so editors, autocomplete, the function
 * picker and documentation can share ONE list instead of each re-declaring the
 * function set.
 *
 * This module is metadata only — it never evaluates anything and never imports
 * `./formula` (which owns evaluation). Names are the lowercased call names the
 * evaluator recognises, so `findFunction("ABS")` and `findFunction("abs")` are
 * deliberately the same entry.
 */

/** The buckets a function can belong to, in display order. */
export const FUNCTION_CATEGORIES = [
  "math",
  "text",
  "logic",
  "date",
  "regex",
  "list",
  "reference",
] as const;

export type FunctionCategory = (typeof FUNCTION_CATEGORIES)[number];

/**
 * Accepted argument-count bounds. `max` omitted means the function is variadic
 * (accepts `min` or more); when present, `min <= argCount <= max`.
 */
export type FunctionArity = {
  readonly min: number;
  readonly max?: number;
};

/** One catalogued formula function. */
export type FormulaFunction = {
  /** Call name, lowercased — exactly how the formula parser spells it. */
  readonly name: string;
  readonly category: FunctionCategory;
  /** Human-readable call shape, e.g. `round(value, digits?)`. */
  readonly signature: string;
  readonly arity: FunctionArity;
  /** One-line summary for pickers and tooltips. */
  readonly description: string;
};

/**
 * The single source of truth for the function library, grouped by category.
 * Declared `satisfies` so a typo in `name`/`category` is a compile error and
 * the literal types stay precise.
 */
const CATALOG = [
  // math
  {
    name: "abs",
    category: "math",
    signature: "abs(value)",
    arity: { min: 1, max: 1 },
    description: "The absolute (non-negative) value of a number.",
  },
  {
    name: "ceil",
    category: "math",
    signature: "ceil(value)",
    arity: { min: 1, max: 1 },
    description: "Rounds a number up to the nearest integer.",
  },
  {
    name: "floor",
    category: "math",
    signature: "floor(value)",
    arity: { min: 1, max: 1 },
    description: "Rounds a number down to the nearest integer.",
  },
  {
    name: "sqrt",
    category: "math",
    signature: "sqrt(value)",
    arity: { min: 1, max: 1 },
    description: "The square root of a non-negative number.",
  },
  {
    name: "pow",
    category: "math",
    signature: "pow(base, exponent)",
    arity: { min: 2, max: 2 },
    description: "Raises a base to an exponent.",
  },
  {
    name: "round",
    category: "math",
    signature: "round(value, digits?)",
    arity: { min: 1, max: 2 },
    description: "Rounds a number, optionally to a number of decimal digits.",
  },
  {
    name: "min",
    category: "math",
    signature: "min(value, ...)",
    arity: { min: 1 },
    description: "The smallest of one or more numbers.",
  },
  {
    name: "max",
    category: "math",
    signature: "max(value, ...)",
    arity: { min: 1 },
    description: "The largest of one or more numbers.",
  },

  // text
  {
    name: "concat",
    category: "text",
    signature: "concat(value, ...)",
    arity: { min: 1 },
    description: "Joins one or more values into a single string.",
  },
  {
    name: "length",
    category: "text",
    signature: "length(value)",
    arity: { min: 1, max: 1 },
    description: "The number of characters in a string (or items in a list).",
  },
  {
    name: "upper",
    category: "text",
    signature: "upper(text)",
    arity: { min: 1, max: 1 },
    description: "Converts a string to upper case.",
  },
  {
    name: "lower",
    category: "text",
    signature: "lower(text)",
    arity: { min: 1, max: 1 },
    description: "Converts a string to lower case.",
  },
  {
    name: "trim",
    category: "text",
    signature: "trim(text)",
    arity: { min: 1, max: 1 },
    description: "Removes leading and trailing whitespace.",
  },
  {
    name: "contains",
    category: "text",
    signature: "contains(text, search)",
    arity: { min: 2, max: 2 },
    description: "Whether a string contains a search string (case-insensitive).",
  },
  {
    name: "empty",
    category: "text",
    signature: "empty(value)",
    arity: { min: 1, max: 1 },
    description: "Whether a value is blank.",
  },
  {
    name: "slice",
    category: "text",
    signature: "slice(text, start, end?)",
    arity: { min: 2, max: 3 },
    description: "Extracts a substring from a start index to an optional end.",
  },

  // logic
  {
    name: "if",
    category: "logic",
    signature: "if(condition, then, else)",
    arity: { min: 3, max: 3 },
    description: "Picks the then or else branch based on a condition.",
  },
  {
    name: "ifs",
    category: "logic",
    signature: "ifs(condition, value, ..., fallback?)",
    arity: { min: 2 },
    description: "Returns the value for the first true condition, with a fallback.",
  },

  // date
  {
    name: "date",
    category: "date",
    signature: "date(value)",
    arity: { min: 1, max: 1 },
    description: "Parses a value into a UTC ISO date string.",
  },
  {
    name: "dateadd",
    category: "date",
    signature: "dateadd(date, amount, unit)",
    arity: { min: 3, max: 3 },
    description: "Adds a number of days, weeks, months, years, hours or minutes.",
  },
  {
    name: "datesubtract",
    category: "date",
    signature: "datesubtract(date, amount, unit)",
    arity: { min: 3, max: 3 },
    description: "Subtracts a number of days, weeks, months, years, hours or minutes.",
  },
  {
    name: "datebetween",
    category: "date",
    signature: "datebetween(later, earlier, unit)",
    arity: { min: 3, max: 3 },
    description: "Whole units between two dates.",
  },
  {
    name: "formatdate",
    category: "date",
    signature: "formatdate(date, pattern)",
    arity: { min: 2, max: 2 },
    description: "Formats a date in UTC using YYYY/MM/DD/HH/mm/ss tokens.",
  },

  // regex
  {
    name: "match",
    category: "regex",
    signature: "match(text, pattern)",
    arity: { min: 2, max: 2 },
    description: "Whether a regular expression matches a string.",
  },
  {
    name: "replace",
    category: "regex",
    signature: "replace(text, pattern, replacement)",
    arity: { min: 3, max: 3 },
    description: "Replaces every regular-expression match in a string.",
  },
  {
    name: "extract",
    category: "regex",
    signature: "extract(text, pattern)",
    arity: { min: 2, max: 2 },
    description: "Extracts regular-expression matches into a list.",
  },

  // list
  {
    name: "sort",
    category: "list",
    signature: "sort(list)",
    arity: { min: 1, max: 1 },
    description: "Sorts a list into a deterministic order.",
  },
  {
    name: "join",
    category: "list",
    signature: "join(list, separator?)",
    arity: { min: 1, max: 2 },
    description: "Joins a list into a string with an optional separator.",
  },
  {
    name: "map",
    category: "list",
    signature: "map(list, expression)",
    arity: { min: 2, max: 2 },
    description: "Transforms every item of a list with an expression.",
  },
  {
    name: "filter",
    category: "list",
    signature: "filter(list, expression)",
    arity: { min: 2, max: 2 },
    description: "Keeps the list items for which an expression is true.",
  },

  // reference
  {
    name: "prop",
    category: "reference",
    signature: "prop(name)",
    arity: { min: 1, max: 1 },
    description: "Reads another column's value by name.",
  },
] as const satisfies readonly FormulaFunction[];

/**
 * The catalog in its public shape. Exported as `readonly FormulaFunction[]` so
 * every entry uniformly exposes an optional `arity.max`; the `satisfies` above
 * still type-checks each literal against `FormulaFunction`.
 */
export const FORMULA_FUNCTIONS: readonly FormulaFunction[] = CATALOG;

/** Case-insensitive lookup, or `undefined` for an unknown name. */
export function findFunction(name: string): FormulaFunction | undefined {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  return FORMULA_FUNCTIONS.find((entry) => entry.name === needle);
}

export type SearchFunctionsOptions = {
  /** Maximum number of results; omitted means no cap, `<= 0` means none. */
  limit?: number;
};

/** Locale-independent name ordering so ties are fully stable. */
function compareNames(left: FormulaFunction, right: FormulaFunction): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/**
 * Match quality: lower is better. `0` name prefix, `1` name substring, `2`
 * description substring. `null` means no match.
 */
function matchTier(entry: FormulaFunction, query: string): 0 | 1 | 2 | null {
  const name = entry.name;
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (entry.description.toLowerCase().includes(query)) return 2;
  return null;
}

/**
 * Search the catalog. An empty query returns the catalog in its declared order;
 * otherwise matches are ranked name-prefix → name-substring → description, with
 * names as a stable tiebreak. `limit` caps the result (and is applied after
 * ranking). The query is trimmed and matched case-insensitively.
 */
export function searchFunctions(
  query: string,
  options: SearchFunctionsOptions = {},
): FormulaFunction[] {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit <= 0) return [];

  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return FORMULA_FUNCTIONS.slice(0, limit);

  const scored: { entry: FormulaFunction; tier: number }[] = [];
  for (const entry of FORMULA_FUNCTIONS) {
    const tier = matchTier(entry, needle);
    if (tier !== null) scored.push({ entry, tier });
  }
  scored.sort((left, right) => left.tier - right.tier || compareNames(left.entry, right.entry));
  return scored.slice(0, limit).map((scoredEntry) => scoredEntry.entry);
}

/**
 * Name completions for a prefix, alphabetically. An empty prefix returns every
 * name. Matching is case-insensitive; unknown prefixes return `[]`.
 */
export function suggestFunctions(prefix: string): string[] {
  const needle = prefix.trim().toLowerCase();
  return FORMULA_FUNCTIONS.filter((entry) => entry.name.startsWith(needle))
    .map((entry) => entry.name)
    .sort();
}

/** Wording for an arity bound, e.g. `exactly 3`, `1 to 2`, `at least 1`. */
function describeArity(arity: FunctionArity): string {
  const { min, max } = arity;
  if (max === undefined) return `at least ${min}`;
  if (min === max) return `exactly ${min}`;
  return `${min} to ${max}`;
}

export type CallValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a call's argument count against the catalog. Returns `{ ok: true }`
 * for a known function called with an acceptable number of arguments, or
 * `{ ok: false, error }` for an unknown function or an arity mismatch. Lookup
 * is case-insensitive; never throws.
 */
export function validateCall(name: string, argCount: number): CallValidation {
  const entry = findFunction(name);
  if (!entry) return { ok: false, error: `unknown function '${name}'` };

  const { min, max } = entry.arity;
  if (argCount < min || (max !== undefined && argCount > max)) {
    return {
      ok: false,
      error: `'${entry.name}' expects ${describeArity(entry.arity)} argument(s), received ${argCount}`,
    };
  }
  return { ok: true };
}
