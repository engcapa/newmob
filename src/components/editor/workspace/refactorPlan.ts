import type {
  LspLocation,
  LspWorkspaceEdit,
  LspWorkspaceEditOperation,
} from "../../../lib/editor/lsp";
import { normalizeFsPath, relativePathWithinRoot } from "./codeWorkspaceModel";
import type { CapabilityEvidenceV3 } from "./capabilityEvidence";
import { workspaceEditOperations } from "./workspaceEditPreview";

/**
 * §8.20.6 W5: Unified refactoring plan & verification gate.
 *
 * All effectful code modifications from Rename, Safe Delete, `refactor.*`
 * Code Actions, and Generate actions pass through `refactorApplyGate`.
 */

export type RefactorKind =
  | "rename"
  | "safe-delete"
  | "extract"
  | "inline"
  | "change-signature"
  | "move"
  | "other";

export type RefactorCompleteness =
  | "provider-complete"
  | "provider-partial"
  | "unknown";

export type RefactorUriOwner = "workspace" | "library" | "external";

export interface RefactorConflictV3 {
  severity: "warning" | "error";
  message: string;
  location: LspLocation | null;
}

export interface RefactorPlanV3 {
  actionId: string;
  kind: RefactorKind;
  evidence: CapabilityEvidenceV3;
  completeness: RefactorCompleteness;
  conflicts: readonly RefactorConflictV3[];
  operations: readonly LspWorkspaceEditOperation[];
  affectedUris: readonly {
    uri: string;
    revision: number | null;
    owner: RefactorUriOwner;
  }[];
  excludableGroups: readonly {
    id: string;
    label: string;
    operationIndexes: readonly number[];
    required: boolean;
  }[];
}

export interface RefactorGateDecision {
  allowed: boolean;
  requiresConfirm: boolean;
  requiresPreview: boolean;
  reason: string | null;
  blockingConflicts: readonly RefactorConflictV3[];
  warningConflicts: readonly RefactorConflictV3[];
}

/**
 * §8.20.6 gate contract:
 * 1. Library or external resource modification is a hard block.
 * 2. Error-severity conflicts are a hard block.
 * 3. Safe Delete without provider-complete certainty is a hard block.
 * 4. Warning conflicts require explicit user confirmation.
 * 5. Partial/unknown completeness requires preview before execution.
 */
export function refactorApplyGate(plan: RefactorPlanV3): RefactorGateDecision {
  // Rule 1: Read-only library / external file writes are hard blocked.
  const nonWorkspace = plan.affectedUris.find((u) => u.owner !== "workspace");
  if (nonWorkspace) {
    const conflict: RefactorConflictV3 = {
      severity: "error",
      message: `Cannot modify read-only ${nonWorkspace.owner} resource: ${nonWorkspace.uri}`,
      location: null,
    };
    return {
      allowed: false,
      requiresConfirm: false,
      requiresPreview: false,
      reason: conflict.message,
      blockingConflicts: [conflict, ...plan.conflicts.filter((c) => c.severity === "error")],
      warningConflicts: plan.conflicts.filter((c) => c.severity === "warning"),
    };
  }

  // Rule 2: Error-severity conflicts hard block.
  const errorConflicts = plan.conflicts.filter((c) => c.severity === "error");
  if (errorConflicts.length > 0) {
    return {
      allowed: false,
      requiresConfirm: false,
      requiresPreview: false,
      reason: errorConflicts.map((c) => c.message).join("; "),
      blockingConflicts: errorConflicts,
      warningConflicts: plan.conflicts.filter((c) => c.severity === "warning"),
    };
  }

  // Rule 3: Destructive Safe Delete without complete knowledge hard blocks.
  if (plan.kind === "safe-delete" && plan.completeness !== "provider-complete") {
    const reason = `Safe Delete requires provider-complete references; provider reported "${plan.completeness}"`;
    return {
      allowed: false,
      requiresConfirm: false,
      requiresPreview: false,
      reason,
      blockingConflicts: [{ severity: "error", message: reason, location: null }],
      warningConflicts: plan.conflicts.filter((c) => c.severity === "warning"),
    };
  }

  // Rule 4: Warning conflicts require explicit confirmation.
  const warningConflicts = plan.conflicts.filter((c) => c.severity === "warning");
  const requiresConfirm = warningConflicts.length > 0;

  // Rule 5: Partial or unknown completeness requires preview.
  const requiresPreview = plan.completeness !== "provider-complete";

  return {
    allowed: true,
    requiresConfirm,
    requiresPreview,
    reason: warningConflicts.length > 0 ? warningConflicts.map((c) => c.message).join("; ") : null,
    blockingConflicts: [],
    warningConflicts,
  };
}

export interface BuildRefactorPlanInput {
  actionId: string;
  kind: RefactorKind;
  evidence: CapabilityEvidenceV3;
  edit: LspWorkspaceEdit;
  roots: readonly { path: string }[];
  openFiles?: Record<string, { documentRevision?: number; revision?: number }>;
  conflicts?: readonly RefactorConflictV3[];
  completeness?: RefactorCompleteness;
  requiredOperationIndexes?: readonly number[];
}

function classifyUriOwner(uri: string, path: string | null, roots: readonly { path: string }[]): RefactorUriOwner {
  if (!/^file:/i.test(uri) && !path) return "library";
  const filePath = path ?? decodeURIComponent(uri.replace(/^file:\/\//i, ""));
  const normalized = normalizeFsPath(filePath);
  const inRoot = roots.some((root) => relativePathWithinRoot(root.path, normalized) !== null);
  if (inRoot) return "workspace";
  if (/(jar|jrt|zip):/i.test(uri) || /[/\\]\.m2[/\\]|[/\\]\.gradle[/\\]/i.test(normalized)) {
    return "library";
  }
  return "external";
}

/**
 * Build a typed RefactorPlanV3 from an LspWorkspaceEdit and current workspace state.
 */
export function buildRefactorPlan(input: BuildRefactorPlanInput): RefactorPlanV3 {
  const operations = workspaceEditOperations(input.edit);
  const roots = input.roots;
  const openFiles = input.openFiles ?? {};
  const conflicts: RefactorConflictV3[] = [...(input.conflicts ?? [])];

  const affectedMap = new Map<string, { uri: string; revision: number | null; owner: RefactorUriOwner }>();
  const groupMap = new Map<string, { id: string; label: string; indexes: number[]; required: boolean }>();
  const requiredSet = new Set(input.requiredOperationIndexes ?? []);

  operations.forEach((op, index) => {
    let uri = "";
    let path: string | null = null;

    if (op.kind === "text") {
      uri = op.document.uri;
      path = op.document.path;
    } else if (op.kind === "create" || op.kind === "delete") {
      uri = op.uri;
      path = op.path;
    } else if (op.kind === "rename") {
      uri = op.newUri;
      path = op.newPath;
    }

    const key = uri || path || `unknown-${index}`;
    if (!affectedMap.has(key)) {
      const owner = classifyUriOwner(uri, path, roots);
      if (owner !== "workspace") {
        conflicts.push({
          severity: "error",
          message: `Cannot modify read-only ${owner} resource: ${uri || path}`,
          location: null,
        });
      }
      let revision: number | null = null;
      for (const openFile of Object.values(openFiles)) {
        if (openFile && (openFile.documentRevision !== undefined || openFile.revision !== undefined)) {
          revision = openFile.documentRevision ?? openFile.revision ?? null;
          break;
        }
      }
      affectedMap.set(key, { uri, revision, owner });
    }

    const groupKey = path || uri || "default";
    const existingGroup = groupMap.get(groupKey);
    const isRequired = requiredSet.has(index);
    if (existingGroup) {
      existingGroup.indexes.push(index);
      if (isRequired) existingGroup.required = true;
    } else {
      groupMap.set(groupKey, {
        id: `group:${groupKey}`,
        label: groupKey,
        indexes: [index],
        required: isRequired,
      });
    }
  });

  const excludableGroups = Array.from(groupMap.values()).map((g) => ({
    id: g.id,
    label: g.label,
    operationIndexes: Object.freeze(g.indexes),
    required: g.required,
  }));

  return {
    actionId: input.actionId,
    kind: input.kind,
    evidence: input.evidence,
    completeness: input.completeness ?? (input.evidence.coverage.complete ? "provider-complete" : "provider-partial"),
    conflicts: Object.freeze(conflicts),
    operations: Object.freeze(operations),
    affectedUris: Object.freeze(Array.from(affectedMap.values())),
    excludableGroups: Object.freeze(excludableGroups),
  };
}

/**
 * Validates that deselecting specific operation indexes does not violate
 * required refactoring dependencies.
 */
export function verifyExclusionSafety(
  plan: RefactorPlanV3,
  excludedOperationIndexes: ReadonlySet<number>,
): { safe: boolean; reason: string | null } {
  for (const group of plan.excludableGroups) {
    if (group.required) {
      const hasExcluded = group.operationIndexes.some((idx) => excludedOperationIndexes.has(idx));
      if (hasExcluded) {
        return {
          safe: false,
          reason: `Group "${group.label}" contains changes required for this refactoring and cannot be excluded`,
        };
      }
    }
  }
  return { safe: true, reason: null };
}
