import { describe, expect, it, vi } from "vitest";
import type { LspCodeAction, LspDiagnostic, LspRange } from "../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "./capabilityEvidence";
import {
  buildCodeActionClientCapabilities,
  buildCodeActionParams,
  evaluateCodeActionResult,
  toProviderActionsV4,
  CanonicalCodeActionService,
  computeStableActionId,
  isCommandAllowed,
  type CodeActionContextIdentity,
  type CodeActionCandidate,
  type CodeActionProviderClient,
  type ImmutableCodeActionPlan,
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

  describe("§ED-ACTION-001: Canonical Code Action Service Core", () => {
    const service = new CanonicalCodeActionService();

    const sampleContext: CodeActionContextIdentity = {
      document: {
        uri: "file:///workspace/src/Main.java",
        revision: 4,
        languageId: "java",
      },
      provider: {
        id: "jdtls",
        version: "1.61.0",
        generation: 2,
        projectFingerprint: "fp-test-456",
        trusted: true,
      },
      range: sampleRange,
      diagnostics: [sampleDiagnostic],
    };

    it("generates stable deterministic action ID across re-requests and ordering changes", () => {
      const id1 = computeStableActionId({ title: "Import 'List'", kind: "quickfix" }, "jdtls");
      const id2 = computeStableActionId({ title: "Import 'List'", kind: "quickfix" }, "jdtls");
      const idDifferent = computeStableActionId({ title: "Import 'Set'", kind: "quickfix" }, "jdtls");

      expect(id1).toBe(id2);
      expect(id1).not.toBe(idDifferent);
      expect(id1).toMatch(/^codeAction\.jdtls\.[a-f0-9]{16}$/);
    });

    it("validates command-only allowlist with known safe prefixes", () => {
      expect(isCommandAllowed("_java.apply.workspaceEdit")).toBe(true);
      expect(isCommandAllowed("java.apply.workspaceEdit")).toBe(true);
      expect(isCommandAllowed("editor.action.applyWorkspaceEdit")).toBe(true);
      expect(isCommandAllowed("rust-analyzer.applySourceChange")).toBe(true);
      expect(isCommandAllowed("quickfix.addImport")).toBe(true);

      // Disallowed dangerous or arbitrary commands
      expect(isCommandAllowed("shell.executeScript")).toBe(false);
      expect(isCommandAllowed("system.runCommand")).toBe(false);
      expect(isCommandAllowed("")).toBe(false);
    });

    it("refuses to query Java provider for plaintext or unknown files", async () => {
      const plaintextContext: CodeActionContextIdentity = {
        ...sampleContext,
        document: {
          uri: "file:///workspace/README.txt",
          revision: 1,
          languageId: "plaintext",
        },
      };
      const requestCodeActions = vi.fn();

      const res = await service.requestCandidates(plaintextContext, { requestCodeActions });

      expect(res.state).toBe("unsupported");
      if (res.state === "unsupported") {
        expect(res.reason).toContain("plaintext");
      }
      expect(requestCodeActions).not.toHaveBeenCalled();
    });

    it("refuses to query code actions from untrusted provider", async () => {
      const untrustedContext: CodeActionContextIdentity = {
        ...sampleContext,
        provider: {
          ...sampleContext.provider,
          trusted: false,
        },
      };
      const requestCodeActions = vi.fn();

      const res = await service.requestCandidates(untrustedContext, { requestCodeActions });

      expect(res.state).toBe("unsupported");
      if (res.state === "unsupported") {
        expect(res.reason).toContain("untrusted");
      }
      expect(requestCodeActions).not.toHaveBeenCalled();
    });

    it("handles timeout, throw, null, and malformed actions during request", async () => {
      // 1. Throw
      const throwClient = {
        requestCodeActions: vi.fn().mockRejectedValue(new Error("LSP connection dropped")),
      };
      const resThrow = await service.requestCandidates(sampleContext, throwClient);
      expect(resThrow.state).toBe("failed");
      if (resThrow.state === "failed") {
        expect(resThrow.message).toContain("LSP connection dropped");
      }

      // 2. Null response -> ready with empty actions
      const nullClient = {
        requestCodeActions: vi.fn().mockResolvedValue(null),
      };
      const resNull = await service.requestCandidates(sampleContext, nullClient);
      expect(resNull.state).toBe("ready");
      if (resNull.state === "ready") {
        expect(resNull.actions).toEqual([]);
      }

      // 3. Malformed actions -> filtered to valid actions only
      const malformedClient = {
        requestCodeActions: vi.fn().mockResolvedValue([
          null,
          { title: "" }, // empty title
          { kind: "quickfix" }, // missing title
          { title: "Valid Quickfix", kind: "quickfix" },
        ]),
      };
      const resMalformed = await service.requestCandidates(sampleContext, malformedClient);
      expect(resMalformed.state).toBe("ready");
      if (resMalformed.state === "ready") {
        expect(resMalformed.actions).toHaveLength(1);
        expect(resMalformed.actions[0].action.title).toBe("Valid Quickfix");
      }

      // 4. Timeout
      const timeoutClient = {
        requestCodeActions: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 50)),
        ),
      };
      const resTimeout = await service.requestCandidates(sampleContext, timeoutClient, { timeoutMs: 10 });
      expect(resTimeout.state).toBe("timeout");
      if (resTimeout.state === "timeout") {
        expect(resTimeout.cancelled).toBe(true);
      }
    });

    it("resolves candidate into an immutable plan and detects stale document / provider generations", async () => {
      const candidate: CodeActionCandidate = {
        id: "codeAction.jdtls.1234567890abcdef",
        title: "Import 'java.util.List'",
        kind: "quickfix",
        isPreferred: true,
        disabledReason: null,
        resolveRequired: true,
        rawAction: {
          title: "Import 'java.util.List'",
          kind: "quickfix",
          isPreferred: true,
          edit: null,
          command: null,
          commandArguments: null,
          raw: { data: { fqn: "java.util.List" } },
        },
        evidence: buildCapabilityEvidence({
          capabilityId: "codeAction.intention",
          languageId: "java",
          provider: { id: "jdtls", version: "1.61.0", generation: 2 },
          projectFingerprint: "fp-test-456",
          uri: "file:///workspace/src/Main.java",
          revision: 4,
          complete: true,
          reason: "ok",
        }),
      };

      const resolvedAction: LspCodeAction = {
        ...candidate.rawAction,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/Main.java",
              path: "/workspace/src/Main.java",
              edits: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: "import java.util.List;\n",
                },
              ],
            },
          ],
        },
      };

      const client = {
        requestCodeActions: vi.fn(),
        resolveCodeAction: vi.fn().mockResolvedValue(resolvedAction),
      };

      // 1. Success resolve -> returns immutable plan
      const outcome = await service.resolvePlan(candidate, sampleContext, client, 4, 2);
      expect(outcome.state).toBe("resolved");
      if (outcome.state === "resolved") {
        expect(outcome.plan.actionId).toBe(candidate.id);
        expect(outcome.plan.title).toBe(candidate.title);
        expect(outcome.plan.edit).toBeDefined();
        expect(Object.isFrozen(outcome.plan)).toBe(true);
        expect(Object.isFrozen(outcome.plan.document)).toBe(true);
        expect(Object.isFrozen(outcome.plan.provider)).toBe(true);
      }

      // 2. Stale document revision -> blocked
      const staleDocOutcome = await service.resolvePlan(candidate, sampleContext, client, 5, 2);
      expect(staleDocOutcome.state).toBe("stale");
      if (staleDocOutcome.state === "stale") {
        expect(staleDocOutcome.reason).toContain("Document revision changed");
      }

      // 3. Stale provider generation -> blocked
      const staleGenOutcome = await service.resolvePlan(candidate, sampleContext, client, 4, 3);
      expect(staleGenOutcome.state).toBe("stale");
      if (staleGenOutcome.state === "stale") {
        expect(staleGenOutcome.reason).toContain("Provider generation changed");
      }

      // 4. Command allowlist rejection
      const disallowedCommandCandidate: CodeActionCandidate = {
        ...candidate,
        resolveRequired: false,
        rawAction: {
          ...candidate.rawAction,
          command: "unauthorized.system.command",
        },
      };
      const disallowedOutcome = await service.resolvePlan(disallowedCommandCandidate, sampleContext, client, 4, 2);
      expect(disallowedOutcome.state).toBe("rejected");
      if (disallowedOutcome.state === "rejected") {
        expect(disallowedOutcome.reason).toBe("command-disallowed");
      }
    });
  });

  describe("§ED-ACTION-003: Problems, Context Menu, and Save Plan-Only", () => {
    const service = new CanonicalCodeActionService();

    const sampleContext: CodeActionContextIdentity = {
      document: {
        uri: "file:///workspace/src/SaveService.java",
        revision: 10,
        languageId: "java",
      },
      provider: {
        id: "jdtls",
        version: "1.61.0",
        generation: 4,
        projectFingerprint: "fp-save-999",
        trusted: true,
      },
      range: { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } },
      diagnostics: [],
    };

    it("executes organize imports in plan-only mode with zero live edits, disk writes, or history entries", async () => {
      const organizeAction: LspCodeAction = {
        title: "Organize Imports",
        kind: "source.organizeImports",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { data: { organize: true } },
      };

      const resolvedAction: LspCodeAction = {
        ...organizeAction,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/SaveService.java",
              path: "/workspace/src/SaveService.java",
              edits: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
                  newText: "import java.util.List;\nimport java.util.Map;\n",
                },
              ],
            },
          ],
        },
      };

      const client: CodeActionProviderClient = {
        requestCodeActions: vi.fn().mockResolvedValue([organizeAction]),
        resolveCodeAction: vi.fn().mockResolvedValue(resolvedAction),
      };

      const planResult = await service.planAction(sampleContext, client, {
        only: ["source.organizeImports"],
      });

      expect(planResult.outcome.state).toBe("resolved");
      expect(planResult.plan).not.toBeNull();
      expect(planResult.plan?.title).toBe("Organize Imports");
      expect(planResult.plan?.edit?.documentEdits).toHaveLength(1);

      // Effect counters strictly zero
      expect(planResult.effectCounters).toEqual({
        liveEdits: 0,
        diskWrites: 0,
        historyEntries: 0,
      });
    });

    it("returns plan: null and zero effect counters when organize imports is unsupported or fails", async () => {
      const client: CodeActionProviderClient = {
        requestCodeActions: vi.fn().mockResolvedValue([]),
      };

      const planResult = await service.planAction(sampleContext, client, {
        only: ["source.organizeImports"],
      });

      expect(planResult.plan).toBeNull();
      expect(planResult.outcome.state).toBe("unresolved");
      expect(planResult.effectCounters).toEqual({
        liveEdits: 0,
        diskWrites: 0,
        historyEntries: 0,
      });
    });

    it("shares CanonicalCodeActionService across Problems, Context Menu, and Save entry points", async () => {
      // Problems entrypoint
      const problemDiagnostic: LspDiagnostic = {
        range: { start: { line: 5, character: 2 }, end: { line: 5, character: 10 } },
        message: "Unused variable",
        severity: 2,
        code: "unused",
        source: "Java",
      };
      const problemContext: CodeActionContextIdentity = {
        ...sampleContext,
        range: problemDiagnostic.range,
        diagnostics: [problemDiagnostic],
      };

      const quickFixAction: LspCodeAction = {
        title: "Remove unused variable",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [
            {
              uri: "file:///workspace/src/SaveService.java",
              path: "/workspace/src/SaveService.java",
              edits: [{ range: problemDiagnostic.range, newText: "" }],
            },
          ],
        },
        command: null,
        commandArguments: null,
        raw: null,
      };

      const problemClient: CodeActionProviderClient = {
        requestCodeActions: vi.fn().mockResolvedValue([quickFixAction]),
      };

      const reqRes = await service.requestCandidates(problemContext, problemClient);
      expect(reqRes.state).toBe("ready");
      if (reqRes.state === "ready") {
        expect(reqRes.actions).toHaveLength(1);
        expect(reqRes.actions[0]!.action.title).toBe("Remove unused variable");

        const planRes = await service.resolvePlan(
          {
            id: "codeAction.jdtls.problemFix",
            title: reqRes.actions[0]!.action.title,
            kind: reqRes.actions[0]!.action.kind ?? "",
            isPreferred: true,
            disabledReason: null,
            resolveRequired: false,
            rawAction: reqRes.actions[0]!.action,
            evidence: reqRes.actions[0]!.evidence,
          },
          problemContext,
          problemClient,
          10,
          4,
        );

        expect(planRes.state).toBe("resolved");
        if (planRes.state === "resolved") {
          expect(planRes.plan.edit?.documentEdits).toHaveLength(1);
        }
      }
    });
  });

  describe("§ED-ACTION-004: Preview, Commit, Postcondition, and History", () => {
    const service = new CanonicalCodeActionService();

    const samplePlan: ImmutableCodeActionPlan = {
      actionId: "action-multi-rename-1",
      title: "Rename Symbol Across Files",
      kind: "refactor.rename",
      document: {
        uri: "file:///workspace/src/Service.java",
        revision: 3,
        languageId: "java",
      },
      provider: {
        id: "jdtls",
        version: "1.61.0",
        generation: 2,
        projectFingerprint: "fp-test-4",
        trusted: true,
      },
      edit: {
        documentEdits: [
          {
            uri: "file:///workspace/src/Service.java",
            path: "/workspace/src/Service.java",
            edits: [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 15 } }, newText: "NewService" }],
          },
          {
            uri: "file:///workspace/src/Client.java",
            path: "/workspace/src/Client.java",
            edits: [{ range: { start: { line: 4, character: 10 }, end: { line: 4, character: 20 } }, newText: "NewService" }],
          },
        ],
      },
      command: {
        command: "java.action.logRename",
        arguments: ["Service", "NewService"],
      },
      evidence: null,
      createdAt: Date.now(),
    };

    it("previews multi-file edits, computes pre-hashes, and flags confirmation", () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
        "file:///workspace/src/Client.java": "new OldService();",
      };

      const preview = service.previewPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
      });

      expect(preview.affectedUris).toEqual([
        "file:///workspace/src/Service.java",
        "file:///workspace/src/Client.java",
      ]);
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.preHashes["file:///workspace/src/Service.java"]).toBeDefined();
      expect(preview.preHashes["file:///workspace/src/Client.java"]).toBeDefined();
    });

    it("applies multi-file edit, returns history/recovery IDs, and records pre/post/undo hashes", async () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
        "file:///workspace/src/Client.java": "new OldService();",
      };

      let registeredHistory: { id: string; label: string; affectedUris: string[] } | null = null;
      let executedCommandName: string | null = null;

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: (uri) => (uri === "file:///workspace/src/Service.java" ? 3 : null),
        applyWorkspaceEdit: async () => {
          liveFiles["file:///workspace/src/Service.java"] = "class NewService {}";
          liveFiles["file:///workspace/src/Client.java"] = "new NewService();";
          return [
            { operationIndex: 0, path: "/workspace/src/Service.java", status: "applied-open", dirty: true },
            { operationIndex: 1, path: "/workspace/src/Client.java", status: "applied-disk" },
          ];
        },
        executeCommand: async (cmd) => {
          executedCommandName = cmd;
        },
        registerHistoryEntry: (entry) => {
          registeredHistory = entry;
        },
      });

      expect(outcome.status).toBe("applied");
      if (outcome.status === "applied") {
        expect(outcome.historyId).toMatch(/^ca-hist-/);
        expect(outcome.recoveryId).toMatch(/^ca-rec-/);
        expect(outcome.affectedUris).toHaveLength(2);
        expect(executedCommandName).toBe("java.action.logRename");
        expect(registeredHistory).not.toBeNull();
        expect((registeredHistory as { id: string } | null)?.id).toBe(outcome.historyId);

        // Pre/post/undo hash validation
        const serviceHash = outcome.uriHashes["file:///workspace/src/Service.java"]!;
        expect(serviceHash.preHash).not.toBe(serviceHash.postHash);
        expect(serviceHash.undoHash).toBe(serviceHash.preHash);

        const clientHash = outcome.uriHashes["file:///workspace/src/Client.java"]!;
        expect(clientHash.preHash).not.toBe(clientHash.postHash);
        expect(clientHash.undoHash).toBe(clientHash.preHash);
      }
    });

    it("detects live owner document revision changes before commit and rejects with stale", async () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
      };

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: () => 4, // Live document moved from 3 -> 4!
        applyWorkspaceEdit: async () => [],
      });

      expect(outcome.status).toBe("stale");
      if (outcome.status === "stale") {
        expect(outcome.reason).toContain("Live document revision changed from 3 to 4");
      }
    });

    it("respects abort signal and cancels before commit with zero apply", async () => {
      const controller = new AbortController();
      controller.abort();

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: () => "",
        getLiveDocumentRevision: () => 3,
        applyWorkspaceEdit: async () => [],
      }, { signal: controller.signal });

      expect(outcome.status).toBe("cancelled");
    });

    it("surfaces provider command failures visibly without masking errors", async () => {
      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: () => "text",
        getLiveDocumentRevision: () => 3,
        applyWorkspaceEdit: async () => [{ operationIndex: 0, path: "/workspace/src/Service.java", status: "applied-open", dirty: true }],
        executeCommand: async () => {
          throw new Error("LSP command execution timed out on language server");
        },
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.error).toContain("LSP command execution timed out on language server");
      }
    });
  });
});
