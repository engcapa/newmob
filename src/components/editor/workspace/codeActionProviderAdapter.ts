import type { LspCodeAction, LspDiagnostic, LspRange } from "../../../lib/editor/lsp";
import {
  buildCapabilityEvidence,
  type BuildEvidenceInput,
  type CapabilityEvidenceV3,
} from "./capabilityEvidence";

/**
 * §8.21.4 V3: Typed provider action contract with capability evidence and
 * disabled reason.
 */
export interface ProviderActionV4 {
  action: LspCodeAction;
  evidence: CapabilityEvidenceV3;
  disabledReason: string | null;
}

/**
 * §8.21.4 V3 CodeActionProviderResultV4 union.
 * Provider responses are strictly categorized: ready actions, version-level
 * unsupported with actionable reason, timeout with cancellation tracking,
 * or failure without faking completion.
 */
export type CodeActionProviderResultV4 =
  | { state: "ready"; actions: readonly ProviderActionV4[]; evidence: CapabilityEvidenceV3 }
  | { state: "unsupported"; reason: string; evidence: CapabilityEvidenceV3 }
  | { state: "timeout"; requestId: string; cancelled: boolean; providerStillHealthy: boolean; retryAfter: "manual" | "restart" }
  | { state: "failed"; message: string; providerStillHealthy: boolean };

/**
 * Canonical CodeAction request parameter builder (§8.21.4).
 * Shared between production adapter and fixture runner to guarantee
 * identical client protocol payloads.
 */
export function buildCodeActionParams(
  uri: string,
  range: LspRange,
  diagnostics: readonly LspDiagnostic[],
  only?: readonly string[] | null,
): {
  textDocument: { uri: string };
  range: LspRange;
  context: {
    diagnostics: readonly LspDiagnostic[];
    only?: readonly string[];
  };
} {
  const filteredOnly = only && only.length > 0
    ? only.map((k) => k.trim()).filter(Boolean)
    : undefined;
  return {
    textDocument: { uri },
    range,
    context: {
      diagnostics,
      ...(filteredOnly && filteredOnly.length > 0 ? { only: filteredOnly } : {}),
    },
  };
}

/**
 * Standard client capabilities for code action negotiation (§8.21.4).
 */
export function buildCodeActionClientCapabilities(): Record<string, unknown> {
  return {
    dynamicRegistration: true,
    codeActionLiteralSupport: {
      codeActionKind: {
        valueSet: [
          "",
          "quickfix",
          "refactor",
          "refactor.extract",
          "refactor.inline",
          "refactor.rewrite",
          "source",
          "source.organizeImports",
          "source.fixAll",
        ],
      },
    },
    isPreferredSupport: true,
    dataSupport: true,
    resolveSupport: {
      properties: ["edit", "command"],
    },
  };
}

/**
 * Maps raw provider actions into ProviderActionV4 with evidence.
 */
export function toProviderActionsV4(
  actions: readonly LspCodeAction[],
  evidenceInput: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">,
  disabledReason: string | null = null,
): ProviderActionV4[] {
  const evidence = buildCapabilityEvidence({
    ...evidenceInput,
    capabilityId: "codeAction.intention",
    complete: true,
    reason: "provider code actions returned for diagnostic context",
  });
  return actions.map((action) => ({
    action,
    evidence,
    disabledReason,
  }));
}

/**
 * Evaluates provider result into CodeActionProviderResultV4 envelope.
 */
export function evaluateCodeActionResult(
  outcome:
    | { kind: "ready"; actions: readonly LspCodeAction[] }
    | { kind: "unsupported"; reason: string }
    | { kind: "timeout"; requestId: string; cancelled: boolean; providerStillHealthy: boolean; retryAfter: "manual" | "restart" }
    | { kind: "failed"; message: string; providerStillHealthy: boolean },
  evidenceInput: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">,
): CodeActionProviderResultV4 {
  if (outcome.kind === "ready") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: true,
      reason: "provider code actions returned",
    });
    return {
      state: "ready",
      actions: toProviderActionsV4(outcome.actions, evidenceInput),
      evidence,
    };
  }
  if (outcome.kind === "unsupported") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: false,
      reason: outcome.reason,
    });
    return {
      state: "unsupported",
      reason: outcome.reason,
      evidence,
    };
  }
  if (outcome.kind === "timeout") {
    return {
      state: "timeout",
      requestId: outcome.requestId,
      cancelled: outcome.cancelled,
      providerStillHealthy: outcome.providerStillHealthy,
      retryAfter: outcome.retryAfter,
    };
  }
  return {
    state: "failed",
    message: outcome.message,
    providerStillHealthy: outcome.providerStillHealthy,
  };
}
