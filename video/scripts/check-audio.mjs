/**
 * Guards the film's sound design.
 *
 *   node scripts/check-audio.mjs
 *
 * The `SFX` table in `src/noema/Main.tsx` names audio files, and the audio is
 * deliberately **not** committed (it is a third-party sample pack — see
 * README.md). That makes a typo in a cue name invisible until Remotion is
 * several thousand frames into a render and dies on a 404, which is exactly what
 * happened once. This checks every name in the table against `public/audio/`
 * before the render starts, and prints how to fix a miss.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "src", "noema", "Main.tsx");
const AUDIO = join(ROOT, "public", "audio");

const source = readFileSync(MAIN, "utf8");
const referenced = [...new Set([...source.matchAll(/"([a-z0-9-]+\.mp3)"/g)].map((match) => match[1]))];

if (referenced.length === 0) {
  console.error("check-audio: no audio names found in src/noema/Main.tsx — did the SFX table move?");
  process.exit(1);
}

const present = existsSync(AUDIO) ? new Set(readdirSync(AUDIO)) : new Set();
const missing = referenced.filter((name) => !present.has(name));

if (missing.length > 0) {
  console.error(`check-audio: ${missing.length} cue(s) point at audio that is not in public/audio/:`);
  for (const name of missing) console.error(`  · ${name}`);
  console.error(
    "\nCopy them from video-shotcraft's assets/audio/sfx/ tree — see video/README.md,\n" +
      "\"Regenerating the textures\".",
  );
  process.exit(1);
}

console.log(`check-audio: OK — all ${referenced.length} cue(s) resolve in public/audio/`);
