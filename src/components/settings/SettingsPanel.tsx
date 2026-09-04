import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  History,
  RotateCcw,
  Search,
  Terminal,
  Type,
  Undo,
} from "lucide-react";
import { useAppTheme } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";
import {
  DEFAULT_TERMINAL_DEFAULT_PROFILE,
  DEFAULT_TERMINAL_PROFILE,
  loadTerminalDefaultProfile,
  saveTerminalDefaultProfile,
  type TerminalProfile,
} from "../../lib/terminalProfile";
import {
  DEFAULT_CODE_VIEW_PROFILE,
  applyCodeViewProfile,
  loadCodeViewProfile,
  saveCodeViewProfile,
  type CodeViewProfile,
} from "../../lib/codeViewProfile";
import { AppThemeSwitcher } from "./AppThemeSwitcher";
import { LanguageSection } from "./LanguageSection";
import { VaultSettings } from "../vault/VaultSettings";
import { BackupSettingsPanel } from "./BackupSettingsPanel";
import { AppProxyPanel } from "./AppProxyPanel";
import { LanChatSettings } from "./LanChatSettings";
import { useAppStore } from "../../stores/appStore";
import { useSystemFonts } from "../../lib/systemFonts";
import { LlmProvidersPanel } from "./LlmProvidersPanel";
import { AsrPanel } from "./AsrPanel";
import { PrivacyToggle } from "./PrivacyToggle";
import { AiMasterSwitch } from "./AiMasterSwitch";
import { AiShellPanel } from "./AiShellPanel";
import { WebSearchPanel } from "./WebSearchPanel";
import { ClaudeCodePanel } from "./ClaudeCodePanel";
import { CodexCodePanel } from "./CodexCodePanel";
import { AcpAgentsPanel } from "./AcpAgentsPanel";
import { ChatHistoryPanel } from "./ChatHistoryPanel";
import { ChatOutputFormatPanel } from "./ChatOutputFormatPanel";
import { ChatSendShortcutPanel } from "./ChatSendShortcutPanel";
import { EditorAiLanguagePanel } from "./EditorAiLanguagePanel";
import { ModelsAdvancedPanel } from "./ModelsAdvancedPanel";
import { useAiStore } from "../../stores/aiStore";
import {
  SETTINGS_GROUPS,
  defaultExpandedGroups,
  groupIdForEntry,
  matchingGroupIds,
  matchingIds,
} from "./settingsSearch";
import { CodeViewAppearanceSettings } from "./CodeViewAppearanceSettings";
import { TerminalAppearanceSettings } from "../terminal/TerminalAppearanceSettings";
import { SqlCompletionSettings } from "./SqlCompletionSettings";
import { SqlExecutionSettings } from "./SqlExecutionSettings";
import { LanguageServersSettings } from "./LanguageServersSettings";
import { LiveTemplatesSettings } from "./LiveTemplatesSettings";
import { SftpSettings } from "./SftpSettings";
import { SdkSettings } from "./SdkSettings";
import { FontPickerSelect, type FontPickerOption } from "../terminal/FontPickerPanel";
import {
  consumePendingSettingsSection,
  clearPendingSettingsSection,
  OPEN_SETTINGS_SECTION_EVENT,
  type OpenSettingsSectionDetail,
} from "../../lib/settingsNavigation";

const UI_FONTS = [
  { value: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "Inter (Default UI - Highly Recommended)" },
  { value: '"Outfit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "Outfit (Geometric Elegant)" },
  { value: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif', label: "Segoe UI (Windows Default)" },
  { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "SF Pro / San Francisco (macOS Default)" },
  { value: '"Ubuntu", "DejaVu Sans", sans-serif', label: "Ubuntu (Linux Default)" },
  { value: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif', label: "System UI Default" },
];
interface SettingsSearchContextValue {
  searching: boolean;
  matchedSet: Set<string>;
  activeId: string | null;
  register: (id: string, el: HTMLElement | null) => void;
}

const SettingsSearchContext = createContext<SettingsSearchContextValue | null>(null);

// Wraps one searchable settings unit: registers its DOM node so the panel can
// scroll to it, and reflects match state through styling plus a
// `data-search-match` attribute that tests can assert on without a real scroll.
function SettingsAnchor({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = useContext(SettingsSearchContext);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ctx?.register(id, ref.current);
    return () => ctx?.register(id, null);
  }, [ctx, id]);

  const searching = ctx?.searching ?? false;
  const matched = ctx?.matchedSet.has(id) ?? false;
  const active = (ctx?.activeId ?? null) === id;

  return (
    <div
      ref={ref}
      data-search-id={id}
      data-search-match={searching ? String(matched) : undefined}
      className={className}
      style={{
        scrollMarginTop: 72,
        borderRadius: matched ? 10 : undefined,
        outline: matched ? `${active ? 2 : 1}px solid var(--taomni-accent)` : undefined,
        outlineOffset: matched ? 3 : undefined,
        boxShadow: active ? "0 0 0 3px var(--taomni-selected)" : undefined,
        opacity: searching && !matched ? 0.4 : 1,
        transition: "opacity 120ms ease",
      }}
    >
      {children}
    </div>
  );
}

function SettingsGroup({
  id,
  title,
  expanded,
  onToggle,
  matchCount,
  searching,
  children,
}: {
  id: string;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  matchCount: number;
  searching: boolean;
  children: React.ReactNode;
}) {
  const hasMatch = matchCount > 0;
  return (
    <section
      data-testid={`settings-group-${id}`}
      data-group-id={id}
      data-expanded={expanded ? "true" : "false"}
      data-group-match={searching ? String(hasMatch) : undefined}
      className="mb-4"
      style={{
        opacity: searching && !hasMatch ? 0.55 : 1,
        transition: "opacity 120ms ease",
      }}
    >
      <button
        type="button"
        data-testid={`settings-group-toggle-${id}`}
        aria-expanded={expanded}
        aria-controls={`settings-group-body-${id}`}
        className="flex w-full items-center gap-2 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] px-3 py-2 text-left hover:bg-[var(--taomni-control-hover)]"
        style={
          searching && hasMatch
            ? { outline: "1px solid var(--taomni-accent)", outlineOffset: 1 }
            : undefined
        }
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--taomni-text-muted)]" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--taomni-text-muted)]" />
        )}
        <span className="flex-1 text-[13px] font-semibold tracking-wide">{title}</span>
        {searching && hasMatch && (
          <span
            data-testid={`settings-group-match-count-${id}`}
            className="tabular-nums text-[11px] font-medium text-[var(--taomni-accent)]"
          >
            {matchCount}
          </span>
        )}
      </button>
      {/* Keep body mounted so SettingsAnchor refs stay registered for scroll. */}
      <div
        id={`settings-group-body-${id}`}
        data-testid={`settings-group-body-${id}`}
        hidden={!expanded}
        className="mt-2"
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsPanel() {
  const [codeViewProfile, setCodeViewProfile] = useState<CodeViewProfile>(() => loadCodeViewProfile());
  const [terminalDefaultProfile, setTerminalDefaultProfile] = useState<TerminalProfile>(
    () => loadTerminalDefaultProfile(),
  );
  const { mode, resolvedTheme } = useAppTheme();
  const uiFontFamily = useAppStore((s) => s.uiFontFamily);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  const welcomeRecentSessionLimit = useAppStore((s) => s.welcomeRecentSessionLimit);
  const setUiFontFamily = useAppStore((s) => s.setUiFontFamily);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const setWelcomeRecentSessionLimit = useAppStore((s) => s.setWelcomeRecentSessionLimit);
  const [fontCatalogRequested, setFontCatalogRequested] = useState(false);
  const systemFonts = useSystemFonts(fontCatalogRequested);
  const voiceShellEnabled = useAiStore((s) => s.voiceShellEnabled);
  const toggleVoiceShell = useAiStore((s) => s.toggleVoiceShell);
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();

  const [query, setQuery] = useState("");
  const matchIds = useMemo(() => matchingIds(query, t), [query, t]);
  const matchKey = matchIds.join("|");
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRefs = useRef<Map<string, HTMLElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(defaultExpandedGroups);

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) anchorRefs.current.set(id, el);
    else anchorRefs.current.delete(id);
  }, []);

  const ensureGroupExpanded = useCallback((entryId: string | undefined) => {
    if (!entryId) return;
    const groupId = groupIdForEntry(entryId);
    if (!groupId) return;
    setExpandedGroups((prev) => {
      if (prev[groupId]) return prev;
      return { ...prev, [groupId]: true };
    });
  }, []);

  const scrollToId = useCallback((id: string | undefined) => {
    if (!id) return;
    ensureGroupExpanded(id);
    // Expand may reflow; wait a frame so hidden=false is applied before scroll.
    window.requestAnimationFrame(() => {
      anchorRefs.current.get(id)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    });
  }, [ensureGroupExpanded]);

  const focusSection = useCallback((detail: OpenSettingsSectionDetail) => {
    ensureGroupExpanded(detail.id);
    let attempts = 0;
    let frame = 0;
    const run = () => {
      const anchor = anchorRefs.current.get(detail.id);
      if (anchor) {
        // Group body may still be `hidden` on the first frame after expand.
        const groupId = groupIdForEntry(detail.id);
        const body = groupId
          ? document.querySelector(`[data-testid="settings-group-body-${groupId}"]`)
          : null;
        if (body instanceof HTMLElement && body.hidden) {
          attempts += 1;
          if (attempts < 48) frame = window.requestAnimationFrame(run);
          return;
        }
        anchor.scrollIntoView({
          block: detail.presetId ? "start" : "center",
          behavior: attempts === 0 ? "auto" : "smooth",
        });
        if (!detail.presetId) clearPendingSettingsSection();
        return;
      }
      attempts += 1;
      if (attempts < 48) frame = window.requestAnimationFrame(run);
    };
    frame = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(frame);
  }, [ensureGroupExpanded]);

  // New query → expand matching groups, jump to the first match.
  useEffect(() => {
    setActiveIndex(0);
    if (matchIds.length === 0) return;
    const groups = matchingGroupIds(matchIds);
    setExpandedGroups((prev) => {
      const next = { ...prev };
      for (const g of SETTINGS_GROUPS) {
        // While searching, open groups with hits so matches are reachable;
        // leave other groups as the user left them (usually collapsed after browse).
        if (groups.includes(g.id)) next[g.id] = true;
      }
      return next;
    });
    scrollToId(matchIds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey]);

  // Status bar / deep links: open Settings and scroll to a section.
  useEffect(() => {
    const onOpenSection = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsSectionDetail>).detail;
      if (!detail?.id) return;
      focusSection(detail);
    };
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpenSection as EventListener);
    return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpenSection as EventListener);
  }, [focusSection]);

  // Settings tab may mount after the navigation event (first open).
  useEffect(() => {
    const pending = consumePendingSettingsSection();
    if (!pending?.id) return;
    return focusSection(pending);
  }, [focusSection]);

  const goToMatch = useCallback(
    (delta: number) => {
      if (matchIds.length === 0) return;
      setActiveIndex((prev) => {
        const next = (prev + delta + matchIds.length) % matchIds.length;
        scrollToId(matchIds[next]);
        return next;
      });
    },
    [matchIds, scrollToId],
  );
  const searching = query.trim().length > 0;
  const clampedIndex = matchIds.length > 0 ? Math.min(activeIndex, matchIds.length - 1) : 0;
  const activeId = matchIds[clampedIndex] ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matchedSet = useMemo(() => new Set(matchIds), [matchKey]);
  const matchedGroupIds = useMemo(() => matchingGroupIds(matchIds), [matchKey]);

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);

  const matchCountByGroup = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const g of SETTINGS_GROUPS) counts[g.id] = 0;
    for (const id of matchIds) {
      const g = groupIdForEntry(id);
      if (g) counts[g] = (counts[g] ?? 0) + 1;
    }
    return counts;
  }, [matchKey]);

  const ctxValue = useMemo<SettingsSearchContextValue>(
    () => ({ searching, matchedSet, activeId, register }),
    [searching, matchedSet, activeId, register],
  );

  const currentSelectValue = useMemo(() => {
    if (UI_FONTS.some((f) => f.value === uiFontFamily)) {
      return uiFontFamily;
    }
    const primary = uiFontFamily.replace(/['"]/g, "").split(",")[0].trim().toLowerCase();
    const sysMatch = systemFonts.fonts.find((f) => f.toLowerCase() === primary);
    if (sysMatch) {
      return `"${sysMatch}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    }
    return uiFontFamily;
  }, [uiFontFamily, systemFonts.fonts]);
  const uiFontOptions = useMemo<FontPickerOption[]>(() => {
    const options: FontPickerOption[] = [
      ...UI_FONTS.map((font) => ({
        value: font.value,
        label: font.label,
        fontFamily: font.value,
        group: "curated",
      })),
      ...systemFonts.fonts.map((font) => ({
        value: `"${font}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
        label: font,
        fontFamily: `"${font}", sans-serif`,
        group: "system",
      })),
    ];
    if (!options.some((option) => option.value === currentSelectValue)) {
      const label = currentSelectValue.replace(/["']/g, "").split(",")[0]?.trim() || currentSelectValue;
      options.unshift({
        value: currentSelectValue,
        label,
        fontFamily: currentSelectValue,
        group: "current",
      });
    }
    return options;
  }, [currentSelectValue, systemFonts.fonts]);
  const uiFontGroupLabels = useMemo(() => ({
    current: "",
    curated: t("settings.fontFamilyCurated"),
    system: t("settings.fontFamilySystem"),
  }), [t]);
  const requestSystemFonts = useCallback(() => setFontCatalogRequested(true), []);

  useEffect(() => {
    applyCodeViewProfile(codeViewProfile, DEFAULT_TERMINAL_PROFILE, { resolvedAppTheme: resolvedTheme });
  }, [codeViewProfile, resolvedTheme]);

  useEffect(() => {
    saveCodeViewProfile(codeViewProfile);
  }, [codeViewProfile]);

  const handleTerminalDefaultProfileChange = useCallback((profile: TerminalProfile) => {
    setTerminalDefaultProfile(profile);
    saveTerminalDefaultProfile(profile);
  }, []);

  const resetTerminalDefaultProfile = useCallback(() => {
    setTerminalDefaultProfile(DEFAULT_TERMINAL_DEFAULT_PROFILE);
    saveTerminalDefaultProfile(DEFAULT_TERMINAL_DEFAULT_PROFILE);
  }, []);

  const groupTitle = useCallback((titleKey: string) => t(titleKey), [t]);

  return (
    <SettingsSearchContext.Provider value={ctxValue}>
      <div
        data-testid="settings-panel"
        className="h-full overflow-auto"
        style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
      >
        <div className="mx-auto max-w-5xl p-5">
          <div className="mb-3">
            <div className="text-[18px] font-semibold">{t("settings.title")}</div>
            <div className="text-[12px] text-[var(--taomni-text-muted)]">
              {t("settings.subtitle")}
            </div>
          </div>
          <div
            className="sticky top-0 z-20 -mx-5 mb-4 px-5 pb-3 pt-1"
            style={{ background: "var(--taomni-bg)" }}
          >
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
                <input
                  ref={searchInputRef}
                  data-testid="settings-search-input"
                  type="search"
                  className="taomni-input h-8 w-full"
                  style={{ paddingLeft: "2rem" }}
                  placeholder={t("settings.searchPlaceholder")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goToMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setQuery("");
                    }
                  }}
                />
              </div>
              {searching && matchIds.length > 0 && (
                <div className="flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
                  <span data-testid="settings-search-count" className="tabular-nums">
                    {t("settings.searchResultCount", { current: clampedIndex + 1, total: matchIds.length })}
                  </span>
                  {matchedGroupIds.length > 1 && (
                    <span
                      data-testid="settings-search-group-count"
                      className="tabular-nums text-[var(--taomni-text-muted)]"
                      title={t("settings.searchGroupHint")}
                    >
                      · {t("settings.searchGroupCount", { count: matchedGroupIds.length })}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={t("settings.searchPrev")}
                    className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
                    onClick={() => goToMatch(-1)}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("settings.searchNext")}
                    className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
                    onClick={() => goToMatch(1)}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
            {searching && matchIds.length === 0 && (
              <div
                data-testid="settings-search-empty"
                className="mt-2 text-[12px] text-[var(--taomni-text-muted)]"
              >
                {t("settings.searchNoResults", { query })}
              </div>
            )}
          </div>

          {/* —— General —— */}
          <SettingsGroup
            id="general"
            title={groupTitle("settings.groupGeneral")}
            expanded={!!expandedGroups.general}
            onToggle={() => toggleGroup("general")}
            matchCount={matchCountByGroup.general ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="language">
              <LanguageSection />
            </SettingsAnchor>
            <SettingsAnchor id="app-theme">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <div className="mb-2 flex items-center gap-3">
                  <div>
                    <div className="text-[14px] font-semibold">{t("settings.appThemeTitle")}</div>
                    <div className="text-[12px] text-[var(--taomni-text-muted)]">
                      {t("settings.appThemeCurrent", { mode: themeLabel(mode), resolved: resolvedTheme })}
                    </div>
                  </div>
                </div>
                <AppThemeSwitcher />
              </section>
            </SettingsAnchor>

            <SettingsAnchor id="welcome-history">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <div className="mb-3 flex items-center gap-3">
                  <History className="w-4 h-4 text-[var(--taomni-accent)]" />
                  <div>
                    <div className="text-[14px] font-semibold">{t("settings.welcomeHistoryTitle")}</div>
                    <div className="text-[12px] text-[var(--taomni-text-muted)]">
                      {t("settings.welcomeHistorySubtitle")}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 pt-2 border-t border-[var(--taomni-divider)]">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="welcome-recent-session-limit" className="text-[12px] font-medium text-[var(--taomni-text-muted)]">
                      {t("settings.welcomeHistoryLimitLabel")}
                    </label>
                    <input
                      id="welcome-recent-session-limit"
                      data-testid="settings-welcome-recent-session-limit"
                      className="taomni-input h-8 w-full"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      aria-label={t("settings.welcomeHistoryLimitAria")}
                      value={welcomeRecentSessionLimit}
                      onChange={(e) => setWelcomeRecentSessionLimit(parseInt(e.target.value, 10))}
                    />
                  </div>
                  <div className="text-[12px] text-[var(--taomni-text-muted)] flex items-center">
                    {t("settings.welcomeHistoryLimitHint")}
                  </div>
                </div>
              </section>
            </SettingsAnchor>

            <SettingsAnchor id="global-ui">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <div className="mb-3 flex items-center gap-3">
                  <div>
                    <div className="text-[14px] font-semibold flex items-center gap-2">
                      <Type className="w-4 h-4 text-[var(--taomni-accent)]" />
                      {t("settings.globalUiTitle")}
                    </div>
                    <div className="text-[12px] text-[var(--taomni-text-muted)]">
                      {t("settings.globalUiSubtitle")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="taomni-btn ml-auto h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
                    onClick={() => {
                      setUiFontFamily('"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
                      setUiFontSize(12);
                    }}
                    title={t("settings.resetUiFontTitle")}
                  >
                    <Undo className="w-3.5 h-3.5" />
                    {t("settings.resetUiFont")}
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 pt-2 border-t border-[var(--taomni-divider)]">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="ui-font-family-select" className="text-[12px] font-medium text-[var(--taomni-text-muted)]">
                      {t("settings.fontFamilyLabel")}
                    </label>
                    <FontPickerSelect
                      ariaLabel={t("settings.fontFamilyLabel")}
                      id="ui-font-family-select"
                      testId="ui-font-family-select"
                      options={uiFontOptions}
                      selectedValue={currentSelectValue}
                      groupLabels={uiFontGroupLabels}
                      loading={fontCatalogRequested && systemFonts.loading}
                      onOpen={requestSystemFonts}
                      onSelect={setUiFontFamily}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center text-[12px] font-medium text-[var(--taomni-text-muted)]">
                      <label htmlFor="ui-font-size-slider">{t("settings.fontSizeLabel")}</label>
                      <span className="font-mono bg-[var(--taomni-selected)] text-[var(--taomni-accent)] px-1.5 py-0.5 rounded text-[11px] font-semibold">
                        {uiFontSize}px
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[10px] text-[var(--taomni-text-muted)]">A</span>
                      <input
                        id="ui-font-size-slider"
                        type="range"
                        min="10"
                        max="18"
                        step="1"
                        value={uiFontSize}
                        onChange={(e) => setUiFontSize(parseInt(e.target.value, 10))}
                        className="flex-1 h-1.5 rounded-lg appearance-none cursor-pointer accent-[var(--taomni-accent)] bg-[var(--taomni-divider)]"
                      />
                      <span className="text-[14px] font-semibold text-[var(--taomni-text-muted)]">A</span>
                    </div>
                  </div>
                </div>
              </section>
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Code —— */}
          <SettingsGroup
            id="code"
            title={groupTitle("settings.groupCode")}
            expanded={!!expandedGroups.code}
            onToggle={() => toggleGroup("code")}
            matchCount={matchCountByGroup.code ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="code-view-appearance">
              <div className="mb-4 flex items-center gap-3">
                <div>
                  <div className="text-[18px] font-semibold">{t("settings.codeViewAppearanceTitle")}</div>
                  <div className="text-[12px] text-[var(--taomni-text-muted)]">{t("settings.codeViewAppearanceSubtitle")}</div>
                </div>
                <button
                  data-testid="settings-reset-code-view-profile"
                  className="taomni-btn ml-auto h-8 inline-flex items-center gap-1.5"
                  type="button"
                  onClick={() => setCodeViewProfile(DEFAULT_CODE_VIEW_PROFILE)}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t("settings.reset")}
                </button>
              </div>
              <CodeViewAppearanceSettings
                profile={codeViewProfile}
                terminalProfile={DEFAULT_TERMINAL_PROFILE}
                onProfileChange={setCodeViewProfile}
                fontState={systemFonts}
                onRequestSystemFonts={requestSystemFonts}
              />
            </SettingsAnchor>

            <SettingsAnchor id="sdks" className="mt-4">
              <SdkSettings />
            </SettingsAnchor>

            <SettingsAnchor id="language-servers" className="mt-4">
              <LanguageServersSettings />
            </SettingsAnchor>

            <SettingsAnchor id="live-templates" className="mt-4">
              <LiveTemplatesSettings />
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Database —— */}
          <SettingsGroup
            id="database"
            title={groupTitle("settings.groupDatabase")}
            expanded={!!expandedGroups.database}
            onToggle={() => toggleGroup("database")}
            matchCount={matchCountByGroup.database ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="sql-completion">
              <SqlCompletionSettings />
            </SettingsAnchor>

            <SettingsAnchor id="sql-execution" className="mt-4">
              <SqlExecutionSettings />
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Terminal —— */}
          <SettingsGroup
            id="terminal"
            title={groupTitle("settings.groupTerminal")}
            expanded={!!expandedGroups.terminal}
            onToggle={() => toggleGroup("terminal")}
            matchCount={matchCountByGroup.terminal ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="sftp">
              <SftpSettings />
            </SettingsAnchor>
            <SettingsAnchor id="terminal-defaults" className="mt-4">
              <div className="mb-4 flex items-center gap-3">
                <Terminal className="w-4 h-4 text-[var(--taomni-accent)]" />
                <div>
                  <div className="text-[18px] font-semibold">{t("settings.terminalDefaultsTitle")}</div>
                  <div className="text-[12px] text-[var(--taomni-text-muted)]">
                    {t("settings.terminalDefaultsSubtitle")}
                  </div>
                </div>
                <button
                  data-testid="settings-reset-terminal-default-profile"
                  className="taomni-btn ml-auto h-8 inline-flex items-center gap-1.5"
                  type="button"
                  onClick={resetTerminalDefaultProfile}
                  title={t("settings.resetTerminalDefaults")}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t("settings.reset")}
                </button>
              </div>
              <TerminalAppearanceSettings
                profile={terminalDefaultProfile}
                onProfileChange={handleTerminalDefaultProfileChange}
                showCustomColors
                allowSystemTheme
                fontState={systemFonts}
                onRequestSystemFonts={requestSystemFonts}
              />
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Security —— */}
          <SettingsGroup
            id="security"
            title={groupTitle("settings.groupSecurity")}
            expanded={!!expandedGroups.security}
            onToggle={() => toggleGroup("security")}
            matchCount={matchCountByGroup.security ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="vault">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)]">
                <VaultSettings />
              </section>
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Backup & Restore —— */}
          <SettingsGroup
            id="backup"
            title={groupTitle("settings.groupBackup")}
            expanded={!!expandedGroups.backup}
            onToggle={() => toggleGroup("backup")}
            matchCount={matchCountByGroup.backup ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="backup">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-4">
                <BackupSettingsPanel />
              </section>
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Network —— */}
          <SettingsGroup
            id="network"
            title={groupTitle("settings.groupNetwork")}
            expanded={!!expandedGroups.network}
            onToggle={() => toggleGroup("network")}
            matchCount={matchCountByGroup.network ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="app-proxy">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <AppProxyPanel />
              </section>
            </SettingsAnchor>

            <SettingsAnchor id="lanchat">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <LanChatSettings />
              </section>
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— AI —— */}
          <SettingsGroup
            id="ai"
            title={groupTitle("settings.groupAi")}
            expanded={!!expandedGroups.ai}
            onToggle={() => toggleGroup("ai")}
            matchCount={matchCountByGroup.ai ?? 0}
            searching={searching}
          >
            <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
              <SettingsAnchor id="ai-master">
                <div className="mb-3 flex items-center gap-2">
                  <Bot className="w-4 h-4 text-[var(--taomni-accent)]" />
                  <div>
                    <div className="text-[14px] font-semibold">{t("settings.aiSection")}</div>
                    <div className="text-[11px] text-[var(--taomni-text-muted)]">
                      {t("settings.aiSubtitle")}
                    </div>
                  </div>
                </div>
                <div className="mb-3">
                  <AiMasterSwitch />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-privacy">
                <div className="mb-3">
                  <PrivacyToggle />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-shell">
                <div className="mb-3 pt-3 border-t border-[var(--taomni-divider)]">
                  <AiShellPanel enabled={voiceShellEnabled} onToggle={toggleVoiceShell} />
                </div>
              </SettingsAnchor>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-[var(--taomni-divider)]">
                <SettingsAnchor id="ai-asr">
                  <AsrPanel />
                </SettingsAnchor>
                <SettingsAnchor id="ai-llm">
                  <LlmProvidersPanel />
                </SettingsAnchor>
              </div>
              <SettingsAnchor id="ai-websearch">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <WebSearchPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-claude">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ClaudeCodePanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-codex">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <CodexCodePanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-acp">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <AcpAgentsPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-chatformat">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ChatOutputFormatPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-chatsend">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ChatSendShortcutPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-answerlang">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <EditorAiLanguagePanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-chathistory">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ChatHistoryPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-models">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ModelsAdvancedPanel />
                </div>
              </SettingsAnchor>
            </section>
          </SettingsGroup>
        </div>
      </div>
    </SettingsSearchContext.Provider>
  );
}
