import type { CSSProperties } from "react";
import type { NotesFont, NotesTheme } from "../../stores/notesStore";

/**
 * Notes theme system (see tao-notes-feature-plan.md). A theme re-maps a
 * handful of `--taomni-*` CSS variables **locally** on the notes panel root, so
 * it restyles only the notes surface and cards without disturbing the global
 * app theme. "taomni" inherits the app theme unchanged.
 * All palettes keep text readable against their background in both modes.
 */

type NotesPalette = Record<string, string>;

const LIGHT: NotesPalette = {
  "--taomni-color-scheme": "light",
  "--taomni-bg": "#ffffff",
  "--taomni-chrome-bg": "#f8fafc",
  "--taomni-sidebar-bg": "#f8fafc",
  "--taomni-panel-bg": "#f1f5f9",
  "--taomni-card-bg": "#ffffff",
  "--taomni-card-border": "#e2e8f0",
  "--taomni-text": "#0f172a",
  "--taomni-text-muted": "#64748b",
  "--taomni-divider": "#e2e8f0",
  "--taomni-hover": "#f1f5f9",
  "--taomni-selected": "#e0e7ff",
  "--taomni-selected-border": "#a5b4fc",
  "--taomni-accent": "#4f46e5",
  "--taomni-accent-soft": "#6366f1",
  "--taomni-control-hover": "rgba(15, 23, 42, 0.05)",
  "--taomni-input-bg": "#ffffff",
  "--taomni-input-border": "#cbd5e1",
  "--taomni-button-from": "#ffffff",
  "--taomni-button-to": "#f8fafc",
  "--taomni-button-hover-from": "#ffffff",
  "--taomni-button-hover-to": "#e2e8f0",
  "--taomni-button-disabled": "#f1f5f9",
  "--taomni-scrollbar-track": "#f8fafc",
  "--taomni-scrollbar-thumb": "#cbd5e1",
  "--taomni-scrollbar-thumb-hover": "#94a3b8",
  "--taomni-shadow-sm": "0 1px 2px rgba(15, 23, 42, 0.05)",
  "--taomni-shadow-md": "0 4px 16px -2px rgba(15, 23, 42, 0.06), 0 2px 4px -1px rgba(15, 23, 42, 0.02)",
  "--taomni-shadow-lg": "0 16px 24px -4px rgba(15, 23, 42, 0.08), 0 4px 8px -2px rgba(15, 23, 42, 0.04)",
  colorScheme: "light",
};

const DARK: NotesPalette = {
  "--taomni-color-scheme": "dark",
  "--taomni-bg": "#0f172a",
  "--taomni-chrome-bg": "#111827",
  "--taomni-sidebar-bg": "#111827",
  "--taomni-panel-bg": "#1e293b",
  "--taomni-card-bg": "#172033",
  "--taomni-card-border": "#334155",
  "--taomni-text": "#f1f5f9",
  "--taomni-text-muted": "#94a3b8",
  "--taomni-divider": "#334155",
  "--taomni-hover": "#1e293b",
  "--taomni-selected": "#1e3a5f",
  "--taomni-selected-border": "#3b82f6",
  "--taomni-accent": "#60a5fa",
  "--taomni-accent-soft": "#93c5fd",
  "--taomni-control-hover": "rgba(255, 255, 255, 0.06)",
  "--taomni-input-bg": "#0f172a",
  "--taomni-input-border": "#334155",
  "--taomni-button-from": "#243044",
  "--taomni-button-to": "#172033",
  "--taomni-button-hover-from": "#334155",
  "--taomni-button-hover-to": "#243044",
  "--taomni-button-disabled": "#111827",
  "--taomni-scrollbar-track": "#111827",
  "--taomni-scrollbar-thumb": "#334155",
  "--taomni-scrollbar-thumb-hover": "#475569",
  "--taomni-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.24)",
  "--taomni-shadow-md": "0 4px 16px -2px rgba(0, 0, 0, 0.36), 0 2px 4px -1px rgba(0, 0, 0, 0.18)",
  "--taomni-shadow-lg": "0 16px 24px -4px rgba(0, 0, 0, 0.46), 0 4px 8px -2px rgba(0, 0, 0, 0.24)",
  colorScheme: "dark",
};

const PAPER: NotesPalette = {
  "--taomni-color-scheme": "light",
  "--taomni-bg": "#fdf6e3",
  "--taomni-chrome-bg": "#f8efd9",
  "--taomni-sidebar-bg": "#f5ecd7",
  "--taomni-panel-bg": "#f0e6cc",
  "--taomni-card-bg": "#fff8e8",
  "--taomni-card-border": "#e0d4b0",
  "--taomni-text": "#4a3f2f",
  "--taomni-text-muted": "#8a7d63",
  "--taomni-divider": "#e0d4b0",
  "--taomni-hover": "#efe6cf",
  "--taomni-selected": "#efe0b8",
  "--taomni-selected-border": "#d6b36b",
  "--taomni-accent": "#b45309",
  "--taomni-accent-soft": "#d97706",
  "--taomni-control-hover": "rgba(74, 63, 47, 0.06)",
  "--taomni-input-bg": "#fff8e8",
  "--taomni-input-border": "#d8c99f",
  "--taomni-button-from": "#fff8e8",
  "--taomni-button-to": "#f5ecd7",
  "--taomni-button-hover-from": "#fffaf0",
  "--taomni-button-hover-to": "#efe0b8",
  "--taomni-button-disabled": "#efe6cf",
  "--taomni-scrollbar-track": "#f5ecd7",
  "--taomni-scrollbar-thumb": "#d8c99f",
  "--taomni-scrollbar-thumb-hover": "#bba46f",
  "--taomni-shadow-sm": "0 1px 2px rgba(74, 63, 47, 0.08)",
  "--taomni-shadow-md": "0 4px 16px -2px rgba(74, 63, 47, 0.12), 0 2px 4px -1px rgba(74, 63, 47, 0.06)",
  "--taomni-shadow-lg": "0 16px 24px -4px rgba(74, 63, 47, 0.16), 0 4px 8px -2px rgba(74, 63, 47, 0.08)",
  colorScheme: "light",
};

const STICKY: NotesPalette = {
  "--taomni-color-scheme": "light",
  "--taomni-bg": "#fff4a8",
  "--taomni-chrome-bg": "#ffe66d",
  "--taomni-sidebar-bg": "#fff199",
  "--taomni-panel-bg": "#ffe982",
  "--taomni-card-bg": "#fff7bd",
  "--taomni-card-border": "#d3a72c",
  "--taomni-text": "#33270d",
  "--taomni-text-muted": "#78611b",
  "--taomni-divider": "#d9b747",
  "--taomni-hover": "#ffe58a",
  "--taomni-selected": "#f8d85e",
  "--taomni-selected-border": "#b98514",
  "--taomni-accent": "#7c3f00",
  "--taomni-accent-soft": "#9a5a00",
  "--taomni-control-hover": "rgba(51, 39, 13, 0.08)",
  "--taomni-input-bg": "#fff8c9",
  "--taomni-input-border": "#d3a72c",
  "--taomni-button-from": "#fff8c9",
  "--taomni-button-to": "#ffe982",
  "--taomni-button-hover-from": "#fffbe0",
  "--taomni-button-hover-to": "#f8d85e",
  "--taomni-button-disabled": "#f3df82",
  "--taomni-scrollbar-track": "#fff199",
  "--taomni-scrollbar-thumb": "#d3a72c",
  "--taomni-scrollbar-thumb-hover": "#9a6b13",
  "--taomni-shadow-sm": "0 1px 2px rgba(80, 52, 0, 0.10)",
  "--taomni-shadow-md": "0 6px 18px -3px rgba(80, 52, 0, 0.18), 0 2px 4px rgba(80, 52, 0, 0.08)",
  "--taomni-shadow-lg": "0 18px 34px -8px rgba(80, 52, 0, 0.25), 0 5px 12px rgba(80, 52, 0, 0.12)",
  colorScheme: "light",
};

const STICKY_BRIGHT: NotesPalette = {
  "--taomni-color-scheme": "light",
  "--taomni-bg": "#fbff8f",
  "--taomni-chrome-bg": "#effa00",
  "--taomni-sidebar-bg": "#fbff98",
  "--taomni-panel-bg": "#f3fb39",
  "--taomni-card-bg": "#fdffa8",
  "--taomni-card-border": "#bbc318",
  "--taomni-text": "#191a05",
  "--taomni-text-muted": "#60640e",
  "--taomni-divider": "#d2d74d",
  "--taomni-hover": "#f2f869",
  "--taomni-selected": "#e8f100",
  "--taomni-selected-border": "#9ca500",
  "--taomni-accent": "#273000",
  "--taomni-accent-soft": "#4b5c00",
  "--taomni-link": "#0f55c8",
  "--taomni-control-hover": "rgba(25, 26, 5, 0.08)",
  "--taomni-input-bg": "#fdffa8",
  "--taomni-input-border": "#b7bd25",
  "--taomni-button-from": "#fdffa8",
  "--taomni-button-to": "#f3fb39",
  "--taomni-button-hover-from": "#ffffc8",
  "--taomni-button-hover-to": "#e8f100",
  "--taomni-button-disabled": "#ecf283",
  "--taomni-scrollbar-track": "#fbff98",
  "--taomni-scrollbar-thumb": "#b7bd25",
  "--taomni-scrollbar-thumb-hover": "#858c00",
  "--taomni-shadow-sm": "0 1px 2px rgba(54, 59, 0, 0.12)",
  "--taomni-shadow-md": "0 6px 18px -3px rgba(54, 59, 0, 0.18), 0 2px 5px rgba(54, 59, 0, 0.08)",
  "--taomni-shadow-lg": "0 16px 32px -10px rgba(25, 26, 5, 0.34), 0 8px 18px -8px rgba(25, 26, 5, 0.24)",
  colorScheme: "light",
};

const MINT: NotesPalette = {
  "--taomni-color-scheme": "light",
  "--taomni-bg": "#edfdf6",
  "--taomni-chrome-bg": "#d8f7e8",
  "--taomni-sidebar-bg": "#e3faef",
  "--taomni-panel-bg": "#d3f3e4",
  "--taomni-card-bg": "#f7fffb",
  "--taomni-card-border": "#9dd8bc",
  "--taomni-text": "#12362b",
  "--taomni-text-muted": "#4f7569",
  "--taomni-divider": "#b7e2cc",
  "--taomni-hover": "#c9eedc",
  "--taomni-selected": "#b8e7d1",
  "--taomni-selected-border": "#49a77c",
  "--taomni-accent": "#087a56",
  "--taomni-accent-soft": "#0f9f73",
  "--taomni-control-hover": "rgba(8, 122, 86, 0.08)",
  "--taomni-input-bg": "#f7fffb",
  "--taomni-input-border": "#9dd8bc",
  "--taomni-button-from": "#f7fffb",
  "--taomni-button-to": "#d8f7e8",
  "--taomni-button-hover-from": "#ffffff",
  "--taomni-button-hover-to": "#b8e7d1",
  "--taomni-button-disabled": "#d3f3e4",
  "--taomni-scrollbar-track": "#e3faef",
  "--taomni-scrollbar-thumb": "#9dd8bc",
  "--taomni-scrollbar-thumb-hover": "#5dac87",
  "--taomni-shadow-sm": "0 1px 2px rgba(18, 54, 43, 0.07)",
  "--taomni-shadow-md": "0 5px 18px -4px rgba(18, 54, 43, 0.13), 0 2px 5px rgba(18, 54, 43, 0.05)",
  "--taomni-shadow-lg": "0 18px 32px -8px rgba(18, 54, 43, 0.18), 0 5px 12px rgba(18, 54, 43, 0.08)",
  colorScheme: "light",
};

const SKY: NotesPalette = {
  "--taomni-color-scheme": "light",
  "--taomni-bg": "#eff7ff",
  "--taomni-chrome-bg": "#d9ecff",
  "--taomni-sidebar-bg": "#e6f3ff",
  "--taomni-panel-bg": "#d7ebfb",
  "--taomni-card-bg": "#f8fcff",
  "--taomni-card-border": "#a9cce7",
  "--taomni-text": "#102a43",
  "--taomni-text-muted": "#53718b",
  "--taomni-divider": "#bdd9ee",
  "--taomni-hover": "#cfe6f8",
  "--taomni-selected": "#c0ddf3",
  "--taomni-selected-border": "#4c96c9",
  "--taomni-accent": "#1266a0",
  "--taomni-accent-soft": "#1b83c7",
  "--taomni-control-hover": "rgba(18, 102, 160, 0.08)",
  "--taomni-input-bg": "#f8fcff",
  "--taomni-input-border": "#a9cce7",
  "--taomni-button-from": "#f8fcff",
  "--taomni-button-to": "#d9ecff",
  "--taomni-button-hover-from": "#ffffff",
  "--taomni-button-hover-to": "#c0ddf3",
  "--taomni-button-disabled": "#d7ebfb",
  "--taomni-scrollbar-track": "#e6f3ff",
  "--taomni-scrollbar-thumb": "#a9cce7",
  "--taomni-scrollbar-thumb-hover": "#6ca9d1",
  "--taomni-shadow-sm": "0 1px 2px rgba(16, 42, 67, 0.07)",
  "--taomni-shadow-md": "0 5px 18px -4px rgba(16, 42, 67, 0.14), 0 2px 5px rgba(16, 42, 67, 0.05)",
  "--taomni-shadow-lg": "0 18px 32px -8px rgba(16, 42, 67, 0.20), 0 5px 12px rgba(16, 42, 67, 0.08)",
  colorScheme: "light",
};

const ROSE: NotesPalette = {
  "--taomni-color-scheme": "light",
  "--taomni-bg": "#fff1f5",
  "--taomni-chrome-bg": "#ffe1ea",
  "--taomni-sidebar-bg": "#ffe9f0",
  "--taomni-panel-bg": "#ffdbe7",
  "--taomni-card-bg": "#fff9fb",
  "--taomni-card-border": "#e8aec1",
  "--taomni-text": "#431525",
  "--taomni-text-muted": "#805468",
  "--taomni-divider": "#efc1cf",
  "--taomni-hover": "#ffd3e1",
  "--taomni-selected": "#ffc5d8",
  "--taomni-selected-border": "#ca5078",
  "--taomni-accent": "#a0194a",
  "--taomni-accent-soft": "#c12b62",
  "--taomni-control-hover": "rgba(160, 25, 74, 0.08)",
  "--taomni-input-bg": "#fff9fb",
  "--taomni-input-border": "#e8aec1",
  "--taomni-button-from": "#fff9fb",
  "--taomni-button-to": "#ffe1ea",
  "--taomni-button-hover-from": "#ffffff",
  "--taomni-button-hover-to": "#ffc5d8",
  "--taomni-button-disabled": "#ffdbe7",
  "--taomni-scrollbar-track": "#ffe9f0",
  "--taomni-scrollbar-thumb": "#e8aec1",
  "--taomni-scrollbar-thumb-hover": "#c86b8b",
  "--taomni-shadow-sm": "0 1px 2px rgba(67, 21, 37, 0.07)",
  "--taomni-shadow-md": "0 5px 18px -4px rgba(67, 21, 37, 0.14), 0 2px 5px rgba(67, 21, 37, 0.05)",
  "--taomni-shadow-lg": "0 18px 32px -8px rgba(67, 21, 37, 0.20), 0 5px 12px rgba(67, 21, 37, 0.08)",
  colorScheme: "light",
};

const GRAPHITE: NotesPalette = {
  "--taomni-color-scheme": "dark",
  "--taomni-bg": "#202124",
  "--taomni-chrome-bg": "#2b2d31",
  "--taomni-sidebar-bg": "#26282c",
  "--taomni-panel-bg": "#303238",
  "--taomni-card-bg": "#2a2d33",
  "--taomni-card-border": "#4a4f58",
  "--taomni-text": "#f2f3f5",
  "--taomni-text-muted": "#a8adb7",
  "--taomni-divider": "#444951",
  "--taomni-hover": "#383b42",
  "--taomni-selected": "#3a4250",
  "--taomni-selected-border": "#86b7e8",
  "--taomni-accent": "#9ad2ff",
  "--taomni-accent-soft": "#b8defc",
  "--taomni-control-hover": "rgba(255, 255, 255, 0.07)",
  "--taomni-input-bg": "#1f2126",
  "--taomni-input-border": "#4a4f58",
  "--taomni-button-from": "#383b42",
  "--taomni-button-to": "#2a2d33",
  "--taomni-button-hover-from": "#444951",
  "--taomni-button-hover-to": "#383b42",
  "--taomni-button-disabled": "#26282c",
  "--taomni-scrollbar-track": "#26282c",
  "--taomni-scrollbar-thumb": "#4a4f58",
  "--taomni-scrollbar-thumb-hover": "#696f7b",
  "--taomni-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.28)",
  "--taomni-shadow-md": "0 5px 18px -4px rgba(0, 0, 0, 0.38), 0 2px 5px rgba(0, 0, 0, 0.20)",
  "--taomni-shadow-lg": "0 18px 32px -8px rgba(0, 0, 0, 0.48), 0 5px 12px rgba(0, 0, 0, 0.26)",
  colorScheme: "dark",
};

/**
 * Style overrides for a notes theme, applied inline on the notes root. Returns
 * an empty object for "taomni" and "compact" (they inherit the app theme);
 * "compact" additionally signals density via [data-density] below.
 */
export function notesThemeStyle(theme: NotesTheme): CSSProperties {
  switch (theme) {
    case "light":
      return LIGHT as CSSProperties;
    case "dark":
      return DARK as CSSProperties;
    case "paper":
      return PAPER as CSSProperties;
    case "sticky":
      return STICKY as CSSProperties;
    case "sticky_bright":
      return STICKY_BRIGHT as CSSProperties;
    case "mint":
      return MINT as CSSProperties;
    case "sky":
      return SKY as CSSProperties;
    case "rose":
      return ROSE as CSSProperties;
    case "graphite":
      return GRAPHITE as CSSProperties;
    case "compact":
    case "taomni":
    default:
      return {};
  }
}

/** Density flag for the notes root — "compact" tightens spacing/typography. */
export function notesThemeDensity(theme: NotesTheme): "comfortable" | "compact" {
  return theme === "compact" ? "compact" : "comfortable";
}

export const NOTES_THEMES: NotesTheme[] = [
  "taomni",
  "light",
  "dark",
  "paper",
  "sticky",
  "sticky_bright",
  "mint",
  "sky",
  "rose",
  "graphite",
  "compact",
];

export function notesFontStyle(font: NotesFont): CSSProperties {
  switch (font) {
    case "inter":
      return { fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' };
    case "outfit":
      return { fontFamily: '"Outfit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' };
    case "system":
      return { fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' };
    case "rounded":
      return { fontFamily: '"SF Pro Rounded", "Segoe UI Variable", "Avenir Next", "Inter", system-ui, sans-serif' };
    case "serif":
      return { fontFamily: 'Georgia, "Times New Roman", "Noto Serif", "Noto Serif SC", serif' };
    case "songti":
      return { fontFamily: '"Songti SC", "STSong", "SimSun", "Noto Serif SC", serif' };
    case "kaiti":
      return { fontFamily: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif SC", serif' };
    case "handwriting":
      return { fontFamily: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Kaiti SC", cursive' };
    case "mono":
      return { fontFamily: 'var(--taomni-code-font-family)' };
    case "inherit":
      return { fontFamily: "var(--taomni-ui-font-family)" };
    default:
      return { fontFamily: font };
  }
}

export function notesFontSizeStyle(fontSize: number): CSSProperties {
  return {
    "--taomni-notes-font-size": `${fontSize}px`,
    "--taomni-ui-font-size": `${fontSize}px`,
  } as CSSProperties;
}

export const NOTES_FONTS: NotesFont[] = [
  "inherit",
  "system",
  "inter",
  "outfit",
  "rounded",
  "serif",
  "songti",
  "kaiti",
  "handwriting",
  "mono",
];
