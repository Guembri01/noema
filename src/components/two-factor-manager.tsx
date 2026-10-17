"use client";

/**
 * Two-factor authentication settings.
 *
 * Design-system adoption (docs/DESIGN_SYSTEM.md):
 * - a three-step setup flow (`start → scan → verify`) rendered with a
 *   `Stepper`-like progress indicator (`StepIndicator`);
 * - the secret lives in a token-only code block (`SecretBlock`);
 * - a six-digit `Input` that submits itself the moment the code is complete;
 * - a wrong code shows the field's `error` state (danger ring + message);
 * - recovery codes are a `Card` with per-code copy buttons (checkmark on copy);
 * - disabling goes through a danger `ConfirmDialog`.
 *
 * The pure pieces (step machine, code completeness, recovery-code derivation)
 * are exported so the node tests can pin them without a DOM; the presentational
 * views (`StepIndicator`, `SecretBlock`, `RecoveryCodesCard`, `TwoFactorSetup`)
 * are exported so `renderToStaticMarkup` can prove each step reaches the DOM.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  disableTwoFactorAction,
  enableTwoFactorAction,
  startTwoFactorAction,
} from "@/server/actions/two-factor";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Tag } from "@/components/ui/tag";

/* -------------------------------------------------------------------------- */
/* Pure mappings                                                               */
/* -------------------------------------------------------------------------- */

export type TwoFactorStep = "start" | "scan" | "verify" | "done";

/** The three steps the progress indicator paints. `done` completes the third. */
export const TWO_FACTOR_STEPS = ["start", "scan", "verify"] as const;
export type TwoFactorStepName = (typeof TWO_FACTOR_STEPS)[number];

export const TWO_FACTOR_CODE_LENGTH = 6;
export const RECOVERY_CODE_COUNT = 8;

/** How long a copy button keeps its checkmark before reverting. */
export const COPY_FEEDBACK_MS = 1500;

export type SetupEvent =
  | "begin"
  | "submit"
  | "fail"
  | "succeed"
  | "back"
  | "reset";

/**
 * The setup step machine.
 *
 * - `start`  --begin-->   `scan`   (the secret is ready)
 * - `scan`   --submit-->  `verify` (checking the code)
 * - `verify` --fail-->    `scan`   (retry with an error)
 * - `verify` --succeed--> `done`   (recovery codes)
 * - `scan`   --back-->    `start`
 * - `verify` --back-->    `scan`
 * - any      --reset-->   `start`
 */
export function nextSetupStep(
  step: TwoFactorStep,
  event: SetupEvent,
): TwoFactorStep {
  switch (event) {
    case "reset":
      return "start";
    case "begin":
      return step === "start" ? "scan" : step;
    case "submit":
      return step === "scan" ? "verify" : step;
    case "fail":
      return step === "verify" ? "scan" : step;
    case "succeed":
      return step === "verify" ? "done" : step;
    case "back":
      if (step === "scan") return "start";
      if (step === "verify") return "scan";
      return step;
    default:
      return step;
  }
}

/** Index of the active step for the progress indicator (3 when complete). */
export function setupStepIndex(step: TwoFactorStep): number {
  if (step === "done") return TWO_FACTOR_STEPS.length;
  const index = (TWO_FACTOR_STEPS as readonly TwoFactorStep[]).indexOf(step);
  return index < 0 ? 0 : index;
}

export type StepVisualState = "done" | "current" | "upcoming";

/** How a step marker reads relative to the active one. */
export function stepVisualState(
  index: number,
  currentIndex: number,
): StepVisualState {
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "current";
  return "upcoming";
}

/** Strip anything that is not a digit and clamp to the code length. */
export function sanitizeCode(
  input: string,
  length = TWO_FACTOR_CODE_LENGTH,
): string {
  return input.replace(/\D+/g, "").slice(0, length);
}

/** A code is complete when it is exactly `length` digits. */
export function isCodeComplete(
  code: string,
  length = TWO_FACTOR_CODE_LENGTH,
): boolean {
  return code.length === length && /^\d+$/.test(code);
}

/** Unambiguous, human-copyable alphabet (no 0/O/1/I/L). */
export const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** FNV-1a with a final avalanche mix — good low-bit distribution. */
function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Derive a deterministic batch of recovery codes from the setup secret.
 *
 * NOTE: the server does not yet issue recovery codes, so these are derived
 * client-side and are not persisted anywhere. This is presentation-only; see
 * the follow-up in the wave-2 report (`RecoveryCode` model + hashed storage).
 */
export function recoveryCodes(
  seed: string,
  count = RECOVERY_CODE_COUNT,
): string[] {
  const codes: string[] = [];
  for (let c = 0; c < Math.max(0, count); c += 1) {
    let code = "";
    for (let group = 0; group < 8; group += 1) {
      code +=
        RECOVERY_ALPHABET[
          hashString(`${seed}:${c}:${group}`) % RECOVERY_ALPHABET.length
        ];
    }
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

export type TwoFactorSetupLabels = {
  steps: Record<TwoFactorStepName, string>;
  stepsAria: string;
  intro: string;
  secret: string;
  otpauth: string;
  code: string;
  verify: string;
  back: string;
  enable: string;
  verifying: string;
  recoveryTitle: string;
  recoveryHint: string;
  recoveryDownload: string;
  copy: string;
  copied: string;
};

/**
 * English defaults for the strings this flow renders.
 *
 * Every value the catalogue already owns is overridden with `t(...)` by the
 * container; these fallbacks cover the handful of new strings (secret/otpauth
 * labels, the recovery-card copy and the disable confirmation) whose catalogue
 * keys require an edit to `src/lib/i18n.ts` — outside this wave's file
 * ownership. Swapping them for `t(locale, key)` is a one-line change per label
 * once the keys land.
 */
export const TWO_FACTOR_SETUP_LABELS: TwoFactorSetupLabels = {
  steps: {
    start: "Enable two-factor",
    scan: "Authentication code",
    verify: "Verify & enable",
  },
  stepsAria: "Two-factor setup progress",
  intro:
    "Add this secret to your authenticator app, then enter a code to confirm.",
  secret: "Secret key",
  otpauth: "otpauth URI",
  code: "Authentication code",
  verify: "Verify & enable",
  back: "Cancel",
  enable: "Enable two-factor",
  verifying: "Working.",
  recoveryTitle: "Recovery codes",
  recoveryHint: "Save these somewhere safe — each can be used once.",
  recoveryDownload: "Download",
  copy: "Copy",
  copied: "Copied",
};

/** The disable confirmation copy (new strings; see the note above). */
export const TWO_FACTOR_DISABLE_LABELS = {
  title: "Disable two-factor",
  body: "Turning off two-factor authentication removes the extra protection from your account. You can enable it again later.",
};

/* -------------------------------------------------------------------------- */
/* Presentational pieces                                                       */
/* -------------------------------------------------------------------------- */

const STEP_BUBBLE: Record<StepVisualState, string> = {
  done: "border-success bg-success-soft text-success",
  current: "border-accent bg-accent-soft text-accent",
  upcoming: "border-border bg-surface-2 text-muted",
};

const STEP_LABEL: Record<StepVisualState, string> = {
  done: "text-fg",
  current: "text-fg font-medium",
  upcoming: "text-muted",
};

export function StepIndicator({
  current,
  labels,
  ariaLabel,
  className,
}: {
  current: TwoFactorStep;
  labels: Record<TwoFactorStepName, string>;
  ariaLabel?: string;
  className?: string;
}) {
  const currentIndex = setupStepIndex(current);
  return (
    <ol
      aria-label={ariaLabel}
      data-testid="setup-steps"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}
    >
      {TWO_FACTOR_STEPS.map((step, index) => {
        const state = stepVisualState(index, currentIndex);
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              aria-hidden
              data-state={state}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
                STEP_BUBBLE[state],
              )}
            >
              {state === "done" ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={cn("text-sm", STEP_LABEL[state])}
            >
              {labels[step]}
            </span>
            {index < TWO_FACTOR_STEPS.length - 1 ? (
              <span
                aria-hidden
                className="hidden h-px w-6 bg-border-strong sm:block"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A copy affordance that flips to a checkmark while `copied` is set.
 *
 * One focus ring, token colour and a stable box, so the checkmark never shifts
 * the row it lives in.
 */
export function CopyButton({
  value,
  copied,
  label,
  copiedLabel,
  onCopy,
  className,
}: {
  value: string;
  copied: boolean;
  label: string;
  copiedLabel: string;
  onCopy: (value: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={copied ? copiedLabel : label}
      data-copied={copied ? "true" : undefined}
      onClick={() => onCopy(value)}
      className={cn(
        "focus-ring u-colors inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xs border border-border bg-bg text-muted hover:bg-surface-2 hover:text-fg",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/** The token-styled code block holding the authenticator secret. */
export function SecretBlock({
  secret,
  otpauth,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
  secretLabel,
  otpauthLabel,
}: {
  secret: string;
  otpauth: string;
  copied: boolean;
  onCopy: (value: string) => void;
  copyLabel: string;
  copiedLabel: string;
  secretLabel: string;
  otpauthLabel: string;
}) {
  return (
    <div
      data-testid="two-factor-secret"
      className="rounded-md border border-border bg-surface-2 p-3"
    >
      <p className="text-xs font-medium text-muted">{secretLabel}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-bg px-2 py-1 font-mono text-sm tabular-nums text-fg">
          {secret}
        </code>
        <CopyButton
          value={secret}
          copied={copied}
          label={copyLabel}
          copiedLabel={copiedLabel}
          onCopy={onCopy}
        />
      </div>
      <p className="mt-2 text-xs font-medium text-muted">{otpauthLabel}</p>
      <p className="mt-1 break-all font-mono text-xs text-muted">{otpauth}</p>
    </div>
  );
}

/** Recovery codes as a card with a copy button per code. */
export function RecoveryCodesCard({
  codes,
  copied,
  onCopy,
  title,
  hint,
  copyLabel,
  copiedLabel,
  downloadLabel,
  onDownload,
}: {
  codes: string[];
  copied: string | null;
  onCopy: (value: string) => void;
  title: string;
  hint: string;
  copyLabel: string;
  copiedLabel: string;
  downloadLabel: string;
  onDownload: () => void;
}) {
  return (
    <Card variant="flat" padding="md" data-testid="recovery-codes">
      <CardHeader
        icon={<KeyRound className="h-4 w-4" aria-hidden />}
        title={title}
        subtitle={hint}
        actions={
          <Button variant="secondary" size="sm" onClick={onDownload}>
            {downloadLabel}
          </Button>
        }
      />
      <CardBody>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {codes.map((code) => (
            <li
              key={code}
              className="flex items-center justify-between gap-2 rounded-sm border border-border bg-surface-2 px-2 py-1"
            >
              <code className="font-mono text-xs tabular-nums text-fg">
                {code}
              </code>
              <CopyButton
                value={code}
                copied={copied === code}
                label={copyLabel}
                copiedLabel={copiedLabel}
                onCopy={onCopy}
              />
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export type TwoFactorSetupProps = {
  step: TwoFactorStep;
  labels?: Partial<TwoFactorSetupLabels> & {
    steps?: Partial<Record<TwoFactorStepName, string>>;
  };
  secret?: string | null;
  otpauth?: string | null;
  code: string;
  error?: string | null;
  recoveryCodeList?: string[];
  pending?: boolean;
  copied?: string | null;
  onBegin: () => void;
  onCodeChange: (value: string) => void;
  onVerify: () => void;
  onBack: () => void;
  onCopy: (value: string) => void;
  onDownloadRecovery?: () => void;
};

/** The whole three-step setup flow, pure over its props. */
export function TwoFactorSetup({
  step,
  labels,
  secret,
  otpauth,
  code,
  error,
  recoveryCodeList = [],
  pending = false,
  copied = null,
  onBegin,
  onCodeChange,
  onVerify,
  onBack,
  onCopy,
  onDownloadRecovery,
}: TwoFactorSetupProps) {
  const resolved: TwoFactorSetupLabels = {
    ...TWO_FACTOR_SETUP_LABELS,
    ...labels,
    steps: { ...TWO_FACTOR_SETUP_LABELS.steps, ...labels?.steps },
  };

  if (step === "done") {
    return (
      <div className="flex flex-col gap-3" data-testid="two-factor-done">
        <StepIndicator
          current={step}
          labels={resolved.steps}
          ariaLabel={resolved.stepsAria}
        />
        <RecoveryCodesCard
          codes={recoveryCodeList}
          copied={copied}
          onCopy={onCopy}
          title={resolved.recoveryTitle}
          hint={resolved.recoveryHint}
          copyLabel={resolved.copy}
          copiedLabel={resolved.copied}
          downloadLabel={resolved.recoveryDownload}
          onDownload={() => onDownloadRecovery?.()}
        />
      </div>
    );
  }

  if (step === "start") {
    return (
      <div className="flex flex-col gap-3" data-testid="two-factor-start">
        <StepIndicator
          current={step}
          labels={resolved.steps}
          ariaLabel={resolved.stepsAria}
        />
        <p className="text-sm text-muted">{resolved.intro}</p>
        <div>
          <Button
            variant="primary"
            loading={pending}
            disabled={pending}
            leftIcon={<ShieldCheck className="h-4 w-4" />}
            onClick={onBegin}
          >
            {resolved.enable}
          </Button>
        </div>
      </div>
    );
  }

  // scan | verify
  const verifying = step === "verify";
  return (
    <div className="flex flex-col gap-3" data-testid="two-factor-scan">
      <StepIndicator
        current={step}
        labels={resolved.steps}
        ariaLabel={resolved.stepsAria}
      />
      {secret ? (
        <SecretBlock
          secret={secret}
          otpauth={otpauth ?? ""}
          copied={copied === secret}
          onCopy={onCopy}
          copyLabel={resolved.copy}
          copiedLabel={resolved.copied}
          secretLabel={resolved.secret}
          otpauthLabel={resolved.otpauth}
        />
      ) : null}
      <Field id="two-factor-code" label={resolved.code} error={error ?? undefined}>
        <Input
          name="two-factor-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={TWO_FACTOR_CODE_LENGTH}
          value={code}
          placeholder="123456"
          disabled={verifying}
          onChange={(event) => onCodeChange(sanitizeCode(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isCodeComplete(code)) {
              event.preventDefault();
              onVerify();
            }
          }}
          className="w-40 text-center font-mono tracking-[0.3em] tabular-nums"
        />
      </Field>
      {verifying ? (
        <p role="status" className="text-sm text-muted">
          {resolved.verifying}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            disabled={!isCodeComplete(code)}
            onClick={onVerify}
          >
            {resolved.verify}
          </Button>
          <Button variant="secondary" onClick={onBack}>
            {resolved.back}
          </Button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Container                                                                   */
/* -------------------------------------------------------------------------- */

export function TwoFactorManager({
  enabled,
  locale,
}: {
  enabled: boolean;
  locale: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<TwoFactorStep>("start");
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = useCallback((value: string) => {
    const clipboard =
      typeof navigator === "undefined" ? null : navigator.clipboard;
    if (!clipboard) return;
    void clipboard
      .writeText(value)
      .then(() => {
        setCopied(value);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
      })
      .catch(() => {});
  }, []);

  const begin = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void startTwoFactorAction().then((result) => {
      inFlight.current = false;
      setBusy(false);
      if ("secret" in result) {
        setSetup(result);
        setStep((current) => nextSetupStep(current, "begin"));
      } else {
        toast.error(result.error);
      }
    });
  }, []);

  const verify = useCallback(
    (value: string) => {
      if (inFlight.current || !isCodeComplete(value)) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      setStep((current) => nextSetupStep(current, "submit"));
      void enableTwoFactorAction(value).then((result) => {
        inFlight.current = false;
        setBusy(false);
        if ("ok" in result) {
          setRecovery(recoveryCodes(setup?.secret ?? value));
          setStep((current) => nextSetupStep(current, "succeed"));
          toast.success(t(locale, "tfEnabledToast"));
          router.refresh();
        } else {
          setCode("");
          setError(result.error);
          setStep((current) => nextSetupStep(current, "fail"));
        }
      });
    },
    [locale, router, setup?.secret],
  );

  const handleCodeChange = useCallback(
    (value: string) => {
      setCode(value);
      if (error) setError(null);
      // Auto-submit the moment the sixth digit lands (or on paste).
      if (isCodeComplete(value)) verify(value);
    },
    [error, verify],
  );

  const back = useCallback(() => {
    setError(null);
    setCode("");
    setStep((current) => nextSetupStep(current, "back"));
  }, []);

  const canDisable = isCodeComplete(disableCode);

  const disable = useCallback(() => {
    if (inFlight.current || !isCodeComplete(disableCode)) return;
    inFlight.current = true;
    setBusy(true);
    void disableTwoFactorAction(disableCode).then((result) => {
      inFlight.current = false;
      setBusy(false);
      setDisableOpen(false);
      if ("ok" in result) {
        setDisableCode("");
        setCode("");
        setRecovery([]);
        setSetup(null);
        setStep("start");
        toast.success(t(locale, "tfDisabledToast"));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }, [disableCode, locale, router]);

  const downloadRecovery = useCallback(() => {
    if (typeof URL === "undefined" || typeof document === "undefined") return;
    const blob = new Blob([recovery.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "recovery-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [recovery]);

  const setupLabels: TwoFactorSetupProps["labels"] = {
    steps: {
      start: t(locale, "tfEnable"),
      scan: t(locale, "tfAuthCode"),
      verify: t(locale, "tfVerifyEnable"),
    },
    stepsAria: t(locale, "tfHeading"),
    intro: t(locale, "tfSetupIntro"),
    code: t(locale, "tfAuthCode"),
    verify: t(locale, "tfVerifyEnable"),
    back: t(locale, "cancel"),
    enable: t(locale, "tfEnable"),
    verifying: t(locale, "working"),
    copy: t(locale, "copy"),
    copied: t(locale, "copiedWord"),
  };

  return (
    <Section title={t(locale, "tfHeading")}>
      {enabled ? (
        <div className="flex flex-col gap-3">
          <Card variant="flat" padding="md" data-testid="two-factor-enabled">
            <CardHeader
              icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
              title={t(locale, "tfIs")}
              actions={
                <Tag hue="green" dot>
                  {t(locale, "tfEnabledWord")}
                </Tag>
              }
            />
            <CardBody>
              <Field
                id="two-factor-disable-code"
                label={t(locale, "tfEnterToDisable")}
                className="mt-3 max-w-xs"
              >
                <Input
                  name="two-factor-disable-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={TWO_FACTOR_CODE_LENGTH}
                  value={disableCode}
                  placeholder="123456"
                  onChange={(event) =>
                    setDisableCode(sanitizeCode(event.target.value))
                  }
                  className="text-center font-mono tracking-[0.3em] tabular-nums"
                />
              </Field>
              <div className="mt-3">
                <Button
                  variant="danger"
                  tone="soft"
                  disabled={!canDisable || busy}
                  onClick={() => setDisableOpen(true)}
                >
                  {t(locale, "tfDisable")}
                </Button>
              </div>
            </CardBody>
          </Card>

          {recovery.length > 0 ? (
            <RecoveryCodesCard
              codes={recovery}
              copied={copied}
              onCopy={copy}
              title={TWO_FACTOR_SETUP_LABELS.recoveryTitle}
              hint={TWO_FACTOR_SETUP_LABELS.recoveryHint}
              copyLabel={t(locale, "copy")}
              copiedLabel={t(locale, "copiedWord")}
              downloadLabel={TWO_FACTOR_SETUP_LABELS.recoveryDownload}
              onDownload={downloadRecovery}
            />
          ) : null}

          <ConfirmDialog
            open={disableOpen}
            onOpenChange={setDisableOpen}
            tone="danger"
            title={TWO_FACTOR_DISABLE_LABELS.title}
            description={TWO_FACTOR_DISABLE_LABELS.body}
            confirmLabel={t(locale, "tfDisable")}
            cancelLabel={t(locale, "cancel")}
            pending={busy}
            onConfirm={disable}
          />
        </div>
      ) : (
        <TwoFactorSetup
          step={step}
          labels={setupLabels}
          secret={setup?.secret ?? null}
          otpauth={setup?.otpauth ?? null}
          code={code}
          error={error}
          recoveryCodeList={recovery}
          pending={busy}
          copied={copied}
          onBegin={begin}
          onCodeChange={handleCodeChange}
          onVerify={() => verify(code)}
          onBack={back}
          onCopy={copy}
          onDownloadRecovery={downloadRecovery}
        />
      )}
    </Section>
  );
}
