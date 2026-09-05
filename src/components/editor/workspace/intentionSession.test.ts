import { describe, expect, it } from "vitest";
import type { LspCodeAction } from "../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "./capabilityEvidence";
import {
  candidateFromLocalAction,
  candidateFromProviderAction,
  IntentionSession,
  intentionCandidateId,
} from "./intentionSession";
import {
  CanonicalCodeActionService,
  type CodeActionContextIdentity,
  type CodeActionProviderClient,
} from "./codeActionProviderAdapter";

const evidence = () => buildCapabilityEvidence({
  capabilityId: "codeAction.quickfix",
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 3 },
  projectFingerprint: "f".repeat(64),
  uri: "file:///repo/A.java",
  revision: 9,
});

const providerAction = (title: string, overrides: Partial<LspCodeAction> = {}): LspCodeAction => ({
  title,
  kind: "quickfix",
  isPreferred: false,
  edit: null,
  command: null,
  commandArguments: null,
  raw: null,
  ...overrides,
});

describe("IntentionSession §8.20.4 frozen candidates", () => {
  it("freezes the candidate list at open; mutations never leak in", () => {
    const session = new IntentionSession();
    const original = [candidateFromProviderAction(providerAction("Import 'StringUtils'"), evidence())];
    const snapshot = session.open(original, {
      fileKey: "a.java",
      uri: "file:///repo/a.java",
      documentRevision: 5,
      providerGeneration: 2,
      projectFingerprint: "f".repeat(64),
    });
    original.push(candidateFromProviderAction(providerAction("Late arrival"), null));
    expect(snapshot.candidates).toHaveLength(1);
    expect(session.getState()!.candidates).toHaveLength(1);
    // Frozen entries reject mutation.
    expect(Object.isFrozen(snapshot.candidates[0])).toBe(true);
    session.dispose();
  });

  it("groups provider and local actions with stable labels and order", () => {
    const session = new IntentionSession();
    const snapshot = session.open([
      candidateFromLocalAction({ id: "local.copyRef", title: "Copy Reference", kind: "editor.clipboard" }),
      candidateFromProviderAction(providerAction("Suppress: unused import", { kind: "source.suppress" }), null),
      candidateFromProviderAction(providerAction("Import 'Foo'"), null),
    ], {
      fileKey: "a.java",
      uri: "file:///a.java",
      documentRevision: 1,
      providerGeneration: 1,
      projectFingerprint: "f".repeat(64),
    });
    expect(snapshot.groups.map((group) => group.source)).toEqual([
      "provider-code-action",
      "local-editor-action",
    ]);
    expect(snapshot.groups[0]!.label).toBe("Provider code actions");
    expect(snapshot.groups[0]!.candidates).toHaveLength(2);
    session.dispose();
  });

  it("tracks resolve state per id; failure keeps candidates and stays retryable", () => {
    const session = new IntentionSession();
    const candidate = candidateFromProviderAction(
      providerAction("Import 'StringUtils'", { raw: { title: "x", data: { uri: "//server" } } }),
      evidence(),
    );
    const snapshot = session.open([candidate], {
      fileKey: "a.java",
      uri: "file:///a.java",
      documentRevision: 5,
      providerGeneration: 2,
      projectFingerprint: "f".repeat(64),
    });
    expect(candidate.resolveRequired).toBe(true);
    const id = snapshot.candidates[0]!.id;

    session.markResolving(id);
    expect(session.getResolveState(id).status).toBe("resolving");

    // Resolve timeout/failure: candidates KEPT, state retryable.
    session.markFailed(id, "resolve timed out after 15000ms");
    expect(session.getState()!.candidates).toHaveLength(1);
    expect(session.getResolveState(id)).toEqual({
      status: "failed",
      message: "resolve timed out after 15000ms",
      retryable: true,
    });

    // Retry path resolves cleanly.
    session.markResolving(id);
    session.markResolved(id);
    expect(session.getResolveState(id).status).toBe("resolved");
    session.dispose();
  });

  it("derives stable ids that survive re-request order changes for identical actions", () => {
    const first = intentionCandidateId({ source: "provider-code-action", kind: "quickfix", title: "Same fix" });
    const again = intentionCandidateId({ source: "provider-code-action", kind: "quickfix", title: "Same fix" });
    expect(first).toBe(again);
    // Different identity fields produce different ids.
    expect(first).not.toBe(intentionCandidateId({ source: "local-editor-action", kind: "quickfix", title: "Same fix" }));
  });

  it("disambiguates duplicate identities inside one freeze with occurrence suffixes", () => {
    const session = new IntentionSession();
    const snapshot = session.open([
      candidateFromProviderAction(providerAction("Import 'Foo'"), null),
      candidateFromProviderAction(providerAction("Import 'Foo'"), null),
    ], {
      fileKey: "a.java",
      uri: "file:///a.java",
      documentRevision: 1,
      providerGeneration: 1,
      projectFingerprint: "f".repeat(64),
    });
    const [firstId, secondId] = snapshot.candidates.map((candidate) => candidate.id);
    expect(firstId).not.toBe(secondId);
    expect(secondId!.startsWith(`${firstId}.`)).toBe(true);
    session.dispose();
  });

  it("marks preferred candidates and passes disabled reasons through", () => {
    const preferred = candidateFromProviderAction(
      providerAction("Import 'Foo'", { isPreferred: true }),
      null,
    );
    expect(preferred.preferred).toBe(true);
    const disabled = candidateFromLocalAction({
      id: "local.x",
      title: "Expand selection",
      kind: "editor.selection",
      disabledReason: "no selection",
    });
    expect(disabled.disabledReason).toBe("no selection");
    expect(disabled.resolveRequired).toBe(false);
    expect(disabled.evidence).toBeNull();
  });

  describe("§ED-ACTION-002: Lightbulb & Alt+Enter Canonical Service Migration", () => {
    it("shares identical request/action/result flow across Lightbulb and Alt+Enter funnels", async () => {
      const canonicalService = new CanonicalCodeActionService();
      const session = new IntentionSession();

      const context: CodeActionContextIdentity = {
        document: {
          uri: "file:///workspace/src/App.java",
          revision: 5,
          languageId: "java",
        },
        provider: {
          id: "jdtls",
          version: "1.61.0",
          generation: 2,
          projectFingerprint: "fp-test",
          trusted: true,
        },
        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 0 } },
        diagnostics: [],
      };

      const rawAction: LspCodeAction = {
        title: "Import 'java.util.Map'",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { data: { fqn: "java.util.Map" } },
      };

      const client: CodeActionProviderClient = {
        requestCodeActions: async () => [rawAction],
        resolveCodeAction: async (act) => ({
          ...act,
          edit: {
            documentEdits: [
              {
                uri: "file:///workspace/src/App.java",
                path: "/workspace/src/App.java",
                edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import java.util.Map;\n" }],
              },
            ],
          },
        }),
      };

      // 1. Both Lightbulb and Alt+Enter request candidates via CanonicalCodeActionService
      const requestRes = await canonicalService.requestCandidates(context, client);
      expect(requestRes.state).toBe("ready");
      if (requestRes.state === "ready") {
        expect(requestRes.actions).toHaveLength(1);
        const candidate = candidateFromProviderAction(requestRes.actions[0]!.action, requestRes.actions[0]!.evidence);

        // 2. Both freeze into IntentionSession
        const snapshot = session.open([candidate], {
          fileKey: "src/App.java",
          uri: context.document.uri,
          documentRevision: context.document.revision,
          providerGeneration: context.provider.generation,
          projectFingerprint: context.provider.projectFingerprint,
        });

        expect(snapshot.candidates).toHaveLength(1);
        const frozenCandidate = snapshot.candidates[0]!;
        expect(frozenCandidate.title).toBe("Import 'java.util.Map'");

        // 3. User clicks -> resolvePlan via CanonicalCodeActionService
        session.markResolving(frozenCandidate.id);
        expect(session.getResolveState(frozenCandidate.id).status).toBe("resolving");

        const resolveOutcome = await canonicalService.resolvePlan(
          { ...frozenCandidate, rawAction: requestRes.actions[0]!.action },
          context,
          client,
          5, // current revision
          2, // current generation
        );

        expect(resolveOutcome.state).toBe("resolved");
        if (resolveOutcome.state === "resolved") {
          session.markResolved(frozenCandidate.id);
          expect(session.getResolveState(frozenCandidate.id).status).toBe("resolved");
          expect(resolveOutcome.plan.edit?.documentEdits).toHaveLength(1);
        }
      }
    });

    it("enforces stale zero-apply when document revision advances before resolve", async () => {
      const canonicalService = new CanonicalCodeActionService();
      const session = new IntentionSession();

      const context: CodeActionContextIdentity = {
        document: {
          uri: "file:///workspace/src/App.java",
          revision: 5,
          languageId: "java",
        },
        provider: {
          id: "jdtls",
          version: "1.61.0",
          generation: 2,
          projectFingerprint: "fp-test",
          trusted: true,
        },
        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 0 } },
        diagnostics: [],
      };

      const rawAction: LspCodeAction = {
        title: "Import 'java.util.List'",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { data: {} },
      };

      const candidate = candidateFromProviderAction(rawAction, evidence());
      session.open([candidate], {
        fileKey: "src/App.java",
        uri: context.document.uri,
        documentRevision: 5,
        providerGeneration: 2,
        projectFingerprint: "fp-test",
      });

      const client: CodeActionProviderClient = {
        requestCodeActions: async () => [rawAction],
        resolveCodeAction: async (act) => act,
      };

      // Document advanced to revision 6
      const resolveOutcome = await canonicalService.resolvePlan(
        { ...candidate, rawAction },
        context,
        client,
        6, // stale revision!
        2,
      );

      expect(resolveOutcome.state).toBe("stale");
      if (resolveOutcome.state === "stale") {
        session.markFailed(candidate.id, resolveOutcome.reason);
        expect(session.getResolveState(candidate.id).status).toBe("failed");
      }
    });

    it("keeps candidate list visible and allows retry on resolve failure/timeout", async () => {
      const canonicalService = new CanonicalCodeActionService();
      const session = new IntentionSession();

      const context: CodeActionContextIdentity = {
        document: {
          uri: "file:///workspace/src/App.java",
          revision: 1,
          languageId: "java",
        },
        provider: {
          id: "jdtls",
          version: "1.61.0",
          generation: 1,
          projectFingerprint: "fp-test",
          trusted: true,
        },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        diagnostics: [],
      };

      const rawAction: LspCodeAction = {
        title: "Extract Method",
        kind: "refactor.extract",
        isPreferred: false,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { data: {} },
      };

      const candidate = candidateFromProviderAction(rawAction, evidence());
      session.open([candidate], {
        fileKey: "src/App.java",
        uri: context.document.uri,
        documentRevision: 1,
        providerGeneration: 1,
        projectFingerprint: "fp-test",
      });

      let fail = true;
      const client: CodeActionProviderClient = {
        requestCodeActions: async () => [rawAction],
        resolveCodeAction: async (act) => {
          if (fail) throw new Error("Resolve connection timed out");
          return {
            ...act,
            edit: { documentEdits: [] },
          };
        },
      };

      // 1. Initial attempt fails
      session.markResolving(candidate.id);
      const outcomeFail = await canonicalService.resolvePlan(
        { ...candidate, rawAction },
        context,
        client,
        1,
        1,
      );
      expect(outcomeFail.state).toBe("unresolved");
      if (outcomeFail.state === "unresolved") {
        session.markFailed(candidate.id, outcomeFail.reason);
      }
      expect(session.getResolveState(candidate.id)).toEqual({
        status: "failed",
        message: expect.stringContaining("Resolve connection timed out"),
        retryable: true,
      });
      // Candidate list preserved!
      expect(session.getState()!.candidates).toHaveLength(1);

      // 2. Retry succeeds
      fail = false;
      session.markResolving(candidate.id);
      const outcomeRetry = await canonicalService.resolvePlan(
        { ...candidate, rawAction },
        context,
        client,
        1,
        1,
      );
      expect(outcomeRetry.state).toBe("resolved");
      session.markResolved(candidate.id);
      expect(session.getResolveState(candidate.id).status).toBe("resolved");
    });
  });
});
