// ED-REF-001 provider contract: the committed sanitized trace produced by
// `runner/run-jdtls-refactor-fixture.mjs` must satisfy every expectation below.
// These tests gate the provider evidence for real JDT LS multi-file rename.
//
// @ts-expect-error node builtin without DOM+node merged globals
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
// @ts-expect-error node webcrypto without DOM+node merged globals
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "../../capabilityEvidence";
import { buildRefactorPlan, refactorApplyGate, verifyExclusionSafety } from "../../refactorPlan";
import { buildWorkspaceEditPreview } from "../../workspaceEditPreview";

function fixtureDir(): string {
  const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  const candidates = [
    join(cwd, "src/components/editor/workspace/__fixtures__/jdtls"),
    join(cwd, "__fixtures__/jdtls"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "traces"))) ?? candidates[0];
}

interface RefactorTraceFile {
  path: string;
  isDeclaration: boolean;
  editCount: number;
  preSha256: string;
  postSha256: string;
  edits: Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }>;
}

interface RefactorTrace {
  schemaVersion: number;
  fixtureId: string;
  sanitized: boolean;
  toolchain: { java: { version: string }; jdtls: { version: string } };
  renameCapability: { advertised: boolean; prepareSupport: boolean };
  prepareRename: {
    position: { line: number; character: number };
    targetSymbol: string;
    result: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    latencyMs: number;
  };
  rename: {
    targetSymbol: string;
    newName: string;
    latencyMs: number;
    affectedFilesCount: number;
    files: RefactorTraceFile[];
  };
  postConditions: {
    appContainsNewMethod: boolean;
    testContainsNewMethodCall: boolean;
    multiFileConfirmed: boolean;
  };
  failures: string[];
}

function loadTrace(): RefactorTrace {
  const path = join(fixtureDir(), "traces", "refactor-maven-single.trace.json");
  return JSON.parse(readFileSync(path, "utf8")) as RefactorTrace;
}

describe("ED-REF-001: JDT LS multi-file rename provider contract", () => {
  it("commits a sanitized trace from the pinned provider", () => {
    const trace = loadTrace();
    expect(trace.schemaVersion).toBe(1);
    expect(trace.fixtureId).toBe("refactor-maven-single");
    expect(trace.sanitized).toBe(true);
    expect(trace.toolchain.jdtls.version).toContain("1.61.0");
    expect(trace.toolchain.java.version).toContain("21.0.4");
    expect(trace.failures).toEqual([]);
  });

  it("advertises rename and prepareRename capabilities (ED-REF-001-A1)", () => {
    const trace = loadTrace();
    expect(trace.renameCapability.advertised).toBe(true);
    expect(trace.renameCapability.prepareSupport).toBe(true);
    expect(trace.prepareRename.result).toBeDefined();
    expect(trace.prepareRename.result.start.line).toBe(39);
  });

  it("proves multi-file rename modifying declaration and caller across files (ED-REF-001-A1)", () => {
    const trace = loadTrace();
    expect(trace.rename.affectedFilesCount).toBe(2);
    expect(trace.rename.files).toHaveLength(2);

    const appFile = trace.rename.files.find((f) => f.path.endsWith("App.java"));
    const testFile = trace.rename.files.find((f) => f.path.endsWith("AppTest.java"));

    expect(appFile).toBeDefined();
    expect(appFile?.isDeclaration).toBe(true);
    expect(appFile?.editCount).toBeGreaterThanOrEqual(1);

    expect(testFile).toBeDefined();
    expect(testFile?.isDeclaration).toBe(false);
    expect(testFile?.editCount).toBeGreaterThanOrEqual(1);

    expect(trace.postConditions.appContainsNewMethod).toBe(true);
    expect(trace.postConditions.testContainsNewMethodCall).toBe(true);
    expect(trace.postConditions.multiFileConfirmed).toBe(true);
  });

  it("synthesizes workspace edit preview and refactor plan matching fixture (ED-REF-001-A1 & A3)", () => {
    const trace = loadTrace();
    const workspaceEdit: LspWorkspaceEdit = {
      documentEdits: trace.rename.files.map((file) => ({
        uri: `file:///workspace/${file.path}`,
        path: `/workspace/${file.path}`,
        edits: file.edits,
      })),
    };

    // 1. Workspace Edit Preview
    const preview = buildWorkspaceEditPreview(workspaceEdit, {
      label: `Rename ${trace.rename.targetSymbol} to ${trace.rename.newName}`,
    });
    expect(preview.affectedFileCount).toBe(2);
    expect(preview.usages.length).toBeGreaterThanOrEqual(2);
    expect(preview.entries.map((e) => e.path)).toEqual([
      "/workspace/src/main/java/com/example/single/App.java",
      "/workspace/src/test/java/com/example/single/AppTest.java",
    ]);

    // 2. Refactor Plan
    const dummyEvidence = buildCapabilityEvidence({
      capabilityId: "refactor.rename",
      languageId: "java",
      provider: { id: "jdtls", version: "1.61.0", generation: 1 },
      projectFingerprint: "fingerprint-maven-single",
      uri: "file:///workspace/src/main/java/com/example/single/App.java",
      revision: 1,
      scope: "project",
      complete: true,
    });

    const plan = buildRefactorPlan({
      actionId: "refactor-fixture-action",
      kind: "rename",
      evidence: dummyEvidence,
      edit: workspaceEdit,
      roots: [{ path: "/workspace" }],
      openFiles: {
        "/workspace/src/main/java/com/example/single/App.java": {
          documentRevision: 1,
          revision: 1,
          diskHash: trace.rename.files[0].preSha256,
        },
        "/workspace/src/test/java/com/example/single/AppTest.java": {
          documentRevision: 1,
          revision: 1,
          diskHash: trace.rename.files[1].preSha256,
        },
      },
      requiredOperationIndexes: [0], // Declaration edit required
    });

    expect(plan.operations).toHaveLength(2);
    expect(plan.documents).toHaveLength(2);
    expect(plan.affectedUris).toHaveLength(2);
    expect(plan.documents[0].owner).toBe("workspace");
    expect(plan.documents[1].owner).toBe("workspace");
    expect(plan.documents[0].expectedDiskHash).toBe(trace.rename.files[0].preSha256);
    expect(plan.documents[1].expectedDiskHash).toBe(trace.rename.files[1].preSha256);

    // Gate decision allows commit
    const gate = refactorApplyGate(plan);
    expect(gate.allowed).toBe(true);
    expect(gate.blockingConflicts).toHaveLength(0);

    // Safety exclusion protects declaration
    const exclusionCheck = verifyExclusionSafety(plan, new Set([0]));
    expect(exclusionCheck.safe).toBe(false);

    const callerExclusion = verifyExclusionSafety(plan, new Set([1]));
    expect(callerExclusion.safe).toBe(true);
  });
});
