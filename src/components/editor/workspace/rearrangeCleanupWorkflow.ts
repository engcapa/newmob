/**
 * ED-STYLE-002 / C8-D: Rearrange Code & Code Cleanup independent workflows.
 *
 * Dedicated planner, execution gates, preview, and verification for
 * Rearrange Code and Code Cleanup workflows.
 * These actions FAIL CLOSED with honest, typed explanations when the language
 * server/provider does not advertise dedicated rearrange/cleanup capabilities.
 * They never disguise format or organize imports as rearrange/cleanup.
 */

import type {
  LspCapabilitySummary,
  LspDocumentStatus,
  LspTextEdit,
  LspWorkspaceEdit,
} from "../../../lib/editor/lsp";
import { applyLspTextEditsToString } from "./lspTextEdits";
import { sha256Hex } from "./projectAnalysisModel";
import {
  buildWorkspaceEditPreview,
  type WorkspaceEditPreview,
} from "./workspaceEditPreview";

export interface RearrangeCapabilities {
  rearrangeSupported: boolean;
  providerId?: string;
  providerVersion?: string;
}

export interface RearrangeInput {
  scope: "selection" | "file";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  hasSelection: boolean;
  capabilities: RearrangeCapabilities;
}

export type RearrangeDecision =
  | {
      kind: "execute";
      scope: "selection" | "file";
      stage: "rearrange";
      provider?: { id: string; version?: string };
    }
  | {
      kind: "unavailable";
      scope: "selection" | "file";
      reason: string;
    };

export function resolveRearrangeCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): RearrangeCapabilities {
  if (!capabilities) {
    return {
      rearrangeSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasRearrangeCodeAction =
    codeActionKinds.includes("source.rearrange") ||
    codeActionKinds.includes("source.rearrangeCode") ||
    codeActionKinds.includes("rearrange");
  const isExplicitlySupported =
    (capabilities as unknown as { rearrangeSupported?: boolean }).rearrangeSupported === true;

  const providerId =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string } })
      ?.rearrangeProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string } })
      ?.rearrangeProvider?.version;

  return {
    rearrangeSupported: Boolean(hasRearrangeCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
  };
}

export function planRearrange(input: RearrangeInput): RearrangeDecision {
  const requestedScope: "selection" | "file" =
    input.scope === "selection" && input.hasSelection ? "selection" : "file";

  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: "No file is open to rearrange",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `${input.targetPath} is read-only and cannot be rearranged`,
    };
  }

  if (!input.capabilities.rearrangeSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: providerLabel
        ? `${providerLabel} does not support member-rearrangement for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`
        : `No member-rearrangement provider is available for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`,
    };
  }

  const decision: RearrangeDecision = {
    kind: "execute",
    scope: requestedScope,
    stage: "rearrange",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

export interface CleanupCapabilities {
  cleanupSupported: boolean;
  providerId?: string;
  providerVersion?: string;
  supportedProfiles?: readonly string[];
}

export interface CleanupInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  profileId?: string;
  capabilities: CleanupCapabilities;
}

export type CleanupDecision =
  | {
      kind: "execute";
      scope: "file" | "directory" | "module" | "project";
      stage: "cleanup";
      profileId: string;
      provider?: { id: string; version?: string };
    }
  | {
      kind: "unavailable";
      scope: "file" | "directory" | "module" | "project";
      reason: string;
    };

export function resolveCleanupCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): CleanupCapabilities {
  if (!capabilities) {
    return {
      cleanupSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasCleanupCodeAction =
    codeActionKinds.includes("source.cleanup") ||
    codeActionKinds.includes("source.fixAll") ||
    codeActionKinds.includes("cleanup");
  const isExplicitlySupported =
    (capabilities as unknown as { cleanupSupported?: boolean }).cleanupSupported === true;

  const providerId =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string } })
      ?.cleanupProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string } })
      ?.cleanupProvider?.version;

  const supportedProfiles =
    (capabilities as unknown as { supportedProfiles?: readonly string[] }).supportedProfiles ??
    (capabilities as unknown as { cleanupProvider?: { supportedProfiles?: readonly string[] } })
      ?.cleanupProvider?.supportedProfiles ??
    ["default", "full-cleanup"];

  return {
    cleanupSupported: Boolean(hasCleanupCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
    supportedProfiles,
  };
}

export function planCleanup(input: CleanupInput): CleanupDecision {
  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: "No target is selected for code cleanup",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: `${input.targetPath} is read-only and cannot be cleaned up`,
    };
  }

  if (!input.capabilities.cleanupSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: providerLabel
        ? `${providerLabel} does not support code cleanup for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`
        : `No code cleanup provider is available for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`,
    };
  }

  const decision: CleanupDecision = {
    kind: "execute",
    scope: input.scope,
    stage: "cleanup",
    profileId: input.profileId ?? "default",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

export interface WorkflowPrecondition {
  uri: string;
  path: string;
  preTextSha256: string;
  documentRevision?: number;
  expectedPostHash: string;
}

export interface WorkflowConflict {
  uri: string;
  path: string;
  reason: "dirty-open-buffer" | "external-divergence" | "read-only" | "version-mismatch";
  message: string;
}

export interface WorkflowPlan {
  workflow: "rearrange" | "cleanup";
  scope: "selection" | "file" | "directory" | "module" | "project";
  profileId?: string;
  provider: { id: string; version?: string };
  preconditions: readonly WorkflowPrecondition[];
  edit: LspWorkspaceEdit;
  preview: WorkspaceEditPreview;
  conflicts: readonly WorkflowConflict[];
  expectedPostHashes: Record<string, string>;
}

export interface BuildRearrangePlanInput {
  scope: "selection" | "file";
  targetPath: string;
  targetUri: string;
  currentText: string;
  documentRevision?: number;
  readOnly: boolean;
  provider: { id: string; version?: string };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export function buildRearrangePlan(input: BuildRearrangePlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be rearranged`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentRevision,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Rearrange Code" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "rearrange",
    scope: input.scope,
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export interface BuildCleanupPlanInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string;
  targetUri: string;
  currentText: string;
  documentRevision?: number;
  readOnly: boolean;
  profileId?: string;
  provider: { id: string; version?: string };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export function buildCleanupPlan(input: BuildCleanupPlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be cleaned up`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentRevision,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Code Cleanup" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "cleanup",
    scope: input.scope,
    profileId: input.profileId ?? "default",
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export function verifyWorkflowPreconditions(
  plan: WorkflowPlan,
  liveDocuments: Record<string, { text: string; revision?: number; readOnly?: boolean }>,
): { ok: boolean; conflict?: WorkflowConflict } {
  for (const pc of plan.preconditions) {
    const live = liveDocuments[pc.path] ?? liveDocuments[pc.uri];
    if (!live) continue;
    if (live.readOnly) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "read-only",
          message: `${pc.path} is read-only`,
        },
      };
    }
    const currentSha = sha256Hex(live.text);
    if (currentSha !== pc.preTextSha256) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "external-divergence",
          message: `${pc.path} has changed since plan generation`,
        },
      };
    }
    if (
      pc.documentRevision !== undefined &&
      live.revision !== undefined &&
      live.revision !== pc.documentRevision
    ) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "version-mismatch",
          message: `${pc.path} revision ${live.revision} differs from planned ${pc.documentRevision}`,
        },
      };
    }
  }
  return { ok: true };
}

export function verifyWorkflowFreshness(
  frozenIdentity: { providerGeneration?: number; sessionId?: string },
  currentIdentity: { providerGeneration?: number; sessionId?: string },
): { ok: boolean; staleReason?: string } {
  if (
    frozenIdentity.providerGeneration !== undefined &&
    currentIdentity.providerGeneration !== undefined &&
    frozenIdentity.providerGeneration !== currentIdentity.providerGeneration
  ) {
    return {
      ok: false,
      staleReason: `Provider generation changed (${frozenIdentity.providerGeneration} -> ${currentIdentity.providerGeneration})`,
    };
  }
  if (
    frozenIdentity.sessionId !== undefined &&
    currentIdentity.sessionId !== undefined &&
    frozenIdentity.sessionId !== currentIdentity.sessionId
  ) {
    return {
      ok: false,
      staleReason: `Session identity changed (${frozenIdentity.sessionId} -> ${currentIdentity.sessionId})`,
    };
  }
  return { ok: true };
}

export function verifyWorkflowPostHashes(
  expectedPostHashes: Record<string, string>,
  appliedFiles: Record<string, string>,
): { ok: boolean; mismatchedFiles: string[] } {
  const mismatchedFiles: string[] = [];
  for (const [path, expectedHash] of Object.entries(expectedPostHashes)) {
    const actualText = appliedFiles[path];
    if (actualText === undefined) {
      mismatchedFiles.push(path);
      continue;
    }
    const actualHash = sha256Hex(actualText);
    if (actualHash !== expectedHash) {
      mismatchedFiles.push(path);
    }
  }
  return {
    ok: mismatchedFiles.length === 0,
    mismatchedFiles,
  };
}

export function cancelWorkflowPlan(_plan?: WorkflowPlan): {
  disposition: "cancelled";
  applied: boolean;
  effects: [];
} {
  return {
    disposition: "cancelled",
    applied: false,
    effects: [],
  };
}
