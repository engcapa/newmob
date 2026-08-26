import {
  type WorkspaceCompletionPreferences,
  DEFAULT_WORKSPACE_COMPLETION_PREFERENCES,
  normalizeWorkspaceIntelligencePreferences,
} from "./intelligencePreferences";
import { LspCompletionController } from "./lspCompletion";

/**
 * §8.20.7 W6-E WorkspaceLspSessionManager coordinating live LSP sessions
 * and completion preferences. Synchronizes changes in real-time to LspCompletionController.
 */
export class WorkspaceLspSessionManager {
  private completionPreferences: WorkspaceCompletionPreferences;
  private readonly completionController: LspCompletionController;

  constructor(initialPreferences?: Partial<WorkspaceCompletionPreferences>) {
    const normalized = normalizeWorkspaceIntelligencePreferences({
      completion: initialPreferences ? { ...DEFAULT_WORKSPACE_COMPLETION_PREFERENCES, ...initialPreferences } : undefined,
    });
    this.completionPreferences = normalized.completion;
    this.completionController = new LspCompletionController(this.completionPreferences);
  }

  getCompletionPreferences(): WorkspaceCompletionPreferences {
    return { ...this.completionPreferences };
  }

  setCompletionPreferences(preferences: Partial<WorkspaceCompletionPreferences>): void {
    const normalized = normalizeWorkspaceIntelligencePreferences({
      completion: { ...this.completionPreferences, ...preferences },
    });
    this.completionPreferences = normalized.completion;
    this.completionController.setPreferences(this.completionPreferences);
  }

  getCompletionController(): LspCompletionController {
    return this.completionController;
  }
}
