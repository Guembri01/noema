/**
 * Bridge from the topbar Actions menu to the docked AI chat panel (B11).
 *
 * Any surface can open a conversation with OPEN_CHAT_EVENT; to make
 * "Use with AI" / "Translate" / "Suggest edits" actually useful we also
 * pre-fill the composer with the generated prompt (React-controlled textarea
 * via the native value setter), leaving the user one Enter away.
 */
import { OPEN_CHAT_EVENT } from "@/components/sidebar-chat";

export function sendChatPrompt(prompt: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: {} }));

  let attempts = 0;
  const prefill = () => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Ask the AI"]',
    );
    if (composer) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(composer, prompt);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.focus();
      return;
    }
    if (attempts++ < 20) setTimeout(prefill, 50);
  };
  setTimeout(prefill, 0);
}
