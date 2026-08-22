import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  codeThemeVariablesFromPalette,
  getCodeThemeDefinition,
  type CodeThemeVars,
} from "../../../lib/codeThemes";

import {
  editorVirtualSpacePolicy,
  type EditorVirtualSpacePolicy,
} from "./workspaceEditorCommands";

export interface EditorAppearanceExtensionProfile {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  ligatures: boolean;
  colorSchemeId: string;
  highContrast: boolean;
  virtualSpace?: EditorVirtualSpacePolicy;
}

const HIGH_CONTRAST_COLORS: CodeThemeVars = codeThemeVariablesFromPalette({
  variant: "dark",
  background: "#000000",
  foreground: "#ffffff",
  selection: "#005fcc",
  cursor: "#ffff00",
  comment: "#d0d0d0",
  keyword: "#ffff00",
  string: "#7fff7f",
  number: "#00ffff",
  function: "#ffffff",
  type: "#00ffff",
  variable: "#ffffff",
  property: "#ffffff",
  operator: "#ffff00",
  punctuation: "#ffffff",
  added: "#00ff00",
  deleted: "#ff4d4d",
  modified: "#00bfff",
});

export function resolveEditorAppearanceColors(
  profile: Pick<EditorAppearanceExtensionProfile, "colorSchemeId" | "highContrast">,
): CodeThemeVars | null {
  if (profile.highContrast) return HIGH_CONTRAST_COLORS;
  if (profile.colorSchemeId === "app") return null;
  const definition = getCodeThemeDefinition(profile.colorSchemeId);
  return definition ? codeThemeVariablesFromPalette(definition.palette) : null;
}

export function editorAppearanceExtension(
  profile: EditorAppearanceExtensionProfile,
): Extension {
  const colors = resolveEditorAppearanceColors(profile);
  const root: Record<string, string> = {
    fontSize: `${profile.fontSizePx}px`,
  };
  const scroller: Record<string, string> = {
    fontFamily: profile.fontFamily,
    lineHeight: String(profile.lineHeight),
    fontFeatureSettings: profile.ligatures
      ? '"liga" 1, "calt" 1'
      : '"liga" 0, "calt" 0',
  };
  if (colors) {
    root.backgroundColor = colors["--taomni-code-bg"];
    root.color = colors["--taomni-code-text"];
  }
  return [
    EditorView.theme({
      "&": root,
      ".cm-scroller": scroller,
      ...(colors ? {
        ".cm-content, .cm-line": {
          color: colors["--taomni-code-text"],
        },
        ".cm-content": {
          caretColor: colors["--taomni-code-caret"],
        },
        ".cm-cursor": {
          borderLeftColor: colors["--taomni-code-caret"],
        },
        ".cm-gutters": {
          backgroundColor: colors["--taomni-code-gutter-bg"],
          color: colors["--taomni-code-line-number"],
          borderRightColor: colors["--taomni-code-border"],
        },
        ".cm-activeLine": {
          backgroundColor: colors["--taomni-code-active-line-bg"],
        },
        ".cm-activeLineGutter": {
          backgroundColor: colors["--taomni-code-active-line-gutter-bg"],
          color: colors["--taomni-code-line-number-active"],
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: `${colors["--taomni-code-selection-bg"]} !important`,
        },
      } : {}),
    }),
    EditorView.contentAttributes.of({
      "data-editor-color-scheme": profile.highContrast
        ? "high-contrast"
        : profile.colorSchemeId,
      "data-editor-ligatures": profile.ligatures ? "true" : "false",
    }),
    editorVirtualSpacePolicy.of(profile.virtualSpace ?? {
      afterLineEnd: false,
      atFileBottom: false,
    }),
  ];
}
