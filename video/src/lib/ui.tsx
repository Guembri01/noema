import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { EASE, FONT, NOEMA, RADIUS, SHADOW, TYPE, type TagHue } from "./theme";

export const easeSmooth = Easing.bezier(...EASE.smooth);
export const easeSpring = Easing.bezier(...EASE.spring);
export const easeCamera = Easing.bezier(...EASE.camera);
export const easeInOutSoft = Easing.bezier(...EASE.inOutSoft);

/** 0 → 1 over `duration` frames, starting at `delay`, clamped at both ends. */
export function useEnter(delay = 0, duration = 24, easing = easeSmooth) {
  const frame = useCurrentFrame();
  return interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });
}

/** A frame counter, for stagger without threading an index around. */
export function useFrame() {
  return useCurrentFrame();
}

/**
 * A `polygon()` mask of `bands` parallel strips, each revealed to `p` of its own
 * thickness — the reveal behind a blinds wipe.
 *
 * The strips are traced as one polygon: the path walks across a strip's top
 * edge, down its revealed right edge, back along its bottom, up the left gutter
 * to the next strip, and so on. Those gutter segments have zero width, so the
 * fill is exactly the union of the strips, and the trace never reverses
 * direction — which keeps the non-zero fill rule happy.
 *
 * At `p = 0` the polygon is degenerate (nothing is visible) and at `p = 1` it is
 * the whole frame, so one function both reveals and completes.
 */
export function bandMask(axis: "x" | "y", p: number, bands: number) {
  const t = Math.min(1, Math.max(0, p));
  const size = 100 / bands;
  const at = (along: number, across: number) =>
    axis === "y" ? `${along}% ${across}%` : `${across}% ${along}%`;

  const points = [at(0, 0)];
  for (let index = 0; index < bands; index += 1) {
    const top = index * size;
    const bottom = top + t * size;
    points.push(at(100, top), at(100, bottom), at(0, bottom));
    if (index < bands - 1) points.push(at(0, (index + 1) * size));
  }
  return `polygon(${points.join(", ")})`;
}

/**
 * A caption. Q11: 5.2% of 1080 (56px) is the floor for anything the viewer is
 * meant to read, so this is 58px and the auxiliary line is 34px. It sits on a
 * soft white plate rather than directly on the page, because a caption over a
 * dense table is otherwise unreadable exactly where it is needed.
 *
 * The plate is *wiped* on rather than faded: a hard edge travelling across the
 * pill, with the words lifting a few pixels behind it. Fading was the first
 * cut's move for every caption in the film, and twenty-two frames of opacity is
 * exactly what makes an edit feel slow — the text is legible nine frames in, so
 * nine frames is how long the reveal takes.
 */
export const Caption: React.FC<{
  children: React.ReactNode;
  delay?: number;
  bottom?: number;
  align?: "center" | "left";
  duration?: number;
  /** Set false for a plain fade, e.g. where the plate is already established. */
  wipe?: boolean;
}> = ({ children, delay = 0, bottom = 76, align = "center", duration = 12, wipe = true }) => {
  const progress = useEnter(delay, duration, easeCamera);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom,
        display: "flex",
        justifyContent: align === "center" ? "center" : "flex-start",
        paddingLeft: align === "left" ? 140 : 0,
      }}
    >
      <span
        style={{
          display: "inline-block",
          background: "rgba(255,255,255,0.92)",
          border: `1px solid ${NOEMA.border}`,
          borderRadius: RADIUS.lg,
          padding: "16px 34px",
          boxShadow: SHADOW.card,
          backdropFilter: "blur(8px)",
          clipPath: wipe ? `inset(0 ${(1 - progress) * 100}% 0 0)` : undefined,
          opacity: wipe ? 1 : progress,
          transform: wipe ? undefined : `translateY(${(1 - progress) * 22}px)`,
        }}
      >
        <span
          style={{
            display: "inline-block",
            fontFamily: FONT,
            fontSize: TYPE.caption,
            fontWeight: 500,
            letterSpacing: "-0.01em",
            color: NOEMA.fg,
            transform: wipe ? `translateY(${(1 - progress) * 7}px)` : undefined,
          }}
        >
          {children}
        </span>
      </span>
    </div>
  );
};

/** A small all-caps label, e.g. a chapter marker or a feature name. */
export const Kicker: React.FC<{ children: React.ReactNode; color?: string; delay?: number }> = ({
  children,
  color = NOEMA.accent,
  delay = 0,
}) => {
  const progress = useEnter(delay, 20);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: TYPE.kicker,
        fontWeight: 700,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color,
        opacity: progress,
        transform: `translateY(${(1 - progress) * 14}px)`,
      }}
    >
      {children}
    </div>
  );
};

/**
 * The breathing card between chapters. Its whole job is to let the film pause:
 * the title lands, then nothing moves for a full second before the cut (R1).
 *
 * The fade is anchored to the **end of the shot** rather than to a fixed frame
 * number. It used to be hard-coded at `hold + 46`, which meant any card shorter
 * than `hold + 62` was cut off mid-fade — the first five cards hard-cut and their
 * titles held for under a second. Whatever length the edit gives a card, it now
 * holds and then leaves.
 */
export const TitleCard: React.FC<{
  index: string;
  title: string;
  subtitle?: string;
  accent?: string;
}> = ({ index, title, subtitle, accent = NOEMA.accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const titleIn = useEnter(8, 22);
  const ruleIn = useEnter(4, 24);
  const subIn = useEnter(18, 20);
  // The card's own entrance: five horizontal strips snapping down over the
  // block, so a chapter lands the way every other shot in the film does instead
  // of cross-fading while the rest of the edit wipes.
  const strips = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeSmooth,
  });
  const out = interpolate(frame, [durationInFrames - 14, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeSmooth,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: NOEMA.bg, opacity: out }}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            width: 1180,
            clipPath: bandMask("y", strips, 5),
            transform: `translateY(${(1 - strips) * 10}px)`,
          }}
        >
          <Kicker delay={4} color={accent}>
            {index}
          </Kicker>
          <div
            style={{
              marginTop: 26,
              height: 6,
              width: 148 * ruleIn,
              background: accent,
              borderRadius: 3,
            }}
          />
          <h2
            style={{
              fontFamily: FONT,
              fontSize: TYPE.cardTitle,
              lineHeight: 1.02,
              letterSpacing: "-0.03em",
              fontWeight: 700,
              color: NOEMA.fg,
              margin: "34px 0 0",
              opacity: titleIn,
              transform: `translateY(${(1 - titleIn) * 30}px)`,
            }}
          >
            {title}
          </h2>
          {subtitle ? (
            <p
              style={{
                fontFamily: FONT,
                fontSize: 40,
                lineHeight: 1.4,
                color: NOEMA.muted,
                margin: "26px 0 0",
                maxWidth: 900,
                opacity: subIn,
                transform: `translateY(${(1 - subIn) * 18}px)`,
              }}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** A label pill, in the app's tag palette. */
export const Pill: React.FC<{ hue: TagHue; children: React.ReactNode; scale?: number }> = ({
  hue,
  children,
  scale = 1,
}) => {
  const [fg, bg, bd] = NOEMA.tag[hue];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontFamily: FONT,
        fontSize: 26 * scale,
        fontWeight: 600,
        color: fg,
        background: bg,
        border: `1px solid ${bd}`,
        borderRadius: 999,
        padding: `${5 * scale}px ${16 * scale}px`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
};

/** A white surface with the app's own shadow and radius. */
export const Card: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
  lifted?: boolean;
  dark?: boolean;
}> = ({ children, style, lifted = false, dark = false }) => (
  <div
    style={{
      background: dark ? NOEMA.dark.surface : NOEMA.bg,
      border: `1px solid ${dark ? NOEMA.dark.border : NOEMA.border}`,
      borderRadius: RADIUS.lg,
      boxShadow: dark ? SHADOW.dark : lifted ? SHADOW.float : SHADOW.card,
      ...style,
    }}
  >
    {children}
  </div>
);

/**
 * Film grain, very low and multiplied. Bright UI films usually skip this; a
 * touch of it keeps large white fields from reading as flat vector and ties the
 * captured screenshots to the motion-graphics overlays. Kept under 4% so text
 * edges stay crisp.
 */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.03 }) => (
  <AbsoluteFill style={{ pointerEvents: "none", opacity, mixBlendMode: "multiply" }}>
    <svg width="100%" height="100%">
      <filter id="noema-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch" />
      </filter>
      <rect width="100%" height="100%" filter="url(#noema-grain)" />
    </svg>
  </AbsoluteFill>
);

/** The stage a shot stands on when no texture fills the frame. */
export const Stage: React.FC<{ children: React.ReactNode; dark?: boolean }> = ({ children, dark = false }) => (
  <AbsoluteFill style={{ backgroundColor: dark ? NOEMA.dark.bg : NOEMA.bg }}>{children}</AbsoluteFill>
);
