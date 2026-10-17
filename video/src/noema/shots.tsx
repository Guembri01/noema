import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { PageCam, type CamKey } from "../lib/PageCam";
import {
  Caption,
  Card,
  Grain,
  Kicker,
  Stage,
  easeCamera,
  easeSmooth,
  easeSpring,
  useEnter,
} from "../lib/ui";
import { FONT, MONO, NOEMA, RADIUS, SHADOW, TYPE } from "../lib/theme";
import { layout, textureH } from "../textures";

/* -------------------------------------------------------------------------- *
 * A page under the camera
 * -------------------------------------------------------------------------- */

/**
 * The workhorse: a real captured page with a 2.5D camera over it. Every feature
 * that is *a surface* (a database, the tracker, a cycle, settings) is this shot
 * with different keys — which is what keeps the film feeling like one product
 * rather than a montage of unrelated effects.
 */
export const PageShot: React.FC<{
  texture: string;
  keys: CamKey[];
  caption?: React.ReactNode;
  captionDelay?: number;
  /** Page-space overlays. */
  children?: React.ReactNode;
  /** Screen-space overlays, above the camera. */
  overlay?: React.ReactNode;
  filter?: string;
  background?: string;
}> = ({ texture, keys, caption, captionDelay = 8, children, overlay, filter, background }) => (
  <AbsoluteFill>
    <PageCam
      src={layout(texture).texture.file}
      pageH={textureH(texture)}
      keys={keys}
      filter={filter}
      background={background}
    >
      {children}
    </PageCam>
    {overlay}
    {caption ? <Caption delay={captionDelay}>{caption}</Caption> : null}
    <Grain />
  </AbsoluteFill>
);

/* -------------------------------------------------------------------------- *
 * Cold open — three flashes, then the name
 * -------------------------------------------------------------------------- */

/**
 * `trailer-grammar-moves`: three of the most striking surfaces, one beat each,
 * before the film says its own name. Each cut lands on the app's own white so
 * the flashes read as the product blinking rather than as a hard montage.
 */
export const HookCut: React.FC<{ textures: string[]; perShot?: number }> = ({ textures, perShot = 24 }) => {
  const frame = useCurrentFrame();
  const index = Math.min(textures.length - 1, Math.floor(frame / perShot));
  const local = frame - index * perShot;
  // A 3-frame white lift on each cut: the app's canvas colour, so the transition
  // is the product's own surface rather than a video effect.
  const flash = interpolate(local, [0, 3], [0.55, 0], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <PageShot
        texture={textures[index]}
        keys={[
          // Keys are per-beat, not per-shot: a single pair would push in on the
          // first cut only and leave the other two beats sitting still.
          { frame: index * perShot, cx: 1120, cy: 520, zoom: 1.34 },
          { frame: index * perShot + perShot + 4, cx: 1010, cy: 500, zoom: 1.12 },
        ]}
      />
      <AbsoluteFill style={{ backgroundColor: NOEMA.bg, opacity: flash }} />
    </AbsoluteFill>
  );
};

/* -------------------------------------------------------------------------- *
 * Brand open
 * -------------------------------------------------------------------------- */

/**
 * The wordmark press-in. R1: once the mark is fully on it holds a full second
 * before anything else moves — this is the one pause in the film that is spent
 * on the brand rather than on information.
 */
export const BrandOpen: React.FC<{ total: number; tagline: string; mark?: string }> = ({
  total,
  tagline,
  mark = "Noema",
}) => {
  const frame = useCurrentFrame();
  const markIn = useEnter(10, 26, easeSpring);
  const ruleIn = useEnter(20, 34);
  const tagIn = useEnter(34, 26);
  // Hold the finished lockup, then hand off.
  const out = interpolate(frame, [total - 20, total], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeSmooth,
  });
  return (
    <AbsoluteFill style={{ backgroundColor: NOEMA.bg, opacity: out }}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 30 }}>
          {/* The app's own page icon: a small rounded square, the way a page is
              drawn in the sidebar. */}
          <div
            style={{
              width: 74,
              height: 74,
              borderRadius: 16,
              background: NOEMA.accent,
              opacity: markIn,
              transform: `scale(${0.6 + markIn * 0.4}) rotate(${(1 - markIn) * -12}deg)`,
              boxShadow: SHADOW.lifted,
            }}
          />
          <span
            style={{
              fontFamily: FONT,
              fontSize: TYPE.wordmark,
              fontWeight: 700,
              letterSpacing: "-0.045em",
              color: NOEMA.fg,
              opacity: markIn,
              transform: `translateY(${(1 - markIn) * 26}px) scale(${0.94 + markIn * 0.06})`,
            }}
          >
            {mark}
          </span>
        </div>
        <div style={{ marginTop: 34, height: 5, width: 620 * ruleIn, background: NOEMA.border, borderRadius: 3 }}>
          <div style={{ height: "100%", width: `${ruleIn * 100}%`, background: NOEMA.accent, borderRadius: 3 }} />
        </div>
        <p
          style={{
            fontFamily: FONT,
            fontSize: 46,
            color: NOEMA.muted,
            margin: "30px 0 0",
            opacity: tagIn,
            transform: `translateY(${(1 - tagIn) * 16}px)`,
          }}
        >
          {tagline}
        </p>
      </AbsoluteFill>
      <Grain />
    </AbsoluteFill>
  );
};

/* -------------------------------------------------------------------------- *
 * A board filling itself
 * -------------------------------------------------------------------------- */

/**
 * `deck-deal-flyin` over the real board: each captured ticket card lands in its
 * own slot on the board texture (Q9 — a fly-in that ends anywhere other than the
 * slot it belongs to is a decoration, not a demonstration). Cards arrive on a
 * hard accelerating stagger, and the board rests for half a second once full
 * (R2).
 */
export const BoardDeal: React.FC<{
  texture: string;
  keys: CamKey[];
  caption?: React.ReactNode;
  cardKeys?: string[];
}> = ({ texture, keys, caption, cardKeys }) => {
  const frame = useCurrentFrame();
  const elements = layout(texture).elements;
  const names = cardKeys ?? Object.keys(elements).filter((name) => name.startsWith("card-all-"));
  const count = Math.max(1, names.length);
  return (
    <PageShot texture={texture} keys={keys} caption={caption} captionDelay={14}>
      {names.map((name, index) => {
        const slot = elements[name];
        // Accelerating stagger: later cards arrive sooner after their
        // predecessor, which is what reads as "a lot of work arriving".
        const start = 8 + (index / count) ** 0.72 * 52;
        const progress = interpolate(frame, [start, start + 26], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: easeSpring,
        });
        const lift = (1 - progress) * (140 + index * 26);
        return (
          <Img
            key={name}
            src={staticFile(slot.file)}
            style={{
              position: "absolute",
              left: slot.x,
              top: slot.y,
              width: slot.width,
              height: slot.height,
              opacity: progress,
              transform: `translate(${(1 - progress) * -90}px, ${-lift}px) rotate(${(1 - progress) * -4}deg)`,
              borderRadius: RADIUS.sm,
              boxShadow: progress > 0.6 ? SHADOW.lifted : undefined,
            }}
          />
        );
      })}
    </PageShot>
  );
};

/* -------------------------------------------------------------------------- *
 * Numbers that mean something
 * -------------------------------------------------------------------------- */

/** A label + a value that counts up, for the metric beats. */
export const Readout: React.FC<{
  label: string;
  value: number;
  suffix?: string;
  delay?: number;
  duration?: number;
  x: number;
  y: number;
  accent?: string;
}> = ({ label, value, suffix = "", delay = 0, duration = 40, x, y, accent = NOEMA.accent }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeCamera,
  });
  const shown = Math.round(value * progress);
  const enter = useEnter(delay, 20);
  return (
    <Card
      lifted
      style={{
        position: "absolute",
        left: x,
        top: y,
        padding: "22px 34px",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 24}px)`,
        minWidth: 250,
      }}
    >
      <div
        style={{
          fontFamily: FONT,
          fontSize: TYPE.label,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: NOEMA.subtle,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT,
          fontSize: 84,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: accent,
          lineHeight: 1.05,
          marginTop: 6,
        }}
      >
        {shown}
        <span style={{ fontSize: 40, color: NOEMA.muted, marginLeft: 6 }}>{suffix}</span>
      </div>
    </Card>
  );
};

/* -------------------------------------------------------------------------- *
 * The close
 * -------------------------------------------------------------------------- */

/**
 * Q8 — the ending is a launch photo, not a fade. Every surface the film showed
 * contributes one element, and they assemble around the wordmark while the
 * energy peaks, then the lockup holds.
 */
export const Outro: React.FC<{
  total: number;
  mark: string;
  line: string;
  footer: string;
  items: Array<{ file: string; x: number; y: number; w: number; from: number }>;
}> = ({ total, mark, line, footer, items }) => {
  const frame = useCurrentFrame();
  const markIn = useEnter(24, 28, easeSpring);
  const lineIn = useEnter(44, 24);
  const footerIn = useEnter(56, 24);
  const out = interpolate(frame, [total - 16, total], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeSmooth,
  });
  return (
    <AbsoluteFill style={{ backgroundColor: NOEMA.bg, opacity: out }}>
      {items.map((item, index) => {
        const start = 4 + index * 3;
        const progress = interpolate(frame, [start, start + 30], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: easeSpring,
        });
        return (
          <Img
            key={item.file + index}
            src={staticFile(item.file)}
            style={{
              position: "absolute",
              left: item.x,
              top: item.y,
              width: item.w,
              opacity: progress * 0.96,
              transform: `translate(${(1 - progress) * item.from}px, ${(1 - progress) * 40}px) rotate(${(1 - progress) * item.from * 0.06}deg)`,
              borderRadius: RADIUS.sm,
              boxShadow: SHADOW.lifted,
            }}
          />
        );
      })}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            opacity: markIn,
            transform: `scale(${0.9 + markIn * 0.1})`,
          }}
        >
          <div style={{ width: 58, height: 58, borderRadius: 14, background: NOEMA.accent }} />
          <span
            style={{
              fontFamily: FONT,
              fontSize: 168,
              fontWeight: 700,
              letterSpacing: "-0.045em",
              color: NOEMA.fg,
            }}
          >
            {mark}
          </span>
        </div>
        <p
          style={{
            fontFamily: FONT,
            fontSize: 48,
            color: NOEMA.fg,
            margin: "28px 0 0",
            opacity: lineIn,
            background: "rgba(255,255,255,0.9)",
            borderRadius: RADIUS.lg,
            padding: "14px 30px",
          }}
        >
          {line}
        </p>
        <p
          style={{
            fontFamily: MONO,
            fontSize: TYPE.label,
            color: NOEMA.muted,
            margin: "22px 0 0",
            opacity: footerIn,
            background: "rgba(255,255,255,0.9)",
            borderRadius: RADIUS.md,
            padding: "10px 22px",
          }}
        >
          {footer}
        </p>
      </AbsoluteFill>
      <Grain />
    </AbsoluteFill>
  );
};

/* -------------------------------------------------------------------------- *
 * A pull-quote over a surface
 * -------------------------------------------------------------------------- */

/** A short claim laid over the page, for the moments that need a sentence. */
export const Claim: React.FC<{ text: string; delay?: number; top?: number }> = ({ text, delay = 0, top = 128 }) => {
  const progress = useEnter(delay, 22);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top,
        display: "flex",
        justifyContent: "center",
        opacity: progress,
        transform: `translateY(${(1 - progress) * -18}px)`,
      }}
    >
      <span
        style={{
          fontFamily: FONT,
          fontSize: TYPE.caption,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: NOEMA.fg,
          background: "rgba(255,255,255,0.94)",
          border: `1px solid ${NOEMA.border}`,
          borderRadius: RADIUS.lg,
          padding: "16px 36px",
          boxShadow: SHADOW.card,
        }}
      >
        {text}
      </span>
    </div>
  );
};

/** A monospace installer line, for the desktop beat. */
export const Terminal: React.FC<{
  lines: string[];
  delay?: number;
  x: number;
  y: number;
  width?: number;
}> = ({ lines, delay = 0, x, y, width = 900 }) => {
  const frame = useCurrentFrame();
  return (
    <Card
      lifted
      style={{ position: "absolute", left: x, top: y, width, background: "#1f1f1f", border: "1px solid #333" }}
    >
      <div style={{ display: "flex", gap: 8, padding: "16px 20px", borderBottom: "1px solid #333" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
          <span key={color} style={{ width: 13, height: 13, borderRadius: 7, background: color }} />
        ))}
      </div>
      <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        {lines.map((line, index) => {
          const shown = frame > delay + index * 12;
          return (
            <div
              key={line}
              style={{
                fontFamily: MONO,
                fontSize: TYPE.label,
                color: index === 0 ? "#e8e8e8" : "#8fce9b",
                opacity: shown ? 1 : 0,
              }}
            >
              {index === 0 ? "› " : "✓ "}
              {line}
            </div>
          );
        })}
      </div>
    </Card>
  );
};

export { Stage, Kicker, Caption, easeSpring, easeCamera, easeSmooth };
