import { describe, expect, it } from "vitest";
import type { LspLocation, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "./capabilityEvidence";
import {
  buildRefactorPlan,
  refactorApplyGate,
  verifyExclusionSafety,
  evaluateDestructiveRefactorAvailability,
  type RefactorPlanV4,
} from "./refactorPlan";

const dummyLocation: LspLocation = {
  uri: "file:///workspace/src/A.java",
  path: "/workspace/src/A.java",
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } },
};

const dummyEvidence = buildCapabilityEvidence({
  capabilityId: "refactor.rename",
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 1 },
  projectFingerprint: "fingerprint-123",
  uri: "file:///workspace/src/A.java",
  revision: 1,
  scope: "project",
  complete: false,
});

describe("refactorApplyGate §8.20.6 & §8.21.2 V1", () => {
  it("blocks outright when error-severity conflicts exist", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-1",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "complete", source: "provider-asserted", proof: null },
      conflicts: [
        { severity: "error", message: "Naming collision with existing class 'B'", location: dummyLocation, source: "reported" },
      ],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.requiresConfirm).toBe(false);
    expect(decision.reason).toContain("Naming collision");
    expect(decision.blockingConflicts).toHaveLength(1);
  });

  it("requires explicit user confirmation when only warning conflicts exist", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-2",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "complete", source: "provider-asserted", proof: null },
      conflicts: [
        { severity: "warning", message: "Overload might become ambiguous", location: dummyLocation, source: "reported" },
      ],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirm).toBe(true);
    expect(decision.reason).toContain("ambiguous");
    expect(decision.warningConflicts).toHaveLength(1);
  });

  it("hard blocks Safe Delete when completeness is provider-partial", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-3",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: { value: "partial", source: "protocol-bounded", proof: null },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Language provider does not attest complete Safe Delete coverage");
  });

  it("hard blocks Safe Delete when completeness is unknown", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-4",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: { value: "unknown", source: "unknown", proof: null },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Language provider does not attest complete Safe Delete coverage");
  });

  it("hard blocks Safe Delete when completeness is only client-observed bounded", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-5b",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: {
        value: "complete",
        source: "client-observed-bounded",
        proof: "all references resolved within workspace roots",
      },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Language provider does not attest complete Safe Delete coverage");
  });

  it("allows Safe Delete only when completeness is provider-asserted complete with proof", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-5",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: {
        value: "complete",
        source: "provider-asserted",
        proof: "jdtls dedicated safe delete command verified",
      },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirm).toBe(false);
  });

  it("hard blocks when any affected URI belongs to a read-only library or external source", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-6",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "complete", source: "provider-asserted", proof: null },
      conflicts: [],
      operations: [],
      documents: [
        { uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" },
        { uri: "jar:file:///root/.m2/repository/dep.jar!/Dep.class", canonicalPath: null, expectedDocumentRevision: null, expectedDiskHash: null, owner: "library" },
      ],
      requiredOperationIndexes: [],
      affectedUris: [
        { uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" },
        { uri: "jar:file:///root/.m2/repository/dep.jar!/Dep.class", revision: null, owner: "library" },
      ],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Cannot modify read-only library resource");
  });

  it("requires preview when completeness is partial", () => {
    const plan: RefactorPlanV4 = {
      actionId: "action-7",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: { value: "partial", source: "protocol-bounded", proof: null },
      conflicts: [],
      operations: [],
      documents: [{ uri: "file:///workspace/src/A.java", canonicalPath: "/workspace/src/A.java", expectedDocumentRevision: 1, expectedDiskHash: null, owner: "workspace" }],
      requiredOperationIndexes: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresPreview).toBe(true);
  });
});

describe("buildRefactorPlan & verifyExclusionSafety §8.20.6 & §8.21.2", () => {
  const sampleEdit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: "file:///workspace/src/A.java",
        path: "/workspace/src/A.java",
        edits: [
          { range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } }, newText: "nextName" },
        ],
      },
      {
        uri: "file:///workspace/src/B.java",
        path: "/workspace/src/B.java",
        edits: [
          { range: { start: { line: 20, character: 4 }, end: { line: 20, character: 12 } }, newText: "nextName" },
        ],
      },
    ],
  };

  it("builds a plan with classified affected URIs and excludable groups", () => {
    const plan = buildRefactorPlan({
      actionId: "plan-1",
      kind: "rename",
      evidence: dummyEvidence,
      edit: sampleEdit,
      roots: [{ path: "/workspace" }],
      requiredOperationIndexes: [0], // first edit is declaration, required
    });

    expect(plan.operations).toHaveLength(2);
    expect(plan.affectedUris).toHaveLength(2);
    expect(plan.affectedUris[0].owner).toBe("workspace");
    expect(plan.affectedUris[1].owner).toBe("workspace");
    expect(plan.documents).toHaveLength(2);
    expect(plan.excludableGroups).toHaveLength(2);
    expect(plan.excludableGroups[0].required).toBe(true);
    expect(plan.excludableGroups[1].required).toBe(false);
  });

  it("maps document revisions and hashes per URI instead of using first open file", () => {
    const multiFileEdit: LspWorkspaceEdit = {
      documentEdits: [
        {
          uri: "file:///workspace/src/A.java",
          path: "/workspace/src/A.java",
          edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "A2" }],
        },
        {
          uri: "file:///workspace/src/B.java",
          path: "/workspace/src/B.java",
          edits: [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, newText: "B2" }],
        },
      ],
    };

    const plan = buildRefactorPlan({
      actionId: "plan-revisions",
      kind: "rename",
      evidence: dummyEvidence,
      edit: multiFileEdit,
      roots: [{ path: "/workspace" }],
      openFiles: {
        "file:///workspace/src/A.java": { documentRevision: 10, diskHash: "hash-a" },
        "file:///workspace/src/B.java": { documentRevision: 20, diskHash: "hash-b" },
      },
    });

    expect(plan.documents).toHaveLength(2);
    const docA = plan.documents.find((d) => d.uri === "file:///workspace/src/A.java");
    const docB = plan.documents.find((d) => d.uri === "file:///workspace/src/B.java");
    expect(docA?.expectedDocumentRevision).toBe(10);
    expect(docA?.expectedDiskHash).toBe("hash-a");
    expect(docB?.expectedDocumentRevision).toBe(20);
    expect(docB?.expectedDiskHash).toBe("hash-b");
  });

  it("flags library file modification as conflict in buildRefactorPlan", () => {
    const externalEdit: LspWorkspaceEdit = {
      documentEdits: [
        {
          uri: "file:///usr/lib/java/rt.jar",
          path: "/usr/lib/java/rt.jar",
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" }],
        },
      ],
    };
    const plan = buildRefactorPlan({
      actionId: "plan-2",
      kind: "rename",
      evidence: dummyEvidence,
      edit: externalEdit,
      roots: [{ path: "/workspace" }],
    });

    expect(plan.affectedUris[0].owner).not.toBe("workspace");
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
  });

  it("verifyExclusionSafety prevents excluding required operation groups", () => {
    const plan = buildRefactorPlan({
      actionId: "plan-3",
      kind: "rename",
      evidence: dummyEvidence,
      edit: sampleEdit,
      roots: [{ path: "/workspace" }],
      requiredOperationIndexes: [0],
    });

    const safeExclusion = verifyExclusionSafety(plan, new Set([1]));
    expect(safeExclusion.safe).toBe(true);

    const unsafeExclusion = verifyExclusionSafety(plan, new Set([0]));
    expect(unsafeExclusion.safe).toBe(false);
    expect(unsafeExclusion.reason).toContain("cannot be excluded");
  });

  describe("§8.22.2 U1 evaluateDestructiveRefactorAvailability", () => {
    it("returns disabled when no attestation is provided", () => {
      const avail = evaluateDestructiveRefactorAvailability(null);
      expect(avail.state).toBe("disabled");
      if (avail.state === "disabled") {
        expect(avail.reasonCode).toBe("provider-no-safe-delete-attestation");
        expect(avail.message).toContain("does not attest complete Safe Delete coverage");
      }
    });

    it("returns disabled when attestation coverage is partial or missing proof id", () => {
      const partialAvail = evaluateDestructiveRefactorAvailability({
        providerId: "jdtls",
        providerVersion: "1.61.0",
        projectFingerprint: "fp",
        capability: "safe-delete",
        coverage: "provider-partial" as any,
        supportedSymbolKinds: ["class"],
        proof: { kind: "provider-command", id: "cmd" },
      });
      expect(partialAvail.state).toBe("disabled");

      const noProofAvail = evaluateDestructiveRefactorAvailability({
        providerId: "jdtls",
        providerVersion: "1.61.0",
        projectFingerprint: "fp",
        capability: "safe-delete",
        coverage: "provider-complete",
        supportedSymbolKinds: ["class"],
        proof: { kind: "provider-command", id: "" },
      });
      expect(noProofAvail.state).toBe("disabled");
    });

    it("returns enabled when provider provides complete attestation with proof", () => {
      const avail = evaluateDestructiveRefactorAvailability({
        providerId: "jdtls",
        providerVersion: "1.61.0",
        projectFingerprint: "fp",
        capability: "safe-delete",
        coverage: "provider-complete",
        supportedSymbolKinds: ["class", "method"],
        proof: { kind: "provider-command", id: "java.action.safeDelete" },
      });
      expect(avail.state).toBe("enabled");
      if (avail.state === "enabled") {
        expect(avail.attestation.proof.id).toBe("java.action.safeDelete");
      }
    });
  });

  describe("ED-REF-001: Multi-file rename, dirty conflicts, and library guards", () => {
    it("builds multi-file rename plan and blocks on dirty buffer conflict", () => {
      const multiFileEdit: LspWorkspaceEdit = {
        documentEdits: [
          {
            textDocument: { uri: "file:///workspace/core/User.java", version: 1 },
            edits: [{ range: { start: { line: 5, character: 13 }, end: { line: 5, character: 17 } }, newText: "Account" }],
          },
          {
            textDocument: { uri: "file:///workspace/app/UserService.java", version: 2 },
            edits: [{ range: { start: { line: 12, character: 8 }, end: { line: 12, character: 12 } }, newText: "Account" }],
          },
        ],
      };

      const plan = buildRefactorPlan({
        actionId: "rename-user-account",
        kind: "rename",
        evidence: dummyEvidence,
        edit: multiFileEdit,
        roots: [{ path: "/workspace" }],
        openFiles: {
          "/workspace/core/User.java": { revision: 1, documentRevision: 1, diskHash: "hash-user" },
          "/workspace/app/UserService.java": { revision: 2, documentRevision: 3, diskHash: "hash-service" }, // Revision mismatch (dirty)
        },
        conflicts: [
          {
            severity: "error",
            message: "File '/workspace/app/UserService.java' has unsaved buffer edits",
            location: null,
            source: "derived",
          },
        ],
      });

      const gate = refactorApplyGate(plan);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain("unsaved buffer edits");
      expect(gate.blockingConflicts).toHaveLength(1);
    });

    it("hard blocks when refactoring touches read-only jar library", () => {
      const libraryEdit: LspWorkspaceEdit = {
        documentEdits: [
          {
            textDocument: { uri: "jar:file:///root/.m2/repository/com/google/guava/guava.jar!/ImmutableList.class", version: null },
            edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: "List" }],
          },
        ],
      };

      const plan = buildRefactorPlan({
        actionId: "rename-library",
        kind: "rename",
        evidence: dummyEvidence,
        edit: libraryEdit,
        roots: [{ path: "/workspace" }],
      });

      const gate = refactorApplyGate(plan);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain("read-only library resource");
    });
  });
});

