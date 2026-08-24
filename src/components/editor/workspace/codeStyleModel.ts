/**
 * Effective Code Style Model & Resolution Pipeline.
 *
 * Implements the IDEA 2026.2 precedence hierarchy:
 *   1. Explicit file override (user selected in status bar)
 *   2. EditorConfig (.editorconfig matching rules)
 *   3. Language/Workspace default (e.g. Go=Tab:4, Java/Python/Rust/C#=Spaces:4, TS/JS/JSON=Spaces:2)
 *   4. Sniffed fallback (heuristics from file text)
 */

import { type EditorConfigProperties } from "./editorConfigParser";

export type CodeStyleSource =
  | "explicit-override"
  | "editorconfig"
  | "scheme"
  | "language-default"
  | "sniffed"
  | "fallback";

export interface EffectiveCodeStyle {
  tabSize: number;
  indentSize: number;
  continuationIndent: number;
  insertSpaces: boolean;
  endOfLine?: "lf" | "crlf" | "cr";
  charset?: string;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  source: CodeStyleSource;
  label: string;
}

export interface ExplicitIndentationOverride {
  type: "spaces" | "tabs";
  size: number;
}

/**
 * Default indentation rules by file extension / language.
 */
export function defaultLanguageCodeStyle(languagePath: string): {
  tabSize: number;
  indentSize: number;
  continuationIndent: number;
  insertSpaces: boolean;
} {
  const ext = languagePath.split(".").pop()?.toLowerCase() ?? "";

  // Go standard is tabs (tab_width=4 or 8)
  if (ext === "go") {
    return { tabSize: 4, indentSize: 4, continuationIndent: 4, insertSpaces: false };
  }

  // 4 spaces default: Java, Python, Rust, C#, C++, C, Kotlin, Scala, Swift, PHP
  if (["java", "py", "rs", "cs", "cpp", "c", "h", "hpp", "kt", "kts", "scala", "swift", "php"].includes(ext)) {
    return { tabSize: 4, indentSize: 4, continuationIndent: 8, insertSpaces: true };
  }

  // 2 spaces default: TypeScript, JavaScript, JSON, YAML, HTML, CSS, SCSS, Markdown, Lua, Ruby
  return { tabSize: 2, indentSize: 2, continuationIndent: 4, insertSpaces: true };
}

/**
 * Sniff indentation from file text.
 */
export function sniffIndentation(text: string): {
  type: "spaces" | "tabs";
  size: number;
} {
  let tabCount = 0;
  let space2Count = 0;
  let space4Count = 0;

  for (const line of text.split("\n").slice(0, 300)) {
    if (!line || /^\s*$/.test(line)) continue;
    if (line.startsWith("\t")) {
      tabCount += 1;
    } else {
      const match = line.match(/^ +/);
      if (match) {
        const len = match[0].length;
        if (len % 4 === 0) space4Count += 1;
        else if (len % 2 === 0) space2Count += 1;
      }
    }
  }

  if (tabCount > space2Count && tabCount > space4Count) {
    return { type: "tabs", size: 4 };
  }
  if (space4Count > space2Count) {
    return { type: "spaces", size: 4 };
  }
  return { type: "spaces", size: 2 };
}

/**
 * Format a human-readable label for the code style, e.g.
 *   "Spaces: 4"
 *   "Spaces: 4 (EditorConfig)"
 *   "Tab: 4 (Auto)"
 */
export function formatCodeStyleLabel(style: {
  insertSpaces: boolean;
  indentSize: number;
  tabSize: number;
  source: CodeStyleSource;
}): string {
  const base = style.insertSpaces
    ? `Spaces: ${style.indentSize}`
    : `Tab: ${style.tabSize}`;

  switch (style.source) {
    case "editorconfig":
      return `${base} (EditorConfig)`;
    case "scheme":
      return `${base} (Scheme)`;
    case "explicit-override":
      return `${base} (Manual)`;
    case "sniffed":
      return `${base} (Auto)`;
    case "language-default":
    case "fallback":
    default:
      return base;
  }
}

/**
 * Resolve effective code style using strict priority hierarchy.
 */
/** Style fields an active scheme may set (§8.19.9 R8-D precedence layer). */
export interface SchemeStyleFields {
  tabSize?: number;
  indentSize?: number;
  continuationIndent?: number;
  insertSpaces?: boolean;
  endOfLine?: "lf" | "crlf" | "cr";
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
}

export function resolveEffectiveCodeStyle(params: {
  filePath: string;
  text?: string;
  explicitOverride?: ExplicitIndentationOverride | null;
  editorConfigProperties?: EditorConfigProperties | null;
  /** Active scheme for the file's language; sits BELOW EditorConfig. */
  activeSchemeFields?: SchemeStyleFields | null;
}): EffectiveCodeStyle {
  const { filePath, text, explicitOverride, editorConfigProperties } = params;
  const scheme = params.activeSchemeFields ?? null;

  // 1. Explicit user override on this file/tab
  if (explicitOverride) {
    const insertSpaces = explicitOverride.type === "spaces";
    const tabSize = explicitOverride.size;
    const indentSize = explicitOverride.size;
    return {
      tabSize,
      indentSize,
      continuationIndent: indentSize * 2,
      insertSpaces,
      source: "explicit-override",
      label: formatCodeStyleLabel({ insertSpaces, indentSize, tabSize, source: "explicit-override" }),
    };
  }

  // 2. EditorConfig properties
  if (editorConfigProperties && (editorConfigProperties.indent_style || editorConfigProperties.indent_size !== undefined)) {
    const isTab = editorConfigProperties.indent_style === "tab" || editorConfigProperties.indent_size === "tab";
    const insertSpaces = !isTab;
    let size = 4;
    if (typeof editorConfigProperties.indent_size === "number") {
      size = editorConfigProperties.indent_size;
    } else if (typeof editorConfigProperties.tab_width === "number") {
      size = editorConfigProperties.tab_width;
    } else if (!insertSpaces) {
      size = 4;
    } else {
      size = defaultLanguageCodeStyle(filePath).indentSize;
    }

    const tabSize = editorConfigProperties.tab_width ?? (insertSpaces ? size : 4);
    const indentSize = size;

    return {
      tabSize,
      indentSize,
      continuationIndent: indentSize * 2,
      insertSpaces,
      // Scheme fills gaps only — EditorConfig entries always win.
      endOfLine: editorConfigProperties.end_of_line ?? scheme?.endOfLine,
      charset: editorConfigProperties.charset,
      trimTrailingWhitespace:
        editorConfigProperties.trim_trailing_whitespace ?? scheme?.trimTrailingWhitespace,
      insertFinalNewline:
        editorConfigProperties.insert_final_newline ?? scheme?.insertFinalNewline,
      source: "editorconfig",
      label: formatCodeStyleLabel({ insertSpaces, indentSize, tabSize, source: "editorconfig" }),
    };
  }

  // 3. Active scheme for this language — explicit user intent, so it beats
  // both the language defaults and sniffed detection (§8.19.9 R8-D).
  const langDefault = defaultLanguageCodeStyle(filePath);
  const schemeDefinesIndentation = scheme != null
    && (scheme.insertSpaces !== undefined || scheme.indentSize !== undefined);
  if (scheme && Object.keys(scheme).length > 0) {
    return {
      tabSize: scheme.tabSize ?? langDefault.tabSize,
      indentSize: scheme.indentSize ?? langDefault.indentSize,
      continuationIndent: scheme.continuationIndent ?? langDefault.continuationIndent,
      insertSpaces: scheme.insertSpaces ?? langDefault.insertSpaces,
      endOfLine: scheme.endOfLine,
      trimTrailingWhitespace: scheme.trimTrailingWhitespace,
      insertFinalNewline: scheme.insertFinalNewline,
      source: "scheme",
      label: formatCodeStyleLabel({
        insertSpaces: scheme.insertSpaces ?? langDefault.insertSpaces,
        indentSize: scheme.indentSize ?? langDefault.indentSize,
        tabSize: scheme.tabSize ?? langDefault.tabSize,
        source: "scheme",
      }),
    };
  }

  if (text && text.trim().length > 0 && !schemeDefinesIndentation) {
    const sniffed = sniffIndentation(text);
    const sniffedInsertSpaces = sniffed.type === "spaces";
    if (sniffedInsertSpaces !== langDefault.insertSpaces || sniffed.size !== langDefault.indentSize) {
      return {
        tabSize: sniffed.size,
        indentSize: sniffed.size,
        continuationIndent: sniffed.size * 2,
        insertSpaces: sniffedInsertSpaces,
        source: "sniffed",
        label: formatCodeStyleLabel({
          insertSpaces: sniffedInsertSpaces,
          indentSize: sniffed.size,
          tabSize: sniffed.size,
          source: "sniffed",
        }),
      };
    }
  }

  return {
    tabSize: langDefault.tabSize,
    indentSize: langDefault.indentSize,
    continuationIndent: langDefault.continuationIndent,
    insertSpaces: langDefault.insertSpaces,
    source: "language-default",
    label: formatCodeStyleLabel({
      insertSpaces: langDefault.insertSpaces,
      indentSize: langDefault.indentSize,
      tabSize: langDefault.tabSize,
      source: "language-default",
    }),
  };
}
