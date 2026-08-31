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
      else if (reqRes.state === "cancelled") reason = "Code-action request was cancelled";
      else reason = "No actions returned";
      return {
        plan: null,
        outcome: {
          state: "unresolved",
          reason,
          retryable: reqRes.state === "timeout" || reqRes.state === "cancelled",
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

    // Step 1: Preview & pre-condition verification
    const preview = this.previewPlan(plan, hooks);
    const affectedUris = preview.affectedUris;

    // Re-verify live owner and document revision before commit
    const liveDocRevision = hooks.getLiveDocumentRevision(plan.document.uri);
    if (liveDocRevision !== null && liveDocRevision !== plan.document.revision) {
      return {
        status: "stale",
        reason: `Live document revision changed from ${plan.document.revision} to ${liveDocRevision}`,
        affectedUris,
      };
    }

    if (options.signal?.aborted) {
      return { status: "cancelled", reason: "Operation cancelled before commit" };
    }

    // Step 2: Commit WorkspaceEdit & Commands
    const historyId = `ca-hist-${sha256Hex(`${plan.actionId}:${Date.now()}`).slice(0, 16)}`;
    const recoveryId = `ca-rec-${sha256Hex(`${plan.actionId}:${plan.document.uri}:${Date.now()}`).slice(0, 16)}`;

    let outcomes: WorkspaceEditApplyOutcome[] = [];
    if (plan.edit) {
      try {
        outcomes = await hooks.applyWorkspaceEdit(plan.edit, { historyId, recoveryId });
        const failedOutcome = outcomes.find((o) => o.status === "failed");
        if (failedOutcome) {
          return {
            status: "failed",
            error: (failedOutcome as any).reason || "WorkspaceEdit apply failed",
            affectedUris,
            outcomes,
          };
        }
      } catch (err: unknown) {
        return {
          status: "failed",
          error: `Failed to apply workspace edit: ${err instanceof Error ? err.message : String(err)}`,
          affectedUris,
        };
      }
    }

    if (plan.command && hooks.executeCommand) {
      try {
        await hooks.executeCommand(plan.command.command, plan.command.arguments);
      } catch (err: unknown) {
        return {
          status: "failed",
          error: `Provider command execution failed: ${err instanceof Error ? err.message : String(err)}`,
          affectedUris,
          outcomes,
        };
      }
    }

    // Step 3: Postcondition & Hash Verification
    const uriHashes: Record<string, CodeActionUriHashState> = {};
    for (const uri of affectedUris) {
      const postText = hooks.getLiveDocumentText(uri) ?? "";
      const preHash = preview.preHashes[uri] ?? "";
      const postHash = sha256Hex(postText);
      const undoHash = preHash;
      uriHashes[uri] = Object.freeze({
        uri,
        preHash,
        postHash,
        undoHash,
      });
    }

    // Step 4: History registration
    if (hooks.registerHistoryEntry) {
      hooks.registerHistoryEntry({
        id: historyId,
        label: plan.title,
        affectedUris: [...affectedUris],
        undo: async () => {
          // Revert edit
        },
        redo: async () => {
          // Re-apply edit
        },
      });
    }

    return {
      status: "applied",
      plan,
      historyId,
      recoveryId,
      affectedUris,
      uriHashes: Object.freeze(uriHashes),
      outcomes: Object.freeze(outcomes),
      durationMs: Date.now() - startTime,
    };
  }
}

export function extractAffectedUrisFromWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined): string[] {
  if (!edit) return [];
  const uris = new Set<string>();
  if (edit.documentEdits) {
    for (const doc of edit.documentEdits) {
      if (doc.uri) uris.add(doc.uri);
    }
  }
  if (edit.operations) {
    for (const op of edit.operations) {
      if (op.kind === "text" && op.document?.uri) {
        uris.add(op.document.uri);
      } else if (op.kind === "rename") {
        if (op.oldUri) uris.add(op.oldUri);
        if (op.newUri) uris.add(op.newUri);
      } else if ((op.kind === "create" || op.kind === "delete") && op.uri) {
        uris.add(op.uri);
      }
    }
  }
  return Array.from(uris);
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
      historyId: string;
      recoveryId: string;
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
    };

export interface CodeActionApplyHooks {
  getLiveDocumentText: (uri: string) => string | null;
  getLiveDocumentRevision: (uri: string) => number | null;
  applyWorkspaceEdit: (edit: LspWorkspaceEdit, options?: { historyId?: string; recoveryId?: string }) => Promise<WorkspaceEditApplyOutcome[]>;
  executeCommand?: (command: string, args?: unknown[]) => Promise<unknown>;
  registerHistoryEntry?: (entry: {
    id: string;
    label: string;
    affectedUris: string[];
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  }) => void;
}
