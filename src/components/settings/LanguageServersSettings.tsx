import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, FolderOpen, RefreshCw, Server } from "lucide-react";
import {
  lspDetectServers,
  lspSetJavaHome,
  lspSetJavaSettings,
  lspSetJavaVmargs,
  type LspJavaSettings,
  type LspServerStatus,
} from "../../lib/editor/lsp";
import { writeText } from "../../lib/clipboard";
import { selectFolderPath } from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import {
  detectHostOs,
  osLabel,
  resolveInstallGuide,
  type LspInstallOs,
  type ResolvedInstallGuide,
} from "../../lib/lspInstallGuides";
import {
  clearPendingSettingsSection,
  consumePendingSettingsSection,
} from "../../lib/settingsNavigation";
import {
  CUSTOM_LSP_COMMAND_ID,
  DEFAULT_LSP_JAVA_VMARGS,
  readLspCommandPrefs,
  readLspCustomCommands,
  readLspJavaHome,
  readLspJavaSettings,
  readLspJavaVmargs,
  writeLspCommandPrefs,
  writeLspCustomCommands,
  writeLspJavaHome,
  writeLspJavaSettings,
  writeLspJavaVmargs,
  type LspCustomCommandConfig,
} from "../editor/workspace/codeWorkspaceModel";

/**
 * Global language-server configuration (install hints, binary selection,
 * custom commands). Lives in Settings so every Code Workspace does not
 * repeat the same panel in the project tree.
 */
export function LanguageServersSettings() {
  const t = useT();
  const [statuses, setStatuses] = useState<LspServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandPrefs, setCommandPrefs] = useState<Record<string, string>>(() => readLspCommandPrefs());
  const [customCommands, setCustomCommands] = useState<Record<string, LspCustomCommandConfig>>(
    () => readLspCustomCommands(),
  );
  const [javaHome, setJavaHome] = useState(() => readLspJavaHome());
  const [javaVmargs, setJavaVmargs] = useState(() => readLspJavaVmargs());
  const [javaSettings, setJavaSettings] = useState<LspJavaSettings>(() => readLspJavaSettings());
  /** Expanded install panels keyed by presetId. */
  const [expandedInstall, setExpandedInstall] = useState<Record<string, boolean>>({});
  /** Brief highlight when deep-linked from a Code Workspace file. */
  const [focusPresetId, setFocusPresetId] = useState<string | null>(() => {
    const pending = consumePendingSettingsSection();
    return pending?.id === "language-servers" ? pending.presetId ?? null : null;
  });
  const hostOs = useMemo(() => detectHostOs(), []);

  const refresh = useCallback(async (overrideJavaHome?: string) => {
    setLoading(true);
    setError(null);
    const home = (overrideJavaHome ?? readLspJavaHome()).trim();
    try {
      // Keep the backend override in sync before probing so jdtls launch + status agree.
      await lspSetJavaHome(home || null);
      await lspSetJavaVmargs(readLspJavaVmargs());
      const next = await lspDetectServers({ javaHome: home || null });
      setStatuses(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const pending = consumePendingSettingsSection();
    if (pending?.id === "language-servers" && pending.presetId) {
      setFocusPresetId(pending.presetId);
    }
  }, []);

  useEffect(() => {
    if (!focusPresetId || loading) return;
    const status = statuses.find((item) => item.presetId === focusPresetId);
    if (!status) return;

    // Expand install when binary missing or runtime is unusable (e.g. Java < 21).
    if (!status.available || status.error) {
      setExpandedInstall((current) => ({ ...current, [focusPresetId]: true }));
    }

    const row = document.getElementById(`language-server-${focusPresetId}`);
    if (!row) return;

    let highlightTimer: number | undefined;
    const scrollFrame = window.requestAnimationFrame(() => {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      clearPendingSettingsSection();
      highlightTimer = window.setTimeout(() => setFocusPresetId(null), 4000);
    });

    return () => {
      window.cancelAnimationFrame(scrollFrame);
      if (highlightTimer) window.clearTimeout(highlightTimer);
    };
  }, [focusPresetId, loading, statuses]);

  const updateCommand = (presetId: string, commandId: string) => {
    setCommandPrefs((current) => {
      const next = { ...current, [presetId]: commandId };
      writeLspCommandPrefs(next);
      return next;
    });
  };

  const updateCustom = (presetId: string, patch: Partial<LspCustomCommandConfig>) => {
    setCustomCommands((current) => {
      const existing = current[presetId] ?? { command: "", args: "" };
      const nextConfig = { ...existing, ...patch };
      const next = { ...current };
      if (nextConfig.command.trim() || nextConfig.args.trim()) next[presetId] = nextConfig;
      else delete next[presetId];
      writeLspCustomCommands(next);
      return next;
    });
  };

  const commitJavaHome = useCallback((next: string) => {
    const trimmed = next.trim();
    setJavaHome(trimmed);
    writeLspJavaHome(trimmed);
    void refresh(trimmed);
  }, [refresh]);

  const commitJavaVmargs = useCallback((raw: string) => {
    const effective = writeLspJavaVmargs(raw.trim() === "" ? null : raw);
    setJavaVmargs(effective);
    void (async () => {
      try {
        await lspSetJavaVmargs(effective);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  /** Merge a patch into the Java settings, persist, and hot-apply to jdtls. */
  const commitJavaSettings = useCallback((patch: Partial<LspJavaSettings>) => {
    setJavaSettings((current) => {
      const next = writeLspJavaSettings({ ...current, ...patch });
      void (async () => {
        try {
          await lspSetJavaSettings(next);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
      return next;
    });
  }, []);

  const browseJavaHome = useCallback(async () => {
    try {
      const selected = await selectFolderPath(javaHome || undefined);
      if (selected) commitJavaHome(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [commitJavaHome, javaHome]);

  const toggleInstall = (presetId: string) => {
    setExpandedInstall((current) => ({
      ...current,
      [presetId]: !current[presetId],
    }));
  };

  const missingCount = statuses.filter((status) => !status.available).length;

  return (
    <section
      data-testid="language-servers-settings"
      className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3"
    >
      <div className="mb-3 flex items-start gap-3">
        <Server className="mt-0.5 h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t("settings.languageServersTitle")}</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.languageServersSubtitle")}
          </div>
        </div>
        <button
          type="button"
          data-testid="language-servers-refresh"
          className="taomni-btn h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.languageServersRefresh")}
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[12px] text-red-500">
          {error}
        </div>
      )}

      <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
        <span>
          {loading
            ? t("settings.languageServersDetecting")
            : t("settings.languageServersSummary", {
              available: statuses.filter((s) => s.available).length,
              total: statuses.length,
            })}
        </span>
        {missingCount > 0 && (
          <span className="text-amber-500">
            {t("settings.languageServersMissing", { count: missingCount })}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {statuses.map((status) => {
          const custom = customCommands[status.presetId] ?? { command: "", args: "" };
          const selected = commandPrefs[status.presetId]
            ?? status.selectedCommandId
            ?? status.commands[0]?.id
            ?? "";
          const selectedCommand = status.commands.find((command) => command.id === selected)
            ?? status.commands[0]
            ?? null;
          // Prefer guide for the selected binary; fall back to first command / server hint.
          const installGuide = resolveInstallGuide(
            selectedCommand?.id ?? status.commands[0]?.id ?? status.presetId,
            selectedCommand?.installHint ?? status.installHint,
          );
          const installOpen = !!expandedInstall[status.presetId];

          return (
            <div
              key={status.presetId}
              id={`language-server-${status.presetId}`}
              data-testid={`language-server-row-${status.presetId}`}
              data-focused={focusPresetId === status.presetId || undefined}
              className={`rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-2.5 py-2 scroll-mt-20 ${
                focusPresetId === status.presetId
                  ? "ring-2 ring-[var(--taomni-accent)] ring-offset-2 ring-offset-[var(--taomni-panel-bg)]"
                  : ""
              }`}
            >
              <div className="flex items-center gap-2 text-[12px]">
                <span
                  data-available={status.available || undefined}
                  data-runtime-error={!!status.error || undefined}
                  className="h-2 w-2 shrink-0 rounded-full bg-amber-500 data-[available=true]:bg-[var(--taomni-accent)] data-[runtime-error=true]:bg-amber-500"
                  title={
                    status.available
                      ? t("settings.languageServersRuntimeOk")
                      : status.error
                        ? t("settings.languageServersRuntimeIssue")
                        : "Not found on PATH"
                  }
                />
                <span className="min-w-0 flex-1 font-medium text-[var(--taomni-text)]">
                  {status.displayName}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-text-muted)]">
                  {status.documentLanguageIds.slice(0, 3).join(", ")}
                  {status.documentLanguageIds.length > 3 ? "…" : ""}
                </span>
              </div>

              <label className="mt-1.5 block text-[11px] text-[var(--taomni-text-muted)]">
                {t("settings.languageServersCommand")}
                <select
                  value={selected}
                  className="mt-0.5 h-7 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 text-[12px] text-[var(--taomni-text)] outline-none"
                  onChange={(event) => updateCommand(status.presetId, event.target.value)}
                  aria-label={`${status.displayName} language server command`}
                >
                  {status.commands.map((command) => (
                    <option key={command.id} value={command.id}>
                      {command.label}{command.fallback ? " fallback" : ""}
                      {command.available ? "" : " — missing"}
                    </option>
                  ))}
                  <option value={CUSTOM_LSP_COMMAND_ID}>
                    {t("settings.languageServersCustomCommand")}
                  </option>
                </select>
              </label>

              {selected === CUSTOM_LSP_COMMAND_ID && (
                <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <input
                    value={custom.command}
                    className="h-7 min-w-0 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                    placeholder={t("settings.languageServersCommandPlaceholder")}
                    aria-label={`${status.displayName} custom command`}
                    onChange={(event) => updateCustom(status.presetId, { command: event.target.value })}
                  />
                  <input
                    value={custom.args}
                    className="h-7 min-w-0 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                    placeholder={t("settings.languageServersArgsPlaceholder")}
                    aria-label={`${status.displayName} custom args`}
                    onChange={(event) => updateCustom(status.presetId, { args: event.target.value })}
                  />
                </div>
              )}

              {(status.runtimeStatus || status.presetId === "java") && (
                <div
                  data-testid={`language-server-runtime-${status.presetId}`}
                  data-ok={status.available && !status.error ? "true" : "false"}
                  className={`mt-1.5 rounded border px-2 py-1.5 text-[11px] leading-snug ${
                    status.available && !status.error
                      ? "border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] text-[var(--taomni-text-muted)]"
                      : "border-amber-500/35 bg-amber-500/10 text-[var(--taomni-text)]"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-[10px] uppercase tracking-wide text-[var(--taomni-text-muted)]">
                      {t("settings.languageServersRuntime")}
                    </span>
                    <span
                      className={`rounded px-1 text-[10px] font-medium ${
                        status.available && !status.error
                          ? "bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)]"
                          : "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                      }`}
                    >
                      {status.available && !status.error
                        ? t("settings.languageServersRuntimeOk")
                        : t("settings.languageServersRuntimeIssue")}
                    </span>
                  </div>
                  {status.runtimeStatus && (
                    <div className="mt-0.5 font-mono text-[10px] break-all">
                      {status.runtimeStatus}
                    </div>
                  )}
                  {status.presetId === "java" && (
                    <>
                      <div className="mt-1 text-[10px] leading-snug text-[var(--taomni-text-muted)]">
                        {t("settings.languageServersJavaRequirement")}
                      </div>
                      <label className="mt-1.5 block text-[11px] text-[var(--taomni-text-muted)]">
                        {t("settings.languageServersJavaHome")}
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <input
                            data-testid="language-servers-java-home"
                            value={javaHome}
                            className="h-7 min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                            placeholder={t("settings.languageServersJavaHomePlaceholder")}
                            aria-label={t("settings.languageServersJavaHome")}
                            onChange={(event) => setJavaHome(event.target.value)}
                            onBlur={(event) => {
                              if (event.target.value.trim() !== readLspJavaHome().trim()) {
                                commitJavaHome(event.target.value);
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.currentTarget.blur();
                              }
                            }}
                          />
                          <button
                            type="button"
                            data-testid="language-servers-java-home-browse"
                            className="taomni-btn h-7 px-2 inline-flex items-center gap-1 text-[11px]"
                            onClick={() => void browseJavaHome()}
                            title={t("settings.languageServersJavaHomeBrowse")}
                          >
                            <FolderOpen className="h-3.5 w-3.5" />
                            {t("settings.languageServersJavaHomeBrowse")}
                          </button>
                          {javaHome.trim() !== "" && (
                            <button
                              type="button"
                              data-testid="language-servers-java-home-clear"
                              className="taomni-btn h-7 px-2 text-[11px]"
                              onClick={() => commitJavaHome("")}
                            >
                              {t("settings.languageServersJavaHomeClear")}
                            </button>
                          )}
                        </div>
                        <div className="mt-1 text-[10px] leading-snug text-[var(--taomni-text-muted)]">
                          {t("settings.languageServersJavaHomeHint")}
                        </div>
                      </label>
                      <label className="mt-2 block text-[11px] text-[var(--taomni-text-muted)]">
                        {t("settings.languageServersJavaVmargs")}
                        <div className="mt-0.5 flex flex-wrap items-start gap-1.5">
                          <textarea
                            data-testid="language-servers-java-vmargs"
                            value={javaVmargs}
                            rows={2}
                            spellCheck={false}
                            className="min-h-14 min-w-0 flex-1 resize-y rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-1 font-mono text-[11px] leading-snug text-[var(--taomni-text)] outline-none"
                            placeholder={t("settings.languageServersJavaVmargsPlaceholder")}
                            aria-label={t("settings.languageServersJavaVmargs")}
                            onChange={(event) => setJavaVmargs(event.target.value)}
                            onBlur={(event) => {
                              const next = event.target.value.replace(/\s+/g, " ").trim();
                              const current = readLspJavaVmargs();
                              if (next === "" || next !== current) {
                                commitJavaVmargs(next);
                              } else {
                                setJavaVmargs(current);
                              }
                            }}
                          />
                          {javaVmargs.trim() !== ""
                            && javaVmargs.replace(/\s+/g, " ").trim() !== DEFAULT_LSP_JAVA_VMARGS && (
                            <button
                              type="button"
                              data-testid="language-servers-java-vmargs-clear"
                              className="taomni-btn h-7 px-2 text-[11px]"
                              onClick={() => commitJavaVmargs("")}
                            >
                              {t("settings.languageServersJavaVmargsClear")}
                            </button>
                          )}
                        </div>
                        <div className="mt-1 text-[10px] leading-snug text-[var(--taomni-text-muted)]">
                          {t("settings.languageServersJavaVmargsHint")}
                        </div>
                      </label>
                      <div className="mt-3 border-t border-[var(--taomni-border)] pt-2">
                        <div className="text-[11px] font-medium text-[var(--taomni-text)]">
                          {t("settings.languageServersJavaSettingsTitle")}
                        </div>
                        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--taomni-text)]">
                          <input
                            type="checkbox"
                            data-testid="language-servers-java-autobuild"
                            checked={javaSettings.autobuildEnabled}
                            onChange={(event) => commitJavaSettings({ autobuildEnabled: event.target.checked })}
                          />
                          {t("settings.languageServersJavaAutobuild")}
                        </label>
                        <label className="mt-1 flex items-center gap-2 text-[11px] text-[var(--taomni-text)]">
                          <input
                            type="checkbox"
                            data-testid="language-servers-java-organize-imports"
                            checked={javaSettings.saveActionsOrganizeImports}
                            onChange={(event) =>
                              commitJavaSettings({ saveActionsOrganizeImports: event.target.checked })}
                          />
                          {t("settings.languageServersJavaOrganizeImports")}
                        </label>
                        <label className="mt-1 flex items-center gap-2 text-[11px] text-[var(--taomni-text)]">
                          <input
                            type="checkbox"
                            data-testid="language-servers-java-lombok"
                            checked={javaSettings.lombokEnabled}
                            onChange={(event) => commitJavaSettings({ lombokEnabled: event.target.checked })}
                          />
                          {t("settings.languageServersJavaLombok")}
                        </label>
                        {javaSettings.lombokEnabled && (
                          <label className="mt-1 block text-[11px] text-[var(--taomni-text-muted)]">
                            {t("settings.languageServersJavaLombokJar")}
                            <input
                              type="text"
                              spellCheck={false}
                              data-testid="language-servers-java-lombok-jar"
                              className="mt-0.5 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-1 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                              placeholder={t("settings.languageServersJavaLombokJarPlaceholder")}
                              defaultValue={javaSettings.lombokJarPath}
                              onBlur={(event) => {
                                if (event.target.value.trim() !== javaSettings.lombokJarPath.trim()) {
                                  commitJavaSettings({ lombokJarPath: event.target.value.trim() });
                                }
                              }}
                            />
                            <span className="mt-0.5 block text-[10px] leading-snug">
                              {t("settings.languageServersJavaLombokHint")}
                            </span>
                          </label>
                        )}
                        <label className="mt-2 block text-[11px] text-[var(--taomni-text-muted)]">
                          {t("settings.languageServersJavaFormatProfile")}
                          <input
                            type="text"
                            spellCheck={false}
                            data-testid="language-servers-java-format-profile"
                            className="mt-0.5 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-1 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                            placeholder={t("settings.languageServersJavaFormatProfilePlaceholder")}
                            defaultValue={javaSettings.formatSettingsUrl}
                            onBlur={(event) => {
                              if (event.target.value.trim() !== javaSettings.formatSettingsUrl.trim()) {
                                commitJavaSettings({ formatSettingsUrl: event.target.value.trim() });
                              }
                            }}
                          />
                        </label>
                        <label className="mt-2 block text-[11px] text-[var(--taomni-text-muted)]">
                          {t("settings.languageServersJavaImportOrder")}
                          <input
                            type="text"
                            spellCheck={false}
                            data-testid="language-servers-java-import-order"
                            className="mt-0.5 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-1 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                            placeholder="java, javax, jakarta, com, org"
                            defaultValue={javaSettings.completionImportOrder.join(", ")}
                            onBlur={(event) => {
                              const next = event.target.value
                                .split(",")
                                .map((entry) => entry.trim())
                                .filter((entry) => entry !== "");
                              if (next.join(",") !== javaSettings.completionImportOrder.join(",")) {
                                commitJavaSettings({ completionImportOrder: next });
                              }
                            }}
                          />
                          <span className="mt-0.5 block text-[10px] leading-snug">
                            {t("settings.languageServersJavaImportOrderHint")}
                          </span>
                        </label>
                      </div>
                    </>
                  )}
                </div>
              )}

              {installGuide && (
                <InstallGuideDisclosure
                  open={installOpen}
                  onToggle={() => toggleInstall(status.presetId)}
                  guide={installGuide}
                  hostOs={hostOs}
                  label={status.displayName}
                  available={status.available}
                />
              )}
              {status.error && (
                <div
                  data-testid={`language-server-error-${status.presetId}`}
                  className="mt-1 text-[11px] text-red-500"
                >
                  {status.error}
                </div>
              )}
            </div>
          );
        })}
        {!loading && statuses.length === 0 && (
          <div className="py-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.languageServersEmpty")}
          </div>
        )}
      </div>
    </section>
  );
}

function InstallGuideDisclosure({
  open,
  onToggle,
  guide,
  hostOs,
  label,
  available,
}: {
  open: boolean;
  onToggle: () => void;
  guide: ResolvedInstallGuide;
  hostOs: LspInstallOs | null;
  label: string;
  available: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-1.5" data-testid="language-servers-install-disclosure">
      <button
        type="button"
        data-testid="language-servers-install-toggle"
        className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-[var(--taomni-text)]"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5" />
          : <ChevronRight className="h-3.5 w-3.5" />}
        {open
          ? t("settings.languageServersHideInstall")
          : available
            ? t("settings.languageServersShowInstallInstalled")
            : t("settings.languageServersShowInstall")}
      </button>
      {open && (
        <div
          className="mt-1 flex flex-col gap-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-2"
          data-testid="language-servers-install-panel"
        >
          {guide.lines.map((line) => {
            const isCurrent = line.os != null && line.os === hostOs;
            const rowKey = line.os ?? "shared";
            return (
              <div
                key={rowKey}
                data-testid={`language-servers-install-line-${rowKey}`}
                data-current-os={isCurrent || undefined}
                className={`rounded px-1.5 py-1 ${
                  isCurrent ? "bg-[var(--taomni-selected)]/40 ring-1 ring-[var(--taomni-accent-soft)]" : ""
                }`}
              >
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium text-[var(--taomni-text-muted)]">
                  {line.os
                    ? (
                      <>
                        <span>{osLabel(line.os)}</span>
                        {isCurrent && (
                          <span className="rounded bg-[var(--taomni-accent)]/15 px-1 text-[var(--taomni-accent)]">
                            {t("settings.languageServersThisOs")}
                          </span>
                        )}
                      </>
                    )
                    : (
                      <span>{t("settings.languageServersAllOs")}</span>
                    )}
                  <button
                    type="button"
                    className="ml-auto inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-[var(--taomni-text)]"
                    title={t("settings.languageServersCopyInstall")}
                    aria-label={`${t("settings.languageServersCopyInstall")} (${label}${line.os ? ` · ${osLabel(line.os)}` : ""})`}
                    data-testid={`language-servers-copy-install-${rowKey}`}
                    onClick={() => { void writeText(line.command); }}
                  >
                    <Copy className="h-3 w-3" />
                    {t("settings.languageServersCopy")}
                  </button>
                </div>
                {line.note && (
                  <div
                    className="mb-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-[var(--taomni-text)]"
                    data-testid={`language-servers-install-note-${rowKey}`}
                  >
                    <span className="font-semibold text-amber-600">
                      {t("settings.languageServersInstallNote")}:{" "}
                    </span>
                    {line.note}
                  </div>
                )}
                <div className="mb-0.5 text-[10px] text-[var(--taomni-text-muted)]">
                  {t("settings.languageServersCopyHint")}
                </div>
                <pre
                  className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-2 py-1.5 font-mono text-[11px] leading-snug text-[var(--taomni-text)]"
                  data-testid={
                    // Keep a stable selector for the first/primary copyable command block.
                    line === guide.lines[0]
                      ? "language-servers-install-hint"
                      : `language-servers-install-cmd-${rowKey}`
                  }
                >
                  {line.command}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
