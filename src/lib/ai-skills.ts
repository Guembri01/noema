/**
 * Reusable AI "skills" — the preset prompts surfaced in the editor's action
 * menu (Notion-style: improve writing, proofread, explain, reformat…).
 * Keeping them here means the toolbar, the command palette and any future
 * automation all use the same wording.
 */

export type AiSkillId =
  | "improve"
  | "proofread"
  | "explain"
  | "reformat"
  | "summarize"
  | "shorten"
  | "translate";

export type AiSkill = {
  id: AiSkillId;
  label: string;
  hint: string;
  prompt: (text: string) => string;
  /** Skills that rewrite the selection replace it; the others append. */
  replacesSelection: boolean;
};

export const AI_SKILLS: AiSkill[] = [
  {
    id: "improve",
    label: "Improve writing",
    hint: "Clearer, more confident prose",
    replacesSelection: true,
    prompt: (text) =>
      `Improve the writing of the text below. Keep the meaning and the language, fix flow and wordiness, and return only the rewritten text.\n\n${text}`,
  },
  {
    id: "proofread",
    label: "Proofread",
    hint: "Fix spelling and grammar",
    replacesSelection: true,
    prompt: (text) =>
      `Proofread the text below. Fix spelling, grammar and punctuation without changing the voice, and return only the corrected text.\n\n${text}`,
  },
  {
    id: "reformat",
    label: "Reformat",
    hint: "Neaten the structure",
    replacesSelection: true,
    prompt: (text) =>
      `Reformat the text below as clean Markdown: short paragraphs, headings and bullet lists where they help. Return only the reformatted Markdown.\n\n${text}`,
  },
  {
    id: "shorten",
    label: "Make shorter",
    hint: "Tighter, same meaning",
    replacesSelection: true,
    prompt: (text) =>
      `Make the text below noticeably shorter while keeping every fact. Return only the shortened text.\n\n${text}`,
  },
  {
    id: "explain",
    label: "Explain",
    hint: "Plain-language explanation",
    replacesSelection: false,
    prompt: (text) =>
      `Explain the text below in plain language for a newcomer. Keep it under 120 words.\n\n${text}`,
  },
  {
    id: "summarize",
    label: "Summarize",
    hint: "Key points only",
    replacesSelection: false,
    prompt: (text) =>
      `Summarize the text below as 3–6 short bullet points.\n\n${text}`,
  },
  {
    id: "translate",
    label: "Translate",
    hint: "Translate to English",
    replacesSelection: true,
    prompt: (text) =>
      `Translate the text below into English, preserving formatting and tone. Return only the translation.\n\n${text}`,
  },
];

export function aiSkill(id: AiSkillId): AiSkill | undefined {
  return AI_SKILLS.find((skill) => skill.id === id);
}
