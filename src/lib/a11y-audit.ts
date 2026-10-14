/**
 * Accessibility audit of a document — the pure checklist behind the
 * "Accessibility" panel (docs/MISSING_FEATURES.md §16 "High-contrast support"
 * and the a11y audit slice).
 *
 * `auditDocument` walks a block tree shaped `{ id, type, text?, attrs?,
 * children?, marks? }` and returns every finding as a flat
 * `{ blockId, code, severity, message }` row, in document order. It only
 * reads; it never mutates and it NEVER throws — malformed nodes (nulls,
 * non-objects, missing ids, cycles) are skipped, so it is safe to run over
 * editor JSON of unknown provenance.
 *
 * The rules (one stable `code` each):
 *  - `image-alt`       an `image` block with no non-empty `attrs.alt`
 *  - `heading-skip`    a heading more than one level below the previous heading
 *  - `empty-link`      a link mark on a node with no visible text
 *  - `table-no-header` a `table` whose first row is not a header row
 *  - `color-only`      emphasis carried by a colour mark with no semantic mark
 *  - `no-heading`      a long document (`LONG_DOC_WORD_THRESHOLD` words) with no heading
 *  - `empty-callout`   a `callout` block with no text
 *
 * Severities live in {@link AUDIT_RULES} so a report and its UI agree.
 *
 * Unit-pinned by `src/lib/a11y-audit.test.ts`.
 */

/** Urgency of a finding, from most to least severe. */
export type AuditSeverity = "error" | "warning" | "info";

/** Stable machine code identifying which rule produced a finding. */
export type AuditCode =
  | "image-alt"
  | "heading-skip"
  | "empty-link"
  | "table-no-header"
  | "color-only"
  | "no-heading"
  | "empty-callout";

/** A single accessibility finding, anchored to the block that caused it. */
export type AuditIssue = {
  readonly blockId: string;
  readonly code: AuditCode;
  readonly severity: AuditSeverity;
  readonly message: string;
};

/** An inline mark (`link`, `bold`, a colour `textStyle`, …) on a node. */
export type A11yMark = {
  readonly type?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
};

/** The block shape the audit understands; extra fields are ignored. */
export type A11yBlock = {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly children?: readonly A11yBlock[];
  readonly marks?: readonly A11yMark[];
};

/** A document counts as "long" (and so should carry structure) past this many words. */
export const LONG_DOC_WORD_THRESHOLD = 300;

/** Severity + human title for every rule, keyed by its {@link AuditCode}. */
export const AUDIT_RULES: Readonly<Record<AuditCode, { severity: AuditSeverity; title: string }>> = {
  "image-alt": { severity: "error", title: "Image alternative text" },
  "empty-link": { severity: "error", title: "Link text" },
  "heading-skip": { severity: "warning", title: "Heading level order" },
  "table-no-header": { severity: "warning", title: "Table header row" },
  "color-only": { severity: "warning", title: "Colour-only emphasis" },
  "no-heading": { severity: "info", title: "Document structure" },
  "empty-callout": { severity: "info", title: "Empty callout" },
};

/** Marks that convey meaning without relying on colour alone. */
const SEMANTIC_MARKS = new Set([
  "bold",
  "strong",
  "italic",
  "em",
  "underline",
  "strike",
  "strikethrough",
  "code",
  "link",
  "mention",
  "sub",
  "sup",
]);

/** `attrs` keys that carry a colour value. */
const COLOR_ATTR_KEYS = ["color", "textColor", "backgroundColor", "background", "highlight"] as const;

/** Mark types that are explicitly colour marks even without an `attrs` colour. */
const COLOR_MARK_TYPES = new Set(["color", "textColor", "highlight"]);

type Node = Record<string, unknown>;

function isRecord(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A node as a plain record, or `null` for anything malformed. */
function asNode(value: unknown): Node | null {
  return isRecord(value) ? value : null;
}

function idOf(node: Node): string {
  return typeof node.id === "string" ? node.id : "";
}

function typeOf(node: Node): string {
  return typeof node.type === "string" ? node.type : "";
}

function textOf(node: Node): string {
  return typeof node.text === "string" ? node.text : "";
}

function attrsOf(node: Node): Record<string, unknown> {
  return isRecord(node.attrs) ? node.attrs : {};
}

function childrenOf(node: Node): unknown[] {
  return Array.isArray(node.children) ? node.children : [];
}

function marksOf(node: Node): Node[] {
  return Array.isArray(node.marks) ? node.marks.map(asNode).filter((m): m is Node => m !== null) : [];
}

/** Depth-first plain text of a node, whitespace-joined and cycle-safe. */
function collectText(node: Node, seen: Set<unknown> = new Set()): string {
  if (seen.has(node)) return "";
  seen.add(node);
  const parts: string[] = [];
  const own = textOf(node);
  if (own) parts.push(own);
  for (const child of childrenOf(node)) {
    const childNode = asNode(child);
    if (childNode !== null) {
      const text = collectText(childNode, seen);
      if (text) parts.push(text);
    }
  }
  return parts.join(" ");
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Heading level (1–6) for a `heading`/`headingN` node, or `null` when not a heading. */
function headingLevelOf(node: Node): number | null {
  const match = /^heading([1-6])?$/.exec(typeOf(node));
  if (match === null) return null;
  if (match[1] !== undefined) return Number(match[1]);
  const raw = attrsOf(node).level;
  const level = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, Math.trunc(level)));
}

/** The colour a mark carries, or `null` when it is not a colour mark. */
function colorOf(mark: Node): string | null {
  const attrs = attrsOf(mark);
  for (const key of COLOR_ATTR_KEYS) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return COLOR_MARK_TYPES.has(typeOf(mark)) ? typeOf(mark) : null;
}

function isColorMark(mark: Node): boolean {
  return colorOf(mark) !== null;
}

function isSemanticMark(mark: Node): boolean {
  return SEMANTIC_MARKS.has(typeOf(mark));
}

function isLinkMark(mark: Node): boolean {
  return typeOf(mark) === "link";
}

/** Whether `table` declares or opens with a header row. */
function tableHasHeader(table: Node): boolean {
  const attrs = attrsOf(table);
  if (attrs.hasHeaderRow === true || attrs.header === true || attrs.headerRow === true) return true;

  const first = childrenOf(table).map(asNode).find((n): n is Node => n !== null);
  if (first === undefined) return false;
  const firstType = typeOf(first);
  if (firstType === "tableHeaderRow" || firstType === "tableHead") return true;
  const rowAttrs = attrsOf(first);
  if (rowAttrs.isHeader === true || rowAttrs.header === true || rowAttrs.isHeaderRow === true) {
    return true;
  }

  return childrenOf(first)
    .map(asNode)
    .filter((n): n is Node => n !== null)
    .some((cell) => {
      const cellType = typeOf(cell);
      const cellAttrs = attrsOf(cell);
      return (
        cellType === "tableHeader" ||
        cellType === "tableHeaderCell" ||
        cellType === "th" ||
        cellAttrs.header === true ||
        cellAttrs.isHeader === true
      );
    });
}

function makeIssue(blockId: string, code: AuditCode, message: string): AuditIssue {
  return { blockId, code, severity: AUDIT_RULES[code].severity, message };
}

/**
 * Audit a document's blocks, returning every finding in document order. The
 * input is read-only; malformed nodes are skipped and cycles are cut, so the
 * call never throws. A document-level finding (`no-heading`) is attributed to
 * the first block and appended last.
 */
export function auditDocument(blocks: readonly A11yBlock[]): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (!Array.isArray(blocks)) return issues;

  const seen = new Set<unknown>();
  let previousHeadingLevel: number | null = null;
  let hasHeading = false;
  let wordCount = 0;
  let firstBlockId: string | null = null;
  let sawAnyBlock = false;

  const visit = (raw: unknown): void => {
    const node = asNode(raw);
    if (node === null || seen.has(node)) return;
    seen.add(node);

    const id = idOf(node);
    if (firstBlockId === null) firstBlockId = id;
    sawAnyBlock = true;

    const type = typeOf(node);
    wordCount += countWords(textOf(node));

    const level = headingLevelOf(node);
    if (level !== null) {
      hasHeading = true;
      if (previousHeadingLevel !== null && level > previousHeadingLevel + 1) {
        issues.push(
          makeIssue(
            id,
            "heading-skip",
            `Heading jumps from level ${previousHeadingLevel} to level ${level}.`,
          ),
        );
      }
      previousHeadingLevel = level;
    }

    if (type === "image") {
      const alt = attrsOf(node).alt;
      if (typeof alt !== "string" || alt.trim() === "") {
        issues.push(makeIssue(id, "image-alt", "Image is missing alternative text (alt)."));
      }
    }

    if (type === "callout" && collectText(node).trim() === "") {
      issues.push(makeIssue(id, "empty-callout", "Callout is empty."));
    }

    if (type === "table" && !tableHasHeader(node)) {
      issues.push(makeIssue(id, "table-no-header", "Table is missing a header row."));
    }

    const marks = marksOf(node);
    if (marks.length > 0) {
      const text = collectText(node);
      if (text.trim() === "" && marks.some(isLinkMark)) {
        issues.push(makeIssue(id, "empty-link", "Link has no text."));
      }
      if (
        text.trim() !== "" &&
        marks.some(isColorMark) &&
        !marks.some(isSemanticMark)
      ) {
        issues.push(makeIssue(id, "color-only", "Emphasis relies on colour alone."));
      }
    }

    for (const child of childrenOf(node)) visit(child);
  };

  for (const block of blocks) visit(block);

  if (sawAnyBlock && !hasHeading && wordCount >= LONG_DOC_WORD_THRESHOLD) {
    issues.push(
      makeIssue(
        firstBlockId ?? "",
        "no-heading",
        `Long document (${wordCount} words) has no headings.`,
      ),
    );
  }

  return issues;
}

/** Counts of a report's findings, broken down by severity and by rule. */
export type AuditSummary = {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  /** Findings per {@link AuditCode}; only codes that occurred are present. */
  readonly byCode: Readonly<Record<string, number>>;
};

/** Aggregate a list of findings into severity and per-rule counts. */
export function summarizeAudit(issues: readonly AuditIssue[]): AuditSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  const byCode: Record<string, number> = {};

  if (Array.isArray(issues)) {
    for (const issue of issues) {
      if (issue.severity === "error") errors += 1;
      else if (issue.severity === "warning") warnings += 1;
      else infos += 1;
      byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
    }
  }

  return { total: errors + warnings + infos, errors, warnings, infos, byCode };
}

/**
 * Whether a report is clean. A report is clean when it holds no `error` or
 * `warning` findings — `info` entries are advisory and do not make it dirty.
 */
export function isCleanReport(issues: readonly AuditIssue[]): boolean {
  if (!Array.isArray(issues)) return true;
  return !issues.some((issue) => issue.severity === "error" || issue.severity === "warning");
}
