// Offsite backups over an S3-compatible endpoint.
//
// A tiny in-process S3 lets the tests prove the whole path without a cloud
// account: Signature V4 headers are sent, bytes round-trip, listings paginate,
// newest-N retention deletes the dump plus its manifest, and `--remote` opens
// the sealed object back to the exact dump.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BACKUP_S3_PREFIX,
  decryptBackup,
  encryptBackup,
  listBackupObjects,
  normalizeBackupPrefix,
  parseS3ListXml,
  pruneOffsiteBackups,
  remoteBackupKey,
  resolveBackupS3Config,
  s3DeleteBackup,
  s3GetBackup,
  s3PutBackup,
  signBackupS3Request,
} from "./backup-lib.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const RESTORE = fileURLToPath(new URL("./backup-restore.mjs", import.meta.url));
const SEAL_KEY = "noema-s3-test-seal-key-0001";

const STAMPS = [
  "2026-10-13T21-09-10",
  "2026-10-13T21-09-23",
  "2026-10-14T08-00-00",
  "2026-10-14T09-30-15",
  "2026-10-15T07-45-30",
];
const dump = (stamp) => `noema-${stamp}.sql.enc`;
const manifest = (stamp) => `noema-${stamp}.manifest.json`;

let server;
let base;
let store;
let requests;
let config;

const xmlEscape = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const decodeKey = (pathname) =>
  pathname
    .split("/")
    .slice(2)
    .map((segment) => decodeURIComponent(segment))
    .join("/");

beforeEach(async () => {
  store = new Map();
  requests = [];
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base ?? "http://127.0.0.1");
    requests.push({ method: request.method, url, headers: request.headers });
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const pathname = url.pathname;
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length === 0) {
        response.statusCode = 400;
        response.end("missing bucket");
        return;
      }
      const key = decodeKey(pathname);

      if (request.method === "PUT") {
        store.set(key, Buffer.concat(chunks));
        response.statusCode = 200;
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        store.delete(key);
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const keys = [...store.keys()].filter((entry) => entry.startsWith(prefix));
        const start = Number(url.searchParams.get("continuation-token") ?? "0") || 0;
        const page = keys.slice(start, start + 2);
        const next = start + 2 < keys.length ? String(start + 2) : null;
        const contents = page
          .map(
            (entry) =>
              `<Contents><Key>${xmlEscape(entry)}</Key><Size>${store.get(entry).length}</Size></Contents>`,
          )
          .join("");
        response.setHeader("content-type", "application/xml");
        response.end(
          `<ListBucketResult>${contents}<IsTruncated>${next !== null}</IsTruncated>` +
            `${next === null ? "" : `<NextContinuationToken>${next}</NextContinuationToken>`}` +
            "</ListBucketResult>",
        );
        return;
      }
      if (request.method === "GET") {
        const body = store.get(key);
        if (!body) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/octet-stream");
        response.end(body);
        return;
      }
      response.statusCode = 405;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  config = resolveBackupS3Config({
    BACKUP_S3_BUCKET: "noema-backups",
    BACKUP_S3_ENDPOINT: base,
    BACKUP_S3_REGION: "eu-west-3",
    BACKUP_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
    BACKUP_S3_SECRET_ACCESS_KEY: "very-secret",
  }).config;
});

afterEach(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

describe("resolveBackupS3Config", () => {
  it("is off by default", () => {
    expect(resolveBackupS3Config({})).toEqual({ ok: true, config: null });
  });

  it("fails closed when a bucket is named without credentials", () => {
    const resolved = resolveBackupS3Config({ BACKUP_S3_BUCKET: "noema" });
    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toContain("BACKUP_S3_ACCESS_KEY_ID");
  });

  it("reads the endpoint, region, keys and a normalised prefix", () => {
    expect(config).toMatchObject({
      bucket: "noema-backups",
      endpoint: base,
      region: "eu-west-3",
      accessKeyId: "AKIAEXAMPLE",
      prefix: "backups",
    });
  });

  it("rejects a malformed endpoint and normalises slashes", () => {
    const bad = resolveBackupS3Config({
      BACKUP_S3_BUCKET: "noema",
      BACKUP_S3_ENDPOINT: "not a url",
      BACKUP_S3_ACCESS_KEY_ID: "a",
      BACKUP_S3_SECRET_ACCESS_KEY: "b",
    });
    expect(bad.ok).toBe(false);
    expect(normalizeBackupPrefix("//daily//noema//")).toBe("daily/noema");
    expect(remoteBackupKey("file.sql.enc")).toBe(
      `${DEFAULT_BACKUP_S3_PREFIX}/file.sql.enc`,
    );
  });
});

describe("signBackupS3Request", () => {
  it("signs the path, query and content type with Signature V4", () => {
    const signed = signBackupS3Request({
      method: "PUT",
      endpoint: base,
      bucket: "noema-backups",
      key: "backups/noema one.sql.enc",
      query: {},
      region: "eu-west-3",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "very-secret",
      payloadHash: "a".repeat(64),
      contentType: "application/octet-stream",
      now: new Date("2026-04-01T10:20:30.000Z"),
    });
    expect(signed.url).toBe(`${base}/noema-backups/backups/noema%20one.sql.enc`);
    expect(signed.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260401\/eu-west-3\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(signed.headers["x-amz-date"]).toBe("20260401T102030Z");
    expect(signed.headers["content-type"]).toBe("application/octet-stream");
  });

  it("sorts the canonical query for a paginated list", () => {
    const signed = signBackupS3Request({
      method: "GET",
      endpoint: base,
      bucket: "noema-backups",
      key: "",
      query: { prefix: "backups/", "list-type": "2", "max-keys": "1000" },
      region: "eu-west-3",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "very-secret",
      payloadHash: "b".repeat(64),
      now: new Date("2026-04-01T10:20:30.000Z"),
    });
    expect(signed.url).toContain("list-type=2&max-keys=1000&prefix=backups%2F");
  });
});

describe("offsite object round-trip", () => {
  it("uploads, reads back and deletes the exact bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251]);
    await s3PutBackup(
      config,
      remoteBackupKey("noema-x.sql.enc"),
      bytes,
      "application/octet-stream",
    );
    expect(Array.from((await s3GetBackup(config, "backups/noema-x.sql.enc")) ?? [])).toEqual([
      0, 1, 2, 250, 251,
    ]);
    expect(requests.every((request) => request.headers.authorization)).toBe(true);

    await s3DeleteBackup(config, "backups/noema-x.sql.enc");
    expect(await s3GetBackup(config, "backups/noema-x.sql.enc")).toBeNull();
  });

  it("returns null for a missing object", async () => {
    expect(await s3GetBackup(config, "backups/missing.sql.enc")).toBeNull();
  });
});

describe("offsite listing and retention", () => {
  beforeEach(() => {
    for (const stamp of STAMPS) {
      store.set(`backups/${dump(stamp)}`, Buffer.from(dump(stamp)));
      store.set(`backups/${manifest(stamp)}`, Buffer.from(manifest(stamp)));
    }
    store.set("backups/notes.txt", Buffer.from("not a dump"));
    store.set("backups/nested/keep.txt", Buffer.from("nested"));
    store.set("assets/photo.png", Buffer.from("not a backup"));
  });

  it("follows continuation tokens until the listing ends", async () => {
    const keys = await listBackupObjects(config, "backups/");
    expect(keys).toHaveLength(STAMPS.length * 2 + 2);
    expect(keys).toContain("backups/notes.txt");
    expect(keys).not.toContain("assets/photo.png");
    expect(requests.filter((request) => request.url.searchParams.get("list-type")).length).toBeGreaterThan(1);
  });

  it("keeps the newest N dumps and deletes older dumps with their manifests", async () => {
    const plan = await pruneOffsiteBackups(config, 2);
    expect(plan.retained).toEqual([dump(STAMPS[4]), dump(STAMPS[3])]);
    expect(plan.deleted).toEqual([dump(STAMPS[2]), dump(STAMPS[1]), dump(STAMPS[0])]);
    expect(plan.failed).toEqual([]);

    expect(store.has(`backups/${dump(STAMPS[4])}`)).toBe(true);
    expect(store.has(`backups/${manifest(STAMPS[4])}`)).toBe(true);
    expect(store.has(`backups/${dump(STAMPS[0])}`)).toBe(false);
    expect(store.has(`backups/${manifest(STAMPS[0])}`)).toBe(false);
    // Non-dump and nested objects are outside retention.
    expect(store.has("backups/notes.txt")).toBe(true);
    expect(store.has("backups/nested/keep.txt")).toBe(true);
    expect(store.has("assets/photo.png")).toBe(true);
  });

  it("parses XML entities and a truncated listing", () => {
    expect(
      parseS3ListXml(
        "<ListBucketResult><Contents><Key>a&amp;b</Key><Size>3</Size></Contents>" +
          "<IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>",
      ),
    ).toEqual({
      objects: [{ key: "a&b", size: 3, lastModified: null }],
      nextContinuationToken: "t1",
      isTruncated: true,
    });
  });
});

describe("backup-restore --remote", () => {
  const plaintext = Buffer.from(
    '-- dump\nCREATE TABLE public."User" (id text);\nCOPY public."User" (id) FROM stdin;\nu1\n\\.\n',
  );

  /** Run the restore script and capture stdout/stderr. */
  function runRemote(args, env = {}) {
    return new Promise((resolve) => {
      const child = spawn("node", [RESTORE, ...args], {
        cwd: REPO,
        env: {
          ...process.env,
          BACKUP_ENCRYPTION_KEY: SEAL_KEY,
          BACKUP_S3_BUCKET: "noema-backups",
          BACKUP_S3_ENDPOINT: base,
          BACKUP_S3_REGION: "eu-west-3",
          BACKUP_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
          BACKUP_S3_SECRET_ACCESS_KEY: "very-secret",
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("downloads the object and opens it back to the exact dump", async () => {
    store.set("backups/noema-x.sql.enc", encryptBackup(plaintext, SEAL_KEY));
    const result = await runRemote(["--remote", "noema-x.sql.enc"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CREATE TABLE");
    expect(result.stdout).toContain("u1");
    expect(result.stderr).toContain("s3://noema-backups/backups/noema-x.sql.enc");
  });

  it("accepts a full s3:// URL", async () => {
    store.set("custom/noema-y.sql.enc", encryptBackup(plaintext, SEAL_KEY));
    const result = await runRemote(["--remote", "s3://noema-backups/custom/noema-y.sql.enc"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CREATE TABLE");
  });

  it("fails closed for a missing object and a wrong key", async () => {
    const missing = await runRemote(["--remote", "noema-missing.sql.enc"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not found");
    expect(missing.stdout).toBe("");

    store.set("backups/noema-x.sql.enc", encryptBackup(plaintext, SEAL_KEY));
    const wrongKey = await runRemote(["--remote", "noema-x.sql.enc"], {
      BACKUP_ENCRYPTION_KEY: "noema-s3-wrong-passphrase-9",
    });
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.stdout).toBe("");
    expect(wrongKey.stderr).toContain("BACKUP_ENCRYPTION_KEY");
  });

  it("requires the offsite destination to be configured", async () => {
    const result = await runRemote(["--remote", "noema-x.sql.enc"], {
      BACKUP_S3_BUCKET: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("BACKUP_S3_BUCKET");
  });

  it("refuses both a local file and --remote", async () => {
    const result = await runRemote(["backups/x.sql.enc", "--remote", "noema-x.sql.enc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  it("decrypts exactly what was uploaded", () => {
    const sealed = encryptBackup(plaintext, SEAL_KEY);
    expect(decryptBackup(sealed, SEAL_KEY).equals(plaintext)).toBe(true);
  });
});

describe("backup-restore local path", () => {
  it("still opens a file and honours --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noema-restore-"));
    try {
      const plaintext = Buffer.from(
        '-- dump\nCREATE TABLE public."User" (id text);\nCOPY public."User" (id) FROM stdin;\nu1\n\\.\n',
      );
      const dumpFile = join(dir, "noema-local.sql.enc");
      const outFile = join(dir, "restored.sql");
      writeFileSync(dumpFile, encryptBackup(plaintext, SEAL_KEY));
      const result = await new Promise((resolve) => {
        const child = spawn("node", [RESTORE, dumpFile, "--out", outFile], {
          cwd: REPO,
          env: { ...process.env, BACKUP_ENCRYPTION_KEY: SEAL_KEY },
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stderr }));
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("delete it once the restore succeeded");
      expect(readFileSync(outFile).equals(plaintext)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
