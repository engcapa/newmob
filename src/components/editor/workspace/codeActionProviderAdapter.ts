import type { LspCodeAction, LspDiagnostic, LspRange, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import {
  buildCapabilityEvidence,
  type BuildEvidenceInput,
  type CapabilityEvidenceV3,
} from "./capabilityEvidence";
import { sha256Hex } from "./projectAnalysisModel";

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

export interface DocumentIdentity {
  uri: string;
  revision: number;
  languageId: string;
}

export interface ProviderIdentity {
  id: string;
  version?: string | null;
  generation: number;
  projectFingerprint: string;
  trusted?: boolean;
}

export interface CodeActionContextIdentity {
  document: DocumentIdentity;
  provider: ProviderIdentity;
  range: LspRange;
  diagnostics: readonly LspDiagnostic[];
  only?: readonly string[];
}

export interface CodeActionCandidate {
  id: string;
  title: string;
  kind: string;
  isPreferred?: boolean;
  preferred?: boolean;
  disabledReason: string | null;
  resolveRequired: boolean;
  rawAction: LspCodeAction;
  evidence?: CapabilityEvidenceV3 | null;
}

export interface ImmutableCodeActionPlan {
  actionId: string;
  title: string;
  kind: string;
  document: DocumentIdentity;
  provider: ProviderIdentity;
  edit: LspWorkspaceEdit | null;
  command: { command: string; arguments?: unknown[] } | null;
  evidence: CapabilityEvidenceV3 | null;
  createdAt: number;
}

export type CodeActionResolveOutcome =
  | { state: "resolved"; plan: ImmutableCodeActionPlan }
  | { state: "unresolved"; reason: string; retryable: boolean }
  | { state: "stale"; reason: string }
  | { state: "rejected"; reason: "untrusted" | "language-mismatch" | "command-disallowed" | "malformed" };

export const DEFAULT_ALLOWED_COMMAND_PREFIXES = [
  "editor.action.",
  "workspace.",
  "_java.",
  "java.",
  "rust-analyzer.",
  "typescript.",
  "eslint.",
  "quickfix.",
] as const;

export function isCommandAllowed(command: string, customAllowlist?: readonly string[]): boolean {
  if (!command || typeof command !== "string") return false;
  const allowlist = customAllowlist ?? DEFAULT_ALLOWED_COMMAND_PREFIXES;
  return allowlist.some((prefix) => command.startsWith(prefix) || command === prefix);
}

export function computeStableActionId(
  action: { title: string; kind?: string | null },
  providerId: string,
): string {
  const hash = sha256Hex(`${providerId} ${action.kind ?? ""} ${action.title}`).slice(0, 16);
  return `codeAction.${providerId}.${hash}`;
}

export interface CodeActionProviderClient {
  requestCodeActions: (params: ReturnType<typeof buildCodeActionParams>) => Promise<readonly LspCodeAction[] | null>;
  resolveCodeAction?: (action: LspCodeAction) => Promise<LspCodeAction | null>;
  checkCapability?: () => { supported: boolean; reason?: string };
}

/**
 * §8.21.4 Canonical Code Action Service (§ED-ACTION-001).
 * Single authoritative pipeline for:
 * `capability -> request -> stable id -> resolve -> immutable plan`
 */
export class CanonicalCodeActionService {
  /**
   * Pipeline step 1 & 2: Capability check & Request execution -> Typed candidates with stable IDs.
   */
  async requestCandidates(
    context: CodeActionContextIdentity,
    client: CodeActionProviderClient,
    options: { timeoutMs?: number } = {},
  ): Promise<CodeActionProviderResultV4> {
    const { document, provider, range, diagnostics, only } = context;
    const timeoutMs = options.timeoutMs ?? 10_000;

    const evidenceInput = {
      languageId: document.languageId,
      provider: { id: provider.id, version: provider.version ?? "1.0.0", generation: provider.generation },
      projectFingerprint: provider.projectFingerprint,
      uri: document.uri,
      revision: document.revision,
    };

    // Unknown or plaintext files must never default to Java provider (§ED-ACTION-001)
    if (document.languageId === "plaintext" && provider.id === "jdtls") {
      return evaluateCodeActionResult(
        { kind: "unsupported", reason: "Java language server cannot serve plaintext documents" },
        evidenceInput,
      );
    }

    if (provider.trusted === false) {
      return evaluateCodeActionResult(
        { kind: "unsupported", reason: "Code actions from untrusted provider are disabled" },
        evidenceInput,
      );
    }

    if (client.checkCapability) {
      const cap = client.checkCapability();
      if (!cap.supported) {
        return evaluateCodeActionResult(
          { kind: "unsupported", reason: cap.reason ?? "Code actions unsupported by provider" },
          evidenceInput,
        );
      }
    }

    const params = buildCodeActionParams(document.uri, range, diagnostics, only);
    const requestId = `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    try {
      const resultPromise = client.requestCodeActions(params);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CODE_ACTION_TIMEOUT")), timeoutMs);
      });

      const rawActions = await Promise.race([resultPromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });

      if (!rawActions) {
        return evaluateCodeActionResult({ kind: "ready", actions: [] }, evidenceInput);
      }

      // Filter out malformed actions (e.g. missing or non-string title)
      const validActions = rawActions.filter((a): a is LspCodeAction => {
        return a != null && typeof a === "object" && typeof a.title === "string" && a.title.trim().length > 0;
      });

      return evaluateCodeActionResult({ kind: "ready", actions: validActions }, evidenceInput);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "CODE_ACTION_TIMEOUT" || message.includes("timeout") || message.includes("Timeout")) {
        return evaluateCodeActionResult(
          {
            kind: "timeout",
            requestId,
            cancelled: true,
            providerStillHealthy: true,
            retryAfter: "manual",
          },
          evidenceInput,
        );
      }
      return evaluateCodeActionResult(
        {
          kind: "failed",
          message: `Code action request failed: ${message}`,
          providerStillHealthy: true,
        },
        evidenceInput,
      );
    }
  }

  /**
   * Pipeline step 3 & 4: Resolve & Immutable Plan generation.
   */
  async resolvePlan(
    candidate: CodeActionCandidate,
    context: CodeActionContextIdentity,
    client: CodeActionProviderClient,
    currentDocumentRevision: number,
    currentProviderGeneration: number,
    options: { timeoutMs?: number; allowedCommands?: readonly string[] } = {},
  ): Promise<CodeActionResolveOutcome> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const { document, provider } = context;

    // Check for stale document or provider generation (§ED-ACTION-001)
    if (currentDocumentRevision !== document.revision) {
      return {
        state: "stale",
        reason: `Document revision changed from ${document.revision} to ${currentDocumentRevision}`,
      };
    }
    if (currentProviderGeneration !== provider.generation) {
      return {
        state: "stale",
        reason: `Provider generation changed from ${provider.generation} to ${currentProviderGeneration}`,
      };
    }

    if (provider.trusted === false) {
      return { state: "rejected", reason: "untrusted" };
    }

    // Java language guard
    const isJavaSpecific =
      Boolean(candidate.kind?.startsWith("quickfix.import.java")) ||
      Boolean(candidate.rawAction.command?.includes("_java.")) ||
      Boolean(candidate.rawAction.command?.includes("java."));
    if (isJavaSpecific && document.languageId !== "java") {
      return { state: "rejected", reason: "language-mismatch" };
    }

    let resolvedAction = candidate.rawAction;
    if (candidate.resolveRequired && client.resolveCodeAction) {
      try {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const resolvePromise = client.resolveCodeAction(candidate.rawAction);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("RESOLVE_TIMEOUT")), timeoutMs);
        });

        const outcome = await Promise.race([resolvePromise, timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer);
        });

        if (outcome) {
          resolvedAction = outcome;
        } else {
          return { state: "unresolved", reason: "Provider returned null on resolve", retryable: true };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          state: "unresolved",
          reason: `Resolve failed: ${message}`,
          retryable: !message.includes("stale"),
        };
      }
    }

    // Extract edit & command
    let effectiveEdit = resolvedAction.edit ?? null;
    let effectiveCommand: { command: string; arguments?: unknown[] } | null = null;

    if (resolvedAction.command) {
      const args = resolvedAction.commandArguments;
      effectiveCommand = {
        command: resolvedAction.command,
        arguments: Array.isArray(args) ? args : args !== null && args !== undefined ? [args] : undefined,
      };
    }

    // Unpack workspaceEdit embedded in commandArguments if applicable
    const isApplyEditCommand =
      effectiveCommand?.command === "_java.apply.workspaceEdit" ||
      effectiveCommand?.command === "java.apply.workspaceEdit" ||
      effectiveCommand?.command === "editor.action.applyWorkspaceEdit" ||
      effectiveCommand?.command === "applyWorkspaceEdit";

    if (!effectiveEdit && isApplyEditCommand && Array.isArray(effectiveCommand?.arguments)) {
      const firstArg = effectiveCommand.arguments[0] as Record<string, unknown> | undefined;
      if (firstArg && (firstArg.changes || firstArg.documentChanges || firstArg.documentEdits || firstArg.operations)) {
        effectiveEdit = firstArg as unknown as LspWorkspaceEdit;
        effectiveCommand = null;
      }
    }

    // If there is a command remaining, validate against command allowlist
    if (effectiveCommand && !isCommandAllowed(effectiveCommand.command, options.allowedCommands)) {
      return { state: "rejected", reason: "command-disallowed" };
    }

    const plan: ImmutableCodeActionPlan = Object.freeze({
      actionId: candidate.id,
      title: resolvedAction.title || candidate.title,
      kind: resolvedAction.kind || candidate.kind,
      document: Object.freeze({ ...document }),
      provider: Object.freeze({ ...provider }),
      edit: effectiveEdit ? Object.freeze(JSON.parse(JSON.stringify(effectiveEdit))) : null,
      command: effectiveCommand ? Object.freeze({ ...effectiveCommand }) : null,
      evidence: candidate.evidence ?? null,
      createdAt: Date.now(),
    });

    return { state: "resolved", plan };
  }

  /**
   * Plan-only execution mode (§ED-ACTION-003).
   * Retrieves and resolves code actions (e.g. organizeImports) into an immutable plan
   * without applying any live buffer mutations, disk writes, or undo history entries.
   */
  async planAction(
    context: CodeActionContextIdentity,
    client: CodeActionProviderClient,
    options: {
      only?: readonly string[];
      timeoutMs?: number;
      allowedCommands?: readonly string[];
    } = {},
  ): Promise<PlanOnlyCodeActionResult> {
    const reqContext = options.only ? { ...context, only: options.only } : context;
    const reqRes = await this.requestCandidates(reqContext, client, { timeoutMs: options.timeoutMs });

    if (reqRes.state !== "ready" || reqRes.actions.length === 0) {
      return {
        plan: null,
        outcome: {
          state: "unresolved",
          reason: reqRes.state === "unsupported" ? reqRes.reason : reqRes.state === "failed" ? reqRes.message : "No actions returned",
          retryable: reqRes.state === "timeout",
        },
        effectCounters: { liveEdits: 0, diskWrites: 0, historyEntries: 0 },
      };
    }

    // Pick first matching or preferred action
    const providerAction = reqRes.actions.find((a) => a.action.isPreferred) ?? reqRes.actions[0]!;
    const candidate: CodeActionCandidate = {
      id: computeStableActionId(providerAction.action, context.provider.id),
      title: providerAction.action.title,
      kind: providerAction.action.kind ?? "",
      isPreferred: providerAction.action.isPreferred,
      disabledReason: providerAction.disabledReason,
      resolveRequired: Boolean(providerAction.action.raw && typeof providerAction.action.raw === "object" && "data" in providerAction.action.raw),
      rawAction: providerAction.action,
      evidence: providerAction.evidence,
    };

    const resolveOutcome = await this.resolvePlan(
      candidate,
      context,
      client,
      context.document.revision,
      context.provider.generation,
      { timeoutMs: options.timeoutMs, allowedCommands: options.allowedCommands },
    );

    return {
      plan: resolveOutcome.state === "resolved" ? resolveOutcome.plan : null,
      outcome: resolveOutcome,
      effectCounters: { liveEdits: 0, diskWrites: 0, historyEntries: 0 },
    };
  }
}

export interface PlanOnlyCodeActionResult {
  plan: ImmutableCodeActionPlan | null;
  outcome: CodeActionResolveOutcome;
  effectCounters: {
    liveEdits: 0;
    diskWrites: 0;
    historyEntries: 0;
  };
}
