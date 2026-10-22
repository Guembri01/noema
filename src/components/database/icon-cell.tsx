import { EmojiPicker } from "@/components/ui/emoji-picker";
import { t } from "@/lib/i18n";

/**
 * ICON cell. The stored shape is `{ emoji }`, with a legacy `{ text }` fallback
 * so an icon saved before the picker existed still renders. The picker owns
 * per-user frecency; this cell only reads and clears the stored glyph.
 */
export function IconCell({
  propertyName,
  value,
  editable,
  locale,
  userId,
  onChange,
}: {
  propertyName: string;
  value: unknown;
  editable: boolean;
  locale: string;
  userId?: string;
  onChange: (value: { emoji: string } | null) => void;
}) {
  const record = (value ?? {}) as { emoji?: unknown; text?: unknown };
  const glyph =
    typeof record.emoji === "string"
      ? record.emoji
      : typeof record.text === "string"
        ? record.text
        : "";

  if (!editable) {
    return (
      <span
        aria-label={propertyName}
        title={glyph || undefined}
        className="min-w-0 max-w-full truncate text-muted"
      >
        {glyph || "—"}
      </span>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 items-center gap-1"
      role="group"
      aria-label={propertyName}
    >
      {glyph ? <span className="text-base leading-none">{glyph}</span> : null}
      <EmojiPicker
        locale={locale}
        userId={userId}
        storageKey="noema:emoji-frecency:icon"
        onSelect={(emoji) => onChange({ emoji })}
      />
      {glyph ? (
        <button
          type="button"
          aria-label={`${t(locale, "remove")} ${propertyName}`}
          onClick={() => onChange(null)}
          className="focus-ring text-muted hover:text-fg"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
