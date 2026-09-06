import { describe, expect, it } from "vitest";
import {
  buildCleanupPlan,
  buildRearrangePlan,
  cancelWorkflowPlan,
  planCleanup,
  planRearrange,
  resolveCleanupCapabilities,
  resolveRearrangeCapabilities,
  verifyWorkflowFreshness,
  verifyWorkflowPostHashes,
  verifyWorkflowPreconditions,
  type CleanupInput,
  type RearrangeInput,
} from "./rearrangeCleanupWorkflow";
import { sha256Hex } from "./projectAnalysisModel";

describe("ED-STYLE-002: Rearrange / Cleanup independent workflows", () => {
  describe("resolveRearrangeCapabilities", () => {
    it("resolves supported when codeActionKinds includes source.rearrange", () => {
      const caps = resolveRearrangeCapabilities(
        {
          completion: true,
          signatureHelp: true,
          hover: true,
          definition: true,
          typeDefinition: true,
          implementation: true,
          references: true,
          documentSymbol: true,
          workspaceSymbol: true,
          rename: true,
          formatting: true,
          rangeFormatting: true,
          codeAction: true,
          documentHighlight: true,
          callHierarchy: true,
          typeHierarchy: true,
          inlayHint: true,
          selectionRange: true,
          semanticTokens: true,
          completionTriggerCharacters: [],
          signatureTriggerCharacters: [],
          codeActionKinds: ["source.rearrange"],
        },
        {
          path: "/repo/App.java",
          uri: "file:///repo/App.java",
          presetId: "jdtls",
          languageId: "java",
          displayName: "Eclipse JDT Language Server",
          available: true,
          active: true,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        },
      );
      expect(caps.rearrangeSupported).toBe(true);
      expect(caps.providerId).toBe("Eclipse JDT Language Server");
    });

    it("resolves unsupported when server advertises only standard actions", () => {
      const caps = resolveRearrangeCapabilities(
        {
          completion: true,
          signatureHelp: true,
          hover: true,
          definition: true,
          typeDefinition: true,
          implementation: true,
          references: true,
          documentSymbol: true,
          workspaceSymbol: true,
          rename: true,
          formatting: true,
          rangeFormatting: true,
          codeAction: true,
          documentHighlight: true,
          callHierarchy: true,
          typeHierarchy: true,
          inlayHint: true,
          selectionRange: true,
          semanticTokens: true,
          completionTriggerCharacters: [],
          signatureTriggerCharacters: [],
          codeActionKinds: ["source.organizeImports", "refactor"],
        },
        {
          path: "/repo/App.java",
          uri: "file:///repo/App.java",
          presetId: "jdtls",
          languageId: "java",
          displayName: "Eclipse JDT Language Server",
          available: true,
          active: true,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        },
      );
      expect(caps.rearrangeSupported).toBe(false);
      expect(caps.providerId).toBe("Eclipse JDT Language Server");
    });
  });

  describe("resolveCleanupCapabilities", () => {
    it("resolves supported when codeActionKinds includes source.cleanup or source.fixAll", () => {
      const caps = resolveCleanupCapabilities({
        completion: true,
        signatureHelp: true,
        hover: true,
        definition: true,
        typeDefinition: true,
        implementation: true,
        references: true,
        documentSymbol: true,
        workspaceSymbol: true,
        rename: true,
        formatting: true,
        rangeFormatting: true,
        codeAction: true,
        documentHighlight: true,
        callHierarchy: true,
        typeHierarchy: true,
        inlayHint: true,
        selectionRange: true,
        semanticTokens: true,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
        codeActionKinds: ["source.cleanup"],
      });
      expect(caps.cleanupSupported).toBe(true);
      expect(caps.supportedProfiles).toContain("default");
    });

    it("resolves unsupported when null capabilities provided", () => {
      const caps = resolveCleanupCapabilities(null);
      expect(caps.cleanupSupported).toBe(false);
    });
  });

  describe("planRearrange (ED-STYLE-002-A1, A2)", () => {
    it("fails closed when rearrange is unsupported by provider with honest reason", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: false,
        capabilities: { rearrangeSupported: false },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("No member-rearrangement provider is available");
      }
    });

    it("names the provider in the unavailable explanation when providerId is provided", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: false,
        capabilities: {
          rearrangeSupported: false,
          providerId: "Eclipse JDT Language Server",
        },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("Eclipse JDT Language Server does not support member-rearrangement for java");
      }
    });

    it("rejects read-only files honestly", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/libs/String.class",
        languageId: "java",
        readOnly: true,
        hasSelection: false,
        capabilities: { rearrangeSupported: true },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("is read-only");
      }
    });

    it("executes when provider explicitly advertises rearrange capability", () => {
      const input: RearrangeInput = {
        scope: "selection",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: true,
        capabilities: { rearrangeSupported: true },
      };

      const decision = planRearrange(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "selection",
        stage: "rearrange",
      });
    });

    it("executes with provider metadata when supplied", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: false,
        capabilities: {
          rearrangeSupported: true,
          providerId: "Java Arrangement Server",
          providerVersion: "2.1.0",
        },
      };

      const decision = planRearrange(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "file",
        stage: "rearrange",
        provider: {
          id: "Java Arrangement Server",
          version: "2.1.0",
        },
      });
    });
  });

  describe("planCleanup (ED-STYLE-002-A1, A2)", () => {
    it("fails closed when cleanup is unsupported by provider", () => {
      const input: CleanupInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        capabilities: { cleanupSupported: false },
      };

      const decision = planCleanup(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("No code cleanup provider is available");
      }
    });

    it("names the provider in the cleanup unavailable explanation", () => {
      const input: CleanupInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        capabilities: {
          cleanupSupported: false,
          providerId: "Eclipse JDT Language Server",
        },
      };

      const decision = planCleanup(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("Eclipse JDT Language Server does not support code cleanup for java");
      }
    });

    it("executes when cleanup is supported with profile", () => {
      const input: CleanupInput = {
        scope: "module",
        targetPath: "/repo/app",
        languageId: "java",
        readOnly: false,
        profileId: "full-cleanup",
        capabilities: { cleanupSupported: true, supportedProfiles: ["full-cleanup"] },
      };

      const decision = planCleanup(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "module",
        stage: "cleanup",
        profileId: "full-cleanup",
      });
    });
  });

  describe("workflow plan, preview, conflict, and cancel (ED-STYLE-002-A3)", () => {
    const originalText = "class Example {\n  void b() {}\n  void a() {}\n}\n";
    const rearrangedText = "class Example {\n  void a() {}\n  void b() {}\n}\n";

    it("builds rearrange plan with preview and preconditions", () => {
      const plan = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        documentRevision: 1,
        readOnly: false,
        provider: { id: "ArrangementProvider", version: "1.0.0" },
        edits: [
          {
            range: {
              start: { line: 1, character: 0 },
              end: { line: 3, character: 0 },
            },
            newText: "  void a() {}\n  void b() {}\n",
          },
        ],
      });

      expect(plan.workflow).toBe("rearrange");
      expect(plan.provider.id).toBe("ArrangementProvider");
      expect(plan.preconditions).toHaveLength(1);
      expect(plan.preconditions[0].preTextSha256).toBe(sha256Hex(originalText));
      expect(plan.preconditions[0].expectedPostHash).toBe(sha256Hex(rearrangedText));
      expect(plan.conflicts).toHaveLength(0);
      expect(plan.preview.entries).toHaveLength(1);
      expect(plan.preview.entries[0].path).toBe("/repo/src/Example.java");
    });

    it("detects dirty buffer or read-only conflict at plan generation", () => {
      const planDirty = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        readOnly: false,
        isDirty: true,
        provider: { id: "p" },
        edits: [],
      });
      expect(planDirty.conflicts).toHaveLength(1);
      expect(planDirty.conflicts[0].reason).toBe("dirty-open-buffer");

      const planReadOnly = buildCleanupPlan({
        scope: "file",
        targetPath: "/repo/src/ReadOnly.java",
        targetUri: "file:///repo/src/ReadOnly.java",
        currentText: originalText,
        readOnly: true,
        provider: { id: "p" },
        edits: [],
      });
      expect(planReadOnly.conflicts).toHaveLength(1);
      expect(planReadOnly.conflicts[0].reason).toBe("read-only");
    });

    it("verifies preconditions and catches external divergence", () => {
      const plan = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        documentRevision: 2,
        readOnly: false,
        provider: { id: "p" },
        edits: [],
      });

      // Valid live document matching precondition
      const valid = verifyWorkflowPreconditions(plan, {
        "/repo/src/Example.java": { text: originalText, revision: 2 },
      });
      expect(valid.ok).toBe(true);

      // Diverged live text
      const diverged = verifyWorkflowPreconditions(plan, {
        "/repo/src/Example.java": { text: originalText + "// edited\n", revision: 2 },
      });
      expect(diverged.ok).toBe(false);
      expect(diverged.conflict?.reason).toBe("external-divergence");

      // Version mismatch
      const versionMismatch = verifyWorkflowPreconditions(plan, {
        "/repo/src/Example.java": { text: originalText, revision: 3 },
      });
      expect(versionMismatch.ok).toBe(false);
      expect(versionMismatch.conflict?.reason).toBe("version-mismatch");
    });

    it("detects stale provider session or generation", () => {
      const fresh = verifyWorkflowFreshness(
        { providerGeneration: 1, sessionId: "sess-1" },
        { providerGeneration: 1, sessionId: "sess-1" },
      );
      expect(fresh.ok).toBe(true);

      const staleGen = verifyWorkflowFreshness(
        { providerGeneration: 1, sessionId: "sess-1" },
        { providerGeneration: 2, sessionId: "sess-1" },
      );
      expect(staleGen.ok).toBe(false);
      expect(staleGen.staleReason).toContain("Provider generation changed");

      const staleSess = verifyWorkflowFreshness(
        { sessionId: "sess-1" },
        { sessionId: "sess-2" },
      );
      expect(staleSess.ok).toBe(false);
      expect(staleSess.staleReason).toContain("Session identity changed");
    });

    it("cancels plan with zero effects", () => {
      const plan = buildRearrangePlan({
        scope: "file",
        targetPath: "/repo/src/Example.java",
        targetUri: "file:///repo/src/Example.java",
        currentText: originalText,
        readOnly: false,
        provider: { id: "p" },
        edits: [],
      });

      const cancelResult = cancelWorkflowPlan(plan);
      expect(cancelResult.disposition).toBe("cancelled");
      expect(cancelResult.applied).toBe(false);
      expect(cancelResult.effects).toHaveLength(0);
    });
  });

  describe("postcondition verification and undo (ED-STYLE-002-A4)", () => {
    it("verifies postcondition hashes against applied files", () => {
      const originalText = "void test() {}";
      const cleanedText = "void test() {\n    // cleaned\n}";
      const expectedHash = sha256Hex(cleanedText);

      const success = verifyWorkflowPostHashes(
        { "/repo/src/Test.java": expectedHash },
        { "/repo/src/Test.java": cleanedText },
      );
      expect(success.ok).toBe(true);
      expect(success.mismatchedFiles).toHaveLength(0);

      const mismatch = verifyWorkflowPostHashes(
        { "/repo/src/Test.java": expectedHash },
        { "/repo/src/Test.java": originalText },
      );
      expect(mismatch.ok).toBe(false);
      expect(mismatch.mismatchedFiles).toContain("/repo/src/Test.java");
    });
  });
});

