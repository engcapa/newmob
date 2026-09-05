/**
 * Save Normalization Pipeline (E1.3).
 *
 * Runs formatting and standard whitespace/EOL normalization steps before saving to disk:
 *   1. Optional language formatter (LSP / provider)
 *   2. `trim_trailing_whitespace`
 *   3. `insert_final_newline`
 *   4. `end_of_line` (LF / CRLF / CR)
 *   5. Charset / BOM verification
 *
 * Protects against race conditions with concurrent buffer typing during async format.
 */

import type { ResolvedCodeStyle } from "./editorConfigResolver";
import type { EffectiveCodeStyle } from "./codeStyleModel";
import {
  type EffectiveSavePolicyV4,
  isPathExcluded,
  containsDisabledFormatterMarker,
} from "./workspaceCodeStyleScheme";
import { sha256Hex } from "./projectAnalysisModel";

export type SaveStageKind =
  | "format"
  | "organize-imports"
  | "trim"
  | "final-newline"
  | "eol"
  | "charset-bom";

export type SaveStageStatus =
  | "applied"
  | "executed"
  | "disabled"
  | "unavailable"
  | "failed"
  | "stale"
  | "skipped-prior-failure";

export interface SaveStageReport {
  stage: SaveStageKind;
  status: SaveStageStatus;
  error?: string;
  reason?: string;
  beforeHash: string;
  afterHash: string;
}

export interface SavePlanDocumentIdentity {
  uri: string;
  path?: string;
  revision: number;
  languageId?: string;
}

export interface SavePlanDiskIdentity {
  mtimeMs?: number | null;
  sizeBytes?: number | null;
  exists?: boolean;
  sha256?: string | null;
}

export interface SavePlanProviderIdentity {
  id?: string | null;
  generation?: number | null;
}

export interface SavePlanProjectIdentity {
  fingerprint?: string | null;
  rootUri?: string | null;
}

export interface SavePlanEncodingIdentity {
  charset?: string | null;
  bom?: boolean | null;
}

export interface SavePlanIdentity {
  text: string;
  document?: Readonly<SavePlanDocumentIdentity>;
  disk?: Readonly<SavePlanDiskIdentity>;
  policy?: Readonly<EffectiveSavePolicyV4>;
  style: Readonly<ResolvedCodeStyle | EffectiveCodeStyle>;
  provider?: Readonly<SavePlanProviderIdentity>;
  project?: Readonly<SavePlanProjectIdentity>;
  encoding?: Readonly<SavePlanEncodingIdentity>;
}

export interface ImmutableSavePlan {
  planId: string;
  identity: Readonly<SavePlanIdentity>;
  initialHash: string;
  finalHash: string;
  finalText: string;
  stages: readonly SaveStageReport[];
  disposition: "ready" | "stale" | "failed" | "cancelled";
  cancelledDueToEdit: boolean;
  encodingError?: boolean;
  diagnostics: readonly string[];
  resolvedEol?: "lf" | "crlf" | "cr";
  resolvedCharset?: string;
  resolvedBom?: boolean;
  createdAt: number;
}

export interface SaveNormalizationOptions {
  text: string;
  codeStyle: ResolvedCodeStyle | EffectiveCodeStyle;
  savePolicy?: EffectiveSavePolicyV4;
  filePath?: string;
  formatOnSave?: boolean;
  formatFn?: (text: string) => Promise<string | null>;
  organizeImportsOnSave?: boolean;
  organizeImportsFn?: (text: string) => Promise<string | null>;
  getLatestBufferText?: () => string;
  expectedVersion?: number;
  getLatestBufferVersion?: () => number;
  documentIdentity?: SavePlanDocumentIdentity;
  diskIdentity?: SavePlanDiskIdentity;
  providerIdentity?: SavePlanProviderIdentity;
  projectIdentity?: SavePlanProjectIdentity;
}

export interface SaveNormalizationResult {
  text: string;
  formatted: boolean;
  importsOrganized: boolean;
  whitespaceTrimmed: boolean;
  newlineAdjusted: boolean;
  eolNormalized: boolean;
  cancelledDueToEdit: boolean;
  encodingError?: boolean;
  diagnostics: string[];
  stages: SaveStageReport[];
  resolvedEol?: "lf" | "crlf" | "cr";
  resolvedCharset?: string;
  resolvedBom?: boolean;
  plan: ImmutableSavePlan;
}

/**
 * Trim trailing whitespace from each line in a text buffer while preserving target EOL.
 * If eol is not specified, preserves existing line breaks (LF, CRLF, bare CR) without modification.
 */
export function trimTrailingWhitespace(text: string, eol?: string): string {
  if (!eol) {
    return text.replace(/[ \t]+(?=\r\n|\r|\n|$)/g, "");
  }
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join(eol);
}

/**
 * Adjust trailing newline at end of file.
 * If insertFinalNewline is true, ensures exactly one trailing newline.
 * If insertFinalNewline is false, removes any trailing newlines.
 */
export function adjustFinalNewline(text: string, insertFinalNewline: boolean, eol?: string): string {
  if (text.length === 0) return text;

  // Strip all trailing newlines first
  const trimmed = text.replace(/(\r\n|\r|\n)+$/, "");
  if (!insertFinalNewline) {
    return trimmed;
  }
  if (eol) {
    return trimmed + eol;
  }
  const detected = text.includes("\r\n")
    ? "\r\n"
    : text.includes("\r") && !text.includes("\n")
      ? "\r"
      : "\n";
  return trimmed + detected;
}

/**
 * Normalize line endings in text to the requested EOL format.
 */
export function normalizeLineEndings(
  text: string,
  targetEol: "lf" | "crlf" | "cr",
): string {
  // First normalize all CRLF and CR to LF
  const unified = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (targetEol === "lf") {
    return unified;
  }
  if (targetEol === "crlf") {
    return unified.replace(/\n/g, "\r\n");
  }
  if (targetEol === "cr") {
    return unified.replace(/\n/g, "\r");
  }
  return text;
}

function buildImmutableSavePlan(
  options: SaveNormalizationOptions,
  result: Omit<SaveNormalizationResult, "plan">,
  disposition: "ready" | "stale" | "failed" | "cancelled",
): ImmutableSavePlan {
  const planId = `save-plan-${sha256Hex(`${options.filePath || ""}:${options.text}:${Date.now()}`).slice(0, 16)}`;
  const identity = cloneAndFreeze<SavePlanIdentity>({
    text: options.text,
    document: options.documentIdentity ?? {
      uri: options.filePath ? (options.filePath.startsWith("file://") ? options.filePath : `file://${options.filePath}`) : "untitled:file",
      path: options.filePath,
      revision: options.expectedVersion ?? 0,
    },
    disk: options.diskIdentity,
    policy: options.savePolicy,
    style: options.codeStyle,
    provider: options.providerIdentity,
    project: options.projectIdentity,
    encoding: {
      charset: result.resolvedCharset ?? options.codeStyle.charset,
      bom: result.resolvedBom,
    },
  });

  return Object.freeze({
    planId,
    identity,
    initialHash: sha256Hex(options.text),
    finalHash: sha256Hex(result.text),
    finalText: result.text,
    stages: cloneAndFreeze(result.stages),
    disposition,
    cancelledDueToEdit: result.cancelledDueToEdit,
    encodingError: result.encodingError,
    diagnostics: cloneAndFreeze(result.diagnostics),
    resolvedEol: result.resolvedEol,
    resolvedCharset: result.resolvedCharset,
    resolvedBom: result.resolvedBom,
    createdAt: Date.now(),
  });
}

/** Clone plan inputs before freezing so a save cannot freeze caller-owned state. */
function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(source, clone);
    for (const item of value) clone.push(cloneAndFreeze(item, seen));
    return Object.freeze(clone) as unknown as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(source, clone);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneAndFreeze(child, seen);
  }
  return Object.freeze(clone) as T;
}

/**
 * Run the save normalization pipeline across 6 fixed stages in strict sequence (§ED-SAVE-001):
 * 1. format
 * 2. organize-imports
 * 3. trim
 * 4. final-newline
 * 5. eol
 * 6. charset-bom
 */
export async function runSaveNormalizationPipeline(
  options: SaveNormalizationOptions,
): Promise<SaveNormalizationResult> {
  const {
    text: initialText,
    codeStyle,
    formatOnSave = false,
    formatFn,
    getLatestBufferText,
    expectedVersion,
    getLatestBufferVersion,
  } = options;

  let currentText = initialText;
  let formatted = false;
  let importsOrganized = false;
  let whitespaceTrimmed = false;
  let newlineAdjusted = false;
  let eolNormalized = false;
  const diagnostics: string[] = [];
  const stages: SaveStageReport[] = [];
  let stopEffectful = false;

  const assemble = (
    data: {
      text: string;
      formatted?: boolean;
      importsOrganized?: boolean;
      whitespaceTrimmed?: boolean;
      newlineAdjusted?: boolean;
      eolNormalized?: boolean;
      cancelledDueToEdit: boolean;
      encodingError?: boolean;
      diagnostics: string[];
      stages: SaveStageReport[];
      resolvedEol?: "lf" | "crlf" | "cr";
      resolvedCharset?: string;
      resolvedBom?: boolean;
      disposition: "ready" | "stale" | "failed" | "cancelled";
    },
  ): SaveNormalizationResult => {
    const rawResult: Omit<SaveNormalizationResult, "plan"> = {
      text: data.text,
      formatted: data.formatted ?? false,
      importsOrganized: data.importsOrganized ?? false,
      whitespaceTrimmed: data.whitespaceTrimmed ?? false,
      newlineAdjusted: data.newlineAdjusted ?? false,
      eolNormalized: data.eolNormalized ?? false,
      cancelledDueToEdit: data.cancelledDueToEdit,
      encodingError: data.encodingError,
      diagnostics: data.diagnostics,
      stages: data.stages,
      resolvedEol: data.resolvedEol,
      resolvedCharset: data.resolvedCharset,
      resolvedBom: data.resolvedBom,
    };
    const plan = buildImmutableSavePlan(options, rawResult, data.disposition);
    return { ...rawResult, plan };
  };

  const formatEnabled = options.savePolicy
    ? options.savePolicy.format.enabled
    : (formatOnSave ?? false);
  const pathIsExcluded = options.savePolicy && options.filePath
    ? isPathExcluded(options.filePath, options.savePolicy.exclusions.patterns)
    : false;
  const markerOff = options.savePolicy?.exclusions.formatterMarkers
    ? containsDisabledFormatterMarker(currentText)
    : false;

  // Stage 1: format
  const formatBeforeHash = sha256Hex(currentText);
  if (!formatEnabled) {
    stages.push({ stage: "format", status: "disabled", reason: "format-disabled", beforeHash: formatBeforeHash, afterHash: formatBeforeHash });
  } else if (pathIsExcluded) {
    stages.push({ stage: "format", status: "disabled", reason: "path-excluded", beforeHash: formatBeforeHash, afterHash: formatBeforeHash });
  } else if (markerOff) {
    stages.push({ stage: "format", status: "disabled", reason: "formatter-marker-off", beforeHash: formatBeforeHash, afterHash: formatBeforeHash });
  } else if (!formatFn) {
    stages.push({ stage: "format", status: "unavailable", reason: "no-provider", beforeHash: formatBeforeHash, afterHash: formatBeforeHash });
  } else {
    try {
      const formattedResult = await formatFn(currentText);
      if (formattedResult !== null && formattedResult !== undefined) {
        if (getLatestBufferVersion && expectedVersion !== undefined) {
          const latestVer = getLatestBufferVersion();
          if (latestVer !== expectedVersion) {
            stages.push({ stage: "format", status: "stale", reason: "concurrent edit", beforeHash: formatBeforeHash, afterHash: formatBeforeHash });
            return assemble({
              text: initialText,
              cancelledDueToEdit: true,
              diagnostics: ["Formatter cancelled because buffer was modified concurrently."],
              stages,
              disposition: "stale",
            });
          }
        }
        const formatAfterHash = sha256Hex(formattedResult);
        formatted = formatAfterHash !== formatBeforeHash;
        currentText = formattedResult;
        stages.push({
          stage: "format",
          status: formatted ? "applied" : "executed",
          beforeHash: formatBeforeHash,
          afterHash: formatAfterHash,
        });
      } else {
        stages.push({ stage: "format", status: "unavailable", reason: "no-change-or-empty", beforeHash: formatBeforeHash, afterHash: formatBeforeHash });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`Format on save failed: ${msg}`);
      stages.push({ stage: "format", status: "failed", error: msg, beforeHash: formatBeforeHash, afterHash: formatBeforeHash });
      stopEffectful = true;
    }
  }

  // Stage 2: organize-imports
  const organizeImportsEnabled = options.savePolicy
    ? options.savePolicy.organizeImports.enabled
    : (options.organizeImportsOnSave ?? false);

  const organizeBeforeHash = sha256Hex(currentText);
  if (stopEffectful) {
    stages.push({
      stage: "organize-imports",
      status: "skipped-prior-failure",
      reason: "Skipped due to prior format failure",
      beforeHash: organizeBeforeHash,
      afterHash: organizeBeforeHash,
    });
  } else if (!organizeImportsEnabled) {
    stages.push({ stage: "organize-imports", status: "disabled", reason: "organize-imports-disabled", beforeHash: organizeBeforeHash, afterHash: organizeBeforeHash });
  } else if (!options.organizeImportsFn) {
    stages.push({ stage: "organize-imports", status: "unavailable", reason: "no-provider", beforeHash: organizeBeforeHash, afterHash: organizeBeforeHash });
  } else {
    try {
      const organizedResult = await options.organizeImportsFn(currentText);
      if (organizedResult !== null && organizedResult !== undefined) {
        if (getLatestBufferVersion && expectedVersion !== undefined) {
          const latestVer = getLatestBufferVersion();
          if (latestVer !== expectedVersion) {
            stages.push({ stage: "organize-imports", status: "stale", reason: "concurrent edit", beforeHash: organizeBeforeHash, afterHash: organizeBeforeHash });
            return assemble({
              text: initialText,
              formatted,
              cancelledDueToEdit: true,
              diagnostics: ["Organize imports cancelled because buffer was modified concurrently."],
              stages,
              disposition: "stale",
            });
          }
        }
        const organizeAfterHash = sha256Hex(organizedResult);
        importsOrganized = organizeAfterHash !== organizeBeforeHash;
        currentText = organizedResult;
        stages.push({
          stage: "organize-imports",
          status: importsOrganized ? "applied" : "executed",
          beforeHash: organizeBeforeHash,
          afterHash: organizeAfterHash,
        });
      } else {
        stages.push({ stage: "organize-imports", status: "unavailable", reason: "no-change-or-empty", beforeHash: organizeBeforeHash, afterHash: organizeBeforeHash });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`Organize imports on save failed: ${msg}`);
      stages.push({ stage: "organize-imports", status: "failed", error: msg, beforeHash: organizeBeforeHash, afterHash: organizeBeforeHash });
    }
  }

  // Stage 3: trim
  const trimBeforeHash = sha256Hex(currentText);
  if (codeStyle.trimTrailingWhitespace) {
    const trimmed = trimTrailingWhitespace(currentText);
    const trimAfterHash = sha256Hex(trimmed);
    whitespaceTrimmed = trimAfterHash !== trimBeforeHash;
    currentText = trimmed;
    stages.push({
      stage: "trim",
      status: whitespaceTrimmed ? "applied" : "executed",
      beforeHash: trimBeforeHash,
      afterHash: trimAfterHash,
    });
  } else {
    stages.push({ stage: "trim", status: "disabled", beforeHash: trimBeforeHash, afterHash: trimBeforeHash });
  }

  // Stage 4: final-newline
  const newlineBeforeHash = sha256Hex(currentText);
  if (codeStyle.insertFinalNewline !== undefined) {
    const adjusted = adjustFinalNewline(currentText, codeStyle.insertFinalNewline);
    const newlineAfterHash = sha256Hex(adjusted);
    newlineAdjusted = newlineAfterHash !== newlineBeforeHash;
    currentText = adjusted;
    stages.push({
      stage: "final-newline",
      status: newlineAdjusted ? "applied" : "executed",
      beforeHash: newlineBeforeHash,
      afterHash: newlineAfterHash,
    });
  } else {
    stages.push({ stage: "final-newline", status: "disabled", beforeHash: newlineBeforeHash, afterHash: newlineBeforeHash });
  }

  // Stage 5: eol
  const eolBeforeHash = sha256Hex(currentText);
  if (codeStyle.endOfLine) {
    const eolFixed = normalizeLineEndings(currentText, codeStyle.endOfLine);
    const eolAfterHash = sha256Hex(eolFixed);
    eolNormalized = eolAfterHash !== eolBeforeHash;
    currentText = eolFixed;
    stages.push({
      stage: "eol",
      status: eolNormalized ? "applied" : "executed",
      beforeHash: eolBeforeHash,
      afterHash: eolAfterHash,
    });
  } else {
    stages.push({ stage: "eol", status: "disabled", beforeHash: eolBeforeHash, afterHash: eolBeforeHash });
  }

  // Stage 6: charset-bom
  let resolvedCharset = codeStyle.charset;
  let resolvedBom: boolean | undefined = undefined;
  const charsetBeforeHash = sha256Hex(currentText);

  if (codeStyle.charset) {
    const charset = codeStyle.charset.toLowerCase();
    if (charset === "utf-8") {
      resolvedCharset = "UTF-8";
      resolvedBom = false;
      if (currentText.startsWith("\uFEFF")) {
        currentText = currentText.slice(1);
      }
      const charsetAfterHash = sha256Hex(currentText);
      stages.push({
        stage: "charset-bom",
        status: charsetAfterHash !== charsetBeforeHash ? "applied" : "executed",
        beforeHash: charsetBeforeHash,
        afterHash: charsetAfterHash,
      });
    } else if (charset === "utf-8-bom") {
      resolvedCharset = "UTF-8";
      resolvedBom = true;
      if (currentText.length > 0 && !currentText.startsWith("\uFEFF")) {
        currentText = `\uFEFF${currentText}`;
      }
      const charsetAfterHash = sha256Hex(currentText);
      stages.push({
        stage: "charset-bom",
        status: charsetAfterHash !== charsetBeforeHash ? "applied" : "executed",
        beforeHash: charsetBeforeHash,
        afterHash: charsetAfterHash,
      });
    } else if (charset === "latin1" || charset === "iso-8859-1") {
      resolvedCharset = "ISO-8859-1";
      let errorIndex = -1;
      for (let i = 0; i < currentText.length; i++) {
        if (currentText.charCodeAt(i) > 255) {
          errorIndex = i;
          break;
        }
      }
      if (errorIndex >= 0) {
        stages.push({
          stage: "charset-bom",
          status: "failed",
          error: "Latin-1 encoding error",
          beforeHash: charsetBeforeHash,
          afterHash: charsetBeforeHash,
        });
        return assemble({
          text: initialText, // live buffer effect 0!
          formatted: false,
          importsOrganized: false,
          whitespaceTrimmed: false,
          newlineAdjusted: false,
          eolNormalized: false,
          cancelledDueToEdit: false,
          encodingError: true,
          diagnostics: [`Save blocked: Character '${currentText[errorIndex]}' at position ${errorIndex} exceeds Latin-1 range (cannot be represented in Latin-1).`],
          stages,
          disposition: "failed",
        });
      } else {
        stages.push({
          stage: "charset-bom",
          status: "executed",
          beforeHash: charsetBeforeHash,
          afterHash: charsetBeforeHash,
        });
      }
    } else if (charset === "us-ascii" || charset === "ascii") {
      resolvedCharset = "US-ASCII";
      let errorIndex = -1;
      for (let i = 0; i < currentText.length; i++) {
        if (currentText.charCodeAt(i) > 127) {
          errorIndex = i;
          break;
        }
      }
      if (errorIndex >= 0) {
        stages.push({
          stage: "charset-bom",
          status: "failed",
          error: "US-ASCII encoding error",
          beforeHash: charsetBeforeHash,
          afterHash: charsetBeforeHash,
        });
        return assemble({
          text: initialText, // live buffer effect 0!
          formatted: false,
          importsOrganized: false,
          whitespaceTrimmed: false,
          newlineAdjusted: false,
          eolNormalized: false,
          cancelledDueToEdit: false,
          encodingError: true,
          diagnostics: [`Save blocked: Character '${currentText[errorIndex]}' at position ${errorIndex} exceeds ASCII range (cannot be represented in US-ASCII).`],
          stages,
          disposition: "failed",
        });
      } else {
        stages.push({
          stage: "charset-bom",
          status: "executed",
          beforeHash: charsetBeforeHash,
          afterHash: charsetBeforeHash,
        });
      }
    } else if (charset === "utf-16le" || charset === "utf-16be" || charset === "utf-16") {
      resolvedCharset = charset.toUpperCase();
      stages.push({
        stage: "charset-bom",
        status: "executed",
        beforeHash: charsetBeforeHash,
        afterHash: charsetBeforeHash,
      });
    }
  } else {
    stages.push({ stage: "charset-bom", status: "disabled", beforeHash: charsetBeforeHash, afterHash: charsetBeforeHash });
  }

  // Final race condition check
  if (getLatestBufferText) {
    const latestText = getLatestBufferText();
    if (latestText !== initialText && latestText !== currentText) {
      return assemble({
        text: latestText,
        formatted,
        importsOrganized,
        whitespaceTrimmed,
        newlineAdjusted,
        eolNormalized,
        cancelledDueToEdit: true,
        diagnostics: ["Normalization aborted due to newer buffer edits."],
        stages,
        disposition: "stale",
      });
    }
  }

  return assemble({
    text: currentText,
    formatted,
    importsOrganized,
    whitespaceTrimmed,
    newlineAdjusted,
    eolNormalized,
    cancelledDueToEdit: false,
    diagnostics,
    stages,
    resolvedEol: codeStyle.endOfLine,
    resolvedCharset,
    resolvedBom,
    disposition: "ready",
  });
}

/**
 * Pure helper to apply LSP text edits to an in-memory string without live buffer mutations (§8.26.5 AA4).
 */
export function applyLspTextEditsToString(
  text: string,
  edits: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[],
): string {
  if (!edits || edits.length === 0) return text;
  const lines = text.split("\n");
  const getOffset = (pos: { line: number; character: number }): number => {
    let offset = 0;
    const targetLine = Math.min(pos.line, lines.length);
    for (let i = 0; i < targetLine; i++) {
      offset += lines[i].length + 1; // +1 for '\n'
    }
    if (pos.line < lines.length) {
      offset += Math.min(pos.character, lines[pos.line].length);
    }
    return Math.min(offset, text.length);
  };

  const offsetEdits = edits.map((e) => ({
    start: getOffset(e.range.start),
    end: getOffset(e.range.end),
    newText: e.newText,
  }));

  // Sort descending by offset to apply from bottom-to-top
  offsetEdits.sort((a, b) => b.start - a.start || b.end - a.end);

  let result = text;
  for (const edit of offsetEdits) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

/**
 * §8.22.6 U2-D: Actions on Save Pipeline coordinator.
 */
export const WorkspaceSavePipeline = {
  run: runSaveNormalizationPipeline,
  trimTrailingWhitespace,
  adjustFinalNewline,
  normalizeLineEndings,
  applyLspTextEditsToString,
};
