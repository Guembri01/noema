"use client";

import { useState } from "react";
import { DialogTitle } from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { Cell } from "@/components/database/view-parts";
import type { DBProperty, DBRow } from "@/components/database/database-types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { guarded } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  deleteRowAction,
  setPropertyValueAction,
} from "@/server/actions/database";
import { updatePageAction } from "@/server/actions/pages";
import type { LinkedDatabaseData } from "@/server/actions/linked-database";

// One transport-failure policy for every write in this dialog. `guarded` turns
// a rejected call into the same `{ error }` shape the actions already return.
const renameLinkedRow = guarded(updatePageAction);
const writeLinkedCell = guarded(setPropertyValueAction);
const deleteLinkedRow = guarded(deleteRowAction);

/**
 * Edit one linked-database row without leaving the embedding page.
 *
 * The block is an atom, so it cannot host the full table's keyboard grid. This
 * dialog reuses the database `Cell` renderer (the same editor for every
 * property type) and writes through the same actions the database screen uses.
 * A successful write asks the block to re-read its data; the dialog stays open
 * so several cells can be edited in one visit.
 */
export function LinkedRowEditor({
  row,
  data,
  workspaceId,
  locale,
  onClose,
  onSaved,
  onDeleted,
}: {
  row: LinkedDatabaseData["rows"][number];
  data: LinkedDatabaseData;
  workspaceId: string;
  locale: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...row.values,
  }));
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const properties: DBProperty[] = data.properties.map((property) => ({
    id: property.id,
    name: property.name,
    type: property.type as DBProperty["type"],
    config: (property.config ?? null) as DBProperty["config"],
  }));
  const dbRow: DBRow = {
    id: row.id,
    title: row.title,
    icon: row.icon,
    propertyValues: Object.entries(values).map(([propertyId, value]) => ({
      propertyId,
      value,
    })),
  };
  const primaryId = properties[0]?.id ?? null;

  const write = async (property: DBProperty, value: unknown) => {
    setValues((current) => ({ ...current, [property.id]: value }));
    setBusy(true);
    setError(null);
    if (property.id === primaryId) {
      const text =
        typeof value === "object" &&
        value !== null &&
        typeof (value as { text?: unknown }).text === "string"
          ? (value as { text: string }).text
          : row.title;
      const renamed = await renameLinkedRow(row.id, { title: text });
      if ("error" in renamed) {
        setError(renamed.error);
        setBusy(false);
        return;
      }
    }
    const result = await writeLinkedCell(row.id, property.id, value);
    if ("error" in result) setError(result.error);
    else onSaved();
    setBusy(false);
  };

  const remove = async () => {
    setRemoving(true);
    setError(null);
    const result = await deleteLinkedRow(row.id);
    setRemoving(false);
    if ("error" in result) {
      setError(result.error);
      setConfirmRemove(false);
      return;
    }
    onDeleted();
  };

  return (
    <>
      <Dialog open onOpenChange={(next) => !next && onClose()}>
        <DialogContent
          className="max-w-lg p-0"
          aria-labelledby="linked-row-title"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <DialogTitle id="linked-row-title" className="min-w-0 truncate text-base font-semibold">
              {t(locale, "edit")}
              {row.title ? ` · ${row.title}` : ""}
            </DialogTitle>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t(locale, "done")}
            </Button>
          </div>

          <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-3">
            {properties.map((property) => (
              <label key={property.id} className="block space-y-1">
                <span className="block text-xs font-medium text-muted">{property.name}</span>
                <div className="min-h-8 rounded-control border border-border bg-bg px-2 py-1">
                  <Cell
                    property={property}
                    value={values[property.id]}
                    editable={data.canEdit}
                    onChange={(value) => void write(property, value)}
                    locale={locale}
                    workspaceId={workspaceId}
                    peopleOptions={data.members}
                    relationOptions={data.relations[property.id] ?? []}
                    actingUserId={data.actingUserId}
                    row={dbRow}
                    properties={properties}
                  />
                </div>
              </label>
            ))}
            {properties.length === 0 && (
              <p className="text-sm text-muted">{t(locale, "dbNoRows")}</p>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              tone="soft"
              size="sm"
              className="text-danger"
              disabled={busy || removing}
              onClick={() => setConfirmRemove(true)}
            >
              {t(locale, "deleteRow")}
            </Button>
            {busy && (
              <span className="flex items-center gap-1 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t(locale, "loading")}
              </span>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t(locale, "deleteRow")}
        description={row.title}
        confirmLabel={t(locale, "delete")}
        cancelLabel={t(locale, "cancel")}
        tone="danger"
        pending={removing}
        onConfirm={() => void remove()}
      />
    </>
  );
}
