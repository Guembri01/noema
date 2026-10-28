/**
 * URL construction for the live workspace search. Kept pure so the debounce
 * component and the tests agree on how an empty query and the type filter are
 * encoded.
 */
export function searchHref(
  pathname: string,
  query: string,
  type?: string | null,
): string {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed !== "") params.set("q", trimmed);
  if (type) params.set("type", type);
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}
