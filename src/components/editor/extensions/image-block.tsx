"use client";

import { useRef, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import { AlignCenter, AlignLeft, AlignRight, Download, File as FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { alignOf, alignStyle, MIN_IMAGE_WIDTH_PERCENT } from "@/lib/media";
import {
  aspectRatio,
  clampSize,
  fitContain,
  percentToPx,
  resizeByWidth,
  type Size,
} from "@/lib/image-dimensions";
import { t } from "@/lib/i18n";

/**
 * Notion-style image block.
 *
 * Extends the stock TipTap image node so `setImage()` commands, existing
 * stored documents (type "image") and HTML parsing keep working unchanged.
 * Adds what the stock node lacks: a caption line under the picture, an
 * alt-text editor (accessibility - the upload path only sets alt from the
 * filename), drag-to-resize (percent width stored on the node) and the
 * left/center/right alignment controls.
 *
 * Width is stored as a percent of the block (`width` attr, serialised as
 * `data-width`) so it survives responsive layouts; alignment is stored as
 * `align` (`data-align`). The resize-handle arithmetic is pixel geometry from
 * `src/lib/image-dimensions.ts` (ratio-preserving, clamped), rounded back to a
 * percent for the attribute.
 */
/** Image options plus the locale threaded from `page-editor.tsx`. */
type ImageBlockOptions = ImageOptions & { locale: string };

export const ImageBlock = Image.extend<ImageBlockOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      locale: "en",
    } as ImageBlockOptions;
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-caption") ?? "",
      },
      width: {
        // Percent of the content width; null = natural size.
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-width");
          if (raw === null) return null;
          const value = Number(raw);
          return Number.isFinite(value) ? value : null;
        },
      },
      align: {
        default: "left",
        parseHTML: (element) => alignOf(element.getAttribute("data-align")),
      },
      // Which element the node view renders (image/video/audio/file). Absent
      // means "infer from the src", preserving stock image documents.
      mediaType: {
        default: null,
        parseHTML: (element) => mediaKindAttr(element.getAttribute("data-media-type")),
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    const { caption, width, align, mediaType, ...rest } = HTMLAttributes as Record<string, unknown>;
    const kind = mediaKindAttr(mediaType);
    return [
      "img",
      {
        ...rest,
        ...(caption ? { "data-caption": String(caption) } : {}),
        ...(typeof width === "number" ? { "data-width": String(width) } : {}),
        ...(align ? { "data-align": String(align) } : {}),
        ...(kind ? { "data-media-type": kind } : {}),
      },
    ];
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <ImageView {...props} locale={locale} />
    ));
  },
});

type DragState = {
  startX: number;
  startPercent: number;
  containerWidth: number;
  /** Natural pixel box of the picture, captured when the drag begins. */
  intrinsic: Size;
};

/** The width window the block has always resized inside, as a percent. */
const MAX_IMAGE_WIDTH_PERCENT = 100;

/**
 * What the generalised media node view renders. The node type stays `image`
 * (so `setImage()`, stored documents and HTML parsing are untouched); the kind
 * only decides which element the node view paints.
 */
export type MediaKind = "image" | "video" | "audio" | "file";

const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "audio", "file"];

const VIDEO_EXTENSION = /\.(mp4|m4v|webm|ogv|mov)$/;
const AUDIO_EXTENSION = /\.(mp3|wav|m4a|aac|oga|ogg|flac)$/;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)$/;
const FILE_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|json|zip|rar|7z|tar|gz)$/;

/** Normalise a stored `mediaType` (an explicit declaration wins over the URL). */
export function mediaKindAttr(value: unknown): MediaKind | null {
  return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value)
    ? (value as MediaKind)
    : null;
}

/** Lower-case path of a src, without query string or fragment. */
function srcPath(src: string): string {
  return src.split(/[?#]/)[0].toLowerCase();
}

/**
 * Decide how to render a media node: an explicit `mediaType` wins, otherwise
 * infer from the URL extension. Anything unrecognised stays an image, so the
 * existing upload/setImage path keeps rendering exactly as before.
 */
export function mediaKindOf(src: string, explicit?: unknown): MediaKind {
  const forced = mediaKindAttr(explicit);
  if (forced) return forced;
  const path = srcPath(src);
  if (VIDEO_EXTENSION.test(path)) return "video";
  if (AUDIO_EXTENSION.test(path)) return "audio";
  if (IMAGE_EXTENSION.test(path)) return "image";
  if (FILE_EXTENSION.test(path)) return "file";
  return "image";
}

/** Best-effort display name for a file block, taken from the URL's last segment. */
export function fileNameOf(src: string): string {
  const segment = src.split(/[?#]/)[0].split("/").filter(Boolean).pop();
  if (!segment) return src;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Round a width into the block's `[MIN, MAX]` percent window, fail-safe. */
function clampImageWidthPercent(percent: number): number {
  if (!Number.isFinite(percent)) return MIN_IMAGE_WIDTH_PERCENT;
  return Math.min(MAX_IMAGE_WIDTH_PERCENT, Math.max(MIN_IMAGE_WIDTH_PERCENT, Math.round(percent)));
}

/**
 * One resize-drag step, driven by `src/lib/image-dimensions.ts`. The stored
 * `width` is a percent, but the drag itself is pixel geometry: the starting
 * width becomes pixels (`percentToPx`), follows the pointer, is re-derived
 * from the picture's intrinsic ratio (`resizeByWidth`, guarded by
 * `aspectRatio`) and clamped inside the content column (`clampSize`) — the
 * percent that survives is what the node persists. A picture whose intrinsic
 * size is unknown (`aspectRatio === 0`) keeps the legacy pointer-percent maths
 * so a drag never collapses it.
 */
function dragResizePercent(input: {
  intrinsic: Size;
  startPercent: number;
  deltaX: number;
  containerWidth: number;
}): number {
  const { intrinsic, startPercent, deltaX, containerWidth } = input;
  if (aspectRatio(intrinsic) <= 0 || containerWidth <= 0) {
    const travel = containerWidth > 0 ? (deltaX / containerWidth) * 100 : 0;
    return clampImageWidthPercent(startPercent + travel);
  }
  const targetPx = percentToPx(startPercent, containerWidth) + deltaX;
  const bounded = clampSize(resizeByWidth(intrinsic, targetPx), { maxW: containerWidth });
  return clampImageWidthPercent((bounded.w / containerWidth) * 100);
}

const ALIGNS = [
  { value: "left", labelKey: "imageAlignLeft", icon: AlignLeft },
  { value: "center", labelKey: "imageAlignCenter", icon: AlignCenter },
  { value: "right", labelKey: "imageAlignRight", icon: AlignRight },
] as const;

function ImageView({
  node,
  updateAttributes,
  editor,
  selected,
  locale,
}: NodeViewProps & { locale: string }) {
  const [altOpen, setAltOpen] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const editable = editor.isEditable;
  const attrs = node.attrs as {
    src: string;
    alt: string | null;
    title: string | null;
    caption: string;
    width: number | null;
    align: unknown;
    mediaType: unknown;
  };
  const caption = String(attrs.caption ?? "");
  const align = alignOf(attrs.align);
  const width = dragWidth ?? (typeof attrs.width === "number" ? attrs.width : null);
  const kind = mediaKindOf(String(attrs.src ?? ""), attrs.mediaType);

  /** The decoded picture size, or a zero box while it has not loaded. */
  const intrinsicSize = (): Size => {
    const img = imgRef.current;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { w: img.naturalWidth, h: img.naturalHeight };
    }
    return { w: 0, h: 0 };
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!editable) return;
    const handle = event.currentTarget;
    const figure = handle.closest("[data-image-figure]") as HTMLElement | null;
    const wrapper = handle.closest("[data-image-block]") as HTMLElement | null;
    if (!figure || !wrapper) return;
    event.preventDefault();
    const containerWidth = wrapper.getBoundingClientRect().width;
    const figureWidth = figure.getBoundingClientRect().width;
    const intrinsic = intrinsicSize();
    // A fresh image renders at its natural size, capped to the column
    // (`fitContain`); a stored width wins. `figureWidth` is the fallback when
    // the picture has not decoded yet.
    const natural = fitContain(intrinsic, { w: containerWidth, h: intrinsic.h });
    const startWidth = natural.w > 0 ? natural.w : figureWidth;
    const startPercent = width ?? (containerWidth > 0 ? (startWidth / containerWidth) * 100 : 100);
    dragRef.current = { startX: event.clientX, startPercent, containerWidth, intrinsic };
    handle.setPointerCapture(event.pointerId);
    setDragWidth(dragResizePercent({ intrinsic, startPercent, deltaX: 0, containerWidth }));
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state) return;
    setDragWidth(
      dragResizePercent({
        intrinsic: state.intrinsic,
        startPercent: state.startPercent,
        deltaX: event.clientX - state.startX,
        containerWidth: state.containerWidth,
      }),
    );
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const state = dragRef.current;
    if (!state) return;
    dragRef.current = null;
    setDragWidth(null);
    if (commit) {
      const next = dragResizePercent({
        intrinsic: state.intrinsic,
        startPercent: state.startPercent,
        deltaX: event.clientX - state.startX,
        containerWidth: state.containerWidth,
      });
      updateAttributes({ width: next });
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <NodeViewWrapper
      className={cn("noema-image-block", selected && "is-selected")}
      data-image-block=""
      data-media-kind={kind}
      data-width={width === null ? "" : `${width}%`}
      data-align={align}
    >
      <div
        className="noema-image-figure"
        data-image-figure=""
        style={{
          width: width === null ? "fit-content" : `${width}%`,
          ...alignStyle(align),
        }}
      >
        {kind === "image" && (
          /* eslint-disable-next-line @next/next/no-img-element -- user uploads; alt is editable below */
          <img
            ref={imgRef}
            src={attrs.src}
            alt={attrs.alt ?? ""}
            title={attrs.title ?? undefined}
            className="noema-image"
            draggable={false}
          />
        )}
        {kind === "video" && (
          <video
            src={attrs.src}
            controls
            preload="metadata"
            className="noema-media-video block max-w-full rounded-md"
            data-testid="media-video"
            aria-label={attrs.alt ?? undefined}
            title={attrs.title ?? undefined}
          />
        )}
        {kind === "audio" && (
          <audio
            src={attrs.src}
            controls
            preload="metadata"
            className="noema-media-audio block w-full max-w-full"
            data-testid="media-audio"
            aria-label={attrs.alt ?? undefined}
            title={attrs.title ?? undefined}
          />
        )}
        {kind === "file" && (
          <a
            className="noema-media-file inline-flex max-w-full items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)] hover:bg-[var(--hover)]"
            data-testid="media-file"
            href={attrs.src}
            download={attrs.alt ?? attrs.title ?? undefined}
            target="_blank"
            rel="noreferrer"
            contentEditable={false}
          >
            <FileIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="noema-media-file-name truncate">
              {attrs.alt ?? attrs.title ?? fileNameOf(String(attrs.src ?? ""))}
            </span>
            <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </a>
        )}
        {kind === "image" && editable && (
          <div
            className="noema-image-resize u-no-transition"
            data-testid="image-resize-handle"
            aria-label={t(locale, "imageResizeAria")}
            contentEditable={false}
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={(event) => endResize(event, true)}
            onPointerCancel={(event) => endResize(event, false)}
            onDoubleClick={() => updateAttributes({ width: null })}
          />
        )}
      </div>

      {editable ? (
        <div className="noema-image-meta" contentEditable={false}>
          <input
            className="noema-image-caption"
            value={caption}
            placeholder={t(locale, "imageCaptionPlaceholder")}
            aria-label={t(locale, "imageCaptionAria")}
            onChange={(event) => updateAttributes({ caption: event.target.value })}
          />
          <span className="noema-image-align" role="group" aria-label={t(locale, "imageAlignmentAria")}>
            {ALIGNS.map(({ value, labelKey, icon: Icon }) => (
              <button
                key={value}
                type="button"
                data-testid={`image-align-${value}`}
                aria-label={t(locale, labelKey)}
                aria-pressed={align === value}
                onClick={() => updateAttributes({ align: value })}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </span>
          <button
            type="button"
            className="noema-image-alt-toggle focus-ring u-interactive"
            aria-expanded={altOpen}
            onClick={() => setAltOpen((open) => !open)}
          >
            {t(locale, "imageAltText")}
          </button>
          {altOpen && (
            <input
              className="noema-image-alt"
              value={attrs.alt ?? ""}
              placeholder={t(locale, "imageAltPlaceholder")}
              aria-label={t(locale, "imageAltText")}
              onChange={(event) => updateAttributes({ alt: event.target.value })}
            />
          )}
        </div>
      ) : (
        caption.trim() !== "" && (
          <p className="noema-image-caption-view" contentEditable={false}>
            {caption}
          </p>
        )
      )}
    </NodeViewWrapper>
  );
}
