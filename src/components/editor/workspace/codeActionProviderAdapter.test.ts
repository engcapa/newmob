import { describe, expect, it, vi } from "vitest";
import type { LspCodeAction, LspDiagnostic, LspRange } from "../../../lib/editor/lsp";
import {
  buildCodeActionClientCapabilities,
  buildCodeActionParams,
  evaluateCodeActionResult,
  toProviderActionsV4,
} from "./codeActionProviderAdapter";
import {
  IntentionSession,
  candidateFromProviderAction,
  verifyIntentionPreconditions,
} from "./intentionSession";
import { executeCodeAction } from "./codeActionExecution";

const testEvidenceInput = {
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 3 },
  projectFingerprint: "fp-test-1234",
  uri: "file:///workspace/src/App.java",
  revision: 5,
} as const;

const sampleDiagnostic: LspDiagnostic = {
  range: { start: { line: 10, character: 2 }, end: { line: 10, character: 15 } },
  severity: 1,
  code: "cannot-resolve",
  source: "Java",
  message: "StringUtils cannot be resolved",
};

const sampleRange: LspRange = {
  start: { line: 10, character: 2 },
  end: { line: 10, character: 15 },
};

describe("§8.21.4 V3 codeActionProviderAdapter", () => {
  it("builds canonical request params and client capabilities", () => {
    const params = buildCodeActionParams("file:///test.java", sampleRange, [sampleDiagnostic], ["quickfix", " "]);
    expect(params.textDocument.uri).toBe("file:///test.java");
    expect(params.range).toEqual(sampleRange);
    expect(params.context.diagnostics).toEqual([sampleDiagnostic]);
    expect(params.context.only).toEqual(["quickfix"]);

    const capabilities = buildCodeActionClientCapabilities();
    expect(capabilities.dynamicRegistration).toBe(true);
    expect(capabilities.isPreferredSupport).toBe(true);
    expect(capabilities.dataSupport).toBe(true);
    expect((capabilities.codeActionLiteralSupport as any)?.codeActionKind?.valueSet).toContain("quickfix");
  });

  it("evaluates ready provider outcome into CodeActionProviderResultV4", () => {
    const action: LspCodeAction = {
      title: "Import 'StringUtils'",
      kind: "quickfix",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { data: { fqn: "org.apache.commons.lang3.StringUtils" } },
    };
    const result = evaluateCodeActionResult(
      { kind: "ready", actions: [action] },
      testEvidenceInput,
    );

    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].action.title).toBe("Import 'StringUtils'");
      expect(result.actions[0].evidence.capabilityId).toBe("codeAction.intention");
      expect(result.actions[0].evidence.coverage.complete).toBe(true);
    }
  });

  it("evaluates unsupported provider outcome with actionable reason", () => {
    const result = evaluateCodeActionResult(
      { kind: "unsupported", reason: "Language server version (jdtls 1.61) does not support codeAction" },
      testEvidenceInput,
    );

    expect(result.state).toBe("unsupported");
    if (result.state === "unsupported") {
      expect(result.reason).toContain("jdtls 1.61");
      expect(result.evidence.coverage.complete).toBe(false);
      expect(result.evidence.coverage.reason).toContain("jdtls 1.61");
    }
  });

  it("evaluates timeout outcome with cancellation tracking and retry policy", () => {
    const result = evaluateCodeActionResult(
      {
        kind: "timeout",
        requestId: "ca-req-999",
        cancelled: true,
        providerStillHealthy: true,
        retryAfter: "manual",
      },
      testEvidenceInput,
    );

    expect(result.state).toBe("timeout");
    if (result.state === "timeout") {
      expect(result.requestId).toBe("ca-req-999");
      expect(result.cancelled).toBe(true);
      expect(result.providerStillHealthy).toBe(true);
      expect(result.retryAfter).toBe("manual");
    }
  });

  it("evaluates failed outcome without faking actions", () => {
    const result = evaluateCodeActionResult(
      { kind: "failed", message: "Server connection reset", providerStillHealthy: false },
      testEvidenceInput,
    );

    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.message).toBe("Server connection reset");
      expect(result.providerStillHealthy).toBe(false);
    }
  });
});

describe("§8.21.4 V3 Intention session recovery and preconditions", () => {
  it("freezes candidate list, marks timeout without losing candidates, and allows retry with new requestId", () => {
    const session = new IntentionSession();
    const action: LspCodeAction = {
      title: "Add import",
      kind: "quickfix",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { data: {} },
    };

    const providerActions = toProviderActionsV4([action], testEvidenceInput);
    const candidates = providerActions.map((pa) => candidateFromProviderAction(pa.action, pa.evidence));

    const snapshot = session.open(candidates, {
      fileKey: "k1",
      uri: testEvidenceInput.uri,
      documentRevision: testEvidenceInput.revision,
      providerGeneration: testEvidenceInput.provider.generation,
      projectFingerprint: testEvidenceInput.projectFingerprint,
    });

    expect(snapshot.candidates).toHaveLength(1);
    const candidateId = snapshot.candidates[0].id;

    // Resolving
    session.markResolving(candidateId, "req-1");
    expect(session.getResolveState(candidateId)).toEqual({ status: "resolving", requestId: "req-1" });

    // Timeout: candidate remains in list, state becomes retryable with requestId
    session.markTimeout(candidateId, "req-1");
    const timeoutState = session.getResolveState(candidateId);
    expect(timeoutState.status).toBe("failed");
    if (timeoutState.status === "failed") {
      expect(timeoutState.retryable).toBe(true);
      expect(timeoutState.requestId).toBe("req-1");
      expect(timeoutState.message).toContain("timed out");
    }
    // Candidate still exists!
    expect(session.getCandidate(candidateId)).not.toBeNull();

    // Retry with new request id
    session.markResolving(candidateId, "req-2");
    expect(session.getResolveState(candidateId)).toEqual({ status: "resolving", requestId: "req-2" });

    session.markResolved(candidateId);
    expect(session.getResolveState(candidateId)).toEqual({ status: "resolved" });

    session.dispose();
  });

  it("verifies intention preconditions and blocks stale revisions or fingerprints", () => {
    const context = {
      fileKey: "k1",
      uri: "file:///App.java",
      documentRevision: 10,
      providerGeneration: 2,
      projectFingerprint: "fp-abc",
      openedAt: Date.now(),
    };

    // Exactly matching -> valid
    const ok = verifyIntentionPreconditions(context, {
      documentRevision: 10,
      providerGeneration: 2,
      projectFingerprint: "fp-abc",
    });
    expect(ok.valid).toBe(true);

    // Stale document revision -> blocked
    const staleDoc = verifyIntentionPreconditions(context, {
      documentRevision: 11,
      providerGeneration: 2,
      projectFingerprint: "fp-abc",
    });
    expect(staleDoc).toEqual({ valid: false, reason: "revision-changed" });

    // Stale provider generation -> blocked
    const staleGen = verifyIntentionPreconditions(context, {
      documentRevision: 10,
      providerGeneration: 3,
      projectFingerprint: "fp-abc",
    });
    expect(staleGen).toEqual({ valid: false, reason: "generation-changed" });

    // Changed project fingerprint -> blocked
    const staleFp = verifyIntentionPreconditions(context, {
      documentRevision: 10,
      providerGeneration: 2,
      projectFingerprint: "fp-xyz",
    });
    expect(staleFp).toEqual({ valid: false, reason: "fingerprint-changed" });
  });

  it("executeCodeAction rejects execution when precondition check fails", async () => {
    const action: LspCodeAction = {
      title: "Fix",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: {},
    };

    const applyEdit = vi.fn();
    const executeCommand = vi.fn();

    const outcome = await executeCodeAction(
      action,
      { applyEdit, executeCommand },
      () => ({ valid: false, reason: "document-revision-advanced" }),
    );

    expect(outcome).toEqual({
      status: "stale-precondition",
      reason: "document-revision-advanced",
      outcomes: [],
    });
    expect(applyEdit).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
