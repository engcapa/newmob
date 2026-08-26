import { describe, expect, it } from "vitest";
import type { LspLocation, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "./capabilityEvidence";
import {
  buildRefactorPlan,
  refactorApplyGate,
  verifyExclusionSafety,
  type RefactorPlanV3,
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

describe("refactorApplyGate §8.20.6", () => {
  it("blocks outright when error-severity conflicts exist", () => {
    const plan: RefactorPlanV3 = {
      actionId: "action-1",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: "provider-complete",
      conflicts: [
        { severity: "error", message: "Naming collision with existing class 'B'", location: dummyLocation },
      ],
      operations: [],
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
    const plan: RefactorPlanV3 = {
      actionId: "action-2",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: "provider-complete",
      conflicts: [
        { severity: "warning", message: "Overload might become ambiguous", location: dummyLocation },
      ],
      operations: [],
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
    const plan: RefactorPlanV3 = {
      actionId: "action-3",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: "provider-partial",
      conflicts: [],
      operations: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Safe Delete requires provider-complete references");
  });

  it("hard blocks Safe Delete when completeness is unknown", () => {
    const plan: RefactorPlanV3 = {
      actionId: "action-4",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: "unknown",
      conflicts: [],
      operations: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(false);
  });

  it("allows Safe Delete when completeness is provider-complete", () => {
    const plan: RefactorPlanV3 = {
      actionId: "action-5",
      kind: "safe-delete",
      evidence: dummyEvidence,
      completeness: "provider-complete",
      conflicts: [],
      operations: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirm).toBe(false);
  });

  it("hard blocks when any affected URI belongs to a read-only library or external source", () => {
    const plan: RefactorPlanV3 = {
      actionId: "action-6",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: "provider-complete",
      conflicts: [],
      operations: [],
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
    const plan: RefactorPlanV3 = {
      actionId: "action-7",
      kind: "rename",
      evidence: dummyEvidence,
      completeness: "provider-partial",
      conflicts: [],
      operations: [],
      affectedUris: [{ uri: "file:///workspace/src/A.java", revision: 1, owner: "workspace" }],
      excludableGroups: [],
    };
    const decision = refactorApplyGate(plan);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresPreview).toBe(true);
  });
});

describe("buildRefactorPlan & verifyExclusionSafety §8.20.6", () => {
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
    expect(plan.excludableGroups).toHaveLength(2);
    expect(plan.excludableGroups[0].required).toBe(true);
    expect(plan.excludableGroups[1].required).toBe(false);
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
});
