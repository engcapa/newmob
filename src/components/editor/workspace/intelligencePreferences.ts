export interface WorkspaceIntelligencePreferences {
  inlayHintsEnabled: boolean;
  inlayHintLanguages: Record<string, boolean>;
  inlineBlameEnabled: boolean;
  formatOnSave: boolean;
  stickyLinesEnabled: boolean;
}

export const DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES: WorkspaceIntelligencePreferences = {
  inlayHintsEnabled: false,
  inlayHintLanguages: {},
  inlineBlameEnabled: false,
  formatOnSave: false,
  stickyLinesEnabled: true,
};

function storageKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.intelligence.v1.${workspaceInstanceId}`;
}

export function readWorkspaceIntelligencePreferences(
  workspaceInstanceId: string,
): WorkspaceIntelligencePreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(workspaceInstanceId)) ?? "null") as
      Partial<WorkspaceIntelligencePreferences> | null;
    if (!parsed) return { ...DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES };
    return {
      inlayHintsEnabled: parsed.inlayHintsEnabled === true,
      inlayHintLanguages: parsed.inlayHintLanguages && typeof parsed.inlayHintLanguages === "object"
        ? Object.fromEntries(Object.entries(parsed.inlayHintLanguages).filter(([, enabled]) => typeof enabled === "boolean"))
        : {},
      inlineBlameEnabled: parsed.inlineBlameEnabled === true,
      formatOnSave: parsed.formatOnSave === true,
      stickyLinesEnabled: parsed.stickyLinesEnabled !== false,
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES };
  }
}

export function writeWorkspaceIntelligencePreferences(
  workspaceInstanceId: string,
  preferences: WorkspaceIntelligencePreferences,
): void {
  window.localStorage.setItem(storageKey(workspaceInstanceId), JSON.stringify(preferences));
}

export function inlayHintsEnabledForLanguage(
  preferences: WorkspaceIntelligencePreferences,
  languageId: string | null | undefined,
): boolean {
  if (!preferences.inlayHintsEnabled) return false;
  if (!languageId) return true;
  return preferences.inlayHintLanguages[languageId] !== false;
}
