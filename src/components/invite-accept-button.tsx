"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * The submit control on an invitation card.
 *
 * Accepting an invitation is a POST (the form around this button), so the control
 * has to survive the round trip: `useFormStatus` reads the enclosing form's
 * pending state, which disables the button and shows the house spinner while the
 * server writes the membership. The label swaps to the present participle in the
 * same slot and `Button`'s `loading` carries the busy state to assistive tech, so
 * nothing shifts and the button cannot be pressed twice.
 */
export function InviteAcceptButton({ locale }: { locale: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending}>
      {t(locale, pending ? "acceptingInvitation" : "acceptInvitation")}
    </Button>
  );
}
