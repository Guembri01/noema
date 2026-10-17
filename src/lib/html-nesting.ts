/**
 * The nesting limit of the HTML tokenizer (B131).
 *
 * The tokenizer builds a tree, and the tree is walked further down
 * **recursively** — the container collector of the Confluence import, the
 * block builder of the Google Docs import, the serializer of the sanitizer
 * and the paste path. A document with deeply nested tags therefore overflows
 * the stack: 10 000 nested `<b>` (40 KB) are enough for a
 * `RangeError: Maximum call stack size exceeded`, and the Confluence import
 * does not catch it — the request answers 500.
 *
 * The limit is on the tree, not on the document: beyond it the element is
 * unwrapped (the tag goes, the content stays), which is what the sanitizer
 * already does with an unknown tag. A document a human writes does not come
 * near the limit — the limit is far above the depth of any real markup and
 * far below the depth that breaks the stack.
 */

/** The nesting depth the tokenizer builds. */
export const HTML_MAX_NESTING = 100;
