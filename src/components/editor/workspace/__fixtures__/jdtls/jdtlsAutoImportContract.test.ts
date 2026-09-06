// The frontend TS program has no node type globals; these imports are resolved by vitest.
// @ts-expect-error node builtin without DOM+node merged globals
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_IMPORT_SETTINGS,
  parseProviderImportCandidates,
  planAutoImport,
} from "../../autoImportModel";

function fixtureDir(): string {
  const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  const candidates = [
    join(cwd, "src/components/editor/workspace/__fixtures__/jdtls"),
    join(cwd, "__fixtures__/jdtls"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "traces"))) ?? candidates[0];
}

interface ImportTrace {
  schemaVersion: number;
  fixtureId: string;
  generatedAt: string;
  sanitized: boolean;
  toolchain: {
    java: { path: string; version: string };
    jdtls: { home: string; version: string };
  };
  capabilities: {
    codeActionSupported: boolean;
    codeActionKinds: readonly string[];
  };
  codeActionQuery: {
    file: string;
    symbol: string;
    diagnosticMessage: string;
    offeredTitles: readonly string[];
  };
  parsedCandidates: Array<{
    symbolName: string;
    fullyQualifiedName: string;
    sourcePackage: string;
    origin: string;
  }>;
  policyExecution: {
    defaultExcludedPackages: readonly string[];
    unambiguousWithExclusion: {
      candidate: string;
      outcome: string;
      importStatement: string;
    };
    ambiguousWithoutExclusion: {
      candidateCount: number;
      outcome: string;
      requiresPrompt: boolean;
    };
    independenceOfSettings: {
      onTheFlyOnly: { onTheFly: string; paste: string };
      pasteOnly: { onTheFly: string; paste: string };
    };
    staleGenerationGating: {
      staleGenerationOutcome: string;
      reason: string;
      editsApplied: number;
    };
  };
  transactionEvidence: {
    originalSha256: string;
    appliedSha256: string;
    revertedSha256: string;
    revertedRestoresOriginalHash: boolean;
  };
  failures: readonly string[];
}

function loadTrace(): ImportTrace {
  const file = join(fixtureDir(), "traces/import-maven-single.trace.json");
  const raw = readFileSync(file, "utf8");
  return JSON.parse(raw) as ImportTrace;
}

describe("ED-IMPORT-001: JDT LS Auto-Import Contract Evidence", () => {
  const trace = loadTrace();

  it("proves real JDT LS provider metadata and code action capabilities", () => {
    expect(trace.fixtureId).toBe("import-maven-single");
    expect(trace.toolchain.java.version).toMatch(/^21\./);
    expect(trace.toolchain.jdtls.version).toContain("1.61.0");
    expect(trace.capabilities.codeActionSupported).toBe(true);
    expect(trace.capabilities.codeActionKinds).toContain("quickfix");
    expect(trace.failures).toHaveLength(0);
  });

  it("parses real provider code action titles into dynamic AutoImportCandidates (rejects fixed dictionaries)", () => {
    const actions = trace.codeActionQuery.offeredTitles.map((title) => ({ title }));
    const candidates = parseProviderImportCandidates(actions);

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const names = candidates.map((c) => c.fullyQualifiedName);
    expect(names).toContain("com.sun.tools.javac.util.StringUtils");
    expect(names).toContain("org.apache.commons.lang3.StringUtils");

    for (const c of candidates) {
      expect(c.symbolName).toBe("StringUtils");
      expect(c.origin).toBe("provider");
    }
  });

  describe("ED-IMPORT-001-A1: unique, ambiguous, excluded, prioritized flows match policy", () => {
    it("auto-applies unique candidate when internal packages are excluded by policy", () => {
      const actions = trace.codeActionQuery.offeredTitles.map((title) => ({ title }));
      const candidates = parseProviderImportCandidates(actions);
      const doc = "package com.example;\n\npublic class QuickFixTarget {\n    boolean blank = StringUtils.isBlank(\"x\");\n}\n";

      const plan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          excludedPackages: ["com.sun.*", "sun.*"],
        },
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(plan.outcome).toBe("auto-apply");
      if (plan.outcome === "auto-apply") {
        expect(plan.candidate.fullyQualifiedName).toBe("org.apache.commons.lang3.StringUtils");
        expect(plan.importStatement).toBe("import org.apache.commons.lang3.StringUtils;\n");
      }
    });

    it("requires user prompt when multiple candidates remain unexcluded (ambiguous flow)", () => {
      const actions = trace.codeActionQuery.offeredTitles.map((title) => ({ title }));
      const candidates = parseProviderImportCandidates(actions);
      const doc = "package com.example;\n\npublic class QuickFixTarget {\n    boolean blank = StringUtils.isBlank(\"x\");\n}\n";

      const plan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          excludedPackages: [], // No exclusions
        },
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(plan.outcome).toBe("ambiguous");
      if (plan.outcome === "ambiguous") {
        expect(plan.requiresPrompt).toBe(true);
        expect(plan.candidates.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("ED-IMPORT-001-A2: paste and on-the-fly settings are strictly independent", () => {
    it("honors independent preferences for on-the-fly vs paste modes", () => {
      const actions = trace.codeActionQuery.offeredTitles.map((title) => ({ title }));
      const candidates = parseProviderImportCandidates(actions);
      const doc = "package com.example;\n\npublic class QuickFixTarget {\n}\n";

      // Case 1: on-the-fly enabled, paste disabled ("none")
      const onTheFlyPlan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          addUnambiguousImportsOnTheFly: true,
          pasteImportMode: "none",
        },
        isPaste: false,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });
      expect(onTheFlyPlan.outcome).toBe("auto-apply");

      const pasteBlockedPlan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          addUnambiguousImportsOnTheFly: true,
          pasteImportMode: "none",
        },
        isPaste: true,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });
      expect(pasteBlockedPlan.outcome).toBe("none");
      if (pasteBlockedPlan.outcome === "none") {
        expect(pasteBlockedPlan.reason).toBe("paste-mode-none");
      }

      // Case 2: on-the-fly disabled, paste enabled ("all")
      const onTheFlyDisabledPlan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          addUnambiguousImportsOnTheFly: false,
          pasteImportMode: "all",
        },
        isPaste: false,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });
      expect(onTheFlyDisabledPlan.outcome).toBe("none");
      if (onTheFlyDisabledPlan.outcome === "none") {
        expect(onTheFlyDisabledPlan.reason).toBe("disabled");
      }

      const pasteAllowedPlan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          addUnambiguousImportsOnTheFly: false,
          pasteImportMode: "all",
        },
        isPaste: true,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });
      expect(pasteAllowedPlan.outcome).toBe("auto-apply");
    });
  });

  describe("ED-IMPORT-001-A3: stale generation or unready facts apply zero edits", () => {
    it("rejects auto-import when project facts are stale, loading, or unready", () => {
      const actions = trace.codeActionQuery.offeredTitles.map((title) => ({ title }));
      const candidates = parseProviderImportCandidates(actions);
      const doc = "package com.example;\n\npublic class QuickFixTarget {\n}\n";

      const stalePlan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 2, // generation mismatch
      });
      expect(stalePlan.outcome).toBe("none");
      if (stalePlan.outcome === "none") {
        expect(stalePlan.reason).toBe("stale-generation");
      }

      const loadingPlan = planAutoImport({
        symbolName: "StringUtils",
        candidates,
        documentText: doc,
        projectFactsStatus: "loading",
      });
      expect(loadingPlan.outcome).toBe("none");
      if (loadingPlan.outcome === "none") {
        expect(loadingPlan.reason).toBe("unready-facts");
      }
    });
  });

  describe("ED-IMPORT-001-A4: provider-backed fixture proves import and one undo", () => {
    it("proves single undo restores byte-for-byte exact SHA-256 pre-image", () => {
      expect(trace.transactionEvidence.revertedRestoresOriginalHash).toBe(true);
      expect(trace.transactionEvidence.revertedSha256).toBe(trace.transactionEvidence.originalSha256);
      expect(trace.transactionEvidence.appliedSha256).not.toBe(trace.transactionEvidence.originalSha256);
    });
  });
});
