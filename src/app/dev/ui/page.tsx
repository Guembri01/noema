import { notFound } from "next/navigation";
import { DesignGallery } from "./design-gallery";

/**
 * Internal design gallery — `/dev/ui`.
 *
 * A development-only surface that renders **every** primitive in
 * `src/components/ui/`, in every state they document, on one screen. It exists
 * so the whole system can be reviewed (and screenshot) in light, dark and
 * high-contrast at once.
 *
 * Guard: it renders only while `NODE_ENV !== "production"`; a production build
 * calls `notFound()`, so the route can never ship publicly. The completeness
 * test (`gallery.test.ts`) keeps the manifest in step with the primitives.
 *
 * This is the only route file; the gallery itself is a local client component.
 */
export const metadata = {
  title: "Design system gallery",
  robots: { index: false, follow: false },
};

export default function DevUiPage() {
  if (process.env.NODE_ENV !== "production") {
    return <DesignGallery />;
  }
  notFound();
}
