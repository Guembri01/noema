"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { invokeShell } from "@/lib/runtime-mode";
import { t } from "@/lib/i18n";

/** The subset of `desktop_info` this dialog renders (see `src-tauri/src/commands.rs`). */
type DesktopInfo = {
  app_version?: string;
  platform?: string;
  arch?: string;
  api_base?: string;
  data_dir?: string;
  port?: number | null;
  log_file?: string | null;
  /** Already redacted by the shell: the password is replaced with `***`. */
  database_url?: string;
  ready?: boolean;
};

/** One `label: value` line; a missing value says so instead of rendering blank. */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-all font-mono text-xs">{value && value !== "" ? value : "—"}</dd>
    </div>
  );
}

/**
 * The desktop shell's own diagnostics, shown in the app.
 *
 * Until now the only way to see any of this was the shell's bootstrap page,
 * which is exactly the page you cannot reach once the app is running — so
 * "Diagnostics…" in the Data menu opened nothing at all.
 *
 * Everything here comes from two commands (`desktop_info`, `recent_logs`) and
 * the connection string arrives already redacted: the shell strips the password
 * before the value leaves it, so pasting the panel into an issue is safe.
 *
 * The data is fetched when the dialog opens rather than kept live: the point is
 * a snapshot to read or paste, and a poll would re-render the log tail under
 * whoever is trying to select it.
 */
export function DiagnosticsDialog({
  open,
  onClose,
  locale = "en",
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}) {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState("loading");
    setCopied(false);
    const infoCall = invokeShell("desktop_info");
    const logsCall = invokeShell("recent_logs", { limit: 60 });
    void Promise.all([
      infoCall ?? Promise.resolve(null),
      logsCall ?? Promise.resolve(null),
    ])
      .then(([rawInfo, rawLogs]) => {
        if (cancelled) return;
        if (!rawInfo || typeof rawInfo !== "object") {
          setState("failed");
          return;
        }
        setInfo(rawInfo as DesktopInfo);
        setLogs(Array.isArray(rawLogs) ? rawLogs.filter((l): l is string => typeof l === "string") : []);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const copy = async () => {
    // The same payload the bootstrap page copies, so a report looks the same
    // whichever surface the user reached.
    const payload = `${JSON.stringify(info, null, 2)}\n\n${logs.join("\n")}`;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        className="w-full max-w-2xl rounded-overlay border border-border bg-bg p-4 shadow-2xl"
        aria-label={t(locale, "diagnostics")}
      >
        <h2 className="text-base font-semibold">{t(locale, "diagnostics")}</h2>
        <p className="mt-1 text-xs text-muted">{t(locale, "diagnosticsIntro")}</p>

        {state === "failed" ? (
          <p className="mt-4 text-sm text-danger" role="alert">
            {t(locale, "diagnosticsFailed")}
          </p>
        ) : (
          <dl className="mt-3 divide-y divide-border">
            <Row label="Version" value={info?.app_version} />
            <Row label="Platform" value={info?.platform} />
            <Row label="API base" value={info?.api_base} />
            <Row label="Port" value={info?.port == null ? null : String(info.port)} />
            <Row label="Data folder" value={info?.data_dir} />
            <Row label="Log file" value={info?.log_file} />
            <Row label="Database" value={info?.database_url} />
          </dl>
        )}

        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
          Recent log
        </h3>
        <pre
          data-testid="diagnostics-log"
          className="mt-2 max-h-56 overflow-auto rounded-control border border-border bg-surface p-2 font-mono text-2xs leading-relaxed"
        >
          {logs.length > 0 ? logs.join("\n") : "—"}
        </pre>

        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-success" aria-live="polite">
            {copied ? t(locale, "diagnosticsCopied") : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring u-interactive h-9 rounded-control border border-border px-3 text-sm text-muted hover:bg-surface-2"
          >
            {t(locale, "close")}
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={state !== "ready"}
            className="focus-ring u-interactive h-9 rounded-control bg-action px-3 text-sm text-action-fg disabled:opacity-40"
          >
            {t(locale, "copyDiagnostics")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
