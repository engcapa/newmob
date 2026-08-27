import { describe, expect, it } from "vitest";
import type { LspCodeAction } from "../../../lib/editor/lsp";
import { buildCapabilityEvidence } from "./capabilityEvidence";
import {
  candidateFromLocalAction,
  candidateFromProviderAction,
  IntentionSession,
  intentionCandidateId,
} from "./intentionSession";

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
});
