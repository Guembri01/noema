"use client";

import { useRef, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { alignOf, alignStyle, resizeWidthPercent } from "@/lib/media";

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
 * `align` (`data-align`).
 */
export const ImageBlock = Image.extend({
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
    return ReactNodeViewRenderer(ImageView);
  },
});

type DragState = { startX: number; startPercent: number; containerWidth: number };

const ALIGNS = [
  { value: "left", label: "Align image left", icon: AlignLeft },
  { value: "center", label: "Align image center", icon: AlignCenter },
  { value: "right", label: "Align image right", icon: AlignRight },
] as const;

function ImageView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const [altOpen, setAltOpen] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
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

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!editable) return;
    const handle = event.currentTarget;
    const figure = handle.closest("[data-image-figure]") as HTMLElement | null;
    const wrapper = handle.closest("[data-image-block]") as HTMLElement | null;
    if (!figure || !wrapper) return;
    event.preventDefault();
    const containerWidth = wrapper.getBoundingClientRect().width;
    const figureWidth = figure.getBoundingClientRect().width;
    const startPercent =
      width ?? (containerWidth > 0 ? (figureWidth / containerWidth) * 100 : 100);
    dragRef.current = { startX: event.clientX, startPercent, containerWidth };
    handle.setPointerCapture(event.pointerId);
    setDragWidth(resizeWidthPercent({ startPercent, deltaX: 0, containerWidth }));
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state) return;
    setDragWidth(
      resizeWidthPercent({
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
      const next = resizeWidthPercent({
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
            aria-label="Resize image"
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
            placeholder="Write a caption…"
            aria-label="Image caption"
            onChange={(event) => updateAttributes({ caption: event.target.value })}
          />
          <span className="noema-image-align" role="group" aria-label="Image alignment">
            {ALIGNS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                data-testid={`image-align-${value}`}
                aria-label={label}
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
            Alt text
          </button>
          {altOpen && (
            <input
              className="noema-image-alt"
              value={attrs.alt ?? ""}
              placeholder="Describe this image for screen readers"
              aria-label="Alt text"
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
