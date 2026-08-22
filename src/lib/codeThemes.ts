import type { ITheme } from "@xterm/xterm";

// Editor colour themes for the shared code view (Code Workspace + Git diff view).
//
// Unlike terminal themes (an 8-colour ANSI `ITheme` from which syntax colours
// are *derived*), these are real editor palettes ported from the bundled theme
// pack (highlight.js / Prism / CodeMirror sources). Each palette expands into
// the full `--taomni-code-*` custom-property set consumed by
// `src/lib/codeViewTheme.ts` and `src/components/git/DiffViewer.tsx`.

export const CODE_THEME_COLOR_VARS = [
  "--taomni-code-bg", "--taomni-code-gutter-bg", "--taomni-code-text", "--taomni-code-muted",
  "--taomni-code-line-number", "--taomni-code-line-number-active", "--taomni-code-border",
  "--taomni-code-active-line-bg", "--taomni-code-active-line-gutter-bg",
  "--taomni-code-selection-bg", "--taomni-code-selection-text",
  "--taomni-code-selection-match-bg", "--taomni-code-selection-match-border",
  "--taomni-code-find-match-bg", "--taomni-code-find-match-fg", "--taomni-code-find-match-border",
  "--taomni-code-caret", "--taomni-code-bracket-match-bg", "--taomni-code-bracket-match-border",
  "--taomni-code-bracket-error-bg", "--taomni-code-tooltip-bg",
  "--taomni-code-scrollbar-track", "--taomni-code-scrollbar-thumb",
  "--taomni-code-syntax-keyword", "--taomni-code-syntax-variable", "--taomni-code-syntax-property",
  "--taomni-code-syntax-function", "--taomni-code-syntax-type", "--taomni-code-syntax-string",
  "--taomni-code-syntax-escape", "--taomni-code-syntax-number", "--taomni-code-syntax-atom",
  "--taomni-code-syntax-comment", "--taomni-code-syntax-operator", "--taomni-code-syntax-punctuation",
  "--taomni-code-syntax-link", "--taomni-code-syntax-heading", "--taomni-code-syntax-inserted",
  "--taomni-code-syntax-deleted", "--taomni-code-syntax-changed", "--taomni-code-syntax-invalid",
  "--taomni-code-diff-added-bg", "--taomni-code-diff-added-word", "--taomni-code-diff-deleted-bg",
  "--taomni-code-diff-deleted-word", "--taomni-code-diff-deleted-border",
  "--taomni-code-diff-modified-bg", "--taomni-code-diff-modified-word",
  "--taomni-code-diff-connector-added", "--taomni-code-diff-connector-deleted",
  "--taomni-code-diff-connector-modified", "--taomni-code-diff-connector-stroke",
  "--taomni-code-diagnostic-error", "--taomni-code-diagnostic-warning",
  "--taomni-code-diagnostic-info", "--taomni-code-diagnostic-hint",
] as const;

export type CodeThemeVarName = (typeof CODE_THEME_COLOR_VARS)[number];
export type CodeThemeVars = Record<CodeThemeVarName, string>;

export const CODE_VIEW_THEME_SYSTEM = "system";
export const SYSTEM_DARK_CODE_THEME = "dracula";
export const SYSTEM_LIGHT_CODE_THEME = "github-light";

export interface CodeThemePalette {
  variant: "dark" | "light";
  background: string;
  foreground: string;
  selection?: string;
  cursor?: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  variable?: string;
  property?: string;
  operator?: string;
  punctuation?: string;
  atom?: string;
  escape?: string;
  heading?: string;
  link?: string;
  /** Diff accent overrides; sensible per-variant defaults are used otherwise. */
  added?: string;
  deleted?: string;
  modified?: string;
}

export interface CodeThemeDefinition {
  id: string;
  name: string;
  variant: "dark" | "light";
  palette: CodeThemePalette;
}

function mix(colorValue: string, percent: number, target: string): string {
  return `color-mix(in srgb, ${colorValue} ${percent}%, ${target})`;
}

/** Expand a palette into the full `--taomni-code-*` variable set. */
export function codeThemeVariablesFromPalette(p: CodeThemePalette): CodeThemeVars {
  const dark = p.variant === "dark";
  const bg = p.background;
  const fg = p.foreground;
  const selection = p.selection ?? mix(fg, dark ? 22 : 16, bg);
  const muted = mix(fg, dark ? 56 : 52, bg);
  const green = p.added ?? (dark ? "#3fb950" : "#2da44e");
  const red = p.deleted ?? (dark ? "#f85149" : "#cf222e");
  const blue = p.modified ?? (dark ? "#519aff" : "#0969da");

  return {
    "--taomni-code-bg": bg,
    "--taomni-code-gutter-bg": mix(fg, dark ? 5 : 4, bg),
    "--taomni-code-text": fg,
    "--taomni-code-muted": muted,
    "--taomni-code-line-number": mix(fg, dark ? 44 : 46, bg),
    "--taomni-code-line-number-active": mix(fg, dark ? 82 : 88, bg),
    "--taomni-code-border": mix(fg, dark ? 16 : 18, bg),
    "--taomni-code-active-line-bg": mix(selection, 38, "transparent"),
    "--taomni-code-active-line-gutter-bg": mix(selection, 44, "transparent"),
    "--taomni-code-selection-bg": selection,
    "--taomni-code-selection-text": fg,
    "--taomni-code-selection-match-bg": mix(p.number, 22, "transparent"),
    "--taomni-code-selection-match-border": mix(p.number, 52, "transparent"),
    // Find-in-Files keyword hit: stronger than editor selection-match so list rows scan fast.
    "--taomni-code-find-match-bg": mix(p.number, dark ? 48 : 38, "transparent"),
    "--taomni-code-find-match-fg": dark ? "#fff8e7" : mix(p.number, 18, "#1a0b00"),
    "--taomni-code-find-match-border": mix(p.number, dark ? 72 : 62, "transparent"),
    "--taomni-code-caret": p.cursor ?? fg,
    "--taomni-code-bracket-match-bg": mix(green, 24, "transparent"),
    "--taomni-code-bracket-match-border": mix(green, 44, "transparent"),
    "--taomni-code-bracket-error-bg": mix(red, 18, "transparent"),
    // Lift tooltips above the editor surface so hover docs stay readable
    // (especially when markdown code blocks use --taomni-code-bg inside).
    "--taomni-code-tooltip-bg": dark ? mix(fg, 12, bg) : mix(fg, 3, bg),
    "--taomni-code-scrollbar-track": mix(fg, dark ? 5 : 4, bg),
    "--taomni-code-scrollbar-thumb": mix(fg, dark ? 30 : 26, bg),
    "--taomni-code-syntax-keyword": p.keyword,
    "--taomni-code-syntax-variable": p.variable ?? fg,
    "--taomni-code-syntax-property": p.property ?? p.function,
    "--taomni-code-syntax-function": p.function,
    "--taomni-code-syntax-type": p.type,
    "--taomni-code-syntax-string": p.string,
    "--taomni-code-syntax-escape": p.escape ?? p.string,
    "--taomni-code-syntax-number": p.number,
    "--taomni-code-syntax-atom": p.atom ?? p.number,
    "--taomni-code-syntax-comment": p.comment,
    "--taomni-code-syntax-operator": p.operator ?? mix(fg, 80, bg),
    "--taomni-code-syntax-punctuation": p.punctuation ?? mix(fg, 66, bg),
    "--taomni-code-syntax-link": p.link ?? p.function,
    "--taomni-code-syntax-heading": p.heading ?? p.function,
    "--taomni-code-syntax-inserted": green,
    "--taomni-code-syntax-deleted": red,
    "--taomni-code-syntax-changed": p.number,
    "--taomni-code-syntax-invalid": red,
    "--taomni-code-diff-added-bg": mix(green, dark ? 22 : 16, "transparent"),
    "--taomni-code-diff-added-word": mix(green, dark ? 38 : 28, "transparent"),
    "--taomni-code-diff-deleted-bg": mix(red, dark ? 19 : 14, "transparent"),
    "--taomni-code-diff-deleted-word": mix(red, dark ? 34 : 26, "transparent"),
    "--taomni-code-diff-deleted-border": red,
    "--taomni-code-diff-modified-bg": mix(blue, dark ? 18 : 14, "transparent"),
    "--taomni-code-diff-modified-word": mix(blue, dark ? 32 : 26, "transparent"),
    "--taomni-code-diff-connector-added": mix(green, dark ? 26 : 20, "transparent"),
    "--taomni-code-diff-connector-deleted": mix(red, dark ? 22 : 18, "transparent"),
    "--taomni-code-diff-connector-modified": mix(blue, dark ? 23 : 19, "transparent"),
    "--taomni-code-diff-connector-stroke": mix(fg, 22, "transparent"),
    "--taomni-code-diagnostic-error": red,
    "--taomni-code-diagnostic-warning": p.number ?? (dark ? "#e3b341" : "#9a6700"),
    "--taomni-code-diagnostic-info": blue,
    "--taomni-code-diagnostic-hint": muted,
  };
}

export const CODE_THEME_DEFINITIONS: CodeThemeDefinition[] = [
  {
    id: "dracula",
    name: "Dracula",
    variant: "dark",
    palette: {
      variant: "dark", background: "#282a36", foreground: "#f8f8f2",
      selection: "#44475a", cursor: "#f8f8f2",
      comment: "#6272a4", keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9",
      function: "#50fa7b", type: "#8be9fd", variable: "#f8f8f2", property: "#66d9ef",
      operator: "#ff79c6", punctuation: "#f8f8f2", atom: "#bd93f9",
      added: "#50fa7b", deleted: "#ff5555", modified: "#8be9fd",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    variant: "dark",
    palette: {
      variant: "dark", background: "#272822", foreground: "#f8f8f2",
      selection: "#49483e", cursor: "#f8f8f0",
      comment: "#75715e", keyword: "#f92672", string: "#e6db74", number: "#ae81ff",
      function: "#a6e22e", type: "#66d9ef", variable: "#f8f8f2", property: "#a6e22e",
      operator: "#f92672", punctuation: "#f8f8f2", atom: "#ae81ff",
      added: "#a6e22e", deleted: "#f92672", modified: "#66d9ef",
    },
  },
  {
    id: "nord",
    name: "Nord",
    variant: "dark",
    palette: {
      variant: "dark", background: "#2e3440", foreground: "#d8dee9",
      selection: "#434c5e", cursor: "#d8dee9",
      comment: "#616e88", keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead",
      function: "#88c0d0", type: "#8fbcbb", variable: "#d8dee9", property: "#88c0d0",
      operator: "#81a1c1", punctuation: "#d8dee9", atom: "#b48ead",
      added: "#a3be8c", deleted: "#bf616a", modified: "#81a1c1",
    },
  },
  {
    id: "one-dark",
    name: "Atom One Dark",
    variant: "dark",
    palette: {
      variant: "dark", background: "#282c34", foreground: "#abb2bf",
      selection: "#3e4451", cursor: "#528bff",
      comment: "#5c6370", keyword: "#c678dd", string: "#98c379", number: "#d19a66",
      function: "#61afef", type: "#e5c07b", variable: "#e06c75", property: "#e06c75",
      operator: "#56b6c2", punctuation: "#abb2bf", atom: "#d19a66",
      added: "#98c379", deleted: "#e06c75", modified: "#61afef",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    variant: "dark",
    palette: {
      variant: "dark", background: "#0d1117", foreground: "#c9d1d9",
      selection: "#264f78", cursor: "#c9d1d9",
      comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff",
      function: "#d2a8ff", type: "#ffa657", variable: "#ffa657", property: "#79c0ff",
      operator: "#79c0ff", punctuation: "#c9d1d9", atom: "#79c0ff",
      added: "#3fb950", deleted: "#f85149", modified: "#58a6ff",
    },
  },
  {
    id: "night-owl",
    name: "Night Owl",
    variant: "dark",
    palette: {
      variant: "dark", background: "#011627", foreground: "#d6deeb",
      selection: "#1d3b53", cursor: "#80a4c2",
      comment: "#637777", keyword: "#c792ea", string: "#ecc48d", number: "#f78c6c",
      function: "#82aaff", type: "#82aaff", variable: "#addb67", property: "#7fdbca",
      operator: "#7fdbca", punctuation: "#d6deeb", atom: "#ff5874",
      added: "#22da6e", deleted: "#ef5350", modified: "#82aaff",
    },
  },
  {
    id: "vscode-dark-plus",
    name: "VS Code Dark+",
    variant: "dark",
    palette: {
      variant: "dark", background: "#1e1e1e", foreground: "#d4d4d4",
      selection: "#264f78", cursor: "#aeafad",
      comment: "#6a9955", keyword: "#569cd6", string: "#ce9178", number: "#b5cea8",
      function: "#dcdcaa", type: "#4ec9b0", variable: "#9cdcfe", property: "#9cdcfe",
      operator: "#d4d4d4", punctuation: "#d4d4d4", atom: "#569cd6", escape: "#d7ba7d",
    },
  },
  {
    id: "visual-studio-2015",
    name: "Visual Studio 2015 Dark",
    variant: "dark",
    palette: {
      variant: "dark", background: "#1e1e1e", foreground: "#dcdcdc",
      selection: "#264f78", cursor: "#dcdcdc",
      comment: "#57a64a", keyword: "#569cd6", string: "#d69d85", number: "#b8d7a3",
      function: "#dcdcdc", type: "#4ec9b0", variable: "#bd63c5", property: "#9cdcfe",
      operator: "#dcdcdc", punctuation: "#dcdcdc", atom: "#569cd6", escape: "#d7ba7d",
    },
  },
  {
    id: "android-studio",
    name: "Android Studio",
    variant: "dark",
    palette: {
      variant: "dark", background: "#282b2e", foreground: "#a9b7c6",
      selection: "#214283", cursor: "#a9b7c6",
      comment: "#808080", keyword: "#cc7832", string: "#6a8759", number: "#6897bb",
      function: "#ffc66d", type: "#ffc66d", variable: "#629755", property: "#ffc66d",
      operator: "#a9b7c6", punctuation: "#a9b7c6", atom: "#6897bb",
    },
  },
  {
    id: "darcula",
    name: "Darcula (IntelliJ)",
    variant: "dark",
    palette: {
      variant: "dark", background: "#2b2b2b", foreground: "#a9b7c6",
      selection: "#214283", cursor: "#a9b7c6",
      comment: "#808080", keyword: "#cc7832", string: "#6a8759", number: "#6897bb",
      function: "#ffc66d", type: "#aabbcc", variable: "#a9b7c6", property: "#ffc66d",
      operator: "#a9b7c6", punctuation: "#a9b7c6", atom: "#cc7832", escape: "#cc7832",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    variant: "dark",
    palette: {
      variant: "dark", background: "#1d2021", foreground: "#ebdbb2",
      selection: "#3c3836", cursor: "#ebdbb2",
      comment: "#a89984", keyword: "#fb4934", string: "#b8bb26", number: "#d3869b",
      function: "#fabd2f", type: "#fabd2f", variable: "#ebdbb2", property: "#fb4934",
      operator: "#a89984", punctuation: "#a89984", atom: "#d3869b",
      added: "#b8bb26", deleted: "#fb4934", modified: "#83a598",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    variant: "dark",
    palette: {
      variant: "dark", background: "#002b36", foreground: "#93a1a1",
      selection: "#073642", cursor: "#93a1a1",
      comment: "#586e75", keyword: "#268bd2", string: "#859900", number: "#859900",
      function: "#268bd2", type: "#b58900", variable: "#268bd2", property: "#268bd2",
      operator: "#93a1a1", punctuation: "#93a1a1", atom: "#b58900",
      added: "#859900", deleted: "#dc322f", modified: "#268bd2",
    },
  },
  {
    id: "zenburn",
    name: "Zenburn",
    variant: "dark",
    palette: {
      variant: "dark", background: "#3f3f3f", foreground: "#dcdccc",
      selection: "#545454", cursor: "#dcdccc",
      comment: "#7f9f7f", keyword: "#f0dfaf", string: "#cc9393", number: "#8cd0d3",
      function: "#efef8f", type: "#dfdebd", variable: "#dfaf8f", property: "#dfaf8f",
      operator: "#f0efd0", punctuation: "#dcdccc", atom: "#bfebbf",
    },
  },
  {
    id: "ayu-mirage",
    name: "Ayu Mirage",
    variant: "dark",
    palette: {
      variant: "dark", background: "#1f2430", foreground: "#cbccc6",
      selection: "#34455a", cursor: "#ffcc66",
      comment: "#5c6773", keyword: "#ffa759", string: "#bae67e", number: "#ffcc66",
      function: "#ffd580", type: "#5ccfe6", variable: "#cbccc6", property: "#f29e74",
      operator: "#f29e74", punctuation: "#cbccc6", atom: "#ae81ff",
      added: "#bae67e", deleted: "#f28779", modified: "#5ccfe6",
    },
  },
  {
    id: "lucario",
    name: "Lucario",
    variant: "dark",
    palette: {
      variant: "dark", background: "#263e52", foreground: "#f8f8f2",
      selection: "#435b98", cursor: "#f8f8f2",
      comment: "#5c98cd", keyword: "#6eb26e", string: "#fcfcd6", number: "#bc94f9",
      function: "#66d8ef", type: "#66d8ef", variable: "#f8f8f2", property: "#f05e5d",
      operator: "#f8f8f2", punctuation: "#f8f8f2", atom: "#bc94f9",
      added: "#6eb26e", deleted: "#f05e5d", modified: "#66d8ef",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    variant: "light",
    palette: {
      variant: "light", background: "#ffffff", foreground: "#393a34",
      selection: "#b3d4fc", cursor: "#393a34",
      comment: "#999988", keyword: "#00a4db", string: "#e3116c", number: "#36acaa",
      function: "#9a050f", type: "#00009f", variable: "#36acaa", property: "#36acaa",
      operator: "#393a34", punctuation: "#393a34", atom: "#36acaa",
      added: "#2da44e", deleted: "#cf222e", modified: "#0969da",
    },
  },
  {
    id: "intellij-idea",
    name: "IntelliJ IDEA Light",
    variant: "light",
    palette: {
      variant: "light", background: "#ffffff", foreground: "#080808",
      selection: "#a6d2ff", cursor: "#080808",
      comment: "#808080", keyword: "#000080", string: "#008000", number: "#0000ff",
      function: "#000000", type: "#000080", variable: "#660e7a", property: "#660e7a",
      operator: "#000000", punctuation: "#000000", atom: "#0000ff",
    },
  },
  {
    id: "intellij-light",
    name: "IntelliJ Light",
    variant: "light",
    palette: {
      variant: "light", background: "#ffffff", foreground: "#080808",
      selection: "#a6d2ff", cursor: "#080808",
      comment: "#8c8c8c", keyword: "#0033b3", string: "#067d17", number: "#1750eb",
      function: "#00627a", type: "#0033b3", variable: "#080808", property: "#871094",
      operator: "#000000", punctuation: "#000000", atom: "#1750eb", escape: "#0037a6",
    },
  },
  {
    id: "material-light",
    name: "Material Light",
    variant: "light",
    palette: {
      variant: "light", background: "#fafafa", foreground: "#546e7a",
      selection: "#cceae7", cursor: "#546e7a",
      comment: "#90a4ae", keyword: "#7c4dff", string: "#f6a434", number: "#f76d47",
      function: "#7c4dff", type: "#6182b8", variable: "#e53935", property: "#39adb5",
      operator: "#39adb5", punctuation: "#39adb5", atom: "#7c4dff",
      added: "#91b859", deleted: "#e53935", modified: "#6182b8",
    },
  },
  {
    id: "visual-studio-classic",
    name: "Visual Studio Classic",
    variant: "light",
    palette: {
      variant: "light", background: "#ffffff", foreground: "#393a34",
      selection: "#c1def1", cursor: "#393a34",
      comment: "#008000", keyword: "#0000ff", string: "#a31515", number: "#36acaa",
      function: "#393a34", type: "#2b91af", variable: "#36acaa", property: "#ff0000",
      operator: "#393a34", punctuation: "#393a34", atom: "#36acaa",
    },
  },
];

const CODE_THEME_BY_ID: Record<string, CodeThemeDefinition> = Object.fromEntries(
  CODE_THEME_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getCodeThemeDefinition(id: string): CodeThemeDefinition | undefined {
  return CODE_THEME_BY_ID[id];
}

export function terminalThemeFromCodeTheme(definition: CodeThemeDefinition): ITheme {
  const palette = definition.palette;
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor ?? palette.foreground,
    selectionBackground: palette.selection ?? palette.background,
    black: palette.background,
    red: palette.deleted ?? palette.escape ?? palette.keyword,
    green: palette.added ?? palette.string,
    yellow: palette.number,
    blue: palette.modified ?? palette.function,
    magenta: palette.property ?? palette.keyword,
    cyan: palette.type,
    white: palette.foreground,
  };
}

/** True when `id` names one of the editor themes in this registry. */
export function isCodeThemeId(id: string): boolean {
  return id in CODE_THEME_BY_ID;
}

/** Legacy system-theme mapping kept for older saved code-view profiles. */
export function resolveSystemCodeThemeId(resolvedAppTheme: "light" | "dark"): string {
  return resolvedAppTheme === "dark" ? SYSTEM_DARK_CODE_THEME : SYSTEM_LIGHT_CODE_THEME;
}





