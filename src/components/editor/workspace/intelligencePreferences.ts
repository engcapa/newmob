export type QuickDocDefaultTarget = "popup" | "tool-window";

export interface WorkspaceParameterInfoPreferences {
  autoPopup: boolean;
  delayMs: number;
  showFullSignatures: boolean;
}

export interface WorkspaceQuickDocPreferences {
  showOnHover: boolean;
  hoverDelayMs: number;
  defaultTarget: QuickDocDefaultTarget;
}

export type CompletionCaseMatching = "first-letter" | "all" | "none";
export type CompletionSortMode = "provider-relevance" | "alphabetical";

export interface SymbolPatternRule {
  pattern: string;
  scope: "project" | "global";
}

export interface WorkspaceCompletionPreferences {
  autoTrigger: boolean;
  triggerDelayMs: number;
  minPrefixLength: number;
  maxItems: number;
  showDocumentation: boolean;
  documentationDelayMs: number;
  caseMatching: CompletionCaseMatching;
  sortMode: CompletionSortMode;
  autoInsertSingle: boolean;
  excludedSymbols: readonly SymbolPatternRule[];
  prioritizedSymbols: readonly SymbolPatternRule[];
}

export interface BasicCompletionPolicyV2 {
  autoPopup: boolean;
  delayMs: number;
  caseMatching: CompletionCaseMatching;
  sortMode: CompletionSortMode;
  autoInsertSingle: boolean;
  excludedSymbols: readonly SymbolPatternRule[];
  prioritizedSymbols: readonly SymbolPatternRule[];
  maxVisibleItems: number;
  documentation: { enabled: boolean; delayMs: number };
}

export interface WorkspaceIntelligencePreferences {
  inlayHintsEnabled: boolean;
  inlayHintLanguages: Record<string, boolean>;
  inlineBlameEnabled: boolean;
  formatOnSave: boolean;
  stickyLinesEnabled: boolean;
  parameterInfo: WorkspaceParameterInfoPreferences;
  quickDoc: WorkspaceQuickDocPreferences;
  completion: WorkspaceCompletionPreferences;
}

export const DEFAULT_WORKSPACE_COMPLETION_PREFERENCES: WorkspaceCompletionPreferences = {
  autoTrigger: true,
  triggerDelayMs: 50,
  minPrefixLength: 1,
  maxItems: 50,
  showDocumentation: true,
  documentationDelayMs: 250,
  caseMatching: "first-letter",
  sortMode: "provider-relevance",
  autoInsertSingle: false,
  excludedSymbols: [],
  prioritizedSymbols: [],
};

export const DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES: WorkspaceIntelligencePreferences = {
  inlayHintsEnabled: false,
  inlayHintLanguages: {},
  inlineBlameEnabled: false,
  formatOnSave: false,
  stickyLinesEnabled: true,
  parameterInfo: {
    autoPopup: true,
    delayMs: 0,
    showFullSignatures: false,
  },
  quickDoc: {
    showOnHover: true,
    hoverDelayMs: 300,
    defaultTarget: "popup",
  },
  completion: DEFAULT_WORKSPACE_COMPLETION_PREFERENCES,
};

const MAX_INTELLIGENCE_DELAY_MS = 5_000;

function normalizedDelay(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_INTELLIGENCE_DELAY_MS, Math.max(0, Math.round(value)));
}

function storageKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.intelligence.v1.${workspaceInstanceId}`;
}

export function normalizeWorkspaceIntelligencePreferences(
  value: Partial<WorkspaceIntelligencePreferences> | null | undefined,
): WorkspaceIntelligencePreferences {
  const parameterInfo = value?.parameterInfo;
  const quickDoc = value?.quickDoc;
  return {
    inlayHintsEnabled: value?.inlayHintsEnabled === true,
    inlayHintLanguages: value?.inlayHintLanguages && typeof value.inlayHintLanguages === "object"
      ? Object.fromEntries(Object.entries(value.inlayHintLanguages).filter(([, enabled]) => typeof enabled === "boolean"))
      : {},
    inlineBlameEnabled: value?.inlineBlameEnabled === true,
    formatOnSave: value?.formatOnSave === true,
    stickyLinesEnabled: value?.stickyLinesEnabled !== false,
    parameterInfo: {
      autoPopup: parameterInfo?.autoPopup !== false,
      delayMs: normalizedDelay(
        parameterInfo?.delayMs,
        DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES.parameterInfo.delayMs,
      ),
      showFullSignatures: parameterInfo?.showFullSignatures === true,
    },
    quickDoc: {
      showOnHover: quickDoc?.showOnHover !== false,
      hoverDelayMs: normalizedDelay(
        quickDoc?.hoverDelayMs,
        DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES.quickDoc.hoverDelayMs,
      ),
      defaultTarget: quickDoc?.defaultTarget === "tool-window" ? "tool-window" : "popup",
    },
    completion: {
      autoTrigger: value?.completion?.autoTrigger !== false,
      triggerDelayMs: normalizedDelay(
        value?.completion?.triggerDelayMs,
        DEFAULT_WORKSPACE_COMPLETION_PREFERENCES.triggerDelayMs,
      ),
      minPrefixLength: Math.min(
        10,
        Math.max(
          0,
          Math.round(
            Number(value?.completion?.minPrefixLength ?? DEFAULT_WORKSPACE_COMPLETION_PREFERENCES.minPrefixLength),
          ),
        ),
      ),
      maxItems: Math.min(
        200,
        Math.max(
          1,
          Math.round(
            Number(value?.completion?.maxItems ?? DEFAULT_WORKSPACE_COMPLETION_PREFERENCES.maxItems),
          ),
        ),
      ),
      showDocumentation: value?.completion?.showDocumentation !== false,
      documentationDelayMs: normalizedDelay(
        value?.completion?.documentationDelayMs,
        DEFAULT_WORKSPACE_COMPLETION_PREFERENCES.documentationDelayMs,
      ),
      caseMatching: (value?.completion?.caseMatching === "all" || value?.completion?.caseMatching === "none")
        ? value.completion.caseMatching
        : "first-letter",
      sortMode: value?.completion?.sortMode === "alphabetical"
        ? "alphabetical"
        : "provider-relevance",
      autoInsertSingle: value?.completion?.autoInsertSingle === true,
      excludedSymbols: Array.isArray(value?.completion?.excludedSymbols)
        ? value.completion.excludedSymbols
            .filter((s): s is SymbolPatternRule => typeof s?.pattern === "string" && s.pattern.trim().length > 0)
            .map((s) => ({ pattern: s.pattern.trim(), scope: s.scope === "project" ? "project" : "global" }))
        : [],
      prioritizedSymbols: Array.isArray(value?.completion?.prioritizedSymbols)
        ? value.completion.prioritizedSymbols
            .filter((s): s is SymbolPatternRule => typeof s?.pattern === "string" && s.pattern.trim().length > 0)
            .map((s) => ({ pattern: s.pattern.trim(), scope: s.scope === "project" ? "project" : "global" }))
        : [],
    },
  };
}

export function toBasicCompletionPolicyV2(
  prefs?: Partial<WorkspaceCompletionPreferences> | null,
): BasicCompletionPolicyV2 {
  return {
    autoPopup: prefs?.autoTrigger !== false,
    delayMs: prefs?.triggerDelayMs ?? 50,
    caseMatching: (prefs?.caseMatching === "all" || prefs?.caseMatching === "none") ? prefs.caseMatching : "first-letter",
    sortMode: prefs?.sortMode === "alphabetical" ? "alphabetical" : "provider-relevance",
    autoInsertSingle: prefs?.autoInsertSingle === true,
    excludedSymbols: prefs?.excludedSymbols ?? [],
    prioritizedSymbols: prefs?.prioritizedSymbols ?? [],
    maxVisibleItems: prefs?.maxItems ?? 50,
    documentation: {
      enabled: prefs?.showDocumentation !== false,
      delayMs: prefs?.documentationDelayMs ?? 250,
    },
  };
}

export function readWorkspaceIntelligencePreferences(
  workspaceInstanceId: string,
): WorkspaceIntelligencePreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(workspaceInstanceId)) ?? "null") as
      Partial<WorkspaceIntelligencePreferences> | null;
    return normalizeWorkspaceIntelligencePreferences(parsed);
  } catch {
    return normalizeWorkspaceIntelligencePreferences(null);
  }
}

export function writeWorkspaceIntelligencePreferences(
  workspaceInstanceId: string,
  preferences: WorkspaceIntelligencePreferences,
): WorkspaceIntelligencePreferences {
  const normalized = normalizeWorkspaceIntelligencePreferences(preferences);
  try {
    window.localStorage.setItem(storageKey(workspaceInstanceId), JSON.stringify(normalized));
  } catch {
    // Persistence is best-effort; the live workspace must remain usable.
  }
  return normalized;
}

export function inlayHintsEnabledForLanguage(
  preferences: WorkspaceIntelligencePreferences,
  languageId: string | null | undefined,
): boolean {
  if (!preferences.inlayHintsEnabled) return false;
  if (!languageId) return true;
  return preferences.inlayHintLanguages[languageId] !== false;
}
