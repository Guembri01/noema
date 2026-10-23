"use client";

import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";

/**
 * Whether the editor owns the focus.
 *
 * The fixed editor bars use this to avoid hovering over body copy while the
 * page is being read on a phone. They still appear as soon as the user taps
 * into the editor, and desktop keeps them visible permanently.
 */
export function useEditorFocus(editor: Editor): boolean {
  const [focused, setFocused] = useState(editor.isFocused);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    setFocused(editor.isFocused);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
  }, [editor]);

  return focused;
}
