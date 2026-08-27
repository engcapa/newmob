import { beforeEach, describe, expect, it } from "vitest";
import {
  inlayHintsEnabledForLanguage,
  readWorkspaceIntelligencePreferences,
  toBasicCompletionPolicyV2,
  writeWorkspaceIntelligencePreferences,
} from "./intelligencePreferences";

describe("workspace intelligence preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults optional editor intelligence off and persists workspace/language switches", () => {
    const defaults = readWorkspaceIntelligencePreferences("ws");
    expect(inlayHintsEnabledForLanguage(defaults, "typescript")).toBe(false);
    expect(defaults.formatOnSave).toBe(false);
    expect(defaults.stickyLinesEnabled).toBe(true);
    expect(defaults.parameterInfo).toEqual({
      autoPopup: true,
      delayMs: 0,
      showFullSignatures: false,
    });
    expect(defaults.quickDoc).toEqual({
      showOnHover: true,
      hoverDelayMs: 300,
      defaultTarget: "popup",
    });
    writeWorkspaceIntelligencePreferences("ws", {
      inlayHintsEnabled: true,
      inlayHintLanguages: { typescript: false, rust: true },
      inlineBlameEnabled: true,
      formatOnSave: true,
      stickyLinesEnabled: false,
      parameterInfo: {
        autoPopup: false,
        delayMs: 275,
        showFullSignatures: true,
      },
      quickDoc: {
        showOnHover: false,
        hoverDelayMs: 725,
        defaultTarget: "tool-window",
      },
      completion: {
        autoTrigger: false,
        triggerDelayMs: 120,
        minPrefixLength: 2,
        maxItems: 80,
        showDocumentation: false,
        documentationDelayMs: 400,
        caseMatching: "first-letter",
        sortMode: "provider-relevance",
        autoInsertSingle: false,
        excludedSymbols: [],
        prioritizedSymbols: [],
      },
    });
    const restored = readWorkspaceIntelligencePreferences("ws");
    expect(inlayHintsEnabledForLanguage(restored, "typescript")).toBe(false);
    expect(inlayHintsEnabledForLanguage(restored, "rust")).toBe(true);
    expect(inlayHintsEnabledForLanguage(restored, "go")).toBe(true);
    expect(restored.inlineBlameEnabled).toBe(true);
    expect(restored.formatOnSave).toBe(true);
    expect(restored.stickyLinesEnabled).toBe(false);
    expect(restored.parameterInfo).toEqual({
      autoPopup: false,
      delayMs: 275,
      showFullSignatures: true,
    });
    expect(restored.quickDoc).toEqual({
      showOnHover: false,
      hoverDelayMs: 725,
      defaultTarget: "tool-window",
    });
    expect(restored.completion).toEqual({
      autoTrigger: false,
      triggerDelayMs: 120,
      minPrefixLength: 2,
      maxItems: 80,
      showDocumentation: false,
      documentationDelayMs: 400,
      caseMatching: "first-letter",
      sortMode: "provider-relevance",
      autoInsertSingle: false,
      excludedSymbols: [],
      prioritizedSymbols: [],
    });
  });

  it("normalizes legacy, corrupt, and out-of-range values", () => {
    window.localStorage.setItem("taomni.codeWorkspace.intelligence.v1.legacy", JSON.stringify({
      stickyLinesEnabled: true,
      parameterInfo: { autoPopup: "yes", delayMs: -12, showFullSignatures: 1 },
      quickDoc: { showOnHover: "yes", hoverDelayMs: 99_000, defaultTarget: "side" },
    }));

    const restored = readWorkspaceIntelligencePreferences("legacy");
    expect(restored.parameterInfo).toEqual({
      autoPopup: true,
      delayMs: 0,
      showFullSignatures: false,
    });
    expect(restored.quickDoc).toEqual({
      showOnHover: true,
      hoverDelayMs: 5_000,
      defaultTarget: "popup",
    });
    expect(restored.completion).toEqual({
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
    });
  });

  it("normalizes and clamps out-of-range completion preferences", () => {
    window.localStorage.setItem("taomni.codeWorkspace.intelligence.v1.completion-clamp", JSON.stringify({
      completion: {
        autoTrigger: false,
        triggerDelayMs: 99_999, // exceeds 5000 max -> 5000
        minPrefixLength: -5,    // below 0 min -> 0
        maxItems: 500,          // exceeds 200 max -> 200
        showDocumentation: false,
        documentationDelayMs: -100, // below 0 min -> 0
      },
    }));

    const restored = readWorkspaceIntelligencePreferences("completion-clamp");
    expect(restored.completion).toEqual({
      autoTrigger: false,
      triggerDelayMs: 5_000,
      minPrefixLength: 0,
      maxItems: 200,
      showDocumentation: false,
      documentationDelayMs: 0,
      caseMatching: "first-letter",
      sortMode: "provider-relevance",
      autoInsertSingle: false,
      excludedSymbols: [],
      prioritizedSymbols: [],
    });
  });

  it("§8.21.3 V2-E: maps to BasicCompletionPolicyV2 with custom rules", () => {
    const prefs = readWorkspaceIntelligencePreferences("default-policy");
    const policy = toBasicCompletionPolicyV2(prefs.completion);
    expect(policy).toEqual({
      autoPopup: true,
      delayMs: 50,
      caseMatching: "first-letter",
      sortMode: "provider-relevance",
      autoInsertSingle: false,
      excludedSymbols: [],
      prioritizedSymbols: [],
      maxVisibleItems: 50,
      documentation: {
        enabled: true,
        delayMs: 250,
      },
    });
  });
});
