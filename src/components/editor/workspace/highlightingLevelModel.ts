export type HighlightingLevel = "none" | "syntax" | "all";

const HIGHLIGHTING_LEVEL_STORAGE_PREFIX = "taomni.codeWorkspace.highlightingLevel.v1.";

/**
 * Reads persisted highlighting level for a file in a workspace instance.
 * Defaults to "all" (All Problems).
 */
export function readHighlightingLevel(workspaceInstanceId: string, fileKey: string): HighlightingLevel {
  if (typeof window === "undefined" || !workspaceInstanceId || !fileKey) return "all";
  try {
    const raw = window.localStorage.getItem(`${HIGHLIGHTING_LEVEL_STORAGE_PREFIX}${workspaceInstanceId}:${fileKey}`);
    if (raw === "none" || raw === "syntax" || raw === "all") {
      return raw;
    }
  } catch {
    // ignore storage exceptions
  }
  return "all";
}

/**
 * Persists highlighting level for a file in a workspace instance.
 */
export function writeHighlightingLevel(
  workspaceInstanceId: string,
  fileKey: string,
  level: HighlightingLevel,
): void {
  if (typeof window === "undefined" || !workspaceInstanceId || !fileKey) return;
  try {
    window.localStorage.setItem(`${HIGHLIGHTING_LEVEL_STORAGE_PREFIX}${workspaceInstanceId}:${fileKey}`, level);
  } catch {
    // ignore storage exceptions
  }
}
