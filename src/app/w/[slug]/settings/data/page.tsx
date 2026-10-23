"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { t } from "@/lib/i18n";
import { safeAction } from "@/lib/actions-client";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsNav } from "../settings-nav";
import {
  eraseSubjectDataAction,
  loadDataControlsAction,
  type DataControlsSnapshot,
} from "@/server/actions/gdpr";

/**
 * Settings → Data & privacy (`/w/[slug]/settings/data`).
 *
 * Client shell over the GDPR server actions. It loads the subject's export
 * bundle (Art. 15) and erasure plan (Art. 17), lets the operator mark records
 * as under legal hold and re-previews the plan, downloads the export as JSON
 * (a Blob — no size cap, unlike a data: URL), and finally executes the erasure.
 * Every read and write is enforced server-side (`requireUser` + workspace
 * membership in `gdpr.ts`); this component only renders what those actions
 * return.
 */
export default function DataControlsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [snapshot, setSnapshot] = useState<DataControlsSnapshot | null>(null);
  const [holds, setHolds] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const localeRef = useRef("en");

  const refresh = useCallback(
    async (holdKeys: readonly string[]) => {
      setLoading(true);
      const outcome = await safeAction(
        () => loadDataControlsAction(slug, [...holdKeys]),
        { locale: localeRef.current },
      );
      if (!outcome.ok) {
        setError(outcome.error);
      } else if (outcome.value.ok) {
        localeRef.current = outcome.value.locale;
        setSnapshot(outcome.value);
        setError(null);
      } else {
        setError(outcome.value.error);
      }
      setLoading(false);
    },
    [slug],
  );

  useEffect(() => {
    void refresh([]);
  }, [refresh]);

  function toggleHold(key: string) {
    const next = new Set(holds);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setHolds(next);
    setMessage(null);
    void refresh([...next]);
  }

  function downloadExport() {
    if (!snapshot) return;
    const blob = new Blob([snapshot.exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = snapshot.exportFileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function executeErasure() {
    if (!snapshot || confirmText !== "ERASE") return;
    setBusy(true);
    setError(null);
    const outcome = await safeAction(
      () => eraseSubjectDataAction(slug, [...holds]),
      { locale: localeRef.current },
    );
    if (!outcome.ok) {
      setError(outcome.error);
    } else if (outcome.value.ok) {
      setMessage(outcome.value.summary.text);
    } else {
      setError(outcome.value.error);
    }
    setBusy(false);
    setConfirmText("");
    void refresh([]);
  }

  const redactedPreview = useMemo(
    () => snapshot?.redacted.entries.slice(0, 8) ?? [],
    [snapshot],
  );
  const counts = snapshot
    ? Object.entries(snapshot.exportCounts).filter(([, count]) => count > 0)
    : [];

  // The snapshot carries the viewer's locale (returned by the load action); the
  // first paint falls back to the default catalogue.
  const locale = snapshot?.locale ?? "en";

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Link
        href={`/w/${slug}/settings`}
        className="focus-ring rounded-sm text-xs text-muted hover:underline"
      >
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">Data &amp; privacy</h1>
      <p className="mb-6 text-sm text-muted">
        Your personal data under GDPR: download everything held about you (Art. 15), preview the
        erasure that would remove it, and execute that erasure (Art. 17). Records under legal hold
        are always retained.
      </p>

      <SettingsNav slug={slug} locale={locale} className="mb-8" />

      {error && (
        <p role="alert" className="mb-4 rounded-card border border-danger/40 bg-danger-soft px-3 py-2 text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-4 rounded-card border border-border bg-surface-2 px-3 py-2 text-sm">
          {message}
        </p>
      )}

      {loading && !snapshot && (
        <div className="mt-8 flex flex-col gap-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading…</span>
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="table" rows={4} cols={2} />
        </div>
      )}

      {snapshot && (
        <>
          <Section className="mt-8" title="Export (Art. 15)">
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm">
                {snapshot.records.length} record{snapshot.records.length === 1 ? "" : "s"} across{" "}
                {counts.length} personal-data {counts.length === 1 ? "entity" : "entities"}.
              </p>
              {counts.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  {counts.map(([entity, count]) => (
                    <li key={entity}>
                      <span className="font-medium text-fg">{entity}</span>: {count}
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={downloadExport}
                className="focus-ring u-interactive mt-4 inline-flex h-9 items-center rounded-control border border-border px-3 text-sm hover:bg-surface-2"
              >
                Download export (JSON)
              </button>

              {redactedPreview.length > 0 && (
                <details className="mt-4 text-xs text-muted">
                  <summary className="cursor-pointer">Redacted preview (safe to share)</summary>
                  <ul className="mt-2 space-y-1">
                    {redactedPreview.map((entry) => (
                      <li key={`${entry.entity}:${entry.id}`} className="font-mono">
                        {entry.entity}/{entry.id}: {Object.keys(entry.fields).length} field(s)
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </Section>

          <Section className="mt-10" title="Erasure plan (Art. 17)">
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm">{snapshot.summary.text}</p>
              <p className="mt-1 text-xs text-muted">
                {snapshot.validation.ok
                  ? `Plan validated: ${snapshot.validation.checked} personal field(s) covered.`
                  : `Plan invalid (${snapshot.validation.errors.length} issue(s)).`}
              </p>

              <ul className="mt-4 divide-y divide-border rounded-card border border-border">
                {snapshot.records.map((record) => (
                  <li key={record.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={holds.has(record.key)}
                      onChange={() => toggleHold(record.key)}
                      aria-label={`${t(locale, "legalHoldFor")} ${record.key}`}
                    />
                    <span className="w-20 shrink-0 text-xs uppercase text-muted">{record.entity}</span>
                    <span className="min-w-0 flex-1 truncate" title={record.key}>
                      {record.label}
                    </span>
                    {holds.has(record.key) && (
                      <span className="shrink-0 text-xs text-warning">legal hold</span>
                    )}
                  </li>
                ))}
                {snapshot.records.length === 0 && (
                  <li className="px-3 py-2 text-sm text-muted">No personal records found.</li>
                )}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Checked records are treated as under legal hold: they are retained and never erased.
              </p>

              <div className="mt-5 rounded-card border border-danger/40 p-3">
                <p className="text-sm font-medium">Erase my personal data</p>
                <p className="mt-1 text-xs text-muted">
                  This applies the plan above in one transaction. It cannot be undone. Type{" "}
                  <strong>ERASE</strong> to confirm.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    placeholder={t(locale, "eraseWord")}
                    aria-label={t(locale, "typeEraseToConfirm")}
                    className="focus-ring h-9 rounded-control border-control bg-bg px-2 text-sm text-fg"
                  />
                  <button
                    type="button"
                    disabled={busy || confirmText !== "ERASE"}
                    onClick={executeErasure}
                    aria-label={t(locale, "eraseData")}
                    className="focus-ring u-interactive inline-flex h-9 items-center rounded-control border border-danger/60 px-3 text-sm text-danger hover:bg-danger-soft disabled:opacity-40"
                  >
                    {busy ? "Erasing…" : "Erase data"}
                  </button>
                </div>
              </div>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
