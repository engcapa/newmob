import { useEffect } from "react";
import {
  CheckCircle2,
  HelpCircle,
  Loader2,
  Play,
  RefreshCw,
  Shield,
  X,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import type { RedirectorInstallStatus } from "../../lib/sockscap";

type GuideMode = "onboarding" | "help";

interface Props {
  mode: GuideMode;
  installStatus: RedirectorInstallStatus | null;
  captureReady: boolean;
  completed: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onInstall: () => void;
  onRefreshApproval: () => void;
  onContinueToStart: () => void;
}

type StepState = "done" | "current" | "upcoming";

function statusSummaryKey(status: RedirectorInstallStatus | null): string {
  if (!status) return "sockscap.macosSetupStatusChecking";
  if (status.state === "missing") return "sockscap.macosSetupStatusMissing";
  if (status.state === "upgradeAvailable") return "sockscap.macosSetupStatusUpgrade";
  if (status.state === "resourceMissing") return "sockscap.macosSetupStatusResourceMissing";
  if (status.state === "conflict") return "sockscap.macosSetupStatusConflict";
  if (status.systemExtensionState === "waitingForUser") {
    return "sockscap.macosSetupStatusWaiting";
  }
  if (status.systemExtensionState === "notRegistered") {
    return "sockscap.macosSetupStatusNotRegistered";
  }
  if (status.systemExtensionState === "enabled") {
    return "sockscap.macosSetupStatusEnabled";
  }
  return "sockscap.macosSetupStatusUnknown";
}

function StepMarker({ index, state }: { index: number; state: StepState }) {
  if (state === "done") {
    return <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-500" />;
  }
  return (
    <span
      className={`w-5 h-5 shrink-0 rounded-full inline-flex items-center justify-center text-[10px] font-semibold border ${
        state === "current"
          ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)] text-white"
          : "border-[var(--taomni-divider)] text-[var(--taomni-text-muted)]"
      }`}
    >
      {index}
    </span>
  );
}

export function SocksCapMacosSetupGuide({
  mode,
  installStatus,
  captureReady,
  completed,
  busy,
  error,
  onClose,
  onInstall,
  onRefreshApproval,
  onContinueToStart,
}: Props) {
  const t = useT();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const installed =
    installStatus?.state === "pendingSystemApproval" || installStatus?.state === "ready";
  const activationRequested =
    installStatus?.systemExtensionState === "waitingForUser" ||
    installStatus?.systemExtensionState === "other" ||
    installStatus?.systemExtensionState === "enabled";
  const approvalGranted = installStatus?.systemExtensionState === "enabled";
  const setupComplete = completed || captureReady;

  const stepStates: StepState[] = [
    installed ? "done" : "current",
    activationRequested ? "done" : installed ? "current" : "upcoming",
    approvalGranted ? "done" : activationRequested ? "current" : "upcoming",
    setupComplete ? "done" : approvalGranted ? "current" : "upcoming",
  ];

  const canInstall =
    !!installStatus?.resourceAvailable &&
    installStatus.state !== "conflict" &&
    installStatus.state !== "resourceMissing";
  const primary = !installStatus
    ? "checking"
    : !installed
      ? "install"
      : !activationRequested
        ? "start"
        : !approvalGranted
          ? "refresh"
          : !setupComplete
            ? "start"
            : "close";

  const steps = [
    {
      title: t("sockscap.macosSetupStep1Title"),
      body: t("sockscap.macosSetupStep1Body"),
    },
    {
      title: t("sockscap.macosSetupStep2Title"),
      body: t("sockscap.macosSetupStep2Body"),
    },
    {
      title: t("sockscap.macosSetupStep3Title"),
      body: t("sockscap.macosSetupStep3Body"),
    },
    {
      title: t("sockscap.macosSetupStep4Title"),
      body: t("sockscap.macosSetupStep4Body"),
    },
  ];

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-4"
      data-testid="sockscap-macos-setup-overlay"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sockscap-macos-setup-title"
        data-testid="sockscap-macos-setup-dialog"
        className="w-[min(620px,94vw)] max-h-[86vh] flex flex-col rounded-xl bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--taomni-divider)]">
          {mode === "onboarding" ? (
            <Shield className="w-5 h-5 shrink-0 text-[var(--taomni-accent)]" />
          ) : (
            <HelpCircle className="w-5 h-5 shrink-0 text-[var(--taomni-accent)]" />
          )}
          <div className="min-w-0 flex-1">
            <h2 id="sockscap-macos-setup-title" className="text-[14px] font-semibold">
              {t(
                mode === "onboarding"
                  ? "sockscap.macosSetupTitle"
                  : "sockscap.macosSetupHelpTitle",
              )}
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--taomni-text-muted)]">
              {t("sockscap.macosSetupIntro")}
            </p>
          </div>
          <button
            type="button"
            data-testid="sockscap-macos-setup-close"
            className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-50"
            aria-label={t("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          <div
            data-testid="sockscap-macos-setup-status"
            className="mb-3 flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-800 dark:text-sky-300"
          >
            {busy ? (
              <Loader2 className="mt-0.5 w-3.5 h-3.5 shrink-0 animate-spin" />
            ) : (
              <Shield className="mt-0.5 w-3.5 h-3.5 shrink-0" />
            )}
            <div>
              <span className="font-semibold">{t("sockscap.macosSetupCurrentStatus")}</span>{" "}
              {t(statusSummaryKey(installStatus))}
              {installStatus?.packageVersion && (
                <span className="ml-1 font-mono">v{installStatus.packageVersion}</span>
              )}
            </div>
          </div>

          <ol className="space-y-2.5">
            {steps.map((step, index) => (
              <li
                key={step.title}
                data-testid={`sockscap-macos-setup-step-${index + 1}`}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
                  stepStates[index] === "current"
                    ? "border-[var(--taomni-accent)]/50 bg-[var(--taomni-accent)]/5"
                    : "border-[var(--taomni-divider)]"
                }`}
              >
                <StepMarker index={index + 1} state={stepStates[index]} />
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold">{step.title}</div>
                  <div className="mt-1 text-[11px] leading-5 text-[var(--taomni-text-muted)]">
                    {step.body}
                  </div>
                  {index === 2 && (
                    <div className="mt-1.5 inline-flex rounded bg-[var(--taomni-bg)] px-2 py-1 font-mono text-[10px] text-[var(--taomni-text)] border border-[var(--taomni-divider)]">
                      {t("sockscap.macosSetupPrivacyPath")}
                    </div>
                  )}
                  {index === 3 && (
                    <div className="mt-1.5 text-[10px] text-[var(--taomni-text-muted)]">
                      {t("sockscap.macosSetupNetworkPath")}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {error && (
            <div
              data-testid="sockscap-macos-setup-error"
              className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-300 break-words"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
          <button
            type="button"
            className="px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
          >
            {mode === "onboarding" && !setupComplete
              ? t("sockscap.macosSetupLater")
              : t("common.close")}
          </button>

          {primary === "install" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-install"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90 disabled:opacity-50"
              disabled={busy || !canInstall}
              onClick={onInstall}
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Shield className="w-3.5 h-3.5" />
              )}
              {t("sockscap.installRedirector")}
            </button>
          )}

          {primary === "refresh" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-refresh"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90 disabled:opacity-50"
              disabled={busy}
              onClick={onRefreshApproval}
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {t("sockscap.macosSetupRefreshNow")}
            </button>
          )}

          {primary === "start" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-continue"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90 disabled:opacity-50"
              disabled={busy}
              onClick={onContinueToStart}
            >
              <Play className="w-3.5 h-3.5" />
              {t("sockscap.macosSetupGoToStart")}
            </button>
          )}

          {primary === "close" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-finish"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] bg-emerald-600 text-white hover:bg-emerald-500"
              onClick={onClose}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t("sockscap.macosSetupFinished")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

