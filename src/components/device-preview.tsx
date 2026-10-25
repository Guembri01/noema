import type { CSSProperties, ReactNode } from "react";
import {
  describeDevice,
  devicePreviewPlan,
  type FitMode,
  type MediaSize,
} from "@/lib/animated-media";
import { cn } from "@/lib/utils";

/**
 * Device-preview surface for a media/embed block.
 *
 * The pure geometry lives in `animated-media.ts` (`devicePreviewPlan`: frame
 * registry, scaling, fit math and the `[0.25, 4]` scale guard rail). This
 * component only paints it — no device registry logic is duplicated here.
 *
 * The frame is deliberately content-agnostic: callers pass an `<img>`, a
 * `<video>`, or an iframe that already came from the embed allowlist resolver.
 * An unknown/missing `device` renders the children unwrapped, so malformed
 * stored content is never replaced by a blank static block.
 */
export type DevicePreviewProps = {
  /** Stored device id (`desktop`/`tablet`/`phone`/`watch`/`custom`). */
  device?: unknown;
  /** Zoom multiplier, clamped by the engine. */
  scale?: unknown;
  /** Natural content size, used for the fit result metadata. */
  image?: MediaSize;
  fit?: FitMode;
  maxWidth?: unknown;
  /** Accessible name; defaults to `describeDevice(frame)`. */
  label?: string;
  className?: string;
  children?: ReactNode;
};

export function DevicePreview({
  device,
  scale,
  image,
  fit,
  maxWidth,
  label,
  className,
  children,
}: DevicePreviewProps) {
  const plan = devicePreviewPlan({ device, scale, image, fit, maxWidth });
  if (!plan) return <>{children}</>;

  const { frame } = plan;
  const rootStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    maxWidth: plan.style.maxWidth,
    aspectRatio: plan.style.aspectRatio,
    borderRadius: plan.style.borderRadius,
    overflow: "hidden",
    border: "1px solid var(--border)",
    background: "var(--surface-2)",
  };
  const viewportStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    borderRadius: "inherit",
  };

  return (
    <div
      className={cn("noema-device-preview", className)}
      data-device-preview={frame.id}
      data-device={frame.id}
      data-device-fit={plan.fit ? `${plan.fit.width}x${plan.fit.height}` : undefined}
      role="group"
      aria-label={label ?? describeDevice(frame)}
      style={rootStyle}
    >
      <div className="noema-device-viewport" data-device-viewport="" style={viewportStyle}>
        {children}
      </div>
      {(frame.notches ?? []).map((notch, index) => {
        const notchStyle: CSSProperties = {
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          width: `${(notch.width / frame.width) * 100}%`,
          height: `${notch.height}px`,
          background: "var(--fg)",
          opacity: 0.14,
          borderRadius: notch.side === "top" ? "0 0 999px 999px" : "999px 999px 0 0",
          ...(notch.side === "top" ? { top: 0 } : { bottom: 0 }),
        };
        return (
          <span
            key={`${notch.side}-${index}`}
            aria-hidden="true"
            className="noema-device-notch"
            data-device-notch={notch.side}
            style={notchStyle}
          />
        );
      })}
    </div>
  );
}
