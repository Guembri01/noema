"use client";

import { useRef, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
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
    };
  },

  renderHTML({ HTMLAttributes }) {
    const { caption, width, align, ...rest } = HTMLAttributes as Record<string, unknown>;
    return [
      "img",
      {
        ...rest,
        ...(caption ? { "data-caption": String(caption) } : {}),
        ...(typeof width === "number" ? { "data-width": String(width) } : {}),
        ...(align ? { "data-align": String(align) } : {}),
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
  };
  const caption = String(attrs.caption ?? "");
  const align = alignOf(attrs.align);
  const width = dragWidth ?? (typeof attrs.width === "number" ? attrs.width : null);

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
        {/* eslint-disable-next-line @next/next/no-img-element -- user uploads; alt is editable below */}
        <img
          ref={imgRef}
          src={attrs.src}
          alt={attrs.alt ?? ""}
          title={attrs.title ?? undefined}
          className="noema-image"
          draggable={false}
        />
        {editable && (
          <div
            className="noema-image-resize"
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
            className="noema-image-alt-toggle"
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
