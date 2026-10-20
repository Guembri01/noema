/**
 * Asset storage.
 *
 * One interface, two drivers:
 *   • `local` (default) — the filesystem under `<cwd>/uploads`.
 *   • `s3` — any S3-compatible endpoint (AWS, MinIO, R2, Garage), signed with
 *     Signature V4 over `fetch`, so no SDK is needed.
 *
 * The app always proxies reads through its own authorised route, so the driver
 * only has to move bytes.
 */

import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredObject = { body: Uint8Array; contentType: string };

export type StorageDriver = {
  name: "local" | "s3";
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  remove(key: string): Promise<void>;
};

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Signature V4 (S3)
// ---------------------------------------------------------------------------

const hex = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value).digest();

export type SignedRequest = {
  url: string;
  headers: Record<string, string>;
};

/** AWS's URI encoding rules for canonical requests (not `encodeURIComponent`). */
function encodeAws(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Sign an S3 request with Signature V4. Pure and deterministic, so it can be
 * unit-tested; `payloadHash` is `UNSIGNED-PAYLOAD` for streaming bodies.
 */
export function signS3Request(input: {
  method: "GET" | "PUT" | "DELETE";
  endpoint: string;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash: string;
  contentType?: string;
  expiresIn?: number;
  now?: Date;
}): SignedRequest {
  const now = input.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(input.endpoint).host;
  const canonicalUri = `/${input.bucket}/${input.key.split("/").map(encodeAws).join("/")}`;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.expiresIn) {
    // Presigned URL: the query string carries the signature instead of headers.
    const credential = `${input.accessKeyId}/${dateStamp}/${input.region}/s3/aws4_request`;
    const query =
      `X-Amz-Algorithm=AWS4-HMAC-SHA256` +
      `&X-Amz-Credential=${encodeAws(credential)}` +
      `&X-Amz-Date=${amzDate}` +
      `&X-Amz-Expires=${input.expiresIn}` +
      `&X-Amz-SignedHeaders=host`;
    const canonicalRequest = [
      input.method,
      canonicalUri,
      query,
      `host:${host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      `${dateStamp}/${input.region}/s3/aws4_request`,
      hex(canonicalRequest),
    ].join("\n");
    const signature = createHmac("sha256", signingKey(input.secretAccessKey, dateStamp, input.region))
      .update(stringToSign)
      .digest("hex");
    return { url: `${input.endpoint}${canonicalUri}?${query}&X-Amz-Signature=${signature}`, headers: {} };
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}`).join("\n");
  const canonicalRequest = [
    input.method,
    canonicalUri,
    "",
    `${canonicalHeaders}\n`,
    signedHeaderNames.join(";"),
    input.payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${input.region}/s3/aws4_request`,
    hex(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, dateStamp, input.region))
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${dateStamp}/${input.region}/s3/aws4_request, ` +
    `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;

  return {
    url: `${input.endpoint}${canonicalUri}`,
    headers: {
      ...headers,
      authorization,
      ...(input.contentType ? { "content-type": input.contentType } : {}),
    },
  };
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), "s3"), "aws4_request");
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** Filesystem driver — the default for self-hosted installs. */
export function localDriver(root = process.env.STORAGE_DIR ?? path.join(process.cwd(), "uploads")): StorageDriver {
  const resolve = (key: string) => {
    const target = path.join(root, key);
    if (!target.startsWith(root)) throw new Error("Refusing to escape the storage root");
    return target;
  };
  return {
    name: "local",
    async put(key, body) {
      const target = resolve(key);
      // Uploads are tenant data: the workspace directory and the file itself
      // are created owner-only instead of the umask default (0755/0644), so
      // no other user on the host can read another tenant's uploads (B38).
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, body, { mode: 0o600 });
    },
    async get(key) {
      try {
        return { body: await readFile(resolve(key)), contentType: contentTypeFor(key) };
      } catch {
        return null;
      }
    },
    async remove(key) {
      await rm(resolve(key), { force: true });
    },
  };
}

/** S3-compatible driver, selected by `S3_BUCKET` (+ endpoint and keys). */
export function s3Driver(config: {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
}): StorageDriver {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const prefixed = (key: string) => (config.prefix ? `${config.prefix.replace(/^\/|\/$/g, "")}/${key}` : key);

  const call = async (
    method: "GET" | "PUT" | "DELETE",
    key: string,
    body?: Uint8Array,
    contentType?: string,
  ) => {
    const signed = signS3Request({
      method,
      endpoint,
      bucket: config.bucket,
      key: prefixed(key),
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      payloadHash: body ? hex(Buffer.from(body)) : hex(""),
      ...(contentType ? { contentType } : {}),
    });
    return fetch(signed.url, {
      method,
      headers: signed.headers,
      ...(body ? { body: body as unknown as BodyInit } : {}),
    });
  };

  return {
    name: "s3",
    async put(key, body, contentType) {
      const response = await call("PUT", key, body, contentType);
      if (!response.ok) {
        throw new Error(`Storage rejected the upload (${response.status})`);
      }
    },
    async get(key) {
      const response = await call("GET", key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Storage could not read the file (${response.status})`);
      return {
        body: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? contentTypeFor(key),
      };
    },
    async remove(key) {
      await call("DELETE", key);
    },
  };
}

/** The configured driver: S3 when `S3_BUCKET` is set, local otherwise. */
export function storageDriver(): StorageDriver {
  const bucket = process.env.S3_BUCKET;
  if (bucket && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    return s3Driver({
      endpoint: process.env.S3_ENDPOINT ?? "https://s3.amazonaws.com",
      bucket,
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      prefix: process.env.S3_PREFIX,
    });
  }
  return localDriver();
}

/** Asset keys are `"<workspaceId>/<name>"`; guard against traversal. */
export function isValidAssetKey(key: string): boolean {
  const segments = key.split("/");
  return (
    segments.length === 2 &&
    /^[A-Za-z0-9_-]+$/.test(segments[0]) &&
    /^[A-Za-z0-9._-]+$/.test(segments[1]) &&
    !segments[1].includes("..")
  );
}
