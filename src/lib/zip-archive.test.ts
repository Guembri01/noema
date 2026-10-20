import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { readZipDirectory, readZipEntry } from "@/lib/zip-archive";

/**
 * B22 — the budgeted ZIP reader.
 *
 * The property under test is that the *actual* unpacked size is bounded, not
 * the size the archive claims: an entry that under-declares itself must still
 * be refused when it expands past the limit.
 */

async function makeArchive(
  files: Record<string, string>,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression }));
}

/**
 * Rewrite the uncompressed size in the central directory of an archive, so the
 * archive *claims* to be small while it really is not — the shape a zip bomb
 * takes when it wants to slip past a size check.
 */
function underDeclare(bytes: Uint8Array, declaredSize: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let offset = 0; offset + 46 <= out.length; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    view.setUint32(offset + 24, declaredSize, true);
    offset += 46 + nameLength + extraLength + commentLength - 1;
  }
  return out;
}

/**
 * A self-extracting archive: a stub (an executable) in front of the archive.
 *
 * The offsets inside the central directory stay relative to the start of the
 * *archive*, so the reader has to find the stub's length and add it to them.
 */
function withStub(bytes: Uint8Array): Uint8Array {
  const stub = new TextEncoder().encode("#!/bin/sh\necho self-extracting\n");
  const out = new Uint8Array(stub.length + bytes.length);
  out.set(stub, 0);
  out.set(bytes, stub.length);
  return out;
}

/** Rewrite a field of the end-of-central-directory record of an archive. */
function patchEocd(bytes: Uint8Array, patch: (view: DataView, offset: number) => void): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let offset = out.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    patch(view, offset);
    return out;
  }
  return out;
}

describe("readZipDirectory()", () => {
  it("lists the entries of an archive with their sizes", async () => {
    const bytes = await makeArchive({ "a.md": "# Alpha", "b.md": "# Beta" });
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    expect(directory.entries.map((entry) => entry.name)).toEqual(["a.md", "b.md"]);
    expect(directory.entries[0].uncompressedSize).toBe(7);
    expect(directory.entries[0].method).toBe(8);
  });

  it("reads a stored archive as well", async () => {
    const bytes = await makeArchive({ "a.md": "# Alpha" }, "STORE");
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    expect(directory.entries[0].method).toBe(0);
    const read = readZipEntry(bytes, directory.entries[0], 1024);
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.bytes)).toBe("# Alpha");
  });

  it("reports bytes that are not an archive as such", () => {
    expect(readZipDirectory(new TextEncoder().encode("not a zip at all"))).toEqual({
      ok: false,
      reason: "not-an-archive",
    });
  });

  it("resolves `..` segments so an archive cannot smuggle a path", async () => {
    const bytes = await makeArchive({ "folder/../evil.md": "# Evil" });
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    for (const entry of directory.entries) {
      expect(entry.name).not.toContain("..");
    }
    expect(directory.entries.some((entry) => entry.name === "evil.md")).toBe(true);
  });

  it("reads a self-extracting archive — the stub in front of it is accounted for", async () => {
    // The archive's own offsets are relative to the start of the archive, so
    // without the stub's length the reader would seek into the wrong place.
    const bytes = withStub(await makeArchive({ "a.md": "# Alpha" }));
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    expect(directory.entries[0].name).toBe("a.md");

    const read = readZipEntry(bytes, directory.entries[0], 1024);
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.bytes)).toBe("# Alpha");
  });

  it("names the format it refuses instead of claiming the file is not an archive", async () => {
    const archive = await makeArchive({ "a.md": "# Alpha" });

    // ZIP64: the entry count does not fit into 16 bits.
    const zip64 = patchEocd(archive, (view, offset) => {
      view.setUint16(offset + 8, 0xffff, true);
      view.setUint16(offset + 10, 0xffff, true);
    });
    expect(readZipDirectory(zip64)).toEqual({ ok: false, reason: "zip64" });

    // A split archive: the entries live on another disk.
    const split = patchEocd(archive, (view, offset) => {
      view.setUint16(offset + 4, 1, true);
    });
    expect(readZipDirectory(split)).toEqual({ ok: false, reason: "split" });

    // A password-protected entry.
    const encrypted = new Uint8Array(archive);
    const view = new DataView(encrypted.buffer);
    for (let offset = 0; offset + 46 <= encrypted.length; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      view.setUint16(offset + 8, 0x0001, true);
      break;
    }
    expect(readZipDirectory(encrypted)).toEqual({ ok: false, reason: "encrypted" });
  });
});

describe("readZipEntry()", () => {
  it("reads the content of an entry", async () => {
    const bytes = await makeArchive({ "a.md": "# Alpha" });
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    const read = readZipEntry(bytes, directory.entries[0], 1024);
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.bytes)).toBe("# Alpha");
  });

  it("refuses an entry that expands past the limit", async () => {
    const bytes = await makeArchive({ "big.md": "x".repeat(64 * 1024) });
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    const read = readZipEntry(bytes, directory.entries[0], 1024);
    expect(read).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses an entry that under-declares its size — the cap is on the real bytes", async () => {
    const bytes = underDeclare(await makeArchive({ "big.md": "x".repeat(64 * 1024) }), 16);
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    // The archive claims 16 bytes; the reader must not believe it.
    expect(directory.entries[0].uncompressedSize).toBe(16);
    const read = readZipEntry(bytes, directory.entries[0], 1024);
    expect(read).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses an entry whose stored data is larger than the limit", async () => {
    const bytes = await makeArchive({ "big.md": "x".repeat(64 * 1024) }, "STORE");
    const directory = readZipDirectory(bytes);
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;
    const read = readZipEntry(bytes, directory.entries[0], 1024);
    expect(read).toEqual({ ok: false, reason: "too-large" });
  });
});
