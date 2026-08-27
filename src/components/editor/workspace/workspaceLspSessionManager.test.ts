import { describe, expect, it } from "vitest";
import { WorkspaceLspSessionManager } from "./workspaceLspSessionManager";

describe("§8.20.7 W6-E WorkspaceLspSessionManager & LspCompletionController", () => {
  it("initializes with default completion preferences and exposes controller", () => {
    const manager = new WorkspaceLspSessionManager();
    const controller = manager.getCompletionController();
    const prefs = manager.getCompletionPreferences();

    expect(prefs.autoTrigger).toBe(true);
    expect(prefs.triggerDelayMs).toBe(50);
    expect(prefs.minPrefixLength).toBe(1);
    expect(prefs.maxItems).toBe(50);
    expect(prefs.showDocumentation).toBe(true);
    expect(prefs.documentationDelayMs).toBe(250);

    expect(controller.shouldAutoTrigger(1, false)).toBe(true);
    expect(controller.shouldAutoTrigger(0, false)).toBe(false);
    expect(controller.shouldAutoTrigger(0, true)).toBe(true); // explicit always triggers
    expect(controller.getMaxItems()).toBe(50);
    expect(controller.shouldShowDocumentation()).toBe(true);
  });

  it("synchronizes preferences in real-time and takes effect immediately on next trigger", () => {
    const manager = new WorkspaceLspSessionManager();
    const controller = manager.getCompletionController();

    // Disable autoTrigger
    manager.setCompletionPreferences({ autoTrigger: false });
    expect(controller.shouldAutoTrigger(5, false)).toBe(false);
    expect(controller.shouldAutoTrigger(5, true)).toBe(true); // explicit still triggers

    // Re-enable autoTrigger with minPrefixLength = 3
    manager.setCompletionPreferences({ autoTrigger: true, minPrefixLength: 3 });
    expect(controller.shouldAutoTrigger(2, false)).toBe(false);
    expect(controller.shouldAutoTrigger(3, false)).toBe(true);
    expect(controller.shouldAutoTrigger(4, false)).toBe(true);

    // Update maxItems and showDocumentation
    manager.setCompletionPreferences({ maxItems: 120, showDocumentation: false });
    expect(controller.getMaxItems()).toBe(120);
    expect(controller.shouldShowDocumentation()).toBe(false);

    // Update delays
    manager.setCompletionPreferences({ triggerDelayMs: 200, documentationDelayMs: 600 });
    expect(controller.getTriggerDelayMs()).toBe(200);
    expect(controller.getDocumentationDelayMs()).toBe(600);
  });

  it("clamps invalid or out-of-range preference values", () => {
    const manager = new WorkspaceLspSessionManager();
    const controller = manager.getCompletionController();

    manager.setCompletionPreferences({
      triggerDelayMs: 999_999, // clamped to 5000
      minPrefixLength: -10,   // clamped to 0
      maxItems: 999,          // clamped to 200
      documentationDelayMs: -50, // clamped to 0
    });

    expect(controller.getTriggerDelayMs()).toBe(5_000);
    expect(controller.shouldAutoTrigger(0, false)).toBe(true); // minPrefixLength is 0
    expect(controller.getMaxItems()).toBe(200);
    expect(controller.getDocumentationDelayMs()).toBe(0);
  });

  it("§8.21.3 V2-E: configures BasicCompletionPolicyV2 caseMatching, sortMode, exclusions, and autoInsertSingle", () => {
    const manager = new WorkspaceLspSessionManager();
    const controller = manager.getCompletionController();

    manager.setCompletionPreferences({
      caseMatching: "all",
      sortMode: "alphabetical",
      autoInsertSingle: true,
      excludedSymbols: [{ pattern: "java.awt.*", scope: "project" }],
      prioritizedSymbols: [{ pattern: "java.util.*", scope: "global" }],
    });

    expect(controller.getCaseMatching()).toBe("all");
    expect(controller.getSortMode()).toBe("alphabetical");
    expect(controller.getAutoInsertSingle()).toBe(true);
    expect(controller.getExcludedSymbols()).toEqual([{ pattern: "java.awt.*", scope: "project" }]);
    expect(controller.getPrioritizedSymbols()).toEqual([{ pattern: "java.util.*", scope: "global" }]);

    const policy = controller.getPolicy();
    expect(policy.caseMatching).toBe("all");
    expect(policy.sortMode).toBe("alphabetical");
    expect(policy.autoInsertSingle).toBe(true);
    expect(policy.excludedSymbols).toEqual([{ pattern: "java.awt.*", scope: "project" }]);
    expect(policy.prioritizedSymbols).toEqual([{ pattern: "java.util.*", scope: "global" }]);
  });
});
