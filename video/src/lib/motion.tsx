/**
 * The film's motion-design layer.
 *
 * The first cut of this film gave almost every surface the same slow push-in —
 * twenty shots in a row on one move, which stops reading as camera work and
 * starts reading as one long zoom. That is the template answer, and it is what
 * this file exists to replace.
 *
 * Motion design is variety: the camera is now used on a handful of shots, and
 * everything else is carried by a *transition* (a designed reveal at the cut), an
 * element landing in its real slot, or a reveal inside the shot. So the pieces
 * here are:
 *
 *   · `Transition` — the entry move at the head of a shot. Eight variants, all
 *     built from the app's own canvas colour and accent, so a wipe reads as the
 *     product's surface moving rather than as a video effect laid on top.
 *   · `Land` — a captured cutout flying into the slot it actually belongs to.
 *     Q9: a fly-in that ends anywhere else is a decoration, not a demonstration.
 *   · `Rail` — a segmented progress strip, so a shot that cycles seven views
 *     tells the viewer how far through it is.
 */
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { NOEMA, RADIUS, SHADOW } from "./theme";
import { bandMask, easeCamera, easeSmooth, easeSpring } from "./ui";
import { layout } from "../textures";

/* -------------------------------------------------------------------------- *
 * Entry transitions
 * -------------------------------------------------------------------------- */

export type TransitionName =
  | "none"
  /** Five horizontal strips sliding down. */
  | "blinds"
  /** Five vertical strips sliding right. */
  | "columns"
  /** A hard edge travelling right, with an accent leading line. */
  | "edgeR"
  | "edgeL"
  | "edgeU"
  | "edgeD"
  /** A circular aperture opening from the centre. */
  | "iris"
  /** The frame slides in as a panel, shadowed on its leading edge. */
  | "slideR"
  | "slideL"
  /** Scales down from 1.06. Reads as the page settling under the lens. */
  | "settle"
  /** Scales up from 0.975 with the app's settle curve. A snap-in. */
  | "press";

/** How long each variant takes. Snappy: a wipe that lingers is a dissolve. */
const ENTRY: Record<TransitionName, number> = {
  none: 0,
  blinds: 12,
  columns: 12,
  edgeR: 11,
  edgeL: 11,
  edgeU: 11,
  edgeD: 11,
  iris: 14,
  slideR: 15,
  slideL: 15,
  settle: 16,
  press: 9,
};

const isEdge = (name: TransitionName) => name.startsWith("edge");

export const Transition: React.FC<{
  name: TransitionName;
  /** Frames; defaults to the variant's own length. */
  duration?: number;
  /** The surface the reveal happens on — the app's canvas unless told otherwise. */
  background?: string;
  children: React.ReactNode;
}> = ({ name, duration, background = NOEMA.bg, children }) => {
  const frame = useCurrentFrame();
  const total = duration ?? ENTRY[name];
  const p = interpolate(frame, [0, Math.max(1, total)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: name === "press" ? easeSpring : name === "settle" ? easeCamera : easeSmooth,
  });

  if (name === "none" || total === 0) {
    return <AbsoluteFill style={{ backgroundColor: background }}>{children}</AbsoluteFill>;
  }

  let clip: string | undefined;
  let transform: string | undefined;
  let opacity = 1;

  if (name === "blinds") clip = bandMask("y", p, 5);
  else if (name === "columns") clip = bandMask("x", p, 5);
  else if (name === "edgeR") clip = `inset(0 ${(1 - p) * 100}% 0 0)`;
  else if (name === "edgeL") clip = `inset(0 0 0 ${(1 - p) * 100}%)`;
  else if (name === "edgeU") clip = `inset(${(1 - p) * 100}% 0 0 0)`;
  else if (name === "edgeD") clip = `inset(0 0 ${(1 - p) * 100}% 0)`;
  else if (name === "iris") clip = `circle(${p * 82}% at 50% 50%)`;
  else if (name === "slideR") {
    transform = `translateX(${(1 - p) * 9}%)`;
    opacity = 0.4 + p * 0.6;
  } else if (name === "slideL") {
    transform = `translateX(${-(1 - p) * 9}%)`;
    opacity = 0.4 + p * 0.6;
  } else if (name === "settle") {
    transform = `scale(${1.06 - p * 0.06})`;
    opacity = Math.min(1, p * 1.8);
  } else if (name === "press") {
    transform = `scale(${0.975 + p * 0.025})`;
    opacity = Math.min(1, p * 2.2);
  }

  // The leading line on a directional wipe. It is the app's accent, so the move
  // belongs to the product; without it a wipe is just a hard edge and reads as a
  // glitch rather than as a designed transition.
  const edge = isEdge(name) ? (
    <div
      style={{
        position: "absolute",
        ...(name === "edgeR" || name === "edgeL"
          ? {
              top: 0,
              bottom: 0,
              width: 5,
              [name === "edgeR" ? "left" : "right"]: `${p * 100}%`,
            }
          : {
              left: 0,
              right: 0,
              height: 5,
              [name === "edgeU" ? "top" : "bottom"]: `${p * 100}%`,
            }),
        background: NOEMA.accent,
        boxShadow: `0 0 26px 7px ${NOEMA.accentSoft}`,
        opacity: p > 0.02 && p < 0.985 ? 1 : 0,
      }}
    />
  ) : null;

  return (
    <AbsoluteFill style={{ backgroundColor: background, overflow: "hidden" }}>
      <AbsoluteFill style={{ clipPath: clip, transform, opacity }}>{children}</AbsoluteFill>
      {edge}
    </AbsoluteFill>
  );
};

/* -------------------------------------------------------------------------- *
 * An element landing in its real slot
 * -------------------------------------------------------------------------- */

/**
 * A captured cutout arriving at the coordinates it was captured from.
 *
 * `cover` is the fix for a real bug in the first cut: the board texture was
 * photographed with its cards already on it, so a "card lands here" fly-in was
 * drawing the card on top of a card that had never left — 34 landing animations
 * nobody could see. Blanking the slot in the board's own column colour first
 * (`#f7f7f5`, sampled from the texture) empties the column, so the deal is real.
 */
export const Land: React.FC<{
  texture: string;
  element: string;
  delay?: number;
  duration?: number;
  /** How far above its slot the element starts. */
  lift?: number;
  /** Horizontal offset it enters from. */
  drift?: number;
  rotate?: number;
  /** Blank the slot first, in this colour, so the animation is visible. */
  cover?: string;
  style?: React.CSSProperties;
}> = ({ texture, element, delay = 6, duration = 22, lift = 120, drift = -80, rotate = -4, cover, style }) => {
  const frame = useCurrentFrame();
  const slot = layout(texture).elements[element];
  if (!slot) return null;

  const p = interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeSpring,
  });

  return (
    <>
      {cover ? (
        <div
          style={{
            position: "absolute",
            left: slot.x - 3,
            top: slot.y - 3,
            width: slot.width + 6,
            height: slot.height + 6,
            borderRadius: RADIUS.sm + 2,
            background: cover,
          }}
        />
      ) : null}
      <Img
        src={staticFile(slot.file)}
        style={{
          position: "absolute",
          left: slot.x,
          top: slot.y,
          width: slot.width,
          height: slot.height,
          opacity: p,
          transform: `translate(${(1 - p) * drift}px, ${-(1 - p) * lift}px) rotate(${(1 - p) * rotate}deg)`,
          borderRadius: RADIUS.sm,
          boxShadow: p > 0.6 ? SHADOW.lifted : undefined,
          ...style,
        }}
      />
    </>
  );
};

/* -------------------------------------------------------------------------- *
 * A progress rail
 * -------------------------------------------------------------------------- */

/**
 * Segments that fill as a shot works through a list. Used where a shot cycles
 * through several surfaces: seven views at 36 frames each is 8 seconds of
 * unexplained cuts, and the rail is what tells the viewer they are watching one
 * feature rather than seven shots.
 */
export const Rail: React.FC<{
  total: number;
  index: number;
  /** 0 → 1 fill of the current segment. */
  progress: number;
  delay?: number;
  /** Distance from the top of the frame, centred horizontally. */
  top?: number;
}> = ({ total, index, progress, delay = 0, top = 846 }) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [delay, delay + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeSmooth,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top,
        display: "flex",
        alignItems: "center",
        gap: 12,
        opacity: enter,
        transform: `translate(-50%, ${(1 - enter) * 14}px)`,
      }}
    >
      <span
        style={{
          fontFamily: "'ui-monospace', SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 30,
          color: NOEMA.muted,
          marginRight: 4,
          letterSpacing: "0.02em",
        }}
      >
        {String(index + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}
      </span>
      {Array.from({ length: total }, (_, segment) => (
        <span
          key={segment}
          style={{
            width: 62,
            height: 8,
            borderRadius: 4,
            background: NOEMA.surface3,
            overflow: "hidden",
            display: "block",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${segment < index ? 100 : segment === index ? progress * 100 : 0}%`,
              background: NOEMA.accent,
              borderRadius: 4,
            }}
          />
        </span>
      ))}
    </div>
  );
};
