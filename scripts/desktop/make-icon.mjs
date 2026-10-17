#!/usr/bin/env node
/**
 * Generates `assets/icon.png` — a valid 1024x1024 PNG — so
 * `npm run desktop:icons` (npx tauri icon) always has a source.
 *
 * This is a **placeholder** so a build never fails for a missing asset: a
 * designer replaces `assets/icon.png` with the real mark and re-runs
 * `npm run desktop:icons`. The generator is dependency-free (zlib + manual PNG
 * chunks) so it works offline and in CI.
 *
 * Design: the token accent blue with an inset rounded square and a white "N"
 * drawn as five filled rectangles — enough to read at 16px in a tray.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const size = 1024;

/** CRC32 (PNG chunk checksum). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A rounded square mask, so the icon looks intentional at any size. */
function insideRoundedSquare(x, y, inset, radius) {
  const min = inset;
  const max = size - inset;
  if (x < min || y < min || x >= max || y >= max) return false;
  const cx = x < min + radius ? min + radius : x > max - radius ? max - radius : x;
  const cy = y < min + radius ? min + radius : y > max - radius ? max - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** The letter N as five strokes (left, right, diagonal), on a 0..1 grid. */
function insideN(u, v) {
  const stroke = 0.11;
  const left = u >= 0.3 && u <= 0.3 + stroke && v >= 0.28 && v <= 0.72;
  const right = u >= 0.7 - stroke && u <= 0.7 && v >= 0.28 && v <= 0.72;
  const diagonal = Math.abs(u - (0.3 + (v - 0.28))) <= stroke / 1.4 && v >= 0.28 && v <= 0.72;
  return left || right || diagonal;
}

function pixels() {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const inTile = insideRoundedSquare(x, y, 60, 180);
      const u = (x - 60) / (size - 120);
      const v = (y - 60) / (size - 120);
      const inLetter = inTile && insideN(u, v);
      // Accent blue tile, white letter, transparent outside the tile.
      const colour = inLetter ? [255, 255, 255, 255] : [26, 117, 210, 255];
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
      raw[offset + 3] = inTile ? 255 : 0;
      offset += 4;
    }
  }
  return raw;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // filter
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(pixels(), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(join(root, "assets"), { recursive: true });
const target = join(root, "assets", "icon.png");
writeFileSync(target, png);
console.log(`· wrote ${target} (${(png.length / 1024).toFixed(1)} KB, ${size}x${size} RGBA)`);
console.log("  next: npm run desktop:icons   (generates every size Tauri needs)");
