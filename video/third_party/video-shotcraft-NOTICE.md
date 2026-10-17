# Third-party notices for the film

The film is part of Noema, which is MIT-licensed (see [`../../LICENSE`](../../LICENSE)).
It also borrows from one Apache-2.0 project, which is why this file exists.

---

## video-shotcraft

- **Project** https://github.com/Vincentwei1021/video-shotcraft
- **Copyright** 2026 Wei Yihao
- **License** Apache License 2.0 — full text in
  [`video-shotcraft-LICENSE.txt`](./video-shotcraft-LICENSE.txt)

**What is used, and what changed.** `src/lib/PageCam.tsx` is adapted from that
project's 2.5D page camera. The adaptation keeps its central technique —
magnification is the CSS `zoom` property rather than `scale()` in the transform
chain, because `scale()` makes Chromium rasterise at layout size and GPU-upscale,
which is what makes most screenshot push-ins look soft — and its camera-key model.

The following were changed for this film:

- camera keys are expressed as a **fraction of the page** (`cam(texture, zoom, fx,
  fy)`) and clamped to the texture box, so a key can never pan off the image;
- the easing set is Noema's own (`src/lib/theme.ts`, derived from the app's
  `src/app/tokens.css`);
- the flat (non-3D) path is this repository's.

**Assets.** The music and sound effects under `public/audio/` are copied from that
project's audio library, under the same license. They are **not** committed to this
repository (see [`../README.md`](../README.md)); the render expects them to be
placed there. No other assets are taken from it: every screenshot in the film is
captured from this repository's own application.

**What is not used.** The storyboard, the copy, the captions, the design tokens,
the scene engines, the capture harness and the edit are original to Noema. The
shot *vocabulary* of that project informed the planning document
([`../DESIGN.md`](../DESIGN.md)) but none of its shot code or content is copied.
