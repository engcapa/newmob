import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import {
  CODE_VIEW_TERMINAL_THEME_PREFIX,
  resolveCodeThemeVars,
  type CodeViewProfile,
} from "../../lib/codeViewProfile";
import { resolveTerminalTheme, type TerminalProfile } from "../../lib/terminalProfile";
import { getTerminalThemeDefinition, resolveThemeId } from "../../lib/themes";
import { useAppTheme } from "../../lib/appTheme";
import { ThemePreviewSelect } from "../theme/ThemePreviewSelect";
import { buildCodeThemeOptions } from "../theme/themePreviews";
import {
  getPrimaryFontName,
  isMonospaceFont,
  makeTerminalFontFamily,
  resolveSelectedFontName,
  SAFE_TERMINAL_FONT_FALLBACKS,
  type SystemFontState,
  useSystemFonts,
  useTerminalFontOptions,
} from "../../lib/systemFonts";
import { useT } from "../../lib/i18n";
import { FontPickerSelect, type FontPickerOption } from "../terminal/FontPickerPanel";

interface CodeViewAppearanceSettingsProps {
  profile: CodeViewProfile;
  terminalProfile: TerminalProfile;
  onProfileChange: (profile: CodeViewProfile) => void;
  fontState?: SystemFontState;
  onRequestSystemFonts?: () => void;
}

export function CodeViewAppearanceSettings(props: CodeViewAppearanceSettingsProps) {
  if (props.fontState) {
    return <CodeViewAppearanceSettingsContent {...props} fontState={props.fontState} />;
  }
  return <CodeViewAppearanceSettingsWithFonts {...props} />;
}

function CodeViewAppearanceSettingsWithFonts(props: CodeViewAppearanceSettingsProps) {
  const [fontCatalogRequested, setFontCatalogRequested] = useState(false);
  const fontState = useSystemFonts(fontCatalogRequested);
  return (
    <CodeViewAppearanceSettingsContent
      {...props}
      fontState={fontState}
      onRequestSystemFonts={() => setFontCatalogRequested(true)}
    />
  );
}

function CodeViewAppearanceSettingsContent({
  profile,
  terminalProfile,
  onProfileChange,
  fontState,
  onRequestSystemFonts,
}: CodeViewAppearanceSettingsProps & { fontState: SystemFontState }) {
  const t = useT();
  const primaryFont = useMemo(() => getPrimaryFontName(profile.fontFamily), [profile.fontFamily]);
  const fontOptions = useTerminalFontOptions(
    [...(fontState.fonts.length > 0 ? fontState.fonts : SAFE_TERMINAL_FONT_FALLBACKS), primaryFont],
  );
  const selectedFont = resolveSelectedFontName(profile.fontFamily, fontOptions);
  const showFontWarning = selectedFont ? !isMonospaceFont(selectedFont) : false;
  const safeFontFamily = useMemo(() => {
    return isMonospaceFont(primaryFont) ? profile.fontFamily : makeTerminalFontFamily("Source Code Pro");
  }, [primaryFont, profile.fontFamily]);
  const fontPickerOptions = useMemo<FontPickerOption[]>(() => fontOptions.map((font) => ({
    value: font,
    label: font,
    fontFamily: `"${font}", monospace`,
  })), [fontOptions]);
  const fontGroupLabels = useMemo(() => ({
    mono: t("terminalAppearance.fontGroupMonoRecommended"),
    proportional: t("terminalAppearance.fontGroupProportional"),
  }), [t]);
  const fontGroupForOption = useCallback(
    (option: FontPickerOption) => isMonospaceFont(option.label) ? "mono" : "proportional",
    [],
  );
  const [fontSizeText, setFontSizeText] = useState(String(profile.fontSize));
  const draftProfileRef = useRef(profile);

  useEffect(() => {
    draftProfileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    setFontSizeText(String(profile.fontSize));
  }, [profile.fontSize]);

  const updateProfile = (patch: Partial<CodeViewProfile>) => {
    const next = { ...draftProfileRef.current, ...patch };
    draftProfileRef.current = next;
    onProfileChange(next);
  };

  const terminalThemeName = getTerminalThemeDefinition(terminalProfile.theme)?.name ?? terminalProfile.theme;
  const themeOptions = useMemo(() => buildCodeThemeOptions({
    appLabel: t("codeViewAppearance.themeFollowApp"),
    terminalLabel: t("codeViewAppearance.themeFollowTerminal", { name: terminalThemeName }),
    terminalTheme: resolveTerminalTheme(terminalProfile.theme),
    darkGroup: t("codeViewAppearance.themeEditorDarkGroup"),
    lightGroup: t("codeViewAppearance.themeEditorLightGroup"),
    terminalGroup: t("codeViewAppearance.themeTerminalGroup"),
  }), [t, terminalProfile.theme, terminalThemeName]);
  const themeSelectValue = useMemo(() => {
    if (themeOptions.some((option) => option.value === profile.theme)) return profile.theme;
    const terminalThemeId = resolveThemeId(profile.theme);
    const terminalValue = `${CODE_VIEW_TERMINAL_THEME_PREFIX}${terminalThemeId}`;
    return themeOptions.some((option) => option.value === terminalValue) ? terminalValue : profile.theme;
  }, [profile.theme, themeOptions]);

  return (
    <div data-testid="code-view-appearance-settings" className="space-y-4">
      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="grid grid-cols-12 gap-3 items-end">
          <label className="col-span-12 md:col-span-7">
            <span className="block text-[12px] font-semibold mb-1">{t("codeViewAppearance.fontLabel")}</span>
            <FontPickerSelect
              ariaLabel={t("codeViewAppearance.fontAria")}
              options={fontPickerOptions}
              selectedValue={selectedFont}
              loading={fontState.loading && fontState.fonts.length === 0}
              groupForOption={fontGroupForOption}
              groupLabels={fontGroupLabels}
              onOpen={onRequestSystemFonts}
              onSelect={(font) => updateProfile({ fontFamily: makeTerminalFontFamily(font) })}
            />
            {showFontWarning && (
              <p className="mt-1.5 text-[11px] text-[#ff6b6b] leading-snug">
                {t("terminalAppearance.nonMonospaceWarning")}
              </p>
            )}
          </label>

          <div className="col-span-8 md:col-span-3">
            <span className="block text-[12px] font-semibold mb-1">{t("codeViewAppearance.textSizeLabel")}</span>
            <div className="inline-flex items-center gap-1">
              <button
                className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label={t("codeViewAppearance.decreaseTextSize")}
                onClick={() => updateProfile({ fontSize: Math.max(8, profile.fontSize - 1) })}
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                className="taomni-input h-8 w-14 text-center"
                aria-label={t("codeViewAppearance.fontSizeAria")}
                value={fontSizeText}
                inputMode="numeric"
                onChange={(event) => {
                  const next = event.target.value;
                  if (!/^\d*$/.test(next)) return;
                  setFontSizeText(next);
                  const parsed = Number(next);
                  if (Number.isFinite(parsed) && parsed >= 8 && parsed <= 32) {
                    updateProfile({ fontSize: Math.round(parsed) });
                  }
                }}
                onBlur={() => {
                  const parsed = Number(fontSizeText);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    const clamped = Math.max(8, Math.min(32, Math.round(parsed)));
                    setFontSizeText(String(clamped));
                    updateProfile({ fontSize: clamped });
                  } else {
                    setFontSizeText(String(profile.fontSize));
                  }
                }}
              />
              <button
                className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label={t("codeViewAppearance.increaseTextSize")}
                onClick={() => updateProfile({ fontSize: Math.min(32, profile.fontSize + 1) })}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <label className="col-span-4 md:col-span-2 inline-flex items-center gap-1.5 pb-1">
            <input
              className="taomni-checkbox"
              type="checkbox"
              aria-label={t("codeViewAppearance.enableLigaturesAria")}
              checked={profile.fontLigatures}
              onChange={(event) => updateProfile({ fontLigatures: event.target.checked })}
            />
            <span className="text-[12px]">{t("terminalAppearance.ligaturesLabel")}</span>
          </label>

          <label className="col-span-12 md:col-span-4 inline-flex items-center gap-1.5 pb-1">
            <input
              className="taomni-checkbox"
              type="checkbox"
              aria-label={t("codeViewAppearance.enableSoftWrapAria")}
              checked={profile.softWrap}
              onChange={(event) => updateProfile({ softWrap: event.target.checked })}
            />
            <span className="text-[12px]">{t("codeViewAppearance.softWrapLabel")}</span>
          </label>
        </div>
      </section>

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="block">
          <span className="block text-[12px] font-semibold mb-1">{t("codeViewAppearance.themeLabel")}</span>
          <ThemePreviewSelect
            ariaLabel={t("codeViewAppearance.themeAria")}
            value={themeSelectValue}
            options={themeOptions}
            testId="code-theme-select"
            onChange={(theme) => updateProfile({ theme })}
          />
        </div>
      </section>

      <CodeViewPreview
        profile={profile}
        terminalProfile={terminalProfile}
        fontFamily={safeFontFamily}
      />
    </div>
  );
}

function CodeViewPreview({
  profile,
  terminalProfile,
  fontFamily,
}: {
  profile: CodeViewProfile;
  terminalProfile: TerminalProfile;
  fontFamily: string;
}) {
  const { resolvedTheme } = useAppTheme();
  const vars = resolveCodeThemeVars(profile, { resolvedAppTheme: resolvedTheme, terminalProfile });
  const style = {
    background: vars?.["--taomni-code-bg"] ?? "var(--taomni-code-bg)",
    color: vars?.["--taomni-code-text"] ?? "var(--taomni-code-text)",
    borderColor: vars?.["--taomni-code-border"] ?? "var(--taomni-code-border)",
    fontFamily,
    fontSize: profile.fontSize,
    fontFeatureSettings: profile.fontLigatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
  };
  const keyword = vars?.["--taomni-code-syntax-keyword"] ?? "var(--taomni-code-syntax-keyword)";
  const fn = vars?.["--taomni-code-syntax-function"] ?? "var(--taomni-code-syntax-function)";
  const variable = vars?.["--taomni-code-syntax-variable"] ?? "var(--taomni-code-syntax-variable)";
  const property = vars?.["--taomni-code-syntax-property"] ?? "var(--taomni-code-syntax-property)";
  const string = vars?.["--taomni-code-syntax-string"] ?? "var(--taomni-code-syntax-string)";
  const comment = vars?.["--taomni-code-syntax-comment"] ?? "var(--taomni-code-syntax-comment)";
  const punctuation = vars?.["--taomni-code-syntax-punctuation"] ?? "var(--taomni-code-syntax-punctuation)";
  const added = vars?.["--taomni-code-diff-added-bg"] ?? "var(--taomni-code-diff-added-bg)";
  const deleted = vars?.["--taomni-code-diff-deleted-bg"] ?? "var(--taomni-code-diff-deleted-bg)";

  return (
    <pre
      data-testid="code-view-preview"
      className="m-0 rounded-md border p-3 overflow-hidden taomni-mono leading-relaxed"
      style={style}
    >
      <span style={{ color: comment }}>{"// code view preview"}</span>
      {"\n"}
      <span style={{ background: deleted }}>
        <span style={{ color: keyword }}>function</span>{" "}
        <span style={{ color: fn }}>writeTerminalSplitLayout</span>
        <span style={{ color: punctuation }}>{"(layout)"}</span>{" "}
        <span style={{ color: punctuation }}>{"{"}</span>
      </span>
      {"\n"}
      <span style={{ background: added }}>
        {"  "}
        <span style={{ color: variable }}>window</span>
        <span style={{ color: punctuation }}>.</span>
        <span style={{ color: property }}>localStorage</span>
        <span style={{ color: punctuation }}>.</span>
        <span style={{ color: fn }}>setItem</span>
        <span style={{ color: punctuation }}>{"("}</span>
        <span style={{ color: string }}>"taomni.layout"</span>
        <span style={{ color: punctuation }}>{", "}</span>
        <span style={{ color: variable }}>layout</span>
        <span style={{ color: punctuation }}>{");"}</span>
      </span>
      {"\n"}
      <span style={{ color: punctuation }}>{"}"}</span>
    </pre>
  );
}
