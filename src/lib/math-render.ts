/**
 * LaTeX / KaTeX support engine - the pure, DB-free core behind the math
 * editor's inline and block equations (docs/MISSING_FEATURES math support:
 * "KaTeX/LaTeX support", "Inline equation", "Block equation"; the feature
 * matrix notes "macro support limited").
 *
 * Nothing here renders and nothing here evaluates TeX. The engine only does
 * the safe, structural work a renderer host needs before it ever hands a
 * string to KaTeX:
 *
 *  - {@link expandMacros} applies user-defined `\newcommand`-style macros with
 *    a bounded recursion depth and a cycle guard, so a malicious or fat-fingered
 *    definition such as `\a -> \a` (or a mutually recursive pair) terminates.
 *  - {@link parseMath} builds a small structural tree (groups, commands,
 *    superscripts/subscripts, `\begin`/`\end` environments with matrix/align
 *    rows and cells) without evaluating anything.
 *  - {@link validateLatex} reports unbalanced braces and environments, unknown
 *    environments, and banned commands (`\write18`, `\input`, `\include`).
 *  - {@link restrictCommands} strips those banned commands (and their
 *    arguments) before rendering.
 *  - {@link toKatexInput} turns an editable string into the exact `latex` +
 *    `displayMode` pair to hand to a renderer.
 *  - {@link splitMathText} splits mixed prose/inline-math text into runs.
 *  - {@link describeMath} summarizes an equation (symbols, commands,
 *    environments, features) for tooltips and accessibility.
 *
 * Pure, side-effect free, and safe over input of unknown provenance: malformed
 * nodes are tolerated and the functions never throw.
 */

/* ------------------------------------------------------------------ macros */

/** A map of macro name (with or without a leading backslash) to its body. */
export type MathMacroMap = Readonly<Record<string, string>>;

/** Options for {@link expandMacros}. */
export type ExpandMacrosOptions = {
  /** User-defined macros, `\newcommand`-style; `#1`..`#9` are parameters. */
  macros?: MathMacroMap;
  /** Maximum expansion depth before expansion stops; defaults to 20. */
  maxDepth?: number;
};

/** Result of {@link expandMacros}. */
export type MacroExpansion = {
  /** The latex with every resolvable macro expanded. */
  latex: string;
  /** Names of the macros that were applied, in first-use order. */
  applied: string[];
  /** Names that were left in place because they expanded into themselves. */
  cycles: string[];
  /** Whether expansion stopped early at the depth bound. */
  depthExceeded: boolean;
};

/** Default recursion bound used by {@link expandMacros}. */
export const DEFAULT_MAX_MACRO_DEPTH = 20;

type MacroDef = { body: string; arity: number };

function readCommandAt(source: string, index: number): { name: string; end: number } {
  let j = index + 1;
  if (j >= source.length) return { name: "", end: j };
  const ch = source.charAt(j);
  if (/[A-Za-z]/.test(ch)) {
    while (j < source.length && /[A-Za-z]/.test(source.charAt(j))) j++;
    return { name: source.slice(index + 1, j), end: j };
  }
  return { name: ch, end: j + 1 };
}

function skipWhitespace(source: string, index: number): number {
  let i = index;
  while (i < source.length && /\s/.test(source.charAt(i))) i++;
  return i;
}

/** Index just past the brace group opened at `open`, or the end of the string. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

function normalizeMacroName(name: string): string {
  return name.startsWith("\\") ? name.slice(1) : name;
}

function arityOf(body: string): number {
  let max = 0;
  const matcher = /#([1-9])/g;
  let match = matcher.exec(body);
  while (match !== null) {
    max = Math.max(max, Number(match[1]));
    match = matcher.exec(body);
  }
  return max;
}

/**
 * Pull `\newcommand` / `\renewcommand` / `\providecommand` / `\def`
 * definitions out of the source, returning the table they describe and the
 * source with those definitions removed.
 */
function parseInlineDefinitions(source: string): { table: Map<string, MacroDef>; rest: string } {
  const table = new Map<string, MacroDef>();
  let out = "";
  let i = 0;

  while (i < source.length) {
    if (source.charAt(i) !== "\\") {
      out += source.charAt(i);
      i++;
      continue;
    }

    const cmd = readCommandAt(source, i);
    const isNew = cmd.name === "newcommand" || cmd.name === "renewcommand" || cmd.name === "providecommand";
    const isDef = cmd.name === "def";

    if (!isNew && !isDef) {
      out += source.slice(i, cmd.end);
      i = cmd.end;
      continue;
    }

    let j = skipWhitespace(source, cmd.end);
    let name = "";

    if (isNew) {
      if (source.charAt(j) === "{") {
        const end = matchingBrace(source, j);
        name = source.slice(j + 1, end);
        j = end + 1;
      } else if (source.charAt(j) === "\\") {
        const named = readCommandAt(source, j);
        name = named.name;
        j = named.end;
      }
    } else if (source.charAt(j) === "\\") {
      const named = readCommandAt(source, j);
      name = named.name;
      j = named.end;
    }

    name = normalizeMacroName(name.trim());
    j = skipWhitespace(source, j);

    let arity = 0;
    if (isNew && source.charAt(j) === "[") {
      const end = source.indexOf("]", j + 1);
      const raw = end === -1 ? source.slice(j + 1) : source.slice(j + 1, end);
      arity = Number.parseInt(raw.trim(), 10) || 0;
      j = end === -1 ? source.length : end + 1;
      j = skipWhitespace(source, j);
    }

    let body = "";
    if (source.charAt(j) === "{") {
      const end = matchingBrace(source, j);
      body = source.slice(j + 1, end);
      j = end + 1;
    }

    if (name !== "") table.set(name, { body, arity: arity || arityOf(body) });
    i = j;
  }

  return { table, rest: out };
}

/**
 * Apply user-defined macros to `latex`.
 *
 * Macros may be supplied via `options.macros` and/or declared inline with
 * `\newcommand`/`\renewcommand`/`\providecommand`/`\def`. Expansion is
 * recursive but bounded by `maxDepth` and guarded against cycles: a macro that
 * expands into itself (directly or indirectly) is left untouched and reported
 * in {@link MacroExpansion.cycles}. Never throws.
 */
export function expandMacros(latex: string, options: ExpandMacrosOptions = {}): MacroExpansion {
  const source = typeof latex === "string" ? latex : "";
  const requested = options.maxDepth;
  const maxDepth =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : DEFAULT_MAX_MACRO_DEPTH;

  const table = new Map<string, MacroDef>();
  const provided = options.macros;
  if (provided !== undefined) {
    for (const key of Object.keys(provided)) {
      const body = provided[key];
      if (typeof body === "string") table.set(normalizeMacroName(key), { body, arity: arityOf(body) });
    }
  }

  const inline = parseInlineDefinitions(source);
  for (const [name, def] of inline.table) table.set(name, def);

  const appliedSet = new Set<string>();
  const applied: string[] = [];
  const cycles: string[] = [];
  let depthExceeded = false;

  const expand = (input: string, depth: number, active: ReadonlySet<string>): string => {
    let out = "";
    let i = 0;

    while (i < input.length) {
      if (input.charAt(i) !== "\\") {
        out += input.charAt(i);
        i++;
        continue;
      }

      const cmd = readCommandAt(input, i);
      const def = table.get(cmd.name);
      if (def === undefined) {
        out += input.slice(i, cmd.end);
        i = cmd.end;
        continue;
      }
      if (active.has(cmd.name)) {
        if (!cycles.includes(cmd.name)) cycles.push(cmd.name);
        out += input.slice(i, cmd.end);
        i = cmd.end;
        continue;
      }
      if (depth >= maxDepth) {
        depthExceeded = true;
        out += input.slice(i, cmd.end);
        i = cmd.end;
        continue;
      }

      let j = cmd.end;
      const args: string[] = [];
      for (let k = 0; k < def.arity; k++) {
        j = skipWhitespace(input, j);
        if (input.charAt(j) === "{") {
          const end = matchingBrace(input, j);
          args.push(input.slice(j + 1, end));
          j = end + 1;
        } else if (j < input.length) {
          const token = input.charAt(j) === "\\" ? readCommandAt(input, j) : { name: "", end: j + 1 };
          args.push(input.slice(j, token.end));
          j = token.end;
        } else {
          args.push("");
        }
      }

      let body = def.body;
      for (let k = 0; k < def.arity; k++) {
        body = body.split(`#${k + 1}`).join(expand(args[k] ?? "", depth + 1, active));
      }

      if (!appliedSet.has(cmd.name)) {
        appliedSet.add(cmd.name);
        applied.push(cmd.name);
      }

      const nextActive = new Set(active);
      nextActive.add(cmd.name);
      out += expand(body, depth + 1, nextActive);
      i = j;
    }

    return out;
  };

  return { latex: expand(inline.rest, 0, new Set<string>()), applied, cycles, depthExceeded };
}

/* -------------------------------------------------------------- structures */

/** A plain text run inside math. */
export type MathTextNode = { type: "text"; value: string };

/** A `\command`, with its optional `[...]` and braced `{...}` arguments. */
export type MathCommandNode = {
  type: "command";
  name: string;
  args: MathNode[][];
  optional: MathNode[][];
};

/** A `{ ... }` group. */
export type MathGroupNode = { type: "group"; children: MathNode[] };

/** A `^`/`_` script attached to the preceding base (or `null` for a bare script). */
export type MathScriptNode = {
  type: "script";
  kind: "sup" | "sub";
  base: MathNode | null;
  argument: MathNode[];
};

/** One `&`-separated cell of an environment row. */
export type MathCellNode = { type: "cell"; children: MathNode[] };

/** One `\\`-separated row of an environment. */
export type MathRowNode = { type: "row"; cells: MathCellNode[] };

/** A `\begin{...}` ... `\end{...}` environment such as a matrix or align. */
export type MathEnvironmentNode = {
  type: "environment";
  name: string;
  rows: MathRowNode[];
  children: MathNode[];
};

/** One structural node of a parsed equation. */
export type MathNode =
  | MathTextNode
  | MathCommandNode
  | MathGroupNode
  | MathScriptNode
  | MathEnvironmentNode;

/** A parse error, anchored to the offset that caused it. */
export type MathParseError = { message: string; index: number };

/** Result of {@link parseMath}. */
export type MathParseResult = {
  ok: boolean;
  errors: MathParseError[];
  nodes: MathNode[];
};

/** Environments the engine understands (matrix family + alignment + cases). */
export const KNOWN_ENVIRONMENTS: readonly string[] = [
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "array",
  "cases",
  "align",
  "align*",
  "aligned",
  "gather",
  "gathered",
  "split",
  "equation",
  "equation*",
];

/** Commands that are never allowed through to a renderer. */
export const BANNED_COMMANDS: readonly string[] = ["write18", "input", "include"];

function normalizeNode(node: MathNode): MathNode {
  switch (node.type) {
    case "text":
      return node;
    case "command":
      return {
        type: "command",
        name: node.name,
        args: node.args.map(normalizeNodes),
        optional: node.optional.map(normalizeNodes),
      };
    case "group":
      return { type: "group", children: normalizeNodes(node.children) };
    case "script":
      return {
        type: "script",
        kind: node.kind,
        base: node.base === null ? null : normalizeNode(node.base),
        argument: normalizeNodes(node.argument),
      };
    case "environment": {
      const rows: MathRowNode[] = node.rows.map((row) => ({
        type: "row",
        cells: row.cells.map((cell) => ({ type: "cell", children: normalizeNodes(cell.children) })),
      }));
      return { type: "environment", name: node.name, rows, children: normalizeNodes(node.children) };
    }
  }
}

/** Merge adjacent text nodes so `abc` is one node rather than three. */
function normalizeNodes(nodes: readonly MathNode[]): MathNode[] {
  const out: MathNode[] = [];
  for (const node of nodes) {
    const fixed = normalizeNode(node);
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (fixed.type === "text" && last !== undefined && last.type === "text") {
      out[out.length - 1] = { type: "text", value: last.value + fixed.value };
      continue;
    }
    out.push(fixed);
  }
  return out;
}

/**
 * Structurally parse a TeX fragment without evaluating it.
 *
 * Recognizes groups, commands (with optional and braced arguments),
 * superscripts/subscripts bound to their base, and `\begin`/`\end`
 * environments whose bodies are split into `\\` rows and `&` cells. Never
 * throws; malformed input is reported through {@link MathParseResult.errors}
 * while still returning the structure recovered so far.
 */
export function parseMath(latex: string): MathParseResult {
  const source = typeof latex === "string" ? latex : "";
  const errors: MathParseError[] = [];
  let pos = 0;

  function skipSpaces(): void {
    while (pos < source.length && /\s/.test(source.charAt(pos))) pos++;
  }

  function groupText(nodes: readonly MathNode[]): string {
    let text = "";
    for (const node of nodes) if (node.type === "text") text += node.value;
    return text.trim();
  }

  function readBraceGroup(): MathNode[] {
    const open = pos;
    pos++;
    const children = parseNodes(false);
    if (pos < source.length && source.charAt(pos) === "}") pos++;
    else errors.push({ message: "Unterminated group", index: open });
    return children;
  }

  function readOptionalArgs(): MathNode[][] {
    const out: MathNode[][] = [];
    for (;;) {
      skipSpaces();
      if (pos >= source.length || source.charAt(pos) !== "[") break;
      const open = pos;
      pos++;
      const start = pos;
      let depth = 0;
      while (pos < source.length && !(source.charAt(pos) === "]" && depth === 0)) {
        const ch = source.charAt(pos);
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        pos++;
      }
      const raw = source.slice(start, pos).trim();
      if (pos < source.length) pos++;
      else errors.push({ message: "Unterminated optional argument", index: open });
      out.push(raw === "" ? [] : [{ type: "text", value: raw }]);
    }
    return out;
  }

  function readBraceArgs(): MathNode[][] {
    const out: MathNode[][] = [];
    for (;;) {
      skipSpaces();
      if (pos >= source.length || source.charAt(pos) !== "{") break;
      out.push(readBraceGroup());
    }
    return out;
  }

  function readScriptArgument(): MathNode[] {
    skipSpaces();
    if (pos >= source.length) return [];
    const ch = source.charAt(pos);
    if (ch === "{") return readBraceGroup();
    if (ch === "\\") {
      const cmd = readCommandAt(source, pos);
      if (cmd.name === "begin") return [parseEnvironment()];
      pos = cmd.end;
      const optional = readOptionalArgs();
      const args = readBraceArgs();
      return [{ type: "command", name: cmd.name, args, optional }];
    }
    pos++;
    return [{ type: "text", value: ch }];
  }

  function parseEnvironment(): MathNode {
    const beginPos = pos;
    const begin = readCommandAt(source, pos);
    pos = begin.end;
    skipSpaces();

    let name = "";
    if (pos < source.length && source.charAt(pos) === "{") {
      name = groupText(readBraceGroup());
    } else {
      errors.push({ message: "Missing environment name after \\begin", index: beginPos });
    }

    const rows: MathRowNode[] = [];
    let cells: MathCellNode[] = [];
    let current: MathNode[] = [];

    const pushCell = (): void => {
      cells.push({ type: "cell", children: current });
      current = [];
    };
    const pushRow = (): void => {
      pushCell();
      rows.push({ type: "row", cells });
      cells = [];
    };

    for (;;) {
      skipSpaces();
      if (pos >= source.length) {
        errors.push({ message: `Unclosed environment "${name}"`, index: beginPos });
        break;
      }

      if (source.charAt(pos) === "\\") {
        const cmd = readCommandAt(source, pos);
        if (cmd.name === "end") {
          const endPos = pos;
          pos = cmd.end;
          skipSpaces();
          let endName = "";
          if (pos < source.length && source.charAt(pos) === "{") endName = groupText(readBraceGroup());
          if (endName !== name) {
            errors.push({ message: `Environment "${name}" closed by "${endName}"`, index: endPos });
          }
          break;
        }
        if (cmd.name === "\\") {
          pos = cmd.end;
          pushRow();
          continue;
        }
      }

      if (source.charAt(pos) === "&") {
        pos++;
        pushCell();
        continue;
      }

      const before = pos;
      const sub = parseNodes(true);
      if (pos === before) {
        if (source.charAt(pos) === "}") {
          errors.push({ message: "Unexpected `}`", index: pos });
        }
        pos++;
        continue;
      }
      current.push(...sub);
    }

    pushRow();
    const children = rows.flatMap((row) => row.cells.flatMap((cell) => cell.children));
    return { type: "environment", name, rows, children };
  }

  function parseNodes(rowAware: boolean): MathNode[] {
    const nodes: MathNode[] = [];
    for (;;) {
      skipSpaces();
      if (pos >= source.length) break;
      const ch = source.charAt(pos);
      if (ch === "}") break;
      if (rowAware && ch === "&") break;

      if (ch === "{") {
        nodes.push({ type: "group", children: readBraceGroup() });
        continue;
      }

      if (ch === "\\") {
        if (rowAware && source.charAt(pos + 1) === "\\") break;
        const cmd = readCommandAt(source, pos);
        if (cmd.name === "end") break;
        if (cmd.name === "begin") {
          nodes.push(parseEnvironment());
          continue;
        }
        pos = cmd.end;
        const optional = readOptionalArgs();
        const args = readBraceArgs();
        nodes.push({ type: "command", name: cmd.name, args, optional });
        continue;
      }

      if (ch === "^" || ch === "_") {
        const base = nodes.length > 0 ? nodes.pop() ?? null : null;
        pos++;
        nodes.push({ type: "script", kind: ch === "^" ? "sup" : "sub", base, argument: readScriptArgument() });
        continue;
      }

      pos++;
      nodes.push({ type: "text", value: ch });
    }
    return nodes;
  }

  const top = parseNodes(false);
  for (;;) {
    skipSpaces();
    if (pos >= source.length) break;
    const ch = source.charAt(pos);
    if (ch === "}") {
      errors.push({ message: "Unexpected `}`", index: pos });
      pos++;
      continue;
    }
    if (ch === "\\") {
      const cmd = readCommandAt(source, pos);
      if (cmd.name === "end") {
        const endPos = pos;
        pos = cmd.end;
        skipSpaces();
        let endName = "";
        if (pos < source.length && source.charAt(pos) === "{") endName = groupText(readBraceGroup());
        errors.push({ message: `Unexpected \\end{${endName}}`, index: endPos });
        continue;
      }
    }
    const before = pos;
    const sub = parseNodes(false);
    if (pos === before) {
      pos++;
      continue;
    }
    top.push(...sub);
  }

  return { ok: errors.length === 0, errors, nodes: normalizeNodes(top) };
}

/* -------------------------------------------------------------- validation */

/** Machine code identifying why a fragment was rejected. */
export type MathIssueCode =
  | "unbalanced-brace"
  | "unclosed-environment"
  | "unexpected-environment-end"
  | "unknown-environment"
  | "banned-command";

/** One validation finding, anchored to the offset that caused it. */
export type MathIssue = { code: MathIssueCode; message: string; index: number };

/**
 * Validate a TeX fragment. Reports unbalanced braces, unbalanced or mismatched
 * environments, unknown environments, and banned commands. Never throws.
 */
export function validateLatex(latex: string): MathIssue[] {
  const source = typeof latex === "string" ? latex : "";
  const issues: MathIssue[] = [];

  for (const name of BANNED_COMMANDS) {
    const matcher = new RegExp(`\\\\${name}(?![A-Za-z0-9])`, "g");
    let match = matcher.exec(source);
    while (match !== null) {
      issues.push({
        code: "banned-command",
        message: `Command \\${name} is not allowed`,
        index: match.index,
      });
      match = matcher.exec(source);
    }
  }

  const braces: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i = readCommandAt(source, i).end - 1;
      continue;
    }
    if (ch === "{") braces.push(i);
    else if (ch === "}") {
      if (braces.length === 0) {
        issues.push({ code: "unbalanced-brace", message: "Unexpected `}`", index: i });
      } else {
        braces.pop();
      }
    }
  }
  for (const open of braces) {
    issues.push({ code: "unbalanced-brace", message: "Unclosed `{`", index: open });
  }

  const environments: { name: string; index: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source.charAt(i) !== "\\") continue;
    const cmd = readCommandAt(source, i);
    if (cmd.name !== "begin" && cmd.name !== "end") {
      i = cmd.end - 1;
      continue;
    }

    const cmdIndex = i;
    let j = skipWhitespace(source, cmd.end);
    let name = "";
    if (source.charAt(j) === "{") {
      const end = matchingBrace(source, j);
      name = source.slice(j + 1, end).trim();
      j = end;
    }
    i = j;

    if (cmd.name === "begin") {
      if (!KNOWN_ENVIRONMENTS.includes(name)) {
        issues.push({ code: "unknown-environment", message: `Unknown environment "${name}"`, index: cmdIndex });
      }
      environments.push({ name, index: cmdIndex });
    } else {
      const top = environments.length > 0 ? environments[environments.length - 1] : undefined;
      if (top === undefined) {
        issues.push({
          code: "unexpected-environment-end",
          message: `Unexpected \\end{${name}}`,
          index: cmdIndex,
        });
      } else if (top.name !== name) {
        issues.push({
          code: "unclosed-environment",
          message: `Environment "${top.name}" closed by "${name}"`,
          index: cmdIndex,
        });
        environments.pop();
      } else {
        environments.pop();
      }
    }
  }
  for (const env of environments) {
    issues.push({
      code: "unclosed-environment",
      message: `Unclosed environment "${env.name}"`,
      index: env.index,
    });
  }

  return issues.sort((a, b) => a.index - b.index);
}

/** Index just past the bracket group opened at `open`, or the end of the string. */
function skipBracket(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/** Index just past the brace group opened at `open`, or the end of the string. */
function skipBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * Match a banned command literally at `index`, returning its end offset (just
 * past the command token) or `null`. Uses literal matching because a name such
 * as `write18` ends in digits, which a TeX command scanner would read as
 * separate tokens.
 */
function matchBannedAt(source: string, index: number): { name: string; end: number } | null {
  for (const name of BANNED_COMMANDS) {
    const token = `\\${name}`;
    if (!source.startsWith(token, index)) continue;
    const after = source.charAt(index + token.length);
    if (/[A-Za-z0-9]/.test(after)) continue;
    return { name, end: index + token.length };
  }
  return null;
}

/**
 * Return `latex` with every banned command removed. A removed command also
 * takes any immediately following optional `[...]` and braced `{...}`
 * arguments with it, so `\input{secret}` leaves nothing behind. Never throws.
 */
export function restrictCommands(latex: string): string {
  const source = typeof latex === "string" ? latex : "";
  let out = "";
  let i = 0;

  while (i < source.length) {
    if (source.charAt(i) !== "\\") {
      out += source.charAt(i);
      i++;
      continue;
    }

    const banned = matchBannedAt(source, i);
    if (banned === null) {
      const cmd = readCommandAt(source, i);
      out += source.slice(i, cmd.end);
      i = cmd.end;
      continue;
    }

    let j = banned.end;
    for (;;) {
      const k = skipWhitespace(source, j);
      if (source.charAt(k) === "[") {
        j = skipBracket(source, k);
        continue;
      }
      if (source.charAt(k) === "{") {
        j = skipBrace(source, k);
        continue;
      }
      break;
    }
    i = j;
  }

  return out;
}

/* ------------------------------------------------------------- toKatexInput */

/** Options for {@link toKatexInput}. */
export type KatexInputOptions = {
  /** User-defined macros applied before the string is emitted. */
  macros?: MathMacroMap;
  /** Maximum macro expansion depth. */
  maxDepth?: number;
};

/** The exact string and mode to hand to a KaTeX renderer. */
export type KatexInput = { latex: string; displayMode: boolean };

function detectDisplayMode(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.length >= 4 && trimmed.startsWith("$$") && trimmed.endsWith("$$")) return true;
  if (trimmed.length >= 4 && trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) return true;
  return false;
}

/**
 * Turn an editable math string into the final `latex` plus `displayMode` to
 * hand to a renderer. Strips `$...$`/`$$...$$`/`\(...\)`/`\[...\]` delimiters,
 * expands macros, and strips banned commands. Never throws.
 */
export function toKatexInput(latex: string, options: KatexInputOptions = {}): KatexInput {
  const source = typeof latex === "string" ? latex.trim() : "";
  let body = source;
  let displayMode = false;

  if (source.length >= 4 && source.startsWith("$$") && source.endsWith("$$")) {
    body = source.slice(2, -2);
    displayMode = true;
  } else if (source.length >= 4 && source.startsWith("\\[") && source.endsWith("\\]")) {
    body = source.slice(2, -2);
    displayMode = true;
  } else if (source.length >= 4 && source.startsWith("\\(") && source.endsWith("\\)")) {
    body = source.slice(2, -2);
  } else if (source.length >= 2 && source.startsWith("$") && source.endsWith("$")) {
    body = source.slice(1, -1);
  }

  const expanded = expandMacros(body, { macros: options.macros, maxDepth: options.maxDepth });
  return { latex: restrictCommands(expanded.latex).trim(), displayMode };
}

/* ------------------------------------------------------------ splitMathText */

/** One run of mixed text/inline-math content. */
export type MathTextRun = { type: "text" | "math"; value: string; displayMode: boolean };

/**
 * Split a string (or an array of raw runs) into alternating text and math
 * runs. Recognizes `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`; a `\$` escape
 * is kept as literal text. An unterminated delimiter is treated as text, so
 * the function never throws mid-edit.
 */
export function splitMathText(input: string | readonly string[]): MathTextRun[] {
  const source = Array.isArray(input) ? input.join("") : typeof input === "string" ? input : "";
  const runs: MathTextRun[] = [];
  let text = "";

  const flush = (): void => {
    if (text !== "") {
      runs.push({ type: "text", value: text, displayMode: false });
      text = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);

    if (ch === "\\" && (source.charAt(i + 1) === "(" || source.charAt(i + 1) === "[")) {
      const displayMode = source.charAt(i + 1) === "[";
      const close = displayMode ? "\\]" : "\\)";
      const end = source.indexOf(close, i + 2);
      if (end === -1) {
        text += source.slice(i);
        break;
      }
      flush();
      runs.push({ type: "math", value: source.slice(i + 2, end), displayMode });
      i = end + 2;
      continue;
    }

    if (ch === "\\") {
      text += source.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "$") {
      if (source.charAt(i + 1) === "$") {
        const end = source.indexOf("$$", i + 2);
        if (end === -1) {
          text += source.slice(i);
          break;
        }
        flush();
        runs.push({ type: "math", value: source.slice(i + 2, end), displayMode: true });
        i = end + 2;
        continue;
      }
      const end = source.indexOf("$", i + 1);
      if (end === -1) {
        text += source.slice(i);
        break;
      }
      flush();
      runs.push({ type: "math", value: source.slice(i + 1, end), displayMode: false });
      i = end + 1;
      continue;
    }

    text += ch;
    i++;
  }

  flush();
  return runs;
}

/* -------------------------------------------------------------- describeMath */

/** A human-oriented summary of an equation. */
export type MathDescription = {
  /** The original latex, unchanged. */
  latex: string;
  /** Whether the source carried block (`$$`/`\[`) delimiters. */
  displayMode: boolean;
  /** Whether the fragment holds no symbols, commands, or environments. */
  empty: boolean;
  /** Number of leaf symbols (text characters plus commands). */
  symbolCount: number;
  /** Command names in first-seen order (without the leading backslash). */
  commands: string[];
  /** Environment names in first-seen order. */
  environments: string[];
  hasSuperscript: boolean;
  hasSubscript: boolean;
  hasFraction: boolean;
  hasMatrix: boolean;
  hasAlignment: boolean;
  /** Maximum structural nesting depth reached. */
  maxDepth: number;
  /** One-line English summary for tooltips and accessibility. */
  summary: string;
};

type SummaryInput = {
  empty: boolean;
  displayMode: boolean;
  symbolCount: number;
  commands: string[];
  environments: string[];
  hasSuperscript: boolean;
  hasSubscript: boolean;
  hasFraction: boolean;
  hasMatrix: boolean;
  hasAlignment: boolean;
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function buildMathSummary(input: SummaryInput): string {
  if (input.empty) return "empty math";
  const parts: string[] = [input.displayMode ? "block math" : "inline math"];
  parts.push(plural(input.symbolCount, "symbol"));
  if (input.commands.length > 0) {
    parts.push(`${plural(input.commands.length, "command")} (${input.commands.map((c) => `\\${c}`).join(", ")})`);
  }
  if (input.environments.length > 0) {
    parts.push(`${plural(input.environments.length, "environment")} (${input.environments.join(", ")})`);
  }
  const features: string[] = [];
  if (input.hasSuperscript) features.push("superscript");
  if (input.hasSubscript) features.push("subscript");
  if (input.hasFraction) features.push("fraction");
  if (input.hasMatrix) features.push("matrix");
  if (input.hasAlignment) features.push("alignment");
  if (features.length > 0) parts.push(features.join(", "));
  return parts.join("; ");
}

/**
 * Summarize an equation for tooltips and accessibility: symbol and command
 * counts, environments, structural features, and a one-line description.
 * Never throws.
 */
export function describeMath(latex: string): MathDescription {
  const source = typeof latex === "string" ? latex : "";
  const parsed = parseMath(source);
  const displayMode = detectDisplayMode(source);

  const commands: string[] = [];
  const environments: string[] = [];
  let symbolCount = 0;
  let hasSuperscript = false;
  let hasSubscript = false;
  let hasFraction = false;
  let hasMatrix = false;
  let hasAlignment = false;
  let maxDepth = 0;

  const visit = (nodes: readonly MathNode[], depth: number): void => {
    if (depth > maxDepth) maxDepth = depth;
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          for (const ch of node.value) if (!/\s/.test(ch)) symbolCount++;
          break;
        case "command":
          if (!commands.includes(node.name)) commands.push(node.name);
          symbolCount++;
          if (node.name === "frac" || node.name === "dfrac" || node.name === "tfrac") hasFraction = true;
          for (const arg of node.args) visit(arg, depth + 1);
          for (const arg of node.optional) visit(arg, depth + 1);
          break;
        case "group":
          visit(node.children, depth + 1);
          break;
        case "script":
          if (node.kind === "sup") hasSuperscript = true;
          else hasSubscript = true;
          if (node.base !== null) visit([node.base], depth + 1);
          visit(node.argument, depth + 1);
          break;
        case "environment":
          if (!environments.includes(node.name)) environments.push(node.name);
          if (/matrix|array|cases/.test(node.name)) hasMatrix = true;
          if (/align/.test(node.name)) hasAlignment = true;
          for (const row of node.rows) for (const cell of row.cells) visit(cell.children, depth + 1);
          break;
      }
    }
  };

  visit(parsed.nodes, 0);

  const empty = symbolCount === 0 && commands.length === 0 && environments.length === 0;
  const summary = buildMathSummary({
    empty,
    displayMode,
    symbolCount,
    commands,
    environments,
    hasSuperscript,
    hasSubscript,
    hasFraction,
    hasMatrix,
    hasAlignment,
  });

  return {
    latex: source,
    displayMode,
    empty,
    symbolCount,
    commands,
    environments,
    hasSuperscript,
    hasSubscript,
    hasFraction,
    hasMatrix,
    hasAlignment,
    maxDepth,
    summary,
  };
}
