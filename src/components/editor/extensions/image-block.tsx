"use client";

import { useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import { cn } from "@/lib/utils";

/**
 * Notion-style image block.
 *
 * Extends the stock TipTap image node so `setImage()` commands, existing
 * stored documents (type "image") and HTML parsing keep working unchanged.
 * Adds the two things the stock node lacks: a caption line under the picture
 * and an alt-text editor (accessibility - the upload path only sets alt from
 * the filename).
 */
export const ImageBlock = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-caption") ?? "",
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    const { caption, ...rest } = HTMLAttributes as Record<string, unknown>;
    return [
      "img",
      {
        ...rest,
        ...(caption ? { "data-caption": String(caption) } : {}),
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

function ImageView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const [altOpen, setAltOpen] = useState(false);
  const editable = editor.isEditable;
  const attrs = node.attrs as {
    src: string;
    alt: string | null;
    title: string | null;
    caption: string;
  };
  const caption = String(attrs.caption ?? "");

  return (
    <NodeViewWrapper
      className={cn("noema-image-block", selected && "is-selected")}
      data-image-block=""
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- user uploads; alt is editable below */}
      <img
        src={attrs.src}
        alt={attrs.alt ?? ""}
        title={attrs.title ?? undefined}
        className="noema-image"
        draggable={false}
      />

      {editable ? (
        <div className="noema-image-meta" contentEditable={false}>
          <input
            className="noema-image-caption"
            value={caption}
            placeholder="Write a caption…"
            aria-label="Image caption"
            onChange={(event) => updateAttributes({ caption: event.target.value })}
          />
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
