/**
 * Large-file downgrade guard (M6-B). Above these thresholds the workspace stops
 * requesting the per-edit "feature storm" — semantic tokens (full document),
 * inlay hints (viewport), and document highlight — and their decoration rebuilds,
 * which are the dominant source of jank on big files. Lezer syntax highlighting and
 * on-demand features (completion / hover / go-to) stay available.
 */

/** ~1.5 MB of UTF-16 code units (≈ bytes for ASCII-heavy source). */
export const LARGE_FILE_CHAR_THRESHOLD = 1_500_000;
/** Line count above which even a small-byte file (many short lines) downgrades. */
export const LARGE_FILE_LINE_THRESHOLD = 20_000;

/**
 * True when `text` should run in large-file mode. Cheap path first: the byte
 * threshold is O(1); the line scan only runs for files under the byte cap and is
 * bounded (stops as soon as the line threshold is crossed).
 */
export function isLargeFileContent(text: string): boolean {
  if (text.length > LARGE_FILE_CHAR_THRESHOLD) return true;
  let lines = 1;
  let index = text.indexOf("\n");
  while (index !== -1) {
    lines += 1;
    if (lines > LARGE_FILE_LINE_THRESHOLD) return true;
    index = text.indexOf("\n", index + 1);
  }
  return false;
}
