import { useProjectFactsStore, type WorkspaceProjectFactsEntry } from "../../../stores/projectFactsStore";
import { consumeCompletionScope } from "./projectFactsConsumers";
import type { ProjectSourceSetKind } from "./projectStructureModel";

export type CompletionScopeLevel = "document" | "module" | "project" | "expanded";

export type CompletionScopeFactsState =
  | {
      status: "ready";
      scope: CompletionScopeLevel;
      moduleId: string;
      sourceKind: ProjectSourceSetKind;
      dependencies: readonly string[];
      classpathFingerprint: string | null;
      generation: number;
    }
  | {
      status: "scope-facts-missing";
      requestedScope: CompletionScopeLevel;
      reason: string;
      fallbackScope: "document";
      generation: number;
    };

/**
 * Resolves completion scope facts from the ready project generation (ED-COMP-004).
 * Enforces strict workspace isolation and fails closed with `scope-facts-missing`
 * if facts are untrusted, loading, degraded, or stale.
 */
export function resolveCompletionScopeFacts(
  workspaceRoot: string,
  filePath: string,
  requestedScope: CompletionScopeLevel = "module",
  expectedGeneration?: number,
  customFactsEntry?: WorkspaceProjectFactsEntry,
): CompletionScopeFactsState {
  if (requestedScope === "document") {
    return {
      status: "ready",
      scope: "document",
      moduleId: "local-document",
      sourceKind: "main",
      dependencies: [],
      classpathFingerprint: null,
      generation: 0,
    };
  }

  const factsEntry = customFactsEntry ?? useProjectFactsStore.getState().getWorkspaceFacts(workspaceRoot);

  const consumerRes = consumeCompletionScope(factsEntry, filePath, expectedGeneration);

  if (consumerRes.state !== "ready" || !consumerRes.data) {
    return {
      status: "scope-facts-missing",
      requestedScope,
      reason: consumerRes.reason || `Project facts not ready (state: ${consumerRes.state})`,
      fallbackScope: "document",
      generation: factsEntry.generation,
    };
  }

  return {
    status: "ready",
    scope: requestedScope,
    moduleId: consumerRes.data.moduleId,
    sourceKind: consumerRes.data.sourceKind,
    dependencies: consumerRes.data.dependencies,
    classpathFingerprint: consumerRes.data.classpathFingerprint,
    generation: factsEntry.generation,
  };
}

/**
 * Formats completion scope for status display and diagnostics.
 */
export function getCompletionScopeDisplay(state: CompletionScopeFactsState): {
  label: string;
  isFallback: boolean;
  tooltip: string;
} {
  if (state.status === "scope-facts-missing") {
    return {
      label: "Document (Scope facts missing)",
      isFallback: true,
      tooltip: `Requested ${state.requestedScope} scope fell back to document: ${state.reason}`,
    };
  }

  if (state.scope === "document") {
    return {
      label: "Document Scope",
      isFallback: false,
      tooltip: "Completion limited to active document buffer",
    };
  }

  return {
    label: `${state.scope.charAt(0).toUpperCase() + state.scope.slice(1)} Scope (${state.moduleId}, G${state.generation})`,
    isFallback: false,
    tooltip: `Module: ${state.moduleId} (${state.sourceKind}), Generation: G${state.generation}, Dependencies: ${state.dependencies.length}`,
  };
}
