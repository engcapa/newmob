export type CompareSource = "clipboard" | "file" | "local-history" | "buffer";

export type CompareUnavailableReason =
  | "binary"
  | "oversized"
  | "read-failed"
  | "no-history"
  | "unsupported";

export interface ComparePosition {
  line: number;
  character: number;
}

export interface CompareSelection {
  start: ComparePosition;
  end: ComparePosition;
  text: string;
}

export interface CompareUnavailable {
  reason: CompareUnavailableReason;
  message: string;
}

export interface CompareDocumentDescriptor {
  title: string;
  path?: string;
  text: string;
  encoding?: string;
  eol?: string;
  bom?: boolean;
  sizeBytes?: number;
  source?: CompareSource;
  readOnly?: boolean;
  unavailable?: CompareUnavailable;
}

export interface CompareTarget {
  fileKey: string;
  documentRevision: number;
  expectedText: string;
  selection?: CompareSelection;
}

export interface EditorCompareSession {
  id: string;
  title: string;
  source?: CompareSource;
  left: CompareDocumentDescriptor;
  right: CompareDocumentDescriptor;
  target?: CompareTarget;
  diffWhitespaceMode?: "all" | "trim" | "ignore-all";
}

export interface CompareValidationResult {
  valid: boolean;
  reason?: string;
  unavailable?: CompareUnavailable;
}

export const MAX_COMPARE_SIZE_BYTES = 2 * 1024 * 1024;

let compareSessionSequence = 0;

function nextCompareSessionId(source: CompareSource): string {
  compareSessionSequence += 1;
  return `compare:${source}:${Date.now()}:${compareSessionSequence}`;
}

function encodedByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function compareTextByteLength(text: string): number {
  return encodedByteLength(text);
}

export function detectCompareEol(text: string): "LF" | "CRLF" | "CR" {
  if (text.includes("\r\n")) return "CRLF";
  if (text.includes("\r")) return "CR";
  return "LF";
}

export function normalizeCompareText(text: string): string {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hasSelection(selection: CompareSelection | undefined): boolean {
  if (!selection) return false;
  return selection.start.line !== selection.end.line
    || selection.start.character !== selection.end.character;
}

function selectionFromInput(
  selection: string | CompareSelection | undefined,
): CompareSelection | undefined {
  if (typeof selection === "string") return undefined;
  if (!selection || !hasSelection(selection)) return undefined;
  return {
    start: { ...selection.start },
    end: { ...selection.end },
    text: selection.text,
  };
}

export function compareDocumentDescriptor(
  descriptor: CompareDocumentDescriptor,
): CompareDocumentDescriptor {
  if (descriptor.unavailable) {
    return { ...descriptor, readOnly: descriptor.readOnly ?? true };
  }
  const normalizedText = normalizeCompareText(descriptor.text);
  return {
    ...descriptor,
    text: normalizedText,
    eol: descriptor.eol ?? detectCompareEol(descriptor.text),
    sizeBytes: descriptor.sizeBytes ?? encodedByteLength(descriptor.text),
  };
}

export function unavailableCompareDescriptor(
  title: string,
  source: CompareSource,
  reason: CompareUnavailableReason,
  message: string,
  path?: string,
): CompareDocumentDescriptor {
  return {
    title,
    path,
    text: "",
    source,
    readOnly: true,
    unavailable: { reason, message },
  };
}

/**
 * Validates text against the diff surface's encoded-byte and binary limits.
 * The byte check deliberately uses UTF-8 bytes rather than JavaScript code
 * units, so non-ASCII content cannot exceed the native limit unnoticed.
 */
export function validateCompareEligibility(text: string, title: string): CompareValidationResult {
  const sizeBytes = encodedByteLength(text);
  if (sizeBytes > MAX_COMPARE_SIZE_BYTES) {
    return {
      valid: false,
      unavailable: {
        reason: "oversized",
        message: `"${title}" exceeds the 2MB comparison limit (${sizeBytes} bytes).`,
      },
      reason: `"${title}" exceeds the 2MB comparison limit (${sizeBytes} bytes).`,
    };
  }
  if (text.includes("\0")) {
    return {
      valid: false,
      unavailable: {
        reason: "binary",
        message: `"${title}" contains binary content and cannot be compared as text.`,
      },
      reason: `"${title}" contains binary content and cannot be compared as text.`,
    };
  }
  return { valid: true };
}

/** Create a typed unavailable session while keeping the common diff surface mounted. */
export function createUnavailableCompareSession(options: {
  source: CompareSource;
  title: string;
  unavailableTitle: string;
  reason: CompareUnavailableReason;
  message: string;
  right: CompareDocumentDescriptor;
  target?: CompareTarget;
}): EditorCompareSession {
  return {
    id: nextCompareSessionId(options.source),
    title: options.title,
    source: options.source,
    left: unavailableCompareDescriptor(
      options.unavailableTitle,
      options.source,
      options.reason,
      options.message,
    ),
    right: compareDocumentDescriptor(options.right),
    target: options.target,
  };
}

export function classifyCompareReadError(error: unknown): CompareUnavailable {
  const message = error instanceof Error ? error.message : String(error);
  if (/binary|decoded|data loss/i.test(message)) {
    return { reason: "binary", message };
  }
  if (/exceed|too large|limit|maximum|oversized/i.test(message)) {
    return { reason: "oversized", message };
  }
  return { reason: "read-failed", message };
}

/** Creates a compare session between an active buffer and clipboard text. */
export function createClipboardCompareSession(
  fileName: string,
  filePath: string,
  fileText: string,
  clipboardText: string,
  selectedText?: string | CompareSelection,
  target?: CompareTarget,
): { session: EditorCompareSession | null; error?: string } {
  const leftValidation = validateCompareEligibility(clipboardText, "Clipboard");
  if (!leftValidation.valid) return { session: null, error: leftValidation.reason };

  const selection = selectionFromInput(selectedText);
  const stringSelection = typeof selectedText === "string" && selectedText.length > 0
    ? selectedText
    : null;
  const rightText = selection?.text ?? stringSelection ?? fileText;
  const rightTitle = selection || stringSelection ? `${fileName} (Selection)` : fileName;
  const rightValidation = validateCompareEligibility(rightText, rightTitle);
  if (!rightValidation.valid) return { session: null, error: rightValidation.reason };

  return {
    session: {
      id: nextCompareSessionId("clipboard"),
      source: "clipboard",
      title: `Compare "${rightTitle}" with Clipboard`,
      left: compareDocumentDescriptor({
        title: "Clipboard",
        text: clipboardText,
        source: "clipboard",
        readOnly: true,
      }),
      right: compareDocumentDescriptor({
        title: rightTitle,
        path: filePath,
        text: rightText,
        source: "buffer",
        readOnly: false,
      }),
      target: target
        ? { ...target, selection: selection ?? target.selection }
        : undefined,
    },
  };
}

/** Creates a compare session between two text descriptors. */
export function createFileCompareSession(
  left: CompareDocumentDescriptor,
  right: CompareDocumentDescriptor,
  target?: CompareTarget,
): { session: EditorCompareSession | null; error?: string } {
  const normalizedLeft = compareDocumentDescriptor(left);
  const normalizedRight = compareDocumentDescriptor(right);
  if (!normalizedLeft.unavailable) {
    const leftValidation = validateCompareEligibility(normalizedLeft.text, normalizedLeft.title);
    if (!leftValidation.valid) return { session: null, error: leftValidation.reason };
  }
  if (!normalizedRight.unavailable) {
    const rightValidation = validateCompareEligibility(normalizedRight.text, normalizedRight.title);
    if (!rightValidation.valid) return { session: null, error: rightValidation.reason };
  }

  return {
    session: {
      id: nextCompareSessionId("file"),
      source: left.source === "local-history" ? "local-history" : "file",
      title: `Compare "${normalizedLeft.title}" ↔ "${normalizedRight.title}"`,
      left: normalizedLeft,
      right: normalizedRight,
      target,
    },
  };
}
