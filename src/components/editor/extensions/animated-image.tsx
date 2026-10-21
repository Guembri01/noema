"use client";

import { useMemo, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Download, File as FileIcon, Play, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { mediaKindOf, mediaKindAttr, fileNameOf, type MediaKind } from "@/components/editor/extensions/image-block";
import {
  GIF_MIME,
  REDUCED_MOTION_QUERY,
  isAnimatedGif,
  playbackPolicy,
  type BytesLike,
  type PlaybackPolicy,
} from "@/lib/animated-media";
import { t } from "@/lib/i18n";
import { sanitizeHref } from "@/lib/validation";

/**
 * Animated-image block. `src/lib/animated-media.ts` is the pure brain: it sniffs
 * whether an upload is really an animated GIF (`isAnimatedGif`) and decides how
 * it may play under `prefers-reduced-motion` (`playbackPolicy`). This file is the
 * thin TipTap adapter that persists that decision on the node and renders it.
 *
 * The `resolveAnimatedMediaAttrs` seam is pure and exported so the engine's
 * bytes-in → node-attributes-out contract can be tested without a DOM.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    animatedImage: {
      setAnimatedImage: (attrs?: Record<string, unknown>) => ReturnType;
    };
  }
}

/** True when the browser currently asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/** A GIF-looking source whose bytes have not been sniffed yet. */
export function looksAnimatedByExtension(src: string): boolean {
  return typeof src === "string" && /\.gif(?:$|[?#])/i.test(src);
}

/**
 * The engine→renderer seam: given an upload's bytes (when available), its MIME
 * type and the environment, sniff the animation and fold it into a playback
 * policy and the node attributes that persist it.
 */
export function resolveAnimatedMediaAttrs(input: {
  src: string;
  alt?: string;
  title?: string | null;
  mimeType?: string;
  bytes?: BytesLike;
  mediaType?: unknown;
  reducedMotion?: boolean;
  autoplay?: boolean;
}): { attrs: Record<string, unknown>; policy: PlaybackPolicy; animated: boolean } {
  const kind = mediaKindOf(input.src, input.mediaType);
  let animated = false;
  let loops: number | undefined;
  if (input.bytes !== undefined) {
    const info = isAnimatedGif(
      input.bytes,
      input.mimeType === undefined ? {} : { mimeType: input.mimeType },
    );
    animated = info.animated;
    loops = info.loops;
  } else if (kind === "image" && (input.mimeType === GIF_MIME || looksAnimatedByExtension(input.src))) {
    // No bytes to sniff yet: the MIME type or extension is the best signal.
    animated = true;
  }

  const policy = playbackPolicy({
    animated,
    reducedMotion: input.reducedMotion === true,
    autoplay: input.autoplay === true,
  });
  return {
    animated,
    policy,
    attrs: {
      src: input.src,
      alt: input.alt ?? "",
      title: input.title ?? null,
      mediaType: kind,
      animated,
      loops: loops ?? null,
      autoplay: policy.autoplay,
      showPlayControl: policy.showPlayControl,
      staticFallback: policy.staticFallback,
    },
  };
}

/** A GIF-aware image block that honours the playback policy. */
export const AnimatedImage = Node.create<{ locale: string }>({
  name: "animatedImage",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: null },
      mediaType: { default: "image" },
      /** `true` when `isAnimatedGif` confirmed more than one frame. */
      animated: { default: false },
      /** Declared loop count, or `null` when the stream carries none. */
      loops: { default: null },
      autoplay: { default: false },
      showPlayControl: { default: false },
      staticFallback: { default: false },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-animated-image]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-animated-image": "" })];
  },

  addCommands() {
    return {
      setAnimatedImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <AnimatedImageView {...props} locale={locale} />
    ));
  },
});

/**
 * The node view of the animated-media block. Exported so the rendered markup
 * (the media "file" link in particular) can be asserted without a DOM.
 */
export function AnimatedImageView({ node, deleteNode, locale }: NodeViewProps & { locale: string }) {
  const attrs = node.attrs as Record<string, unknown>;
  const kind = mediaKindAttr(attrs.mediaType) ?? mediaKindOf(String(attrs.src ?? ""), attrs.mediaType);
  const staticFallback = attrs.staticFallback === true;
  const [playing, setPlaying] = useState(!staticFallback);

  const policy = useMemo<PlaybackPolicy>(
    () => ({
      autoplay: attrs.autoplay === true,
      showPlayControl: attrs.showPlayControl === true,
      staticFallback,
    }),
    [attrs.autoplay, attrs.showPlayControl, staticFallback],
  );

  const src = String(attrs.src ?? "");
  const alt = String(attrs.alt ?? "");
  // A stored `src` is user-controlled and the media "file" block renders it
  // as an anchor href, so it must pass the shared href allowlist first. A
  // `javascript:` URL is dropped instead of becoming a clickable link.
  const fileHref = kind === "file" ? sanitizeHref(src) : null;

  return (
    <NodeViewWrapper
      className={cn("noema-animated-block", playing && "is-playing")}
      data-animated-image=""
      data-media-kind={kind}
      data-animated={attrs.animated === true ? "true" : "false"}
      data-static-fallback={staticFallback ? "true" : "false"}
    >
      <div className="noema-animated-figure" contentEditable={false}>
        {kind === "image" && (
          <>
            {(playing || !policy.staticFallback) && (
              /* eslint-disable-next-line @next/next/no-img-element -- user upload; alt editable elsewhere */
              <img className="noema-image" src={src} alt={alt} draggable={false} />
            )}
            {policy.showPlayControl && (
              <button
                type="button"
                className="noema-animated-play focus-ring u-interactive"
                aria-pressed={playing}
                aria-label={t(locale, "askWord")}
                data-testid="animated-play"
                onClick={() => setPlaying((value) => !value)}
              >
                <Play className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
        {kind === "video" && (
          <video src={src} controls preload="metadata" className="noema-media-video block max-w-full rounded-md" />
        )}
        {kind === "audio" && (
          <audio src={src} controls preload="metadata" className="noema-media-audio block w-full max-w-full" />
        )}
        {kind === "file" && fileHref !== null && (
          <a
            className="noema-media-file inline-flex max-w-full items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)] hover:bg-[var(--hover)]"
            href={fileHref}
            download={alt || fileNameOf(src)}
            target="_blank"
            rel="noreferrer noopener"
          >
            <FileIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{alt || fileNameOf(src)}</span>
            <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </a>
        )}
      </div>
      <button
        type="button"
        aria-label={t(locale, "remove")}
        className="noema-animated-remove focus-ring u-interactive"
        onClick={() => deleteNode()}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </NodeViewWrapper>
  );
}

export type { MediaKind };
