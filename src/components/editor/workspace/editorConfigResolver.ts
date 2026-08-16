/**
 * EditorConfig Production Resolver (E1.2).
 *
 * Implements parent directory chain traversal, `root=true` boundary stopping,
 * nearest-to-farthest property merging, glob/pattern normalization, cache invalidation,
 * and detailed per-field provenance and diagnostics.
 */

import {
  parseEditorConfigFile,
  matchEditorConfig,
  type EditorConfigProperties,
  type ParsedEditorConfigFile,
} from "./editorConfigParser";
import {
  defaultLanguageCodeStyle,
  sniffIndentation,
  formatCodeStyleLabel,
  type EffectiveCodeStyle,
  type ExplicitIndentationOverride,
  type CodeStyleSource,
} from "./codeStyleModel";

export interface CodeStyleFieldProvenance {
  source: "explicit" | "editorconfig" | "language" | "sniffed" | "fallback";
  configPath?: string;
  rawValue?: string;
  reason?: string;
}

export type CodeStyleProvenance = Partial<
  Record<
    | "indent_style"
    | "indent_size"
    | "tab_width"
    | "end_of_line"
    | "charset"
    | "trim_trailing_whitespace"
    | "insert_final_newline",
    CodeStyleFieldProvenance
  >
>;

export interface CodeStyleDiagnostic {
  path?: string;
  property?: string;
  message: string;
  severity: "info" | "warning";
}

export interface ResolvedCodeStyle extends EffectiveCodeStyle {
  provenance: CodeStyleProvenance;
  diagnostics: CodeStyleDiagnostic[];
  editorConfigProperties?: EditorConfigProperties;
}

export interface EditorConfigFileProvider {
  readFile: (absolutePath: string) => Promise<string | null>;
  fileExists?: (absolutePath: string) => Promise<boolean>;
}

export interface ResolveCodeStyleInput {
  workspaceId: string;
  rootId?: string;
  rootPath?: string;
  filePath: string;
  explicitOverride?: ExplicitIndentationOverride | null;
  text?: string;
  fileProvider?: EditorConfigFileProvider;
}

export interface EditorConfigResolver {
  resolveForFile(input: ResolveCodeStyleInput): Promise<ResolvedCodeStyle>;
  invalidate(path: string): void;
  clearWorkspace(workspaceId: string): void;
  clearAll(): void;
}

interface CachedConfig {
  parsed: ParsedEditorConfigFile;
  contentHash?: string;
  mtime?: number;
}

export class DefaultEditorConfigResolver implements EditorConfigResolver {
  private configCache = new Map<string, CachedConfig>();
  private fileProvider: EditorConfigFileProvider;

  constructor(fileProvider?: EditorConfigFileProvider) {
    this.fileProvider = fileProvider ?? {
      readFile: async () => null,
      fileExists: async () => false,
    };
  }

  setFileProvider(fileProvider: EditorConfigFileProvider): void {
    this.fileProvider = fileProvider;
  }

  /**
   * Register or mock an .editorconfig in cache directly (useful for tests or virtual files).
   */
  setCachedConfigFile(configPath: string, content: string): void {
    const normalizedPath = configPath.replace(/\\/g, "/");
    this.configCache.set(normalizedPath, {
      parsed: parseEditorConfigFile(content),
    });
  }

  invalidate(path: string): void {
    const normalized = path.replace(/\\/g, "/");
    this.configCache.delete(normalized);
  }

  clearWorkspace(_workspaceId: string): void {
    // Clear all cached configurations associated with this workspace
    this.configCache.clear();
  }

  clearAll(): void {
    this.configCache.clear();
  }

  /**
   * Traverse directory chain upwards from the file to root directory.
   */
  private async loadEditorConfigChain(
    filePath: string,
    rootPath?: string,
  ): Promise<Array<{ configPath: string; parsed: ParsedEditorConfigFile }>> {
    const normalizedFile = filePath.replace(/\\/g, "/");
    const normalizedRoot = rootPath ? rootPath.replace(/\\/g, "/").replace(/\/+$/, "") : undefined;

    // Collect directory segments
    const segments = normalizedFile.split("/");
    segments.pop(); // Remove filename

    const chain: Array<{ configPath: string; parsed: ParsedEditorConfigFile }> = [];

    while (segments.length > 0) {
      const currentDir = segments.join("/") || "/";
      const configPath = `${currentDir === "/" ? "" : currentDir}/.editorconfig`;

      let cached = this.configCache.get(configPath);
      if (!cached) {
        try {
          const content = await this.fileProvider.readFile(configPath);
          if (content !== null && content !== undefined) {
            cached = { parsed: parseEditorConfigFile(content) };
            this.configCache.set(configPath, cached);
          }
        } catch {
          // File read failed or missing
        }
      }

      if (cached) {
        chain.unshift({ configPath, parsed: cached.parsed }); // Ancestor first
        if (cached.parsed.isRoot) {
          break; // Stop climbing if root = true
        }
      }

      // Stop climbing if we've reached the workspace root
      if (normalizedRoot && currentDir === normalizedRoot) {
        break;
      }

      segments.pop();
    }

    return chain;
  }

  async resolveForFile(input: ResolveCodeStyleInput): Promise<ResolvedCodeStyle> {
    const { filePath, rootPath, explicitOverride, text } = input;
    const langDefault = defaultLanguageCodeStyle(filePath);
    const provenance: CodeStyleProvenance = {};
    const diagnostics: CodeStyleDiagnostic[] = [];

    // 1. Explicit override on this file/tab has top priority
    if (explicitOverride) {
      const insertSpaces = explicitOverride.type === "spaces";
      const tabSize = explicitOverride.size;
      const indentSize = explicitOverride.size;
      const label = formatCodeStyleLabel({ insertSpaces, indentSize, tabSize, source: "explicit-override" });

      provenance.indent_style = { source: "explicit", rawValue: explicitOverride.type };
      provenance.indent_size = { source: "explicit", rawValue: String(explicitOverride.size) };
      provenance.tab_width = { source: "explicit", rawValue: String(explicitOverride.size) };

      return {
        tabSize,
        indentSize,
        continuationIndent: indentSize * 2,
        insertSpaces,
        source: "explicit-override",
        label,
        provenance,
        diagnostics,
      };
    }

    // 2. Resolve EditorConfig chain (parent directory hierarchy)
    const chain = await this.loadEditorConfigChain(filePath, rootPath);
    let mergedProperties: EditorConfigProperties = {};
    const propertySourcePaths: Partial<Record<keyof EditorConfigProperties, string>> = {};

    for (const { configPath, parsed } of chain) {
      const configDir = configPath.slice(0, configPath.lastIndexOf("/"));
      let relativePathToConfig = filePath;
      if (filePath.startsWith(configDir)) {
        relativePathToConfig = filePath.slice(configDir.length).replace(/^\/+/, "");
      }

      const matched = matchEditorConfig(parsed, relativePathToConfig);
      for (const [k, v] of Object.entries(matched) as Array<[keyof EditorConfigProperties, unknown]>) {
        if (v !== undefined) {
          (mergedProperties as Record<string, unknown>)[k] = v;
          propertySourcePaths[k] = configPath;
        }
      }
    }

    // Process matched EditorConfig properties
    const hasEditorConfigProps = Object.keys(mergedProperties).length > 0;

    let insertSpaces = langDefault.insertSpaces;
    let indentSize = langDefault.indentSize;
    let tabSize = langDefault.tabSize;
    let effectiveSource: CodeStyleSource = "language-default";

    if (mergedProperties.indent_style !== undefined) {
      insertSpaces = mergedProperties.indent_style === "space";
      provenance.indent_style = {
        source: "editorconfig",
        configPath: propertySourcePaths.indent_style,
        rawValue: mergedProperties.indent_style,
      };
      effectiveSource = "editorconfig";
    } else {
      provenance.indent_style = { source: "language", rawValue: insertSpaces ? "space" : "tab" };
    }

    if (mergedProperties.indent_size !== undefined) {
      if (mergedProperties.indent_size === "tab") {
        insertSpaces = false;
        indentSize = typeof mergedProperties.tab_width === "number" ? mergedProperties.tab_width : tabSize;
      } else if (typeof mergedProperties.indent_size === "number") {
        indentSize = mergedProperties.indent_size;
      }
      provenance.indent_size = {
        source: "editorconfig",
        configPath: propertySourcePaths.indent_size,
        rawValue: String(mergedProperties.indent_size),
      };
      effectiveSource = "editorconfig";
    } else {
      provenance.indent_size = { source: "language", rawValue: String(indentSize) };
    }

    if (mergedProperties.tab_width !== undefined) {
      tabSize = mergedProperties.tab_width;
      provenance.tab_width = {
        source: "editorconfig",
        configPath: propertySourcePaths.tab_width,
        rawValue: String(mergedProperties.tab_width),
      };
      effectiveSource = "editorconfig";
    } else {
      tabSize = insertSpaces ? indentSize : 4;
      provenance.tab_width = { source: "language", rawValue: String(tabSize) };
    }

    if (mergedProperties.end_of_line) {
      provenance.end_of_line = {
        source: "editorconfig",
        configPath: propertySourcePaths.end_of_line,
        rawValue: mergedProperties.end_of_line,
      };
      effectiveSource = "editorconfig";
    }

    if (mergedProperties.charset) {
      provenance.charset = {
        source: "editorconfig",
        configPath: propertySourcePaths.charset,
        rawValue: mergedProperties.charset,
      };
      effectiveSource = "editorconfig";
    }

    if (mergedProperties.trim_trailing_whitespace !== undefined) {
      provenance.trim_trailing_whitespace = {
        source: "editorconfig",
        configPath: propertySourcePaths.trim_trailing_whitespace,
        rawValue: String(mergedProperties.trim_trailing_whitespace),
      };
      effectiveSource = "editorconfig";
    }

    if (mergedProperties.insert_final_newline !== undefined) {
      provenance.insert_final_newline = {
        source: "editorconfig",
        configPath: propertySourcePaths.insert_final_newline,
        rawValue: String(mergedProperties.insert_final_newline),
      };
      effectiveSource = "editorconfig";
    }

    // If EditorConfig did not configure indentation, fallback to sniffed text (if available)
    if (!hasEditorConfigProps && text && text.trim().length > 0) {
      const sniffed = sniffIndentation(text);
      const sniffedSpaces = sniffed.type === "spaces";
      if (sniffedSpaces !== langDefault.insertSpaces || sniffed.size !== langDefault.indentSize) {
        insertSpaces = sniffedSpaces;
        indentSize = sniffed.size;
        tabSize = sniffed.size;
        effectiveSource = "sniffed";

        provenance.indent_style = { source: "sniffed", rawValue: sniffed.type };
        provenance.indent_size = { source: "sniffed", rawValue: String(sniffed.size) };
        provenance.tab_width = { source: "sniffed", rawValue: String(sniffed.size) };
      }
    }

    const label = formatCodeStyleLabel({
      insertSpaces,
      indentSize,
      tabSize,
      source: effectiveSource,
    });

    return {
      tabSize,
      indentSize,
      continuationIndent: indentSize * 2,
      insertSpaces,
      endOfLine: mergedProperties.end_of_line,
      charset: mergedProperties.charset,
      trimTrailingWhitespace: mergedProperties.trim_trailing_whitespace,
      insertFinalNewline: mergedProperties.insert_final_newline,
      source: effectiveSource,
      label,
      provenance,
      diagnostics,
      editorConfigProperties: hasEditorConfigProps ? mergedProperties : undefined,
    };
  }
}

export const globalEditorConfigResolver = new DefaultEditorConfigResolver();
