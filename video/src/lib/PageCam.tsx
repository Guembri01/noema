/**
 * Adapted from video-shotcraft — https://github.com/Vincentwei1021/video-shotcraft
 * Copyright 2026 Wei Yihao, licensed under the Apache License 2.0.
 *
 * Changed for this film: the camera keys are expressed as a fraction of the page
 * (`cam(texture, zoom, fx, fy)`) and clamped to the texture box, so a key can
 * never pan off the image; the easing set and the flat path are this repository's.
 * See ../third_party/video-shotcraft-NOTICE.md for the full notice.
 */
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { EASE, NOEMA } from "./theme";

export type CamKey = {
  /** Frame, relative to the shot. */
  frame: number;
  /** Page-space CSS point that ends up at the centre of the 1920x1080 frame. */
  cx: number;
  cy: number;
  /** 1 = one CSS px of the page per output px. */
  zoom: number;
  /** deg, tilt about the horizontal axis (positive = top leans away). */
  rotX?: number;
  /** deg, tilt about the vertical axis (positive = right edge recedes). */
  rotY?: number;
  /** deg, in-plane roll. */
  rotZ?: number;
  /** px, perspective strength (default 1400; smaller = stronger). */
  persp?: number;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 2.5D camera over a captured page texture.
 *
 * `(cx, cy)` is the texture-space CSS point centred in the frame and `zoom` is
 * scale (1 CSS px → 1 output px). Textures are captured at 2x
 * (`video/scripts/capture.mjs`), so they are laid out at CSS size and the extra
 * pixels are what a push-in resolves against — a 1x texture goes soft the moment
 * the camera moves, which is the single most common way a shot like this reads
 * as cheap.
 *
 * Adapted from `video-shotcraft`'s `PageCam` (MIT), minus its theme indirection:
 * this film has one theme, and it is the app's.
 */
export const PageCam: React.FC<{
  /** Path under `public/`, e.g. `textures/db-table.png`. */
  src: string;
  /** CSS height of the texture (2x PNG height ÷ 2). */
  pageH: number;
  keys: CamKey[];
  /** Page-space overlays, positioned in CSS px. */
  children?: React.ReactNode;
  ease?: (t: number) => number;
  background?: string;
  /** CSS filter on the page plane, e.g. a slight desaturation behind a panel. */
  filter?: string;
}> = ({
  src,
  pageH,
  keys,
  children,
  ease = Easing.bezier(...EASE.camera),
  background = NOEMA.bg,
  filter,
}) => {
  const frame = useCurrentFrame();
  const pageW = 1920;

  let a = keys[0];
  let b = keys[keys.length - 1];
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (frame >= keys[index].frame && frame <= keys[index + 1].frame) {
      a = keys[index];
      b = keys[index + 1];
      break;
    }
  }
  const t =
    a.frame === b.frame
      ? 1
      : interpolate(frame, [a.frame, b.frame], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        });
  const cx = lerp(a.cx, b.cx, t);
  const cy = lerp(a.cy, b.cy, t);
  const zoom = lerp(a.zoom, b.zoom, t);

  const has3D = keys.some(
    (key) => key.rotX !== undefined || key.rotY !== undefined || key.rotZ !== undefined || key.persp !== undefined,
  );

  if (!has3D) {
    return (
      <AbsoluteFill style={{ overflow: "hidden", backgroundColor: background }}>
        <div
          style={{
            position: "absolute",
            width: pageW,
            height: pageH,
            transform: `translate(${960 - cx * zoom}px, ${540 - cy * zoom}px) scale(${zoom})`,
            transformOrigin: "0 0",
            filter,
          }}
        >
          <Img src={staticFile(src)} style={{ position: "absolute", width: pageW, height: pageH }} />
          {children}
        </div>
      </AbsoluteFill>
    );
  }

  const rotX = lerp(a.rotX ?? 0, b.rotX ?? 0, t);
  const rotY = lerp(a.rotY ?? 0, b.rotY ?? 0, t);
  const rotZ = lerp(a.rotZ ?? 0, b.rotZ ?? 0, t);
  const persp = lerp(a.persp ?? 1400, b.persp ?? 1400, t);

  // Magnification is the CSS `zoom` property, not `scale()` in the transform
  // chain. `scale()` makes Chromium rasterise the 3D layer at 1920-wide layout
  // size and then GPU-upscale it, so every glyph inside is downsampled before it
  // is magnified and the push-in is blurry. `zoom` enlarges the layout box, so
  // the texture rasterises at the enlarged device size and samples down from its
  // 2x source — sharp edges under perspective.
  //
  // `zoom` scales the local coordinate space, so to land the focal point (cx,cy)
  // at the frame centre: cx*zoom + Tx*zoom = 960 ⟹ Tx = 960/zoom - cx.
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: background }}>
      <div style={{ position: "absolute", inset: 0, perspective: `${persp * zoom}px`, perspectiveOrigin: "960px 540px" }}>
        <div
          style={{
            position: "absolute",
            width: pageW,
            height: pageH,
            zoom,
            transform: `translate(${960 / zoom - cx}px, ${540 / zoom - cy}px) rotateY(${rotY}deg) rotateX(${rotX}deg) rotateZ(${rotZ}deg)`,
            transformOrigin: `${cx}px ${cy}px`,
            transformStyle: "preserve-3d",
            filter,
          }}
        >
          <Img src={staticFile(src)} style={{ position: "absolute", width: pageW, height: pageH }} />
          {children}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/**
 * The camera bounds for a texture, so a key can never pan off the edge of the
 * image and reveal the background mid-shot. For a viewport capture the box is
 * small (zoom must exceed 1 for the camera to move at all); for a full-page
 * capture `cy` may travel the length of the document.
 */
export function camBounds(pageH: number, zoom: number, pageW = 1920) {
  const halfW = 960 / zoom;
  const halfH = 540 / zoom;
  return {
    minX: halfW,
    maxX: pageW - halfW,
    minY: halfH,
    maxY: pageH - halfH,
  };
}
