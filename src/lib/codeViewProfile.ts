import type { ITheme } from "@xterm/xterm";
import { DEFAULT_TERMINAL_PROFILE, resolveTerminalTheme, type TerminalProfile } from "./terminalProfile";
import { makeTerminalFontFamily } from "./systemFonts";
import { resolveThemeId, terminalThemes } from "./themes";
import type { ResolvedAppTheme } from "./appTheme";
import {
  CODE_THEME_COLOR_VARS,
  CODE_VIEW_THEME_SYSTEM,
  codeThemeVariablesFromPalette,
  getCodeThemeDefinition,
  isCodeThemeId,
  type CodeThemeVars,
} from "./codeThemes";

export const CODE_VIEW_THEME_APP = "app";
export const CODE_VIEW_THEME_TERMINAL = "terminal";
export const CODE_VIEW_TERMINAL_THEME_PREFIX = "terminal:";
export { CODE_VIEW_THEME_SYSTEM } from "./codeThemes";

export interface CodeViewProfile {
  fontFamily: string;
  fontSize: number;
  fontLigatures: boolean;
  /** Whether long logical lines wrap inside the editor viewport. */
  softWrap?: boolean;
  theme: string;
}

export const DEFAULT_CODE_VIEW_PROFILE: CodeViewProfile = {
  fontFamily: makeTerminalFontFamily("JetBrains Mono"),
  fontSize: 13,
  fontLigatures: true,
  softWrap: false,
  theme: CODE_VIEW_THEME_APP,
};

const CODE_VIEW_PROFILE_STORAGE_KEY = "taomni.codeViewProfile.v1";
const CODE_VIEW_PROFILE_EVENT = "taomni:code-view-profile-changed";

export function loadCodeViewProfile(): CodeViewProfile {
  if (typeof window === "undefined") return DEFAULT_CODE_VIEW_PROFILE;
  try {
    const raw = window.localStorage.getItem(CODE_VIEW_PROFILE_STORAGE_KEY);
    return normalizeCodeViewProfile(raw ? JSON.parse(raw) : undefined);
  } catch {
    return DEFAULT_CODE_VIEW_PROFILE;
  }
}

export function saveCodeViewProfile(profile: CodeViewProfile): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeCodeViewProfile(profile);
  try {
    window.localStorage.setItem(CODE_VIEW_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
  try {
    window.dispatchEvent(new CustomEvent(CODE_VIEW_PROFILE_EVENT, { detail: normalized }));
  } catch {
    // CustomEvent may be unavailable in exotic environments.
  }
}

/**
 * Subscribe to code-view profile changes. Fires when {@link saveCodeViewProfile}
 * runs in this window (via a CustomEvent) and when another window mutates the
 * shared localStorage key (via the native `storage` event). Returns an
 * unsubscribe function. This lets views that stay mounted (e.g. the Code
 * Workspace) follow edits made in Settings without owning their own copy.
 */
export function subscribeCodeViewProfile(listener: (profile: CodeViewProfile) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<CodeViewProfile>).detail;
    listener(normalizeCodeViewProfile(detail));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== CODE_VIEW_PROFILE_STORAGE_KEY) return;
    listener(loadCodeViewProfile());
  };
  window.addEventListener(CODE_VIEW_PROFILE_EVENT, onCustom as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CODE_VIEW_PROFILE_EVENT, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}

export function sameCodeViewProfile(a: CodeViewProfile, b: CodeViewProfile): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontLigatures === b.fontLigatures &&
    (a.softWrap ?? DEFAULT_CODE_VIEW_PROFILE.softWrap)
      === (b.softWrap ?? DEFAULT_CODE_VIEW_PROFILE.softWrap) &&
    a.theme === b.theme
  );
}

export function normalizeCodeViewProfile(input: unknown): CodeViewProfile {
  const source = isRecord(input) ? input : {};
  return {
    fontFamily: readString(source.fontFamily, DEFAULT_CODE_VIEW_PROFILE.fontFamily),
    fontSize: clampInteger(source.fontSize, DEFAULT_CODE_VIEW_PROFILE.fontSize, 8, 32),
    fontLigatures: readBoolean(source.fontLigatures, DEFAULT_CODE_VIEW_PROFILE.fontLigatures),
    softWrap: readBoolean(source.softWrap, DEFAULT_CODE_VIEW_PROFILE.softWrap ?? false),
    theme: readTheme(source.theme, DEFAULT_CODE_VIEW_PROFILE.theme),
  };
}

/**
 * Legacy helper: resolves the profile to an xterm `ITheme` only for the
 * terminal-mirroring paths. App/legacy-system/editor themes return `null` — callers
 * that need full colours for those should use {@link resolveCodeThemeVars}.
 */
export function resolveCodeViewTerminalTheme(
  profile: CodeViewProfile,
  terminalProfile: TerminalProfile = DEFAULT_TERMINAL_PROFILE,
): ITheme | null {
  if (profile.theme === CODE_VIEW_THEME_TERMINAL) return resolveTerminalTheme(terminalProfile.theme);
  const terminalThemeId = codeViewTerminalThemeId(profile.theme);
  if (terminalThemeId) return resolveTerminalTheme(terminalThemeId);
  if (
    profile.theme === CODE_VIEW_THEME_APP ||
    profile.theme === CODE_VIEW_THEME_SYSTEM ||
    isCodeThemeId(profile.theme)
  ) {
    return null;
  }
  return resolveTerminalTheme(profile.theme);
}

/**
 * Resolves the profile to the full `--taomni-code-*` variable set consumed by
 * both the Code Workspace and the Git diff view. Returns `null` for the "app"
 * theme, which defers to the values declared in `index.css`.
 */
export function resolveCodeThemeVars(
  profile: CodeViewProfile,
  options: { resolvedAppTheme?: ResolvedAppTheme; terminalProfile?: TerminalProfile } = {},
): CodeThemeVars | null {
  const terminalProfile = options.terminalProfile ?? DEFAULT_TERMINAL_PROFILE;
  const theme = profile.theme;

  if (theme === CODE_VIEW_THEME_APP || theme === CODE_VIEW_THEME_SYSTEM) return null;
  if (theme === CODE_VIEW_THEME_TERMINAL) {
    return codeThemeVariables(resolveTerminalTheme(terminalProfile.theme));
  }
  if (isCodeThemeId(theme)) {
    const def = getCodeThemeDefinition(theme);
    return def ? codeThemeVariablesFromPalette(def.palette) : null;
  }
  const terminalThemeId = codeViewTerminalThemeId(theme);
  if (terminalThemeId) {
    return codeThemeVariables(resolveTerminalTheme(terminalThemeId));
  }
  // Back-compat: profiles that stored a terminal-theme id (e.g. "kanagawa-wave").
  return codeThemeVariables(resolveTerminalTheme(theme));
}

export function applyCodeViewProfile(
  profile: CodeViewProfile,
  terminalProfile: TerminalProfile = DEFAULT_TERMINAL_PROFILE,
  options: { resolvedAppTheme?: ResolvedAppTheme; root?: HTMLElement | null } = {},
): void {
  const root =
    options.root !== undefined
      ? options.root
      : typeof document === "undefined"
        ? null
        : document.documentElement;
  if (!root) return;
  const normalized = normalizeCodeViewProfile(profile);
  root.style.setProperty("--taomni-code-font-family", normalized.fontFamily);
  root.style.setProperty("--taomni-code-font-size", `${normalized.fontSize}px`);
  root.style.setProperty(
    "--taomni-code-font-features",
    normalized.fontLigatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
  );
  root.style.setProperty("--taomni-mono-font", "var(--taomni-code-font-family)");

  const colors = resolveCodeThemeVars(normalized, {
    resolvedAppTheme: options.resolvedAppTheme,
    terminalProfile,
  });
  if (!colors) {
    for (const variable of CODE_THEME_COLOR_VARS) {
      root.style.removeProperty(variable);
    }
    return;
  }

  for (const [variable, value] of Object.entries(colors)) {
    root.style.setProperty(variable, value);
  }
}

export function codeThemeVariables(theme: ITheme): CodeThemeVars {
  const bg = color(theme.background, "#1d1f21");
  const fg = color(theme.foreground, "#eaeaea");
  const black = color(theme.black, bg);
  const red = color(theme.red, "#ff6b6b");
  const green = color(theme.green, "#62d36f");
  const yellow = color(theme.yellow, "#e3a85e");
  const blue = color(theme.blue, "#83a7d8");
  const magenta = color(theme.magenta, "#c792ea");
  const cyan = color(theme.cyan, "#89ddff");
  const white = color(theme.white, fg);
  const selection = color(theme.selectionBackground, mix(blue, 30, bg));
  const muted = mix(fg, 58, bg);

  return {
    "--taomni-code-bg": bg,
    "--taomni-code-gutter-bg": mix(black, 78, bg),
    "--taomni-code-text": fg,
    "--taomni-code-muted": muted,
    "--taomni-code-line-number": mix(fg, 48, bg),
    "--taomni-code-line-number-active": mix(fg, 82, bg),
    "--taomni-code-border": mix(fg, 18, bg),
    "--taomni-code-active-line-bg": mix(selection, 38, "transparent"),
    "--taomni-code-active-line-gutter-bg": mix(selection, 42, "transparent"),
    "--taomni-code-selection-bg": selection,
    "--taomni-code-selection-text": fg,
    "--taomni-code-selection-match-bg": mix(yellow, 26, "transparent"),
    "--taomni-code-selection-match-border": mix(yellow, 58, "transparent"),
    "--taomni-code-find-match-bg": mix(yellow, 48, "transparent"),
    "--taomni-code-find-match-fg": mix(yellow, 12, "#fff8e7"),
    "--taomni-code-find-match-border": mix(yellow, 72, "transparent"),
    "--taomni-code-caret": color(theme.cursor, fg),
    "--taomni-code-bracket-match-bg": mix(green, 24, "transparent"),
    "--taomni-code-bracket-match-border": mix(green, 44, "transparent"),
    "--taomni-code-bracket-error-bg": mix(red, 18, "transparent"),
    "--taomni-code-tooltip-bg": mix(black, 82, bg),
    "--taomni-code-scrollbar-track": mix(black, 82, bg),
    "--taomni-code-scrollbar-thumb": mix(fg, 32, bg),
    "--taomni-code-syntax-keyword": yellow,
    "--taomni-code-syntax-variable": fg,
    "--taomni-code-syntax-property": magenta,
    "--taomni-code-syntax-function": blue,
    "--taomni-code-syntax-type": cyan,
    "--taomni-code-syntax-string": green,
    "--taomni-code-syntax-escape": red,
    "--taomni-code-syntax-number": mix(yellow, 82, white),
    "--taomni-code-syntax-atom": mix(yellow, 88, red),
    "--taomni-code-syntax-comment": muted,
    "--taomni-code-syntax-operator": mix(fg, 78, bg),
    "--taomni-code-syntax-punctuation": mix(fg, 64, bg),
    "--taomni-code-syntax-link": blue,
    "--taomni-code-syntax-heading": blue,
    "--taomni-code-syntax-inserted": green,
    "--taomni-code-syntax-deleted": red,
    "--taomni-code-syntax-changed": yellow,
    "--taomni-code-syntax-invalid": red,
    "--taomni-code-diff-added-bg": mix(green, 22, "transparent"),
    "--taomni-code-diff-added-word": mix(green, 38, "transparent"),
    "--taomni-code-diff-deleted-bg": mix(red, 19, "transparent"),
    "--taomni-code-diff-deleted-word": mix(red, 34, "transparent"),
    "--taomni-code-diff-deleted-border": red,
    "--taomni-code-diff-modified-bg": mix(blue, 18, "transparent"),
    "--taomni-code-diff-modified-word": mix(blue, 32, "transparent"),
    "--taomni-code-diff-connector-added": mix(green, 26, "transparent"),
    "--taomni-code-diff-connector-deleted": mix(red, 22, "transparent"),
    "--taomni-code-diff-connector-modified": mix(blue, 23, "transparent"),
    "--taomni-code-diff-connector-stroke": mix(fg, 22, "transparent"),
  };
}

function readTheme(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const theme = value.trim();
  if (
    theme === CODE_VIEW_THEME_APP ||
    theme === CODE_VIEW_THEME_SYSTEM ||
    theme === CODE_VIEW_THEME_TERMINAL
  ) {
    return theme === CODE_VIEW_THEME_SYSTEM ? CODE_VIEW_THEME_APP : theme;
  }
  if (isCodeThemeId(theme)) return theme;
  const terminalThemeId = codeViewTerminalThemeId(theme);
  if (terminalThemeId && terminalThemes[resolveThemeId(terminalThemeId)]) {
    return `${CODE_VIEW_TERMINAL_THEME_PREFIX}${resolveThemeId(terminalThemeId)}`;
  }
  return terminalThemes[resolveThemeId(theme)] ? theme : fallback;
}

function codeViewTerminalThemeId(theme: string): string | null {
  if (!theme.startsWith(CODE_VIEW_TERMINAL_THEME_PREFIX)) return null;
  const id = theme.slice(CODE_VIEW_TERMINAL_THEME_PREFIX.length).trim();
  return id || null;
}

function color(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function mix(colorValue: string, percent: number, target: string): string {
  return `color-mix(in srgb, ${colorValue} ${percent}%, ${target})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
