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

export interface SaveNormalizationOptions {
  text: string;
  codeStyle: ResolvedCodeStyle | EffectiveCodeStyle;
  formatOnSave?: boolean;
  formatFn?: (text: string) => Promise<string | null>;
  getLatestBufferText?: () => string;
  expectedVersion?: number;
  getLatestBufferVersion?: () => number;
}

export interface SaveNormalizationResult {
  text: string;
  formatted: boolean;
  whitespaceTrimmed: boolean;
  newlineAdjusted: boolean;
  eolNormalized: boolean;
  cancelledDueToEdit: boolean;
  encodingError?: boolean;
  diagnostics: string[];
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

/**
 * Run the save normalization pipeline in strict sequence.
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
  let whitespaceTrimmed = false;
  let newlineAdjusted = false;
  let eolNormalized = false;
  const diagnostics: string[] = [];

  const explicitEol = codeStyle.endOfLine;
  const eolChar = explicitEol === "crlf" ? "\r\n" : explicitEol === "cr" ? "\r" : explicitEol === "lf" ? "\n" : undefined;

  // Detect if initial text had mismatched EOL
  if (codeStyle.endOfLine) {
    if (codeStyle.endOfLine === "lf" && currentText.includes("\r")) {
      eolNormalized = true;
    } else if (codeStyle.endOfLine === "crlf" && (/[^\r]\n/.test(currentText) || currentText.startsWith("\n"))) {
      eolNormalized = true;
    } else if (codeStyle.endOfLine === "cr" && currentText.includes("\n")) {
      eolNormalized = true;
    }
  }

  // Stage 1: Optional language formatter
  if (formatOnSave && formatFn) {
    try {
      const formattedResult = await formatFn(currentText);
      if (formattedResult !== null && formattedResult !== undefined) {
        // Check if concurrent edits occurred while formatter was running
        if (getLatestBufferVersion && expectedVersion !== undefined) {
          const latestVer = getLatestBufferVersion();
          if (latestVer !== expectedVersion) {
            return {
              text: initialText,
              formatted: false,
              whitespaceTrimmed: false,
              newlineAdjusted: false,
              eolNormalized: false,
              cancelledDueToEdit: true,
              diagnostics: ["Formatter cancelled because buffer was modified concurrently."],
            };
          }
        }
        currentText = formattedResult;
        formatted = true;
      }
    } catch (err) {
      diagnostics.push(`Format on save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Stage 2: Trim trailing whitespace
  if (codeStyle.trimTrailingWhitespace) {
    const trimmed = trimTrailingWhitespace(currentText, eolChar);
    if (trimmed !== currentText) {
      currentText = trimmed;
      whitespaceTrimmed = true;
    }
  }

  // Stage 3: Insert final newline
  if (codeStyle.insertFinalNewline !== undefined) {
    const adjusted = adjustFinalNewline(currentText, codeStyle.insertFinalNewline, eolChar);
    if (adjusted !== currentText) {
      currentText = adjusted;
      newlineAdjusted = true;
    }
  }

  // Stage 4: End of Line normalization
  if (codeStyle.endOfLine) {
    const normalized = normalizeLineEndings(currentText, codeStyle.endOfLine);
    if (normalized !== currentText) {
      currentText = normalized;
      eolNormalized = true;
    }
  }

  // Stage 5: Charset / BOM verification & normalization
  if (codeStyle.charset) {
    const charset = codeStyle.charset.toLowerCase();
    if (charset === "utf-8") {
      // Ensure no BOM prefix for standard utf-8
      if (currentText.startsWith("\uFEFF")) {
        currentText = currentText.slice(1);
      }
    } else if (charset === "utf-8-bom") {
      // Ensure BOM prefix for utf-8-bom if non-empty
      if (currentText.length > 0 && !currentText.startsWith("\uFEFF")) {
        currentText = `\uFEFF${currentText}`;
      }
    } else if (charset === "latin1") {
      for (let i = 0; i < currentText.length; i++) {
        const code = currentText.charCodeAt(i);
        if (code > 255) {
          return {
            text: initialText,
            formatted: false,
            whitespaceTrimmed: false,
            newlineAdjusted: false,
            eolNormalized: false,
            cancelledDueToEdit: false,
            encodingError: true,
            diagnostics: [`Save blocked: Character '${currentText[i]}' at position ${i} exceeds Latin-1 range (cannot be represented in Latin-1).`],
          };
        }
      }
    }
  }

  // Final race condition check
  if (getLatestBufferText) {
    const latestText = getLatestBufferText();
    // If buffer was changed while pipeline was running (and not equal to our input text)
    if (latestText !== initialText && latestText !== currentText) {
      return {
        text: latestText,
        formatted,
        whitespaceTrimmed,
        newlineAdjusted,
        eolNormalized,
        cancelledDueToEdit: true,
        diagnostics: ["Normalization aborted due to newer buffer edits."],
      };
    }
  }

  return {
    text: currentText,
    formatted,
    whitespaceTrimmed,
    newlineAdjusted,
    eolNormalized,
    cancelledDueToEdit: false,
    diagnostics,
  };
}
