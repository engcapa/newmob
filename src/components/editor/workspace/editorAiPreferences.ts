// Per-workspace preferences for the editor's AI selection actions.
//
// Mirrors `intelligencePreferences.ts`: localStorage-backed, keyed by workspace
// instance, and tolerant of missing or corrupt payloads so a bad value can
// never keep the workspace from opening.

import { AI_ANSWER_LANGUAGES, type AiAnswerLanguage } from "./editorAiPrompts";

export interface EditorAiPreferences {
  /** Language the AI should answer in. `auto` follows the app locale. */
  answerLanguage: AiAnswerLanguage;
}

export const DEFAULT_EDITOR_AI_PREFERENCES: EditorAiPreferences = {
  answerLanguage: "auto",
};

function storageKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.editorAi.v1.${workspaceInstanceId}`;
}

function normalizeAnswerLanguage(value: unknown): AiAnswerLanguage {
  return AI_ANSWER_LANGUAGES.includes(value as AiAnswerLanguage)
    ? value as AiAnswerLanguage
    : DEFAULT_EDITOR_AI_PREFERENCES.answerLanguage;
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

/** Next value in the Auto → 中文 → English cycle. */
export function nextAnswerLanguage(current: AiAnswerLanguage): AiAnswerLanguage {
  const index = AI_ANSWER_LANGUAGES.indexOf(current);
  return AI_ANSWER_LANGUAGES[(index + 1) % AI_ANSWER_LANGUAGES.length];
}
