# The Noema film

The two-minute product film: **`out/noema-promo.mp4`** (1920×1080, 30 fps,
1 min 57 s).

It is a real Remotion project, not a screen recording. Every frame is composed
from captured screenshots of the running app, so the film is reproducible: change
a surface, re-capture, re-render, and the video moves with the code.

```
npm install
npm run dev            # Remotion Studio, scrubbable
npm run render         # out/noema-promo.mp4        (with music)
npm run render:nobgm   # out/noema-promo-nobgm.mp4  (music-free cut)
npm run still -- --frame=900 out/qa/frame.png
npm run preview        # docs/Noema-demo-preview.gif — the README's looping preview
npm run check:audio    # every cue name resolves in public/audio/
npm run typecheck
```

`npm run preview` cuts the front page's animated GIF out of
`docs/Noema-demo.mp4` with `ffmpeg`. The README needs it because GitHub will not
play a repository-hosted MP4 inline: the `<video>` tag is stripped and raw file
URLs are not served as media, so the preview is an image — which always renders —
and the caption links to the full film.

`render` runs `check:audio` first. The audio is not committed, so a typo in a cue
name is otherwise invisible until Remotion is several thousand frames in and dies
on a 404 — which is how that check came to exist.

The reasoning behind the film — brief, direction, feature→shot mapping, storyboard
and the review table — is in [`DESIGN.md`](./DESIGN.md).

## Regenerating the textures

The film does not screenshot the app itself. `scripts/capture.mjs` does, and it
needs the app running against a **seeded** database:

```bash
# in the repository root
npm start -- --port 3200
node video/scripts/capture.mjs               # every texture
node video/scripts/capture.mjs --only db-    # a subset
node video/scripts/capture.mjs --list        # names and routes, no browser
node video/scripts/capture.mjs --explore /w/demo-workspace/tickets
```

It drives the installed Edge (`--channel msedge`) and writes, per surface:

| Output | What it is |
| --- | --- |
| `public/textures/<name>.png` | the page at **2×**, which is what keeps text sharp under a push-in |
| `public/textures/<name>.layout.json` | the page box, the scroll offset, and the box of every element a shot animates on its own |
| `public/cutouts/<name>--<element>.png` | those elements, cropped at 2× — ticket cards, a cycle card, a project card, the sidebar |

`public/textures/`, `public/cutouts/` and `public/audio/` are **not committed**:
they are either generated (the first two) or third-party sample packs (the last).
To rebuild the audio, copy the files listed in `src/noema/Main.tsx`'s `SFX` table
out of [`video-shotcraft`](https://github.com/Vincentwei1021/video-shotcraft)'s
`assets/audio/` (its `sfx/` tree and `bgm/bgm-tech-house.mp3`) into
`public/audio/`, renaming the BGM to `bgm.mp3`.

## How it is put together

```
src/noema/Main.tsx    the film: ORDER (the edit), CHAPTERS (copy), SFX (sound),
                      ENTRY_MOVE (which shot enters on which transition), the
                      four-segment music bed
src/noema/shots.tsx   the scene engines — PageShot, HookCut, BrandOpen,
                      BoardDeal, Readout, Outro, Claim, Terminal
src/lib/motion.tsx    Transition (the eight entry moves), Land (an element
                      lifted into its own slot), Rail (the "03/07" strip)
src/lib/PageCam.tsx   the 2.5D camera over a captured page
src/lib/ui.tsx        Caption, TitleCard, Pill, Card, Grain
src/lib/theme.ts      the film's design tokens
src/textures.ts       the captured layouts, typed
```

Four rules hold it together:

1. **One source of truth for time.** `ORDER` in `Main.tsx` lists every shot and
   its duration; every `from` in the film — including every sound cue — is
   derived from it. Retiming a shot moves its sound with it.
2. **The film moves like the product.** `src/lib/theme.ts` takes its palette,
   radii and both easing curves from the app's own `src/app/tokens.css` and
   `src/app/globals.css`. A cut on a different curve reads as a different product.
3. **Real pixels, and they land where they belong.** Every shot is a captured
   surface; the elements that fly in are cropped from the same capture and land on
   the coordinates recorded in its `layout.json`.
4. **The camera earns its moves.** Locked off by default. `still`, `snap` and
   `drift` are the only three, and the first cut's mistake — twenty of thirty
   shots sharing one slow push-in — is the reason `cam()` takes a `chrome` flag
   and the transition table exists.

If a still looks like an older version of the film, delete
`node_modules/.cache/webpack/` and render again: Remotion caches the bundle, and a
stale one is indistinguishable from a fresh one until you read the frames.

## Credits

The camera in `src/lib/PageCam.tsx` is adapted from
[`video-shotcraft`](https://github.com/Vincentwei1021/video-shotcraft) — the 2.5D
page camera, the CSS-`zoom`-not-`transform`-`scale` trick that keeps a push-in
sharp, and the story shape. That project is **Copyright 2026 Wei Yihao, licensed
under the Apache License 2.0**; the music and sound effects come from its audio
library under the same terms. Everything specific to Noema — the storyboard, the
copy, the design tokens, the captures, the scene engines — is this repository's.

The full notice, including the license text, is in
[`third_party/video-shotcraft-NOTICE.md`](./third_party/video-shotcraft-NOTICE.md).
