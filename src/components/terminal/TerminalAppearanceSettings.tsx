import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import {
  TERMINAL_THEME_DEFINITIONS,
  resolveThemeId,
  type TerminalThemeDefinition,
} from "../../lib/themes";
import {
  makeCustomTerminalTheme,
  resolveTerminalTheme,
  terminalProfileThemeColors,
  type TerminalCursorStyle,
  type TerminalProfile,
  type TerminalRightClickBehavior,
} from "../../lib/terminalProfile";
import {
  makeTerminalFontFamily,
  resolveSelectedFontName,
  useSystemFonts,
  useTerminalFontOptions,
} from "../../lib/systemFonts";
import { historyClear } from "../../lib/ipc";

interface TerminalAppearanceSettingsProps {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
  showCustomColors?: boolean;
  showPreview?: boolean;
  className?: string;
}

const TERMINAL_CURSOR_OPTIONS: Array<{ label: string; style: TerminalCursorStyle; blink: boolean }> = [
  { label: "Block (blink)", style: "block", blink: true },
  { label: "Block (steady)", style: "block", blink: false },
  { label: "Underline (blink)", style: "underline", blink: true },
  { label: "Underline (steady)", style: "underline", blink: false },
  { label: "Vertical bar (blink)", style: "bar", blink: true },
  { label: "Vertical bar (steady)", style: "bar", blink: false },
];

const RIGHT_CLICK_OPTIONS: Array<{ label: string; value: TerminalRightClickBehavior }> = [
  { label: "Show context menu", value: "menu" },
  { label: "Paste clipboard", value: "paste" },
  { label: "Copy selection or paste", value: "copy-or-paste" },
];

export function TerminalAppearanceSettings({
  profile,
  onProfileChange,
  showCustomColors = false,
  showPreview = true,
  className = "",
}: TerminalAppearanceSettingsProps) {
  const fontState = useSystemFonts();
  const fontOptions = useTerminalFontOptions(fontState.fonts);
  const selectedFont = resolveSelectedFontName(profile.fontFamily, fontOptions);
  const colors = terminalProfileThemeColors(profile);
  const [bg, setBg] = useState(colors.background);
  const [fg, setFg] = useState(colors.foreground);
  const [fontSizeText, setFontSizeText] = useState(String(profile.fontSize));
  const [scrollbackText, setScrollbackText] = useState(String(profile.scrollback));
  const [inlineSuggestionsMaxText, setInlineSuggestionsMaxText] = useState(
    String(profile.inlineSuggestionsMax),
  );
  const [clearingHistory, setClearingHistory] = useState(false);
  const draftProfileRef = useRef(profile);

  useEffect(() => {
    draftProfileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    const nextColors = terminalProfileThemeColors(profile);
    setBg(nextColors.background);
    setFg(nextColors.foreground);
  }, [profile.theme]);

  useEffect(() => {
    setFontSizeText(String(profile.fontSize));
  }, [profile.fontSize]);

  useEffect(() => {
    setScrollbackText(String(profile.scrollback));
  }, [profile.scrollback]);

  useEffect(() => {
    setInlineSuggestionsMaxText(String(profile.inlineSuggestionsMax));
  }, [profile.inlineSuggestionsMax]);

  const updateProfile = (patch: Partial<TerminalProfile>) => {
    const next = { ...draftProfileRef.current, ...patch };
    draftProfileRef.current = next;
    onProfileChange(next);
  };

  const updateCustomColor = (nextBg: string, nextFg: string) => {
    setBg(nextBg);
    setFg(nextFg);
    if (isHexColor(nextBg) && isHexColor(nextFg)) {
      updateProfile({ theme: makeCustomTerminalTheme(nextBg, nextFg) });
    }
  };

  const resolvedTheme = resolveTerminalTheme(profile.theme);
  const selectedThemeId = resolveThemeId(profile.theme);
  const selectedCursor = TERMINAL_CURSOR_OPTIONS.find((option) =>
    option.style === profile.cursorStyle && option.blink === profile.cursorBlink
  )?.label ?? "Block (blink)";
  const selectedRightClick = RIGHT_CLICK_OPTIONS.find((option) =>
    option.value === profile.rightClickBehavior
  )?.label ?? RIGHT_CLICK_OPTIONS[0].label;

  return (
    <div data-testid="terminal-appearance-settings" className={`space-y-4 ${className}`}>
      <section className="rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
        <div className="grid grid-cols-12 gap-3 items-end">
          <label className="col-span-12 md:col-span-7">
            <span className="block text-[12px] font-semibold mb-1">Font</span>
            <select
              aria-label="Terminal font"
              className="moba-input w-full"
              value={selectedFont}
              disabled={fontOptions.length === 0}
              onChange={(event) => updateProfile({ fontFamily: makeTerminalFontFamily(event.target.value) })}
            >
              {fontOptions.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>

          <div className="col-span-8 md:col-span-3">
            <span className="block text-[12px] font-semibold mb-1">Text Size</span>
            <div className="inline-flex items-center gap-1">
              <button
                className="moba-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label="Decrease text size"
                onClick={() => updateProfile({ fontSize: Math.max(8, profile.fontSize - 1) })}
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                className="moba-input h-8 w-14 text-center"
                aria-label="Terminal font size"
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
                className="moba-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label="Increase text size"
                onClick={() => updateProfile({ fontSize: Math.min(32, profile.fontSize + 1) })}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <label className="col-span-4 md:col-span-2 inline-flex items-center gap-1.5 pb-1">
            <input
              className="moba-checkbox"
              type="checkbox"
              aria-label="Enable font ligatures"
              checked={profile.fontLigatures}
              onChange={(event) => updateProfile({ fontLigatures: event.target.checked })}
            />
            <span className="text-[12px]">Ligatures</span>
          </label>
        </div>
      </section>

      <section className="rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">Terminal theme</div>
        <div data-testid="terminal-theme-gallery" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {TERMINAL_THEME_DEFINITIONS.map((definition) => (
            <ThemeCard
              key={definition.id}
              definition={definition}
              selected={definition.id === selectedThemeId}
              onSelect={() => updateProfile({ theme: definition.id })}
            />
          ))}
        </div>
      </section>

      {showCustomColors && (
        <section className="rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
          <div className="grid grid-cols-12 gap-2 items-center">
            <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
              <span className="w-24 text-[12px] font-semibold">Background</span>
              <input
                type="color"
                value={isHexColor(bg) ? bg : "#000000"}
                onChange={(event) => updateCustomColor(event.target.value, fg)}
                aria-label="Terminal background color"
                className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
              />
              <input
                className="moba-input w-24 moba-mono"
                value={bg}
                aria-label="Terminal background hex"
                onChange={(event) => updateCustomColor(event.target.value, fg)}
              />
            </label>
            <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
              <span className="w-24 text-[12px] font-semibold">Foreground</span>
              <input
                type="color"
                value={isHexColor(fg) ? fg : "#ffffff"}
                onChange={(event) => updateCustomColor(bg, event.target.value)}
                aria-label="Terminal foreground color"
                className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
              />
              <input
                className="moba-input w-24 moba-mono"
                value={fg}
                aria-label="Terminal foreground hex"
                onChange={(event) => updateCustomColor(bg, event.target.value)}
              />
            </label>
          </div>
        </section>
      )}

      <section className="rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">Terminal behavior</div>
        <div className="grid grid-cols-12 gap-x-3 gap-y-3 text-[12px]">
          <label className="col-span-12 md:col-span-4">
            <span className="block mb-1 text-[var(--moba-text-muted)]">Cursor</span>
            <select
              aria-label="Terminal cursor"
              className="moba-input w-full"
              value={selectedCursor}
              onChange={(event) => {
                const option = TERMINAL_CURSOR_OPTIONS.find((item) => item.label === event.target.value);
                if (option) updateProfile({ cursorStyle: option.style, cursorBlink: option.blink });
              }}
            >
              {TERMINAL_CURSOR_OPTIONS.map((option) => (
                <option key={option.label}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="col-span-12 md:col-span-4">
            <span className="block mb-1 text-[var(--moba-text-muted)]">Scrollback</span>
            <span className="flex items-center gap-2">
              <input
                className="moba-input w-28"
                value={scrollbackText}
                aria-label="Scrollback lines"
                inputMode="numeric"
                onChange={(event) => {
                  const next = event.target.value;
                  if (!/^\d*$/.test(next)) return;
                  setScrollbackText(next);
                  const parsed = Number(next);
                  if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 200000) {
                    updateProfile({ scrollback: Math.round(parsed) });
                  }
                }}
                onBlur={() => {
                  const parsed = Number(scrollbackText);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    const clamped = Math.max(100, Math.min(200000, Math.round(parsed)));
                    setScrollbackText(String(clamped));
                    updateProfile({ scrollback: clamped });
                  } else {
                    setScrollbackText(String(profile.scrollback));
                  }
                }}
              />
              <span className="text-[var(--moba-text-muted)]">lines</span>
            </span>
          </label>

          <label className="col-span-12 md:col-span-4">
            <span className="block mb-1 text-[var(--moba-text-muted)]">Right click</span>
            <select
              aria-label="Right click behavior"
              className="moba-input w-full"
              value={selectedRightClick}
              onChange={(event) => {
                const option = RIGHT_CLICK_OPTIONS.find((item) => item.label === event.target.value);
                if (option) updateProfile({ rightClickBehavior: option.value });
              }}
            >
              {RIGHT_CLICK_OPTIONS.map((option) => (
                <option key={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="col-span-12 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            <CheckControl
              label="Show terminal scrollbar"
              checked={profile.showScrollbar}
              onChange={(checked) => updateProfile({ showScrollbar: checked })}
            />
            <CheckControl
              label="Copy on select"
              checked={profile.copyOnSelect}
              onChange={(checked) => updateProfile({ copyOnSelect: checked })}
            />
            <CheckControl
              label="Read-only terminal"
              checked={profile.readOnly}
              onChange={(checked) => updateProfile({ readOnly: checked })}
            />
            <CheckControl
              label="Bracketed paste"
              checked={profile.bracketedPaste}
              onChange={(checked) => updateProfile({ bracketedPaste: checked })}
            />
            <CheckControl
              label="Confirm multiline paste"
              checked={profile.multilinePasteConfirm}
              onChange={(checked) => updateProfile({ multilinePasteConfirm: checked })}
            />
            <CheckControl
              label="Enable keyword highlighting"
              checked={profile.syntaxMode === "keywords"}
              onChange={(checked) => updateProfile({ syntaxMode: checked ? "keywords" : "default" })}
            />
            <CheckControl
              label="Save scrollback to log file on disconnect"
              checked={profile.loggingEnabled}
              onChange={(checked) => updateProfile({ loggingEnabled: checked })}
            />
          </div>
        </div>
      </section>

      <section className="rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">Inline command suggestions</div>
        <div className="grid grid-cols-12 gap-x-3 gap-y-3 text-[12px] items-end">
          <div className="col-span-12 md:col-span-7">
            <CheckControl
              label="Show ghost-text suggestions from command history"
              checked={profile.inlineSuggestions}
              onChange={(checked) => updateProfile({ inlineSuggestions: checked })}
            />
            <p className="mt-1 text-[11px] text-[var(--moba-text-muted)] leading-snug">
              Press → or End at the end of the line to accept. Recommended with a bar or
              underline cursor. Ignored for local PowerShell (its PSReadLine already provides
              predictions).
            </p>
          </div>

          <label className="col-span-8 md:col-span-3">
            <span className="block mb-1 text-[var(--moba-text-muted)]">Max entries per host</span>
            <input
              className="moba-input w-28"
              value={inlineSuggestionsMaxText}
              aria-label="Maximum command history entries per host"
              inputMode="numeric"
              disabled={!profile.inlineSuggestions}
              onChange={(event) => {
                const next = event.target.value;
                if (!/^\d*$/.test(next)) return;
                setInlineSuggestionsMaxText(next);
                const parsed = Number(next);
                if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 50000) {
                  updateProfile({ inlineSuggestionsMax: Math.round(parsed) });
                }
              }}
              onBlur={() => {
                const parsed = Number(inlineSuggestionsMaxText);
                if (Number.isFinite(parsed) && parsed > 0) {
                  const clamped = Math.max(100, Math.min(50000, Math.round(parsed)));
                  setInlineSuggestionsMaxText(String(clamped));
                  updateProfile({ inlineSuggestionsMax: clamped });
                } else {
                  setInlineSuggestionsMaxText(String(profile.inlineSuggestionsMax));
                }
              }}
            />
          </label>

          <div className="col-span-12 md:col-span-2 flex md:justify-end">
            <button
              type="button"
              className="moba-btn h-8 px-2 text-[11px]"
              disabled={clearingHistory}
              onClick={() => {
                if (!window.confirm("Clear all command history? This affects every host.")) {
                  return;
                }
                setClearingHistory(true);
                historyClear(null)
                  .catch((err) => {
                    console.error("Failed to clear history", err);
                  })
                  .finally(() => setClearingHistory(false));
              }}
            >
              Clear all history
            </button>
          </div>
        </div>
      </section>

      {showPreview && (
        <TerminalPreview
          background={showCustomColors ? bg : colors.background}
          foreground={showCustomColors ? fg : colors.foreground}
          fontFamily={profile.fontFamily}
          fontSize={profile.fontSize}
          cursorStyle={profile.cursorStyle}
          cursorBlink={profile.cursorBlink}
          theme={resolvedTheme}
        />
      )}
    </div>
  );
}

function CheckControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <input
        className="moba-checkbox"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function ThemeCard({
  definition,
  selected,
  onSelect,
}: {
  definition: TerminalThemeDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  const theme = definition.theme;
  const borderColor = selected ? "var(--moba-accent)" : "var(--moba-divider)";

  return (
    <button
      type="button"
      aria-label={`Use theme ${definition.name}`}
      data-selected={selected}
      className="h-[74px] rounded-md border bg-[var(--moba-card-bg)] text-left p-2 flex items-center gap-2 hover:bg-[var(--moba-hover)]"
      style={{ borderColor }}
      onClick={onSelect}
    >
      <ThemeSwatch definition={definition} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold truncate">{definition.name}</span>
        <span className="mt-1 flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.green ?? "#62d36f" }} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.blue ?? "#83a7d8" }} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.yellow ?? "#e3a85e" }} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.red ?? "#ff6b6b" }} />
        </span>
      </span>
      {selected && <Check className="w-4 h-4 text-[var(--moba-accent)] flex-shrink-0" />}
    </button>
  );
}

function ThemeSwatch({ definition }: { definition: TerminalThemeDefinition }) {
  const theme = definition.theme;
  const line = useMemo(
    () => [
      theme.green ?? "#62d36f",
      theme.cyan ?? "#89ddff",
      theme.blue ?? "#83a7d8",
      theme.yellow ?? "#e3a85e",
    ],
    [theme.blue, theme.cyan, theme.green, theme.yellow],
  );

  return (
    <span
      className="w-[68px] h-[46px] rounded border p-1 flex-shrink-0"
      style={{
        background: theme.background ?? "#1d1f21",
        color: theme.foreground ?? "#eaeaea",
        borderColor: definition.variant === "light" ? "#c9d1dc" : "#455062",
      }}
    >
      <span className="block h-1.5 rounded-sm mb-1" style={{ background: line[0] }} />
      <span className="flex gap-1 mb-1">
        <span className="block h-1.5 w-7 rounded-sm" style={{ background: line[1] }} />
        <span className="block h-1.5 w-5 rounded-sm" style={{ background: line[2] }} />
      </span>
      <span className="flex gap-1 mb-1">
        <span className="block h-1.5 w-4 rounded-sm" style={{ background: line[0] }} />
        <span className="block h-1.5 w-4 rounded-sm" style={{ background: line[3] }} />
        <span className="block h-1.5 w-3 rounded-sm" style={{ background: theme.foreground ?? "#eaeaea" }} />
      </span>
      <span className="flex gap-1">
        <span className="block h-1.5 w-5 rounded-sm" style={{ background: theme.foreground ?? "#eaeaea", opacity: 0.75 }} />
        <span className="block h-1.5 w-3 rounded-sm" style={{ background: line[2] }} />
      </span>
    </span>
  );
}

function TerminalPreview({
  background,
  foreground,
  fontFamily,
  fontSize,
  cursorStyle,
  cursorBlink,
  theme,
}: {
  background: string;
  foreground: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  theme: ReturnType<typeof resolveTerminalTheme>;
}) {
  const cursorColor = theme.cursor ?? foreground;

  return (
    <div
      data-testid="terminal-preview"
      className="rounded-md p-3 moba-mono leading-relaxed border border-black/10"
      style={{ background, color: foreground, fontFamily, fontSize }}
    >
      <span style={{ color: theme.green ?? "#62d36f" }}>user@host</span>
      <span style={{ color: "#bbbbbb" }}>:</span>
      <span style={{ color: theme.blue ?? "#83a7d8" }}>~/srv</span>
      {"$ tail -f /var/log/nginx/error.log"}
      <br />
      <span style={{ color: theme.yellow ?? "#e3a85e" }}>warning</span>
      {": 2 worker connections are not enough"}
      <br />
      <span style={{ color: theme.red ?? "#ff6b6b" }}>error</span>
      {": connect() failed (111: Connection refused)"}
      <br />
      <TerminalPreviewCursor
        color={cursorColor}
        foreground={foreground}
        styleName={cursorStyle}
        blink={cursorBlink}
      />
    </div>
  );
}

function TerminalPreviewCursor({
  color,
  foreground,
  styleName,
  blink,
}: {
  color: string;
  foreground: string;
  styleName: TerminalCursorStyle;
  blink: boolean;
}) {
  const className = blink ? "moba-blink" : "";

  if (styleName === "underline") {
    return (
      <span
        data-testid="terminal-preview-cursor"
        className={`inline-block w-[0.65em] h-[1em] align-[-0.1em] ${className}`}
        style={{ borderBottom: `2px solid ${color}` }}
      />
    );
  }

  if (styleName === "bar") {
    return (
      <span
        data-testid="terminal-preview-cursor"
        className={`inline-block w-[0.4em] h-[1em] align-[-0.1em] ${className}`}
        style={{ borderLeft: `2px solid ${color}` }}
      />
    );
  }

  return (
    <span
      data-testid="terminal-preview-cursor"
      className={`inline-block w-[0.65em] h-[1em] align-[-0.1em] ${className}`}
      style={{ background: color, color: foreground }}
    />
  );
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
