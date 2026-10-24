"use client";

import type { DBProperty } from "./database-types";
import { FormView } from "./form-view";
import { submitPublicFormAction } from "@/server/actions/public-form";

/**
 * Respondent renderer for a public form link. The server page has already
 * resolved the token, the view and its live properties; this wrapper only
 * turns the form's field list into the answer map the action expects.
 */
export function PublicForm({
  token,
  locale,
  properties,
  config,
}: {
  token: string;
  locale: string;
  properties: DBProperty[];
  config?: unknown;
}) {
  return (
    <FormView
      locale={locale}
      properties={properties}
      config={config}
      publicMode
      onSubmit={async (values) => {
        const answers = Object.fromEntries(
          values.map((cell) => [cell.propertyId, cell.value]),
        );
        return submitPublicFormAction(token, answers);
      }}
    />
  );
}
