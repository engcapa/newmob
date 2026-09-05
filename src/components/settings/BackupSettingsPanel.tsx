import { useEffect, useState } from "react";
import {
  Archive,
  Download,
  Upload,
  RefreshCw,
  Lock,
  Unlock,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Loader2,
  FolderDown,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import { useBackupStore } from "../../stores/backupStore";
import { useVaultStore } from "../../stores/vaultStore";
import {
  selectFilePath,
  selectSaveDirectory,
  selectSaveFilePath,
} from "../../lib/ipc";
import { relaunchApp } from "../../lib/updateService";
import type { BackupManifest, BackupScope } from "../../lib/backup";

export function BackupSettingsPanel() {
  const t = useT();
  const vaultState = useVaultStore((s) => s.state);
  const refreshVault = useVaultStore((s) => s.refresh);

  const {
    policy,
    defaultBackupDir,
    history,
    creating,
    restoring,
    error,
    loadAll,
    refreshHistory,
    updatePolicy,
    triggerBackup,
    inspectArchive,
    performStageRestore,
    deleteBackup,
    clearError,
  } = useBackupStore();

  // Create backup form state
  const [scope, setScope] = useState<BackupScope>("core");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Restore inspection dialog state
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [selectedRestorePath, setSelectedRestorePath] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreVaultPassword, setRestoreVaultPassword] = useState("");
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [restoreStaged, setRestoreStaged] = useState(false);

  useEffect(() => {
    void loadAll();
    void refreshVault();
  }, [loadAll, refreshVault]);

  const effectiveBackupDir = policy?.customBackupDir?.trim() || defaultBackupDir;
  const isCustomDir = Boolean(policy?.customBackupDir?.trim());

  // Handle changing custom directory
  const handleChangeDirectory = async () => {
    try {
      const selected = await selectSaveDirectory(effectiveBackupDir);
      if (selected && selected.trim()) {
        await updatePolicy({ customBackupDir: selected.trim() });
        await refreshHistory();
      }
    } catch (e) {
      console.error("Failed to select backup directory", e);
    }
  };

  // Handle reset to default directory
  const handleResetDefaultDirectory = async () => {
    try {
      await updatePolicy({ customBackupDir: null });
      await refreshHistory();
    } catch (e) {
      console.error("Failed to reset backup directory", e);
    }
  };

  // Handle instant backup directly into the configured backup directory
  const handleBackupNow = async () => {
    setActionSuccess(null);
    setActionError(null);
    clearError();

    try {
      await triggerBackup({
        scope,
        password: usePassword && password.trim() ? password.trim() : undefined,
      });
      setActionSuccess(t("backupSettings.createSuccess"));
    } catch (e) {
      console.error("Failed to create backup", e);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  // Handle backup export to custom path chosen by user
  const handleExportBackup = async () => {
    setActionSuccess(null);
    setActionError(null);
    clearError();

    const nowStr = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const defaultName = `taomni_backup_${nowStr}.taobak`;
    try {
      const target = await selectSaveFilePath(defaultName, effectiveBackupDir);
      if (!target) return;

      await triggerBackup({
        scope,
        targetPath: target,
        password: usePassword && password.trim() ? password.trim() : undefined,
      });
      setActionSuccess(t("backupSettings.createSuccess"));
    } catch (e) {
      console.error("Failed to export backup", e);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  // Trigger file selection for restore
  const handleSelectRestoreFile = async () => {
    try {
      const file = await selectFilePath(effectiveBackupDir);
      if (file) {
        openRestoreModal(file);
      }
    } catch (e) {
      console.error("Failed to pick restore file", e);
    }
  };

  const openRestoreModal = async (filePath: string) => {
    setSelectedRestorePath(filePath);
    setRestoreModalOpen(true);
    setInspectError(null);
    setManifest(null);
    setRestorePassword("");
    setRestoreVaultPassword("");
    setRestoreStaged(false);
    setInspecting(true);

    try {
      const meta = await inspectArchive(filePath);
      setManifest(meta);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("BACKUP_PASSWORD_REQUIRED")) {
        setInspectError(t("backupSettings.inputPasswordForDecrypt"));
      } else {
        setInspectError(msg);
      }
    } finally {
      setInspecting(false);
    }
  };

  // Retry inspect with password
  const handleRetryInspectWithPassword = async () => {
    if (!selectedRestorePath) return;
    setInspecting(true);
    setInspectError(null);
    try {
      const meta = await inspectArchive(selectedRestorePath, restorePassword);
      setManifest(meta);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInspectError(
        msg.includes("BACKUP_BAD_PASSWORD")
          ? "密码错误，请重新输入。"
          : msg,
      );
    } finally {
      setInspecting(false);
    }
  };

  // Execute restore and relaunch
  const handleConfirmRestore = async () => {
    if (!selectedRestorePath) return;
    setInspectError(null);

    if (vaultState !== "empty" && !restoreVaultPassword.trim()) {
      setInspectError(t("backupSettings.vaultPasswordRequired"));
      return;
    }

    try {
      await performStageRestore(
        selectedRestorePath,
        restorePassword.trim() ? restorePassword.trim() : undefined,
        vaultState !== "empty" ? restoreVaultPassword.trim() : undefined,
      );
      setRestoreStaged(true);
      setTimeout(async () => {
        try {
          await relaunchApp();
        } catch (relaunchErr) {
          console.error("Failed to relaunch app", relaunchErr);
        }
      }, 1500);
    } catch (e) {
      console.error("Failed to stage restore", e);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("VAULT_BAD_PASSWORD")) {
        setInspectError(t("backupSettings.vaultBadPassword"));
      } else if (msg.includes("VAULT_PASSWORD_REQUIRED")) {
        setInspectError(t("backupSettings.vaultPasswordRequired"));
      } else {
        setInspectError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const handleDeleteItem = async (fileName: string) => {
    if (window.confirm(t("backupSettings.confirmDelete"))) {
      try {
        await deleteBackup(fileName);
      } catch (e) {
        console.error("Failed to delete backup", e);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-theme-text flex items-center gap-2">
          <Archive className="w-5 h-5 text-accent" />
          {t("backupSettings.sectionTitle")}
        </h3>
        <p className="text-sm text-theme-muted mt-1">
          {t("backupSettings.description")}
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-500 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {actionSuccess && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded text-sm text-emerald-500 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Card 1: Target Directory */}
      <div className="p-4 rounded-lg bg-theme-surface border border-theme-border space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-theme-muted" />
            <h4 className="text-sm font-medium text-theme-text">
              {t("backupSettings.targetDirTitle")}
            </h4>
          </div>
          <span
            className={`text-xs px-2 py-0.5 rounded font-medium ${
              isCustomDir
                ? "bg-accent/20 text-accent border border-accent/30"
                : "bg-theme-border/40 text-theme-muted"
            }`}
          >
            {isCustomDir
              ? t("backupSettings.customPathBadge")
              : t("backupSettings.defaultPathBadge")}
          </span>
        </div>
        <p className="text-xs text-theme-muted">
          {t("backupSettings.targetDirDesc")}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={effectiveBackupDir}
            className="flex-1 px-3 py-1.5 text-xs bg-theme-bg/60 border border-theme-border rounded text-theme-text font-mono truncate"
          />
          <button
            type="button"
            onClick={handleChangeDirectory}
            className="px-3 py-1.5 text-xs rounded bg-theme-surface border border-theme-border hover:border-accent text-theme-text transition-colors"
          >
            {t("backupSettings.changeDir")}
          </button>
          {isCustomDir && (
            <button
              type="button"
              onClick={handleResetDefaultDirectory}
              className="px-3 py-1.5 text-xs rounded bg-theme-surface border border-theme-border hover:border-theme-muted text-theme-muted transition-colors"
            >
              {t("backupSettings.resetDefaultDir")}
            </button>
          )}
        </div>
      </div>

      {/* Card 2: Manual Backup */}
      <div className="p-4 rounded-lg bg-theme-surface border border-theme-border space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-theme-muted" />
            <h4 className="text-sm font-medium text-theme-text">
              {t("backupSettings.createBackupTitle")}
            </h4>
          </div>
          <p className="text-xs text-theme-muted mt-1">
            {t("backupSettings.createBackupDesc")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-theme-muted">
              {t("backupSettings.scopeLabel")}
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as BackupScope)}
              className="w-full px-3 py-1.5 text-xs bg-theme-bg border border-theme-border rounded text-theme-text focus:border-accent outline-none"
            >
              <option value="core">{t("backupSettings.scopeCore")}</option>
              <option value="full">{t("backupSettings.scopeFull")}</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-theme-muted flex items-center justify-between">
              <span>{t("backupSettings.enablePassword")}</span>
              <input
                type="checkbox"
                checked={usePassword}
                onChange={(e) => setUsePassword(e.target.checked)}
                className="rounded border-theme-border text-accent focus:ring-accent"
              />
            </label>
            {usePassword && (
              <input
                type="password"
                placeholder={t("backupSettings.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-1.5 text-xs bg-theme-bg border border-theme-border rounded text-theme-text focus:border-accent outline-none"
              />
            )}
          </div>
        </div>

        {actionError && (
          <div className="text-xs text-red-500 bg-red-500/10 p-2.5 rounded border border-red-500/20 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {actionSuccess && (
          <div className="text-xs text-emerald-500 bg-emerald-500/10 p-2.5 rounded border border-emerald-500/20 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{actionSuccess}</span>
          </div>
        )}

        <div className="pt-2 flex justify-end gap-2">
          <button
            type="button"
            disabled={creating}
            onClick={handleExportBackup}
            className="flex items-center gap-2 px-3 py-2 text-xs font-medium bg-theme-bg border border-theme-border hover:border-accent text-theme-text rounded disabled:opacity-50 transition-colors"
          >
            <FolderDown className="w-3.5 h-3.5" />
            {t("backupSettings.exportTo")}
          </button>
          <button
            type="button"
            disabled={creating}
            onClick={handleBackupNow}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-accent text-accent-text rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {creating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t("backupSettings.creating")}
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                {t("backupSettings.backupNow")}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Card 3: Auto Backup Policy */}
      {policy && (
        <div className="p-4 rounded-lg bg-theme-surface border border-theme-border space-y-4">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-theme-muted" />
            <h4 className="text-sm font-medium text-theme-text">
              {t("backupSettings.autoBackupTitle")}
            </h4>
          </div>

          {/* Enable toggle matching Screenshot 2 / AppProxyPanel style */}
          <div
            role="button"
            tabIndex={0}
            className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
              policy.autoBackupEnabled
                ? "border-[var(--taomni-accent)]/40 bg-[var(--taomni-accent)]/5"
                : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
            }`}
            onClick={() =>
              void updatePolicy({ autoBackupEnabled: !policy.autoBackupEnabled })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void updatePolicy({ autoBackupEnabled: !policy.autoBackupEnabled });
              }
            }}
          >
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-theme-text">
                {t("backupSettings.enableAutoBackup")}
              </div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] mt-0.5">
                {t("backupSettings.weeklyRetainHint")}
              </div>
            </div>
            <div
              className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${
                policy.autoBackupEnabled
                  ? "bg-[var(--taomni-accent)]"
                  : "bg-[var(--taomni-divider)]"
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${
                  policy.autoBackupEnabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </div>
          </div>

          {policy.autoBackupEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-theme-border/40">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-theme-muted">
                  {t("backupSettings.frequencyLabel")}
                </label>
                <select
                  value={policy.frequency}
                  onChange={(e) =>
                    void updatePolicy({
                      frequency: e.target.value as "daily" | "weekly" | "on_exit",
                    })
                  }
                  className="w-full px-3 py-1.5 text-xs bg-theme-bg border border-theme-border rounded text-theme-text focus:border-accent outline-none"
                >
                  <option value="daily">{t("backupSettings.freqDaily")}</option>
                  <option value="weekly">{t("backupSettings.freqWeekly")}</option>
                  <option value="on_exit">{t("backupSettings.freqOnExit")}</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-theme-muted">
                  {t("backupSettings.maxCopiesLabel")}
                </label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={policy.maxRetainedCopies}
                  onChange={(e) =>
                    void updatePolicy({
                      maxRetainedCopies: Math.max(1, parseInt(e.target.value) || 7),
                    })
                  }
                  className="w-full px-3 py-1.5 text-xs bg-theme-bg border border-theme-border rounded text-theme-text focus:border-accent outline-none"
                />
              </div>
            </div>
          )}

          <div className="text-xs text-theme-muted flex items-center justify-between pt-1">
            <span>{t("backupSettings.lastBackupLabel")}:</span>
            <span className="font-mono">
              {policy.lastBackupAt
                ? new Date(policy.lastBackupAt).toLocaleString()
                : t("backupSettings.neverBackedUp")}
            </span>
          </div>
        </div>
      )}

      {/* Card 4: Restore */}
      <div className="p-4 rounded-lg bg-theme-surface border border-theme-border space-y-3">
        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-theme-muted" />
          <h4 className="text-sm font-medium text-theme-text">
            {t("backupSettings.restoreTitle")}
          </h4>
        </div>
        <p className="text-xs text-theme-muted">
          {t("backupSettings.restoreDesc")}
        </p>
        <button
          type="button"
          onClick={handleSelectRestoreFile}
          className="flex items-center gap-2 px-3 py-2 text-xs rounded bg-theme-bg border border-theme-border hover:border-accent text-theme-text transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          {t("backupSettings.chooseFile")}
        </button>
      </div>

      {/* Card 5: History Snapshots */}
      {(() => {
        const safeHistory = history ?? [];
        return (
          <div className="p-4 rounded-lg bg-theme-surface border border-theme-border space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-theme-text">
                {t("backupSettings.historyTitle")} ({safeHistory.length})
              </h4>
              <button
                type="button"
                onClick={() => void refreshHistory()}
                className="p-1 rounded text-theme-muted hover:text-theme-text"
                title="刷新"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {safeHistory.length === 0 ? (
              <p className="text-xs text-theme-muted py-2">
                {t("backupSettings.noHistory")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-theme-border text-theme-muted">
                      <th className="py-2 px-2">{t("backupSettings.fileName")}</th>
                      <th className="py-2 px-2">{t("backupSettings.size")}</th>
                      <th className="py-2 px-2">{t("backupSettings.date")}</th>
                      <th className="py-2 px-2">状态</th>
                      <th className="py-2 px-2 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/40">
                    {safeHistory.map((item) => (
                      <tr key={item.filePath} className="hover:bg-theme-bg/40">
                        <td className="py-2 px-2 font-mono text-theme-text max-w-xs truncate" title={item.fileName}>
                          {item.fileName}
                        </td>
                        <td className="py-2 px-2 text-theme-muted">
                          {(item.sizeBytes / 1024 / 1024).toFixed(2)} MB
                        </td>
                        <td className="py-2 px-2 text-theme-muted">
                          {new Date(item.modifiedAt).toLocaleString()}
                        </td>
                        <td className="py-2 px-2">
                          {item.isEncrypted ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
                              <Lock className="w-3 h-3" />
                              {t("backupSettings.encrypted")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-theme-muted">
                              <Unlock className="w-3 h-3" />
                              {t("backupSettings.unencrypted")}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right space-x-2">
                          <button
                            type="button"
                            onClick={() => openRestoreModal(item.filePath)}
                            className="text-xs text-accent hover:underline font-medium"
                          >
                            {t("backupSettings.restoreAction")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteItem(item.fileName)}
                            className="text-xs text-red-500 hover:underline"
                          >
                            {t("backupSettings.deleteAction")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Restore Confirmation Modal */}
      {restoreModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-restore-dialog-title"
            data-testid="backup-restore-dialog"
            className="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border p-5 shadow-2xl space-y-4"
            style={{
              background: "var(--taomni-bg)",
              borderColor: "var(--taomni-card-border)",
              color: "var(--taomni-text)",
            }}
          >
            <div
              className="flex items-center justify-between border-b pb-3"
              style={{ borderColor: "var(--taomni-divider)" }}
            >
              <h3 id="backup-restore-dialog-title" className="font-semibold text-base flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[var(--taomni-accent)]" />
                {t("backupSettings.restoreModalTitle")}
              </h3>
              <button
                type="button"
                onClick={() => setRestoreModalOpen(false)}
                className="text-sm text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
              >
                ✕
              </button>
            </div>

            <div
              className="rounded border p-3 text-xs"
              style={{
                background: "var(--taomni-warning-bg)",
                borderColor: "var(--taomni-warning-border)",
                color: "var(--taomni-warning-text)",
              }}
            >
              {t("backupSettings.restoreModalWarning")}
            </div>

            {inspecting ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-[var(--taomni-text-muted)]">
                <Loader2 className="h-5 w-5 animate-spin text-[var(--taomni-accent)]" />
                {t("backupSettings.inspecting")}
              </div>
            ) : manifest ? (
              <div className="space-y-3 text-xs">
                <div
                  className="grid grid-cols-2 gap-2 rounded border p-3"
                  style={{
                    background: "var(--taomni-card-bg)",
                    borderColor: "var(--taomni-card-border)",
                  }}
                >
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.archiveVersion")}:</span>
                    <div className="font-medium font-mono">{manifest.appVersion}</div>
                  </div>
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.scopeLabel")}:</span>
                    <div className="font-medium capitalize">{manifest.backupScope}</div>
                  </div>
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.archiveDate")}:</span>
                    <div className="font-mono">{new Date(manifest.createdAt).toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.archiveFilesCount")}:</span>
                    <div className="font-mono">{manifest.files.length} 个文件</div>
                  </div>
                </div>

                <div
                  className="max-h-36 overflow-y-auto space-y-1 rounded border p-2 font-mono text-[11px] text-[var(--taomni-text-muted)]"
                  style={{
                    background: "var(--taomni-panel-bg)",
                    borderColor: "var(--taomni-divider)",
                  }}
                >
                  {manifest.files.map((f) => (
                    <div key={f.path} className="flex justify-between">
                      <span className="truncate pr-2">{f.path}</span>
                      <span>{(f.sizeBytes / 1024).toFixed(1)} KB</span>
                    </div>
                  ))}
                </div>

                {vaultState !== "empty" ? (
                  <div
                    className="space-y-1.5 border-t pt-2"
                    style={{ borderColor: "var(--taomni-divider)" }}
                  >
                    <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--taomni-text-muted)]">
                      <ShieldCheck className="h-3.5 w-3.5 text-[var(--taomni-accent)]" />
                      <span>{t("backupSettings.restoreVaultPasswordLabel")}</span>
                      <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="password"
                      value={restoreVaultPassword}
                      onChange={(e) => {
                        setRestoreVaultPassword(e.target.value);
                        setInspectError(null);
                      }}
                      placeholder={t("backupSettings.restoreVaultPasswordPh")}
                      className="w-full rounded border px-3 py-1.5 text-xs text-[var(--taomni-text)] outline-none focus:border-[var(--taomni-accent)] placeholder:text-[var(--taomni-text-muted)]"
                      style={{
                        background: "var(--taomni-input-bg)",
                        borderColor: "var(--taomni-input-border)",
                      }}
                    />
                    <p className="text-[11px] text-[var(--taomni-text-muted)]">
                      {t("backupSettings.restoreVaultPasswordHint")}
                    </p>
                  </div>
                ) : (
                  <div
                    className="border-t pt-2 text-[11px] italic text-[var(--taomni-text-muted)]"
                    style={{ borderColor: "var(--taomni-divider)" }}
                  >
                    {t("backupSettings.vaultEmptyNotice")}
                  </div>
                )}

                {inspectError && (
                  <div className="text-xs text-red-500 bg-red-500/10 p-2.5 rounded border border-red-500/20 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    <span>{inspectError}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {inspectError && (
                  <div className="text-xs text-red-500 bg-red-500/10 p-2.5 rounded border border-red-500/20">
                    {inspectError}
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--taomni-text-muted)]">
                    {t("backupSettings.inputPasswordForDecrypt")}
                  </label>
                  <input
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    placeholder="输入解密密码"
                    className="w-full rounded border px-3 py-2 text-xs text-[var(--taomni-text)] outline-none focus:border-[var(--taomni-accent)] placeholder:text-[var(--taomni-text-muted)]"
                    style={{
                      background: "var(--taomni-input-bg)",
                      borderColor: "var(--taomni-input-border)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleRetryInspectWithPassword}
                    className="mt-2 w-full rounded border py-1.5 text-xs font-medium text-[var(--taomni-text)] hover:border-[var(--taomni-accent)]"
                    style={{
                      background: "var(--taomni-card-bg)",
                      borderColor: "var(--taomni-input-border)",
                    }}
                  >
                    解锁并验证备份
                  </button>
                </div>
              </div>
            )}

            {restoreStaged && (
              <div
                className="flex items-center gap-2 rounded border p-3 text-xs"
                style={{
                  background: "var(--taomni-success-bg)",
                  borderColor: "var(--taomni-success-border)",
                  color: "var(--taomni-success-text)",
                }}
              >
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" style={{ color: "var(--taomni-success-icon)" }} />
                <span>{t("backupSettings.restoreStagedSuccess")}</span>
              </div>
            )}

            <div
              className="flex justify-end gap-2 border-t pt-2"
              style={{ borderColor: "var(--taomni-divider)" }}
            >
              <button
                type="button"
                disabled={restoring}
                onClick={() => setRestoreModalOpen(false)}
                className="rounded border px-3 py-1.5 text-xs text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
                style={{
                  background: "var(--taomni-card-bg)",
                  borderColor: "var(--taomni-input-border)",
                }}
              >
                取消
              </button>
              {manifest && (
                <button
                  type="button"
                  disabled={restoring || restoreStaged}
                  onClick={handleConfirmRestore}
                  className="flex items-center gap-1.5 rounded bg-red-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {restoring ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {t("backupSettings.restoring")}
                    </>
                  ) : (
                    t("backupSettings.confirmRestoreAndRestart")
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
