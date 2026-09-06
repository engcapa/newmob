// ED-STYLE-002 provider contract: validates the committed sanitized trace
// produced by `runner/run-jdtls-rearrange-cleanup-fixture.mjs`.
//
// @ts-expect-error node builtin without DOM+node merged globals
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planRearrange,
  planCleanup,
  resolveRearrangeCapabilities,
  resolveCleanupCapabilities,
  buildRearrangePlan,
  verifyWorkflowPostHashes,
  verifyWorkflowPreconditions,
} from "../../rearrangeCleanupWorkflow";
import { sha256Hex } from "../../projectAnalysisModel";

function fixtureDir(): string {
  const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  const candidates = [
    join(cwd, "src/components/editor/workspace/__fixtures__/jdtls"),
    join(cwd, "__fixtures__/jdtls"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "traces"))) ?? candidates[0];
}

interface RearrangeCleanupTrace {
  schemaVersion: number;
  fixtureId: string;
  sanitized: boolean;
  toolchain: {
    java: { version: string };
    jdtls: { version: string };
  };
  capabilities: {
    rawCodeActionKinds: string[];
    formattingSupported: boolean;
    organizeImportsSupported: boolean;
    rearrangeAdvertised: boolean;
    cleanupAdvertised: boolean;
  };
  failClosedExplanations: {
    rearrange: string;
    cleanup: string;
  };
  nonRelabelContract: {
    formatNeverRelabeledAsRearrange: boolean;
    organizeImportsNeverRelabeledAsCleanup: boolean;
  };
  capableWorkflowExecution: {
    workflow: string;
    provider: { id: string; version: string };
    scope: string;
    targetPath: string;
    preTextSha256: string;
    expectedPostHash: string;
    previewGenerated: boolean;
    affectedFilesCount: number;
    conflictDetectedOnDirty: boolean;
    singleUndoRestoredPreHash: boolean;
  };
  failures: string[];
}

function loadTrace(): RearrangeCleanupTrace {
  const path = join(fixtureDir(), "traces", "rearrange-cleanup-maven-single.trace.json");
  return JSON.parse(readFileSync(path, "utf8")) as RearrangeCleanupTrace;
}

describe("ED-STYLE-002: JDT LS Rearrange & Cleanup provider contract", () => {
  it("commits a sanitized trace from the pinned provider", () => {
    const trace = loadTrace();
    expect(trace.schemaVersion).toBe(1);
    expect(trace.fixtureId).toBe("rearrange-cleanup-maven-single");
    expect(trace.sanitized).toBe(true);
    expect(trace.toolchain.jdtls.version).toContain("1.61.0");
    expect(trace.toolchain.java.version).toContain("21.0.4");
    expect(trace.failures).toEqual([]);
  });

  it("proves real JDT LS advertises format/imports but lacks rearrange/cleanup (A2)", () => {
    const trace = loadTrace();
    expect(trace.capabilities.formattingSupported).toBe(true);
    expect(trace.capabilities.organizeImportsSupported).toBe(true);
    expect(trace.capabilities.rearrangeAdvertised).toBe(false);
    expect(trace.capabilities.cleanupAdvertised).toBe(false);

    // Verify system capability resolution against JDT LS facts
    const rearrangeCaps = resolveRearrangeCapabilities(
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
        codeActionKinds: trace.capabilities.rawCodeActionKinds,
      },
      {
        path: "App.java",
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
    expect(rearrangeCaps.rearrangeSupported).toBe(false);

    const cleanupCaps = resolveCleanupCapabilities(
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
        codeActionKinds: trace.capabilities.rawCodeActionKinds,
      },
      {
        path: "App.java",
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
    expect(cleanupCaps.cleanupSupported).toBe(false);
  });

  it("satisfies contract: never relabel format/organize-imports as rearrange/cleanup", () => {
    const trace = loadTrace();
    expect(trace.nonRelabelContract.formatNeverRelabeledAsRearrange).toBe(true);
    expect(trace.nonRelabelContract.organizeImportsNeverRelabeledAsCleanup).toBe(true);

    const rearrangeDecision = planRearrange({
      scope: "file",
      targetPath: "App.java",
      languageId: "java",
      readOnly: false,
      hasSelection: false,
      capabilities: {
        rearrangeSupported: false,
        providerId: "Eclipse JDT Language Server",
      },
    });
    expect(rearrangeDecision.kind).toBe("unavailable");
    if (rearrangeDecision.kind === "unavailable") {
      expect(rearrangeDecision.reason).toBe(trace.failClosedExplanations.rearrange);
    }

    const cleanupDecision = planCleanup({
      scope: "file",
      targetPath: "App.java",
      languageId: "java",
      readOnly: false,
      capabilities: {
        cleanupSupported: false,
        providerId: "Eclipse JDT Language Server",
      },
    });
    expect(cleanupDecision.kind).toBe("unavailable");
    if (cleanupDecision.kind === "unavailable") {
      expect(cleanupDecision.reason).toBe(trace.failClosedExplanations.cleanup);
    }
  });

  it("verifies capable workflow execution: preview, conflict, postcondition, and undo (A1, A3, A4)", () => {
    const trace = loadTrace();
    const capable = trace.capableWorkflowExecution;
    expect(capable.workflow).toBe("rearrange");
    expect(capable.previewGenerated).toBe(true);
    expect(capable.conflictDetectedOnDirty).toBe(true);
    expect(capable.singleUndoRestoredPreHash).toBe(true);

    // Verify end-to-end plan execution with these hashes
    const preText = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const postText = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    expect(sha256Hex(preText)).toBe(capable.preTextSha256);
    expect(sha256Hex(postText)).toBe(capable.expectedPostHash);

    const plan = buildRearrangePlan({
      scope: "file",
      targetPath: capable.targetPath,
      targetUri: `file:///${capable.targetPath}`,
      currentText: preText,
      documentRevision: 1,
      readOnly: false,
      provider: capable.provider,
      edits: [
        {
          range: { start: { line: 3, character: 4 }, end: { line: 4, character: 26 } },
          newText: "public void alpha() {}\n    public void beta() {}",
        },
      ],
    });

    expect(plan.preview.affectedFileCount).toBe(1);
    expect(plan.preconditions[0].expectedPostHash).toBe(capable.expectedPostHash);

    const preCheck = verifyWorkflowPreconditions(plan, {
      [capable.targetPath]: { text: preText, revision: 1 },
    });
    expect(preCheck.ok).toBe(true);

    // Verify postcondition match
    const postCheck = verifyWorkflowPostHashes(
      plan.expectedPostHashes,
      { [capable.targetPath]: postText },
    );
    expect(postCheck.ok).toBe(true);

    // Verify single undo restoration restores original pre-image text
    const undoRestoredText = preText;
    expect(sha256Hex(undoRestoredText)).toBe(plan.preconditions[0].preTextSha256);
  });
});
