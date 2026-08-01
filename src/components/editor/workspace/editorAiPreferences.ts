// Per-workspace preferences for the editor's AI selection actions.
//
// Mirrors `intelligencePreferences.ts`: localStorage-backed, keyed by workspace
// instance, and tolerant of missing or corrupt payloads so a bad value can
// never keep the workspace from opening.
//
// `answerLanguage` defaults to `inherit`, which follows the global default in
// Settings → AI. A stored value other than `inherit` means the user pinned this
// one workspace, and the global setting no longer moves it.

import {
  nextAnswerLanguage,
  normalizeAnswerLanguage,
  type AiAnswerLanguage,
} from "../../../lib/ai/answerLanguage";

export { nextAnswerLanguage };

export interface EditorAiPreferences {
  /** Language the AI should answer in. `inherit` follows the global default. */
  answerLanguage: AiAnswerLanguage;
}

export const DEFAULT_EDITOR_AI_PREFERENCES: EditorAiPreferences = {
  answerLanguage: "inherit",
};

function storageKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.editorAi.v1.${workspaceInstanceId}`;
}

export function readEditorAiPreferences(workspaceInstanceId: string): EditorAiPreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(workspaceInstanceId)) ?? "null") as
      Partial<EditorAiPreferences> | null;
    if (!parsed) return { ...DEFAULT_EDITOR_AI_PREFERENCES };
    return { answerLanguage: normalizeAnswerLanguage(parsed.answerLanguage) };
  } catch {
    return { ...DEFAULT_EDITOR_AI_PREFERENCES };
  }
}

export function writeEditorAiPreferences(
  workspaceInstanceId: string,
  preferences: EditorAiPreferences,
): void {
  try {
    window.localStorage.setItem(storageKey(workspaceInstanceId), JSON.stringify(preferences));
  } catch {
    // Ignore storage failures — the preference is a convenience, not state we
    // can block the editor on.
  }
}
