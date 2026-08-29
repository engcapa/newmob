export interface CompareDocumentDescriptor {
  title: string;
  path?: string;
  text: string;
  encoding?: string;
  eol?: string;
  readOnly?: boolean;
}

export interface EditorCompareSession {
  id: string;
  title: string;
  left: CompareDocumentDescriptor;
  right: CompareDocumentDescriptor;
  diffWhitespaceMode?: "all" | "trim" | "ignore-all";
}

export interface CompareValidationResult {
  valid: boolean;
  reason?: string;
}

const MAX_COMPARE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB limit

/**
 * Validates whether text is eligible for text diffing (non-binary and within safe size limits).
 */
export function validateCompareEligibility(text: string, title: string): CompareValidationResult {
  if (text.length > MAX_COMPARE_SIZE_BYTES) {
    return {
      valid: false,
      reason: `"${title}" exceeds the 2MB comparison limit.`,
    };
  }
  // Check for null bytes indicative of binary payload
  if (text.includes("\0")) {
    return {
      valid: false,
      reason: `"${title}" contains binary content and cannot be compared as text.`,
    };
  }
  return { valid: true };
}

/**
 * Creates a compare session between an active file buffer and clipboard text.
 */
export function createClipboardCompareSession(
  fileName: string,
  filePath: string,
  fileText: string,
  clipboardText: string,
  selectedText?: string,
): { session: EditorCompareSession | null; error?: string } {
  const leftValidation = validateCompareEligibility(clipboardText, "Clipboard");
  if (!leftValidation.valid) {
    return { session: null, error: leftValidation.reason };
  }
  const rightText = selectedText && selectedText.length > 0 ? selectedText : fileText;
  const rightTitle = selectedText && selectedText.length > 0 ? `${fileName} (Selection)` : fileName;
  const rightValidation = validateCompareEligibility(rightText, rightTitle);
  if (!rightValidation.valid) {
    return { session: null, error: rightValidation.reason };
  }

  return {
    session: {
      id: `compare:clipboard:${Date.now()}`,
      title: `Compare "${rightTitle}" with Clipboard`,
      left: {
        title: "Clipboard",
        text: clipboardText,
        readOnly: true,
      },
      right: {
        title: rightTitle,
        path: filePath,
        text: rightText,
        readOnly: false,
      },
    },
  };
}

/**
 * Creates a compare session between two files.
 */
export function createFileCompareSession(
  left: CompareDocumentDescriptor,
  right: CompareDocumentDescriptor,
): { session: EditorCompareSession | null; error?: string } {
  const leftValidation = validateCompareEligibility(left.text, left.title);
  if (!leftValidation.valid) return { session: null, error: leftValidation.reason };

  const rightValidation = validateCompareEligibility(right.text, right.title);
  if (!rightValidation.valid) return { session: null, error: rightValidation.reason };

  return {
    session: {
      id: `compare:files:${Date.now()}`,
      title: `Compare "${left.title}" ↔ "${right.title}"`,
      left,
      right,
    },
  };
}
