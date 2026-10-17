import { NextResponse } from "next/server";

/**
 * B22 — bounded request bodies.
 *
 * A route handler that calls `request.json()` or `request.formData()` buffers
 * the *whole* body in memory before it can look at a single field. Without a
 * byte budget that read is unbounded: one request can claim as much heap as
 * the client cares to send, and the check that would have stopped it (the
 * document limit inside the import action, the file limit inside the upload
 * route) only runs *after* the bytes are already allocated.
 *
 * `Content-Length` alone cannot fix that — it is a request header, so the
 * client chooses it. A missing header must not read as "small", and a header
 * that lies (too small) must not buy the caller an unbounded body. So the
 * header is only ever a **fast path**: it lets the route refuse an oversized
 * body before reading a single byte. The budget itself is enforced on the
 * bytes that actually arrive, chunk by chunk, so it holds with the header, with
 * a missing header and with a header that lies.
 *
 * The read helpers below therefore all take a byte `limit`:
 *  - a declared length above the limit is refused up front,
 *  - the body is then streamed and counted, and the read is aborted as soon as
 *    the running total passes the limit,
 *  - only what fits is handed to the parser.
 */

/**
 * The budget for an ordinary JSON request body (256 KiB).
 *
 * The routes that use it carry identifiers, form fields and short text — a
 * prompt, a chat message, a ticket description, a calendar event. 256 KiB is
 * far above what any of them needs and far below "the whole heap".
 */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

/**
 * The budget for a request body that may carry a page's content (4 MiB).
 *
 * Used by the routes that accept a document (the MCP tool calls, the public
 * page API), where the payload is a page's blocks rather than a form field.
 */
export const MAX_CONTENT_BODY_BYTES = 4 * 1024 * 1024;

/** Thrown when a request body is larger than the route's budget. */
export class BodyTooLargeError extends Error {
  /** The budget that was exceeded, in bytes. */
  readonly limit: number;

  constructor(limit: number) {
    super(`Request body exceeds the ${limit} byte limit.`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

/**
 * The `Content-Length` the client declared, or `null` when the header is
 * absent or unusable (chunked transfer-encoding, a malformed value).
 *
 * `null` never means "empty": the caller still has to enforce the budget on
 * the bytes it receives.
 */
export function declaredBodyLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const trimmed = raw.trim();
  // A strict decimal check: "12abc" must not be read as 12.
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read the request body, refusing anything above `limit` bytes.
 *
 * The declared length is checked first (cheap, and it stops an oversized body
 * before it is transferred), then the body is streamed and counted. The count
 * is what actually enforces the budget: a missing or lying `Content-Length`
 * cannot talk the route into accepting more than `limit` bytes.
 */
export async function readBodyBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = declaredBodyLength(request);
  if (declared !== null && declared > limit) {
    throw new BodyTooLargeError(limit);
  }

  const body = request.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        // The request is refused: the rest of the body is neither read nor
        // drained (draining an unbounded body is exactly the work this budget
        // exists to avoid). Cancel the source so the connection is not left
        // open waiting for bytes nobody will consume. A source may reject the
        // cancel (for example a multipart body the platform is still
        // filling); that must not replace the 413 with a 500, so the error is
        // swallowed and `BodyTooLargeError` is still what the route sees.
        try {
          await reader.cancel();
        } catch {
          /* the source was already errored or closed */
        }
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Read and parse a JSON body under a byte budget.
 *
 * Throws {@link BodyTooLargeError} when the body is over the budget and a
 * `SyntaxError` when it is not valid JSON — the route turns both into a
 * response with {@link bodyReadError}.
 */
export async function readJsonBody<T = unknown>(
  request: Request,
  limit: number,
): Promise<T> {
  const bytes = await readBodyBytes(request, limit);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * The read bytes in a buffer that the `Response` constructor accepts.
 *
 * TypeScript's DOM typings want a `BufferSource` to be backed by a plain
 * `ArrayBuffer` (`BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer`),
 * while the bytes that arrive from a stream are a
 * `Uint8Array<ArrayBufferLike>` — possibly a view into a larger buffer. The
 * bytes are therefore handed over in a buffer of their own unless they
 * already fill an `ArrayBuffer` exactly, so the response sees exactly the
 * bytes that were read and nothing else.
 */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return buffer;
  }
  const own = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(own).set(bytes);
  return own;
}

/**
 * Read and parse a multipart body under a byte budget.
 *
 * The raw bytes are read first (and counted), then handed to the platform's
 * multipart parser with the original `Content-Type` — the boundary lives in
 * that header, so it has to be passed through unchanged.
 */
export async function readFormDataBody(request: Request, limit: number): Promise<FormData> {
  const bytes = await readBodyBytes(request, limit);
  const contentType = request.headers.get("content-type") ?? "";
  return new Response(asArrayBuffer(bytes), { headers: { "content-type": contentType } }).formData();
}

/** Read a body as text under a byte budget. */
export async function readTextBody(request: Request, limit: number): Promise<string> {
  const bytes = await readBodyBytes(request, limit);
  return new TextDecoder().decode(bytes);
}

/**
 * Turn a failed body read into a response: **413** when the body was over its
 * budget, the route's own **400** message otherwise (malformed JSON, a body
 * that is not multipart, …).
 */
export function bodyReadError(
  error: unknown,
  invalidMessage = "Invalid JSON body.",
): NextResponse {
  if (error instanceof BodyTooLargeError) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }
  return NextResponse.json({ error: invalidMessage }, { status: 400 });
}
