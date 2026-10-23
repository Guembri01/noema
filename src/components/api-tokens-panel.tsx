"use client";

import {
  createApiTokenAction,
  revokeApiTokenAction,
  type ApiTokenSummary,
} from "@/server/actions/api-tokens";
import { ApiTokenPanelBody } from "@/components/api-token-manager";

/**
 * Scoped API-token management for the dedicated settings page.
 *
 * Unlike the inline `ApiTokenManager`, this panel lists the signed-in user's
 * tokens through `listApiTokensAction` — including the scopes each token
 * carries — and creates/revokes them through the scoped `createApiTokenAction`
 * / `revokeApiTokenAction`. The presentation itself is shared with
 * `ApiTokenManager` through `ApiTokenPanelBody`, so the two surfaces can never
 * drift; this component only injects the scoped actions.
 */
export function ApiTokensPanel({
  initialTokens,
  locale,
  now,
  loading,
}: {
  initialTokens: ApiTokenSummary[];
  locale: string;
  /** Injected clock (ms since epoch) for deterministic relative labels. */
  now?: number;
  /** Render the table skeleton instead of rows. */
  loading?: boolean;
}) {
  return (
    <ApiTokenPanelBody
      tokens={initialTokens}
      locale={locale}
      now={now}
      loading={loading}
      create={(name, scopes) => createApiTokenAction(name, scopes)}
      revoke={revokeApiTokenAction}
      title="Personal access tokens"
      data-testid="api-tokens-panel"
    />
  );
}
