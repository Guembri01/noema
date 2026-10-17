import { mkdtemp, readFile, rm, chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentTypeFor,
  isValidAssetKey,
  localDriver,
  signS3Request,
  type StorageDriver,
} from "./storage";

describe("contentTypeFor", () => {
  it("maps known extensions and falls back safely", () => {
    expect(contentTypeFor("ws1/photo.PNG")).toBe("image/png");
    expect(contentTypeFor("ws1/doc.pdf")).toBe("application/pdf");
    expect(contentTypeFor("ws1/thing.bin")).toBe("application/octet-stream");
  });
});

describe("isValidAssetKey", () => {
  it("accepts workspace/name pairs", () => {
    expect(isValidAssetKey("ws_1/file-01.png")).toBe(true);
  });

  it("refuses traversal and odd shapes", () => {
    for (const key of ["../secret", "ws1/../etc/passwd", "ws1/a/b.png", "ws1/", "/ws1/a.png"]) {
      expect(isValidAssetKey(key)).toBe(false);
    }
  });
});

describe("signS3Request", () => {
  const base = {
    method: "PUT" as const,
    endpoint: "https://s3.example.com",
    bucket: "noema",
    key: "ws1/photo.png",
    region: "eu-west-3",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "very-secret",
    payloadHash: "a".repeat(64),
    contentType: "image/png",
    now: new Date("2026-04-01T10:20:30.000Z"),
  };

  it("builds an AWS4-HMAC-SHA256 authorization header", () => {
    const signed = signS3Request(base);
    expect(signed.url).toBe("https://s3.example.com/noema/ws1/photo.png");
    expect(signed.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260401\/eu-west-3\/s3\/aws4_request, SignedHeaders=/,
    );
    expect(signed.headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(signed.headers["x-amz-date"]).toBe("20260401T102030Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe(base.payloadHash);
  });

  it("is deterministic, and changes with the payload, key or secret", () => {
    const first = signS3Request(base).headers.authorization;
    expect(signS3Request(base).headers.authorization).toBe(first);
    expect(signS3Request({ ...base, payloadHash: "b".repeat(64) }).headers.authorization).not.toBe(first);
    expect(signS3Request({ ...base, key: "ws1/other.png" }).headers.authorization).not.toBe(first);
    expect(signS3Request({ ...base, secretAccessKey: "other" }).headers.authorization).not.toBe(first);
  });

  it("produces a presigned URL when given an expiry", () => {
    const signed = signS3Request({ ...base, method: "GET", expiresIn: 900 });
    expect(signed.headers.authorization).toBeUndefined();
    expect(signed.url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(signed.url).toContain("X-Amz-Expires=900");
    expect(signed.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it("encodes keys that need escaping", () => {
    const signed = signS3Request({ ...base, key: "ws1/my photo (1).png" });
    expect(signed.url).toBe("https://s3.example.com/noema/ws1/my%20photo%20%281%29.png");
  });
});

describe("localDriver", () => {
  let root = "";
  let driver: StorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "noema-storage-"));
    driver = localDriver(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes and reports the content type", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await driver.put("ws1/file.png", body, "image/png");
    const stored = await driver.get("ws1/file.png");
    // Buffer is a Uint8Array subclass, so compare the bytes, not the class.
    expect(Array.from(stored?.body ?? [])).toEqual([1, 2, 3, 4, 5]);
    expect(stored?.contentType).toBe("image/png");
  });

  it("returns null for a missing object and deletes cleanly", async () => {
    expect(await driver.get("ws1/missing.png")).toBeNull();
    await driver.put("ws1/temp.txt", new Uint8Array([9]), "text/plain");
    await driver.remove("ws1/temp.txt");
    expect(await driver.get("ws1/temp.txt")).toBeNull();
  });

  it("refuses to escape its root", async () => {
    await expect(driver.put("../escape.txt", new Uint8Array([1]), "text/plain")).rejects.toThrow();
    expect(await driver.get("../escape.txt")).toBeNull();
  });

  it("refuses a sibling whose name begins with the root's name", async () => {
    // The prefix comparison said "inside the root" for every path that
    // *begins* with the root's name — the sibling `noema-storage-xyz` of the
    // root `noema-storage-abc` is outside it, and its file is writable
    // through this driver.
    const sibling = `${root}-evil`;
    const key = `../${path.basename(sibling)}/secret.txt`;
    await expect(driver.put(key, new Uint8Array([7]), "text/plain")).rejects.toThrow();
    expect(await driver.get(key)).toBeNull();
    // Nothing was written next to the root.
    await expect(readFile(path.join(sibling, "secret.txt"))).rejects.toThrow();
  });

  it("refuses an absolute path and the root itself", async () => {
    await expect(driver.put("/etc/passwd", new Uint8Array([1]), "text/plain")).rejects.toThrow();
    await expect(driver.put(".", new Uint8Array([1]), "text/plain")).rejects.toThrow();
  });

  it("stores uploads owner-only: a 0600 file inside a 0700 directory (B38)", async () => {
    await driver.put("ws1/secret.png", new Uint8Array([1]), "image/png");

    const file = await stat(path.join(root, "ws1", "secret.png"));
    expect(file.mode & 0o777).toBe(0o600);
    const dir = await stat(path.join(root, "ws1"));
    expect(dir.mode & 0o777).toBe(0o700);
  });

  it("hardens uploads that an older version left readable (B67)", async () => {
    // An install from before the modes were set: the workspace directory is
    // 0755 and the file in it 0644 — the umask's defaults.
    await mkdir(path.join(root, "ws1"), { recursive: true });
    await chmod(path.join(root, "ws1"), 0o755);
    await writeFile(path.join(root, "ws1", "old.png"), "old");
    await chmod(path.join(root, "ws1", "old.png"), 0o644);

    // Writing the same key again must not leave the old modes in place.
    await driver.put("ws1/old.png", new Uint8Array([2]), "image/png");

    const file = await stat(path.join(root, "ws1", "old.png"));
    expect(file.mode & 0o777).toBe(0o600);
    const dir = await stat(path.join(root, "ws1"));
    expect(dir.mode & 0o777).toBe(0o700);
  });
});
