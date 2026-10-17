/**
 * Cut the README preview GIF out of the film.
 *
 * A repository-hosted MP4 cannot play inside a GitHub README: the markdown
 * sanitiser strips the `<video>` tag and raw file URLs are not served as media,
 * so a poster that links to an `.mp4` only ever opens a file page. GitHub does
 * render images, so the front page embeds a small looping GIF of the film's key
 * beats — it plays inline, signed in or out — and the caption links to the full
 * film on the release page.
 *
 *   npm run preview
 *
 * Reads `docs/Noema-demo.mp4` (the committed film, so the preview always matches
 * what ships) and writes `docs/Noema-demo-preview.gif`. Needs `ffmpeg` on PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../docs/Noema-demo.mp4", import.meta.url));
const OUT = fileURLToPath(new URL("../../docs/Noema-demo-preview.gif", import.meta.url));

/**
 * For a GIF, width and frame rate cost more than duration. 1000px is the width
 * of the README's content column, so the preview is never scaled up.
 */
const WIDTH = 1000;
const FPS = 12;
const COLORS = 128;
const BEAT_SECONDS = 1.7;

/**
 * One beat per feature area — write, structure, ship, together, own it. Offsets
 * are seconds into the film: `CARD = 72` frames (2.4 s) separates the chapter
 * cards in `src/noema/Main.tsx`'s `ORDER`, and each beat starts a little way
 * into its shot so the camera has finished moving.
 */
const BEATS = [
  { at: 4.6, label: "brand open" },
  { at: 11.6, label: "editor" },
  { at: 21.0, label: "quick find" },
  { at: 28.6, label: "database views" },
  { at: 40.2, label: "conditional formatting" },
  { at: 53.2, label: "ticket board" },
  { at: 62.6, label: "cycles" },
  { at: 75.2, label: "workspace roadmap" },
  { at: 81.2, label: "workspace chat" },
  { at: 106.2, label: "desktop build" },
  { at: 110.4, label: "outro" },
];

const ffmpeg = (args) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });

const scale = `scale=${WIDTH}:-2:flags=lanczos`;
const tmp = mkdtempSync(join(tmpdir(), "noema-preview-"));

try {
  const clips = BEATS.map((beat, index) => {
    const clip = join(tmp, `beat-${String(index).padStart(2, "0")}.mp4`);
    ffmpeg([
      "-ss", String(beat.at),
      "-t", String(BEAT_SECONDS),
      "-i", SRC,
      "-an",
      "-vf", `${scale},fps=${FPS}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
      "-pix_fmt", "yuv420p",
      clip,
    ]);
    return clip;
  });

  const list = join(tmp, "beats.txt");
  writeFileSync(list, clips.map((clip) => `file '${clip.replace(/\\/g, "/")}'`).join("\n") + "\n");
  const joined = join(tmp, "joined.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);

  const palette = join(tmp, "palette.png");
  ffmpeg(["-i", joined, "-vf", `${scale},fps=${FPS},palettegen=max_colors=${COLORS}:stats_mode=diff`, palette]);
  ffmpeg([
    "-i", joined,
    "-i", palette,
    "-lavfi", `${scale},fps=${FPS}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    "-loop", "0",
    OUT,
  ]);

  const size = statSync(OUT).size;
  console.log(`preview — ${BEATS.length} beats x ${BEAT_SECONDS}s @ ${FPS} fps, ${WIDTH}px, ${COLORS} colours`);
  console.log(`          ${(size / 1024 / 1024).toFixed(2)} MiB → docs/Noema-demo-preview.gif`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
