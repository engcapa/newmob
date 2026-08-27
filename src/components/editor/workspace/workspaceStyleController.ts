/**
 * Workspace-Scoped Style Controller (N1.1).
 *
 * Implements immutable workspace-owned EditorConfig & code-style resolution,
 * multi-root isolated caching, disk text snapshots, and typed save transactions.
 * Removes dependencies on mutable global providers.
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
  type ExplicitIndentationOverride,
  type CodeStyleSource,
  type SchemeStyleFields,
} from "./codeStyleModel";
import type {
  CodeStyleProvenance,
  CodeStyleDiagnostic,
  ResolvedCodeStyle,
  EditorConfigFileProvider,
} from "./editorConfigResolver";
import type { OpenFileEol } from "./editorGroupTypes";
import {
  runSaveNormalizationPipeline,
  type SaveNormalizationResult,
} from "./saveNormalizationPipeline";
import {
  buildPreparedSave,
  resolveWritePolicy,
  type PreparedSaveCommitter,
  type SaveCommitResult,
} from "./saveCommit";
import type { EffectiveSavePolicyV4 } from "./workspaceCodeStyleScheme";

export interface WorkspaceStyleRoot {
  id?: string;
  path: string;
}

export interface WorkspaceStyleControllerOptions {
  workspaceId: string;
  roots: readonly WorkspaceStyleRoot[];
  fileProvider: EditorConfigFileProvider;
}

export interface ResolveStyleOptions {
  filePath: string;
  explicitOverride?: ExplicitIndentationOverride | null;
  text?: string;
  /** §8.19.9 R8-D1 active scheme fields; layered BELOW EditorConfig. */
  activeSchemeFields?: SchemeStyleFields | null;
}

export interface DiskTextSnapshot {
  text: string;
  eol: OpenFileEol;
  encoding: string;
  bom: boolean;
  hash: string | null;
}

export interface SaveTransactionV2 {
  id: string;
  workspaceId: string;
  fileKey: string;
  filePath: string;
  bufferVersion: number;
  styleGeneration: number;
  expectedDiskHash: string | null;
  explicitOverride?: ExplicitIndentationOverride | null;
  policy: {
    eol?: OpenFileEol | "lf" | "crlf" | "cr";
    encoding: string;
    bom: boolean;
  };
  text: string;
}

/**
 * Six-kind controller/host-level result (§8.18.1). The controller only
 * produces prepare-phase outcomes (`cancelled`/`conflict`/`failed` with
 * `diskEffect: "none"`); every disk-writing outcome is produced verbatim by
 * the single commit core handed in as the committer — the controller never
 * reinterprets a writer result into a different business state.
 */
export type SaveCommitOutcome = SaveCommitResult;

/**
 * Typed writer contract (§8.18.1): the committer receives the frozen
 * `PreparedSave` and returns the full six-kind result including disk /
 * memory / provider effect axes.
 */
export type { PreparedSaveCommitter } from "./saveCommit";

interface CachedConfig {
  parsed: ParsedEditorConfigFile;
  contentHash?: string;
  mtime?: number;
}

export class WorkspaceStyleController {
  private readonly workspaceId: string;
  private roots: readonly WorkspaceStyleRoot[];
  private readonly fileProvider: EditorConfigFileProvider;
  private configCache = new Map<string, CachedConfig>();
  private generation: number = 0;

  constructor(options: WorkspaceStyleControllerOptions) {
    this.workspaceId = options.workspaceId;
    this.roots = [...options.roots];
    this.fileProvider = options.fileProvider;
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  getGeneration(): number {
    return this.generation;
  }

  replaceRoots(roots: readonly WorkspaceStyleRoot[], nextGeneration?: number): void {
    this.roots = [...roots];
    this.generation = nextGeneration !== undefined ? nextGeneration : this.generation + 1;
    this.configCache.clear();
  }

  invalidate(path: string): void {
    const normalized = path.replace(/\\/g, "/");
    for (const key of Array.from(this.configCache.keys())) {
      if (key.endsWith(`:${normalized}`) || key === normalized) {
        this.configCache.delete(key);
      }
    }
    this.generation += 1;
  }

  clearCache(): void {
    this.configCache.clear();
    this.generation += 1;
  }

  /**
   * Register or mock an .editorconfig in cache directly (useful for tests or virtual files).
   */
  setCachedConfigFile(configPath: string, content: string, rootId?: string): void {
    const normalizedPath = configPath.replace(/\\/g, "/");
    const key = `${this.workspaceId}:${rootId ?? "default"}:${normalizedPath}`;
    this.configCache.set(key, {
      parsed: parseEditorConfigFile(content),
    });
  }

  private findMatchingRoot(filePath: string): WorkspaceStyleRoot | undefined {
    const normalizedFile = filePath.replace(/\\/g, "/");
    // Find longest matching root path
    let bestMatch: WorkspaceStyleRoot | undefined;
    let bestLength = -1;

    for (const root of this.roots) {
      const normalizedRoot = root.path.replace(/\\/g, "/").replace(/\/+$/, "");
      if (
        normalizedFile === normalizedRoot ||
        normalizedFile.startsWith(normalizedRoot + "/")
      ) {
        if (normalizedRoot.length > bestLength) {
          bestMatch = root;
          bestLength = normalizedRoot.length;
        }
      }
    }

    return bestMatch;
  }

  private async loadEditorConfigChain(
    filePath: string,
    root: WorkspaceStyleRoot | undefined,
    diagnostics?: CodeStyleDiagnostic[],
  ): Promise<Array<{ configPath: string; parsed: ParsedEditorConfigFile }>> {
    const normalizedFile = filePath.replace(/\\/g, "/");
    const normalizedRoot = root?.path ? root.path.replace(/\\/g, "/").replace(/\/+$/, "") : undefined;
    const rootId = root?.id ?? "default";

    if (
      normalizedRoot &&
      normalizedFile !== normalizedRoot &&
      !normalizedFile.startsWith(normalizedRoot + "/")
    ) {
      diagnostics?.push({
        path: filePath,
        message: `File path "${filePath}" is outside root directory "${root?.path}".`,
        severity: "warning",
      });
      return [];
    }

    const segments = normalizedFile.split("/");
    segments.pop(); // Remove filename

    const chain: Array<{ configPath: string; parsed: ParsedEditorConfigFile }> = [];

    while (segments.length > 0) {
      const currentDir = segments.join("/") || "/";
      const configPath = `${currentDir === "/" ? "" : currentDir}/.editorconfig`;
      const cacheKey = `${this.workspaceId}:${rootId}:${configPath}`;

      let cached = this.configCache.get(cacheKey);
      if (!cached) {
        try {
          const content = await this.fileProvider.readFile(configPath);
          if (content !== null && content !== undefined) {
            cached = { parsed: parseEditorConfigFile(content) };
            this.configCache.set(cacheKey, cached);
          }
        } catch (err) {
          diagnostics?.push({
            path: configPath,
            message: `Failed to read .editorconfig: ${err instanceof Error ? err.message : String(err)}`,
            severity: "warning",
          });
        }
      }

      if (cached) {
        chain.unshift({ configPath, parsed: cached.parsed });
        if (cached.parsed.isRoot) {
          break;
        }
      }

      if (normalizedRoot && (currentDir === normalizedRoot || !currentDir.startsWith(normalizedRoot))) {
        break;
      }

      segments.pop();
    }

    return chain;
  }

  async resolveForFile(options: ResolveStyleOptions): Promise<ResolvedCodeStyle> {
    const { filePath, explicitOverride, text } = options;
    // §8.19.9 R8-D1: the active scheme layers below EditorConfig — its
    // indentation fields also suppress sniffed detection (explicit intent).
    const scheme = options.activeSchemeFields ?? null;
    const schemeDefinesIndentation = scheme != null
      && (scheme.insertSpaces !== undefined || scheme.indentSize !== undefined);
    const matchingRoot = this.findMatchingRoot(filePath);
    const langDefault = defaultLanguageCodeStyle(filePath);
    const provenance: CodeStyleProvenance = {};
    const diagnostics: CodeStyleDiagnostic[] = [];

    const chain = await this.loadEditorConfigChain(filePath, matchingRoot, diagnostics);
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

    const hasEditorConfigIndent =
      mergedProperties.indent_style !== undefined ||
      mergedProperties.indent_size !== undefined ||
      mergedProperties.tab_width !== undefined;

    let insertSpaces = langDefault.insertSpaces;
    let indentSize = langDefault.indentSize;
    let tabSize = langDefault.tabSize;
    let effectiveSource: CodeStyleSource = "language-default";

    if (explicitOverride) {
      insertSpaces = explicitOverride.type === "spaces";
      indentSize = explicitOverride.size;
      tabSize = explicitOverride.size;
      effectiveSource = "explicit-override";

      provenance.indent_style = { source: "explicit", rawValue: explicitOverride.type };
      provenance.indent_size = { source: "explicit", rawValue: String(explicitOverride.size) };
      provenance.tab_width = { source: "explicit", rawValue: String(explicitOverride.size) };
    } else if (hasEditorConfigIndent) {
      effectiveSource = "editorconfig";
      if (mergedProperties.indent_style !== undefined) {
        insertSpaces = mergedProperties.indent_style === "space";
        provenance.indent_style = {
          source: "editorconfig",
          configPath: propertySourcePaths.indent_style,
          rawValue: mergedProperties.indent_style,
        };
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
      } else {
        tabSize = insertSpaces ? indentSize : 4;
        provenance.tab_width = { source: "language", rawValue: String(tabSize) };
      }
    } else if (scheme && schemeDefinesIndentation) {
      insertSpaces = scheme.insertSpaces ?? langDefault.insertSpaces;
      indentSize = scheme.indentSize ?? langDefault.indentSize;
      tabSize = scheme.tabSize ?? (insertSpaces ? indentSize : 4);
      effectiveSource = "scheme";
      provenance.indent_style = { source: "scheme", rawValue: insertSpaces ? "space" : "tab" };
      provenance.indent_size = { source: "scheme", rawValue: String(indentSize) };
      provenance.tab_width = { source: "scheme", rawValue: String(tabSize) };
    } else {
      provenance.indent_style = { source: "language", rawValue: insertSpaces ? "space" : "tab" };
      provenance.indent_size = { source: "language", rawValue: String(indentSize) };
      provenance.tab_width = { source: "language", rawValue: String(tabSize) };
    }

    if (mergedProperties.end_of_line) {
      provenance.end_of_line = {
        source: "editorconfig",
        configPath: propertySourcePaths.end_of_line,
        rawValue: mergedProperties.end_of_line,
      };
    }

    if (mergedProperties.charset) {
      provenance.charset = {
        source: "editorconfig",
        configPath: propertySourcePaths.charset,
        rawValue: mergedProperties.charset,
      };
    }

    if (mergedProperties.trim_trailing_whitespace !== undefined) {
      provenance.trim_trailing_whitespace = {
        source: "editorconfig",
        configPath: propertySourcePaths.trim_trailing_whitespace,
        rawValue: String(mergedProperties.trim_trailing_whitespace),
      };
    }

    if (mergedProperties.insert_final_newline !== undefined) {
      provenance.insert_final_newline = {
        source: "editorconfig",
        configPath: propertySourcePaths.insert_final_newline,
        rawValue: String(mergedProperties.insert_final_newline),
      };
    }

    if (!explicitOverride && !hasEditorConfigIndent && !schemeDefinesIndentation && text && text.trim().length > 0) {
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

    const hasEditorConfigProps = Object.keys(mergedProperties).length > 0;
    const label = formatCodeStyleLabel({
      insertSpaces,
      indentSize,
      tabSize,
      source: effectiveSource,
    });

    return {
      tabSize,
      indentSize,
      continuationIndent: scheme?.continuationIndent ?? indentSize * 2,
      insertSpaces,
      // Scheme fills gaps only — EditorConfig entries always win.
      endOfLine: mergedProperties.end_of_line ?? scheme?.endOfLine,
      charset: mergedProperties.charset,
      trimTrailingWhitespace:
        mergedProperties.trim_trailing_whitespace ?? scheme?.trimTrailingWhitespace,
      insertFinalNewline:
        mergedProperties.insert_final_newline ?? scheme?.insertFinalNewline,
      source: effectiveSource,
      label,
      provenance,
      diagnostics,
      editorConfigProperties: hasEditorConfigProps ? mergedProperties : undefined,
    };
  }

  /**
   * Execute a save transaction: prepare (style resolution, normalization,
   * policy freeze into one `PreparedSave`) then hand the immutable record to
   * the single commit core (§8.18.1). Prepare-phase failures are terminal
   * results with `diskEffect: "none"`; every disk-writing outcome comes back
   * verbatim from the committer — the controller never reclassifies a writer
   * result and never touches buffer state itself.
   */
  async executeSaveTransaction(
    transaction: SaveTransactionV2,
    commit: PreparedSaveCommitter,
    options?: {
      savePolicy?: EffectiveSavePolicyV4;
      formatOnSave?: boolean;
      formatFn?: (text: string) => Promise<string | null>;
      organizeImportsOnSave?: boolean;
      organizeImportsFn?: (text: string) => Promise<string | null>;
      getLatestBufferVersion?: () => number;
    },
  ): Promise<SaveCommitOutcome> {
    if (transaction.workspaceId !== this.workspaceId) {
      return {
        kind: "failed",
        transactionId: transaction.id,
        diskEffect: "none",
        memoryEffect: "unchanged",
        providerEffect: "not-sent",
        error: {
          kind: "io",
          message: `Transaction workspaceId mismatch: expected "${this.workspaceId}", got "${transaction.workspaceId}".`,
        },
      };
    }

    const codeStyle = await this.resolveForFile({
      filePath: transaction.filePath,
      text: transaction.text,
      explicitOverride: transaction.explicitOverride,
    });

    // Run normalization pipeline with resolved style values as priority
    const resolvedEol = codeStyle.endOfLine
      ? (codeStyle.endOfLine.toLowerCase() as "lf" | "crlf" | "cr")
      : transaction.policy.eol
        ? (transaction.policy.eol.toLowerCase() as "lf" | "crlf" | "cr")
        : undefined;

    const resolvedCharset = codeStyle.charset ?? transaction.policy.encoding ?? "UTF-8";

    const normResult: SaveNormalizationResult = await runSaveNormalizationPipeline({
      text: transaction.text,
      codeStyle: {
        ...codeStyle,
        endOfLine: resolvedEol,
        charset: resolvedCharset,
      },
      savePolicy: options?.savePolicy,
      filePath: transaction.filePath,
      formatOnSave: options?.savePolicy ? options.savePolicy.format.enabled : options?.formatOnSave,
      formatFn: options?.formatFn,
      organizeImportsOnSave: options?.savePolicy ? options.savePolicy.organizeImports.enabled : options?.organizeImportsOnSave,
      organizeImportsFn: options?.organizeImportsFn,
      expectedVersion: transaction.bufferVersion,
      getLatestBufferVersion: options?.getLatestBufferVersion,
    });

    if (normResult.cancelledDueToEdit) {
      return {
        kind: "cancelled",
        transactionId: transaction.id,
        diskEffect: "none",
        memoryEffect: "unchanged",
        providerEffect: "not-sent",
        phase: "prepare",
        reason: normResult.diagnostics[0] ?? "Buffer was modified during format/normalize.",
      };
    }

    if (normResult.encodingError) {
      return {
        kind: "failed",
        transactionId: transaction.id,
        diskEffect: "none",
        memoryEffect: "unchanged",
        providerEffect: "not-sent",
        error: {
          kind: "encoding",
          message: normResult.diagnostics[0] ?? "Text cannot be represented in target encoding.",
        },
      };
    }

    // Verify buffer version again if provider available
    if (options?.getLatestBufferVersion) {
      const currentVer = options.getLatestBufferVersion();
      if (currentVer !== transaction.bufferVersion) {
        return {
          kind: "cancelled",
          transactionId: transaction.id,
          diskEffect: "none",
          memoryEffect: "unchanged",
          providerEffect: "not-sent",
          phase: "pre-write",
          reason: `Buffer revision changed (${transaction.bufferVersion} -> ${currentVer}) before write.`,
        };
      }
    }

    // Check style generation
    if (this.generation !== transaction.styleGeneration) {
      return {
        kind: "cancelled",
        transactionId: transaction.id,
        diskEffect: "none",
        memoryEffect: "unchanged",
        providerEffect: "not-sent",
        phase: "pre-write",
        reason: "Workspace style generation changed during save transaction.",
      };
    }

    // Freeze the exact bytes/policy for the writer; nothing below re-reads
    // metadata past this boundary.
    const prepared = buildPreparedSave({
      transactionId: transaction.id,
      workspaceId: this.workspaceId,
      fileKey: transaction.fileKey,
      filePath: transaction.filePath,
      text: normResult.text,
      bufferRevision: transaction.bufferVersion,
      styleGeneration: transaction.styleGeneration,
      expectedDiskHash: transaction.expectedDiskHash,
      policy: resolveWritePolicy({
        explicit: {
          eol: normResult.resolvedEol ?? resolvedEol ?? "lf",
          encoding: normResult.resolvedCharset ?? resolvedCharset ?? "UTF-8",
          bom: normResult.resolvedBom ?? transaction.policy.bom ?? false,
        },
      }),
    });

    // The commit core is the single result classifier (§8.18.1). Its outcome
    // — including IPC errors it could not classify — is returned unchanged.
    return commit(prepared);
  }
}

export function createWorkspaceStyleController(
  options: WorkspaceStyleControllerOptions,
): WorkspaceStyleController {
  return new WorkspaceStyleController(options);
}
