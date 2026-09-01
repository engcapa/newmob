import type { LspCodeAction, LspDiagnostic, LspRange, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import {
  buildCapabilityEvidence,
  type BuildEvidenceInput,
  type CapabilityEvidenceV3,
} from "./capabilityEvidence";
import { sha256Hex } from "./projectAnalysisModel";
import type { WorkspaceEditApplyOutcome } from "./workspaceEditApply";

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
 * Provider responses are strictly categorized: ready actions, null/empty,
 * malformed, version-level unsupported, timeout, caller cancellation, or
 * failure without faking completion.
 */
export type CodeActionProviderResultV4 =
  | {
    state: "ready";
    actions: readonly ProviderActionV4[];
    evidence: CapabilityEvidenceV3;
    discardedMalformedCount: number;
  }
  | { state: "empty"; reason: "null-response"; evidence: CapabilityEvidenceV3 }
  | {
    state: "malformed";
    message: string;
    malformedCount: number;
    providerStillHealthy: boolean;
    evidence: CapabilityEvidenceV3;
  }
  | { state: "unsupported"; reason: string; evidence: CapabilityEvidenceV3 }
  | { state: "timeout"; requestId: string; cancelled: boolean; providerStillHealthy: boolean; retryAfter: "manual" | "restart" }
  | { state: "cancelled"; requestId: string; reason: "aborted"; providerStillHealthy: boolean }
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
    | { kind: "ready"; actions: readonly LspCodeAction[]; discardedMalformedCount?: number }
    | { kind: "empty"; reason: "null-response" }
    | { kind: "malformed"; malformedCount: number; message: string }
    | { kind: "unsupported"; reason: string }
    | { kind: "timeout"; requestId: string; cancelled: boolean; providerStillHealthy: boolean; retryAfter: "manual" | "restart" }
    | { kind: "cancelled"; requestId: string; reason: "aborted"; providerStillHealthy: boolean }
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
      discardedMalformedCount: outcome.discardedMalformedCount ?? 0,
    };
  }
  if (outcome.kind === "empty") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: false,
      reason: "provider returned null instead of a code-action array",
    });
    return { state: "empty", reason: outcome.reason, evidence };
  }
  if (outcome.kind === "malformed") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: false,
      reason: outcome.message,
    });
    return {
      state: "malformed",
      message: outcome.message,
      malformedCount: outcome.malformedCount,
      providerStillHealthy: true,
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
  if (outcome.kind === "cancelled") {
    return {
      state: "cancelled",
      requestId: outcome.requestId,
      reason: outcome.reason,
      providerStillHealthy: outcome.providerStillHealthy,
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
  requestCodeActions: (
    params: ReturnType<typeof buildCodeActionParams>,
    signal?: AbortSignal,
  ) => Promise<readonly LspCodeAction[] | null>;
  resolveCodeAction?: (action: LspCodeAction, signal?: AbortSignal) => Promise<LspCodeAction | null>;
  checkCapability?: () => { supported: boolean; reason?: string };
}

function cloneAndDeepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndDeepFreeze(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneAndDeepFreeze(item)]),
    );
    return Object.freeze(clone) as T;
  }
  return value;
}

export function snapshotCodeActionContext(context: CodeActionContextIdentity): CodeActionContextIdentity {
  return cloneAndDeepFreeze(context);
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
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CodeActionProviderResultV4> {
    const frozenContext = snapshotCodeActionContext(context);
    const { document, provider, range, diagnostics, only } = frozenContext;
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
    if (options.signal?.aborted) {
      return evaluateCodeActionResult(
        { kind: "cancelled", requestId, reason: "aborted", providerStillHealthy: true },
        evidenceInput,
      );
    }

    const requestAbort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectCancellation!: (reason: Error) => void;
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = () => {
      rejectCancellation(new Error("CODE_ACTION_CANCELLED"));
      requestAbort.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const resultPromise = client.requestCodeActions(params, requestAbort.signal);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("CODE_ACTION_TIMEOUT"));
          requestAbort.abort();
        }, timeoutMs);
      });
      const rawActions = await Promise.race([
        resultPromise,
        timeoutPromise,
        cancellationPromise,
      ]);

      if (!rawActions) {
        return evaluateCodeActionResult({ kind: "empty", reason: "null-response" }, evidenceInput);
      }

      // Filter out malformed actions (e.g. missing or non-string title)
      const validActions = rawActions.filter((a): a is LspCodeAction => {
        return a != null && typeof a === "object" && typeof a.title === "string" && a.title.trim().length > 0;
      });
      const malformedCount = rawActions.length - validActions.length;
      if (validActions.length === 0 && malformedCount > 0) {
        return evaluateCodeActionResult({
          kind: "malformed",
          malformedCount,
          message: `Provider returned ${malformedCount} malformed code action${malformedCount === 1 ? "" : "s"}`,
        }, evidenceInput);
      }

      return evaluateCodeActionResult({
        kind: "ready",
        actions: validActions.map((action) => cloneAndDeepFreeze(action)),
        discardedMalformedCount: malformedCount,
      }, evidenceInput);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "CODE_ACTION_CANCELLED") {
        return evaluateCodeActionResult(
          { kind: "cancelled", requestId, reason: "aborted", providerStillHealthy: true },
          evidenceInput,
        );
      }
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
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
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
    const frozenContext = snapshotCodeActionContext(context);
    const frozenCandidate = cloneAndDeepFreeze(candidate);
    const { document, provider } = frozenContext;

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
      Boolean(frozenCandidate.kind?.startsWith("quickfix.import.java")) ||
      Boolean(frozenCandidate.rawAction.command?.includes("_java.")) ||
      Boolean(frozenCandidate.rawAction.command?.includes("java."));
    if (isJavaSpecific && document.languageId !== "java") {
      return { state: "rejected", reason: "language-mismatch" };
    }

    let resolvedAction = frozenCandidate.rawAction;
    if (frozenCandidate.resolveRequired && client.resolveCodeAction) {
      try {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const resolvePromise = client.resolveCodeAction(frozenCandidate.rawAction);
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

    const plan = cloneAndDeepFreeze<ImmutableCodeActionPlan>({
      actionId: frozenCandidate.id,
      title: resolvedAction.title || frozenCandidate.title,
      kind: resolvedAction.kind || frozenCandidate.kind,
      document,
      provider,
      edit: effectiveEdit,
      command: effectiveCommand,
      evidence: frozenCandidate.evidence ?? null,
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
      let reason: string;
      if (reqRes.state === "unsupported") reason = reqRes.reason;
      else if (reqRes.state === "failed" || reqRes.state === "malformed") reason = reqRes.message;
      else if (reqRes.state === "empty") reason = "Provider returned a null code-action response";
      else if (reqRes.state === "timeout") reason = "Code-action request timed out";
      else if (reqRes.state === "cancelled") reason = "Code-action request was cancelled";
      else reason = "No actions returned";
      return {
        plan: null,
        requestState: reqRes.state,
        outcome: {
          state: "unresolved",
          reason,
          retryable: reqRes.state === "timeout" || reqRes.state === "cancelled",
        },
        effectCounters: { liveEdits: 0, diskWrites: 0, historyEntries: 0, commands: 0 },
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
      requestState: reqRes.state,
      outcome: resolveOutcome,
      effectCounters: { liveEdits: 0, diskWrites: 0, historyEntries: 0, commands: 0 },
    };
  }

  /**
   * Preview a resolved code action plan (§ED-ACTION-004).
   * Extracts affected URIs and computes pre-apply content hashes.
   */
  previewPlan(
    plan: ImmutableCodeActionPlan,
    hooks: Pick<CodeActionApplyHooks, "getLiveDocumentText">,
  ): CodeActionPlanPreview {
    const uris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
    if (uris.length === 0) uris.push(plan.document.uri);

    const preHashes: Record<string, string> = {};
    for (const uri of uris) {
      const text = hooks.getLiveDocumentText(uri) ?? "";
      preHashes[uri] = sha256Hex(text);
    }

    return {
      plan,
      affectedUris: Object.freeze(uris),
      requiresConfirmation: uris.length > 1,
      preHashes: Object.freeze(preHashes),
    };
  }

  /**
   * Apply a resolved code action plan through preview -> commit -> postcondition -> history (§ED-ACTION-004).
   */
  async applyPlan(
    plan: ImmutableCodeActionPlan,
    hooks: CodeActionApplyHooks,
    options: { signal?: AbortSignal } = {},
  ): Promise<CodeActionApplyOutcome> {
    const startTime = Date.now();
    if (options.signal?.aborted) {
      return { status: "cancelled", reason: "Operation cancelled before execution" };
    }

    const initialIdentity = verifyCodeActionApplyIdentity(plan, hooks);
    if (!initialIdentity.valid) {
      return {
        status: initialIdentity.status,
        reason: initialIdentity.reason,
        affectedUris: extractAffectedUrisFromWorkspaceEdit(plan.edit),
      };
    }

    const affectedUris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
    if (affectedUris.length === 0 && plan.edit) affectedUris.push(plan.document.uri);
    if (plan.edit && (!hooks.captureSnapshot || !hooks.restoreSnapshot || !hooks.registerHistoryEntry)) {
      return {
        status: "failed",
        error: "Canonical workspace-edit snapshot/history hooks are unavailable",
        affectedUris,
      };
    }

    const beforeSnapshot = plan.edit
      ? await captureCodeActionSnapshot(hooks, plan.edit)
      : null;
    if (plan.edit && !beforeSnapshot) {
      return {
        status: "failed",
        error: "Cannot capture every affected workspace resource before preview",
        affectedUris,
      };
    }
    const preview = beforeSnapshot
      ? previewFromSnapshot(plan, beforeSnapshot)
      : this.previewPlan(plan, hooks);
    const historyCandidateId = `ca-hist-${sha256Hex(`${plan.actionId}:${Date.now()}`).slice(0, 16)}`;
    const recoveryCandidateId = `ca-rec-${sha256Hex(`${plan.actionId}:${plan.document.uri}:${Date.now()}`).slice(0, 16)}`;

    let outcomes: WorkspaceEditApplyOutcome[] = [];
    let appliedEdit = plan.edit;
    const recoverMutation = async (error: string): Promise<CodeActionApplyOutcome> => {
      if (!plan.edit || !beforeSnapshot || !hooks.captureSnapshot || !hooks.restoreSnapshot) {
        return { status: "failed", error, affectedUris, outcomes };
      }

      const partialSnapshot = await captureCodeActionSnapshot(hooks, plan.edit);
      if (!partialSnapshot) {
        return {
          status: "failed",
          error,
          affectedUris,
          outcomes,
          recoveryId: recoveryCandidateId,
          recoveryState: "unavailable",
        };
      }
      const mutated = codeActionSnapshotMismatch(beforeSnapshot, partialSnapshot) !== null;
      if (!mutated) return { status: "failed", error, affectedUris, outcomes };
      const recover = async () => restoreAndVerifyCodeActionSnapshot(
        plan.edit!,
        partialSnapshot,
        beforeSnapshot,
        hooks,
      );
      try {
        await recover();
        return {
          status: "failed",
          error,
          affectedUris,
          outcomes,
          recoveryId: recoveryCandidateId,
          recoveryState: "performed",
        };
      } catch (recoveryError) {
        if (hooks.registerRecoveryEntry) {
          hooks.registerRecoveryEntry({
            id: recoveryCandidateId,
            label: plan.title,
            affectedUris: [...affectedUris],
            recover,
          });
          return {
            status: "failed",
            error: `${error}; automatic recovery failed: ${errorMessage(recoveryError)}`,
            affectedUris,
            outcomes,
            recoveryId: recoveryCandidateId,
            recoveryState: "registered",
          };
        }
        return {
          status: "failed",
          error: `${error}; automatic recovery failed: ${errorMessage(recoveryError)}`,
          affectedUris,
          outcomes,
          recoveryId: recoveryCandidateId,
          recoveryState: "unavailable",
        };
      }
    };

    if (plan.edit) {
      try {
        const applyResult = await hooks.applyWorkspaceEdit(plan.edit, {
          historyId: historyCandidateId,
          recoveryId: recoveryCandidateId,
          onBeforeCommit: async () => {
            if (options.signal?.aborted) {
              throw new Error("CODE_ACTION_CANCELLED: operation cancelled after preview");
            }
            const identity = verifyCodeActionApplyIdentity(plan, hooks);
            if (!identity.valid) {
              throw new Error(`CODE_ACTION_${identity.status.toUpperCase()}: ${identity.reason}`);
            }
            const liveSnapshot = await captureCodeActionSnapshot(hooks, plan.edit!);
            if (!liveSnapshot) {
              throw new Error("CODE_ACTION_CONFLICT: affected resources could not be re-read after preview");
            }
            const mismatch = codeActionSnapshotMismatch(beforeSnapshot!, liveSnapshot);
            if (mismatch) {
              throw new Error(`CODE_ACTION_CONFLICT: ${mismatch}`);
            }
          },
        });
        if (Array.isArray(applyResult)) {
          outcomes = applyResult;
        } else {
          outcomes = [...applyResult.outcomes];
          appliedEdit = applyResult.appliedEdit;
        }
        const rejected = outcomes.find((outcome) => (
          outcome.status === "failed" || outcome.status === "skipped"
        ));
        if (rejected) {
          if (rejected.operationIndex === null && !outcomes.some((outcome) => outcome.status.startsWith("applied"))) {
            if (rejected.status === "skipped") {
              return { status: "cancelled", reason: rejected.reason };
            }
            if (rejected.reason.startsWith("CODE_ACTION_CANCELLED:")) {
              return { status: "cancelled", reason: rejected.reason.slice("CODE_ACTION_CANCELLED:".length).trim() };
            }
            if (rejected.reason.startsWith("CODE_ACTION_STALE:")) {
              return {
                status: "stale",
                reason: rejected.reason.slice("CODE_ACTION_STALE:".length).trim(),
                affectedUris,
              };
            }
            if (rejected.reason.startsWith("CODE_ACTION_CONFLICT:")) {
              return {
                status: "conflict",
                reason: rejected.reason.slice("CODE_ACTION_CONFLICT:".length).trim(),
                affectedUris,
              };
            }
          }
          return recoverMutation(rejected.reason || "WorkspaceEdit apply failed");
        }
      } catch (err: unknown) {
        return recoverMutation(`Failed to apply workspace edit: ${errorMessage(err)}`);
      }
    }

    if (plan.command && hooks.executeCommand) {
      try {
        await hooks.executeCommand(plan.command.command, plan.command.arguments);
      } catch (err: unknown) {
        return recoverMutation(`Provider command execution failed: ${errorMessage(err)}`);
      }
    }

    const afterSnapshot = plan.edit && hooks.captureSnapshot
      ? await captureCodeActionSnapshot(hooks, plan.edit)
      : null;
    if (appliedEdit && !afterSnapshot) {
      return recoverMutation("Cannot read every affected workspace resource after commit");
    }

    const changed = beforeSnapshot && afterSnapshot
      ? codeActionSnapshotMismatch(beforeSnapshot, afterSnapshot) !== null
      : false;
    const uriHashes: Record<string, CodeActionUriHashState> = {};
    const committedUris = appliedEdit
      ? extractAffectedUrisFromWorkspaceEdit(appliedEdit)
      : affectedUris;
    for (const uri of committedUris) {
      const preHash = preview.preHashes[uri]
        ?? codeActionSnapshotHash(beforeSnapshot?.resources.find((resource) => resource.uri === uri));
      const postHash = codeActionSnapshotHash(afterSnapshot?.resources.find((resource) => resource.uri === uri));
      uriHashes[uri] = Object.freeze({
        uri,
        preHash,
        postHash,
        undoHash: preHash,
      });
    }

    let historyId: string | null = null;
    if (changed && plan.edit && appliedEdit && beforeSnapshot && afterSnapshot) {
      historyId = historyCandidateId;
      hooks.registerHistoryEntry!({
        id: historyId,
        label: plan.title,
        affectedUris: [...committedUris],
        undo: () => restoreAndVerifyCodeActionSnapshot(
          plan.edit!,
          afterSnapshot,
          beforeSnapshot,
          hooks,
        ),
        redo: () => restoreAndVerifyCodeActionSnapshot(
          plan.edit!,
          beforeSnapshot,
          afterSnapshot,
          hooks,
        ),
      });
    }

    return {
      status: "applied",
      plan,
      historyId,
      recoveryId: null,
      affectedUris: committedUris,
      uriHashes: Object.freeze(uriHashes),
      outcomes: Object.freeze(outcomes),
      durationMs: Date.now() - startTime,
    };
  }
}

export interface CodeActionAffectedResource {
  uri: string;
  path: string | null;
}

export function extractAffectedResourcesFromWorkspaceEdit(
  edit: LspWorkspaceEdit | null | undefined,
): CodeActionAffectedResource[] {
  if (!edit) return [];
  const resources: CodeActionAffectedResource[] = [];
  const seen = new Set<string>();
  const add = (uri: string, path: string | null) => {
    const key = path || uri;
    if (!key || seen.has(key)) return;
    seen.add(key);
    resources.push({ uri, path });
  };
  if (edit.documentEdits) {
    for (const doc of edit.documentEdits) {
      add(doc.uri, doc.path);
    }
  }
  if (edit.operations) {
    for (const op of edit.operations) {
      if (op.kind === "text" && op.document?.uri) {
        add(op.document.uri, op.document.path);
      } else if (op.kind === "rename") {
        add(op.oldUri, op.oldPath);
        add(op.newUri, op.newPath);
      } else if ((op.kind === "create" || op.kind === "delete") && op.uri) {
        add(op.uri, op.path);
      }
    }
  }
  return resources;
}

export function extractAffectedUrisFromWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined): string[] {
  return extractAffectedResourcesFromWorkspaceEdit(edit).map((resource) => resource.uri);
}

export interface PlanOnlyCodeActionResult {
  plan: ImmutableCodeActionPlan | null;
  requestState: CodeActionProviderResultV4["state"];
  outcome: CodeActionResolveOutcome;
  effectCounters: {
    liveEdits: 0;
    diskWrites: 0;
    historyEntries: 0;
    commands: 0;
  };
}

export interface CodeActionUriHashState {
  uri: string;
  preHash: string;
  postHash: string;
  undoHash: string;
}

export interface CodeActionPlanPreview {
  plan: ImmutableCodeActionPlan;
  affectedUris: readonly string[];
  requiresConfirmation: boolean;
  preHashes: Readonly<Record<string, string>>;
}

export type CodeActionApplyOutcome =
  | {
      status: "applied";
      plan: ImmutableCodeActionPlan;
      historyId: string | null;
      recoveryId: string | null;
      affectedUris: readonly string[];
      uriHashes: Readonly<Record<string, CodeActionUriHashState>>;
      outcomes: readonly WorkspaceEditApplyOutcome[];
      durationMs: number;
    }
  | {
      status: "stale" | "conflict";
      reason: string;
      affectedUris: readonly string[];
    }
  | {
      status: "cancelled";
      reason: string;
    }
  | {
      status: "failed";
      error: string;
      affectedUris: readonly string[];
      outcomes?: readonly WorkspaceEditApplyOutcome[];
      recoveryId?: string;
      recoveryState?: "performed" | "registered" | "unavailable";
    };

export interface CodeActionResourceSnapshot {
  uri: string;
  path: string;
  exists: boolean;
  text: string | null;
  encoding?: string;
  bom?: boolean;
  eol?: "lf" | "crlf" | "cr";
}

export interface CodeActionTransactionSnapshot {
  resources: readonly CodeActionResourceSnapshot[];
}

export interface CodeActionWorkspaceEditApplyResult {
  outcomes: readonly WorkspaceEditApplyOutcome[];
  appliedEdit: LspWorkspaceEdit;
}

export interface CodeActionApplyHooks {
  getLiveDocumentText: (uri: string) => string | null;
  getLiveDocumentRevision: (uri: string) => number | null;
  verifyIdentity?: () =>
    | { valid: true }
    | { valid: false; status: "stale" | "conflict"; reason: string };
  captureSnapshot?: (edit: LspWorkspaceEdit) => Promise<CodeActionTransactionSnapshot | null>;
  restoreSnapshot?: (snapshot: CodeActionTransactionSnapshot) => Promise<void>;
  applyWorkspaceEdit: (
    edit: LspWorkspaceEdit,
    options?: {
      historyId?: string;
      recoveryId?: string;
      onBeforeCommit?: () => Promise<void> | void;
    },
  ) => Promise<WorkspaceEditApplyOutcome[] | CodeActionWorkspaceEditApplyResult>;
  executeCommand?: (command: string, args?: unknown[]) => Promise<unknown>;
  registerHistoryEntry?: (entry: {
    id: string;
    label: string;
    affectedUris: string[];
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  }) => void;
  registerRecoveryEntry?: (entry: {
    id: string;
    label: string;
    affectedUris: string[];
    recover: () => Promise<void>;
  }) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verifyCodeActionApplyIdentity(
  plan: ImmutableCodeActionPlan,
  hooks: CodeActionApplyHooks,
): { valid: true } | { valid: false; status: "stale" | "conflict"; reason: string } {
  const liveDocRevision = hooks.getLiveDocumentRevision(plan.document.uri);
  if (liveDocRevision !== null && liveDocRevision !== plan.document.revision) {
    return {
      valid: false,
      status: "stale",
      reason: `Live document revision changed from ${plan.document.revision} to ${liveDocRevision}`,
    };
  }
  return hooks.verifyIdentity?.() ?? { valid: true };
}

function freezeCodeActionSnapshot(
  snapshot: CodeActionTransactionSnapshot | null,
): CodeActionTransactionSnapshot | null {
  if (!snapshot) return null;
  return Object.freeze({
    resources: Object.freeze(snapshot.resources.map((resource) => Object.freeze({ ...resource }))),
  });
}

async function captureCodeActionSnapshot(
  hooks: CodeActionApplyHooks,
  edit: LspWorkspaceEdit,
): Promise<CodeActionTransactionSnapshot | null> {
  if (!hooks.captureSnapshot) return null;
  try {
    return freezeCodeActionSnapshot(await hooks.captureSnapshot(edit));
  } catch {
    return null;
  }
}

function codeActionSnapshotKey(resource: CodeActionResourceSnapshot): string {
  return resource.path || resource.uri;
}

function codeActionSnapshotMismatch(
  expected: CodeActionTransactionSnapshot,
  current: CodeActionTransactionSnapshot,
): string | null {
  const currentByKey = new Map(current.resources.map((resource) => [codeActionSnapshotKey(resource), resource]));
  for (const resource of expected.resources) {
    const live = currentByKey.get(codeActionSnapshotKey(resource));
    if (!live) return `${resource.uri} is no longer readable`;
    if (
      live.exists !== resource.exists
      || live.text !== resource.text
      || live.encoding !== resource.encoding
      || live.bom !== resource.bom
      || live.eol !== resource.eol
    ) {
      return `${resource.uri} no longer matches the previewed preimage`;
    }
  }
  return null;
}

function codeActionSnapshotHash(resource: CodeActionResourceSnapshot | undefined): string {
  if (!resource || !resource.exists || resource.text === null) {
    return sha256Hex("CODE_ACTION_RESOURCE_MISSING");
  }
  return sha256Hex(resource.text);
}

function previewFromSnapshot(
  plan: ImmutableCodeActionPlan,
  snapshot: CodeActionTransactionSnapshot,
): CodeActionPlanPreview {
  const affectedUris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
  if (affectedUris.length === 0) affectedUris.push(plan.document.uri);
  const preHashes = Object.fromEntries(affectedUris.map((uri) => [
    uri,
    codeActionSnapshotHash(snapshot.resources.find((resource) => resource.uri === uri)),
  ]));
  return {
    plan,
    affectedUris: Object.freeze(affectedUris),
    requiresConfirmation: affectedUris.length > 1,
    preHashes: Object.freeze(preHashes),
  };
}

async function restoreAndVerifyCodeActionSnapshot(
  edit: LspWorkspaceEdit,
  expectedCurrent: CodeActionTransactionSnapshot,
  target: CodeActionTransactionSnapshot,
  hooks: CodeActionApplyHooks,
): Promise<void> {
  if (!hooks.captureSnapshot || !hooks.restoreSnapshot) {
    throw new Error("Code-action snapshot replay is unavailable");
  }
  const current = await captureCodeActionSnapshot(hooks, edit);
  if (!current) throw new Error("Cannot read resources before code-action replay");
  if (codeActionSnapshotMismatch(target, current) === null) return;
  const conflict = codeActionSnapshotMismatch(expectedCurrent, current);
  if (conflict) throw new Error(`Code-action replay conflict: ${conflict}`);
  await hooks.restoreSnapshot(target);
  const restored = await captureCodeActionSnapshot(hooks, edit);
  if (!restored) throw new Error("Cannot verify resources after code-action replay");
  const mismatch = codeActionSnapshotMismatch(target, restored);
  if (mismatch) throw new Error(`Code-action replay postcondition failed: ${mismatch}`);
}
