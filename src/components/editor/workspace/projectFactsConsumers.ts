import type { WorkspaceProjectFactsEntry } from "../../../stores/projectFactsStore";
import {
  findPathSourceSet,
  isPathExcluded,
  type ProjectSourceSetKind,
  type ProjectStructureSnapshotV2,
} from "./projectStructureModel";

export type ConsumerState = "ready" | "loading" | "untrusted" | "degraded" | "stale" | "failed";

export interface ConsumerResult<T> {
  state: ConsumerState;
  generation: number;
  data: T | null;
  reason: string | null;
}

/**
 * 1. Completion Scope Consumer
 * Computes module-level completion scope, classpath, and source set.
 */
export interface CompletionScopeFacts {
  moduleId: string;
  sourceKind: ProjectSourceSetKind;
  dependencies: readonly string[];
  classpathFingerprint: string | null;
  moduleRoot: string;
  isExcluded: boolean;
}

export function consumeCompletionScope(
  entry: WorkspaceProjectFactsEntry,
  filePath: string,
  expectedGeneration?: number,
): ConsumerResult<CompletionScopeFacts> {
  const gate = evaluateConsumerGate(entry, expectedGeneration);
  if (gate.state !== "ready" || !entry.structure) {
    return {
      state: gate.state,
      generation: entry.generation,
      data: null,
      reason: gate.reason,
    };
  }

  const structure = entry.structure;
  const isExcluded = isPathExcluded(structure, filePath);
  const found = findPathSourceSet(structure, filePath);

  if (!found) {
    return {
      state: "ready",
      generation: entry.generation,
      data: {
        moduleId: "workspace-root",
        sourceKind: "main",
        dependencies: [],
        classpathFingerprint: null,
        moduleRoot: entry.workspaceRoot,
        isExcluded,
      },
      reason: null,
    };
  }

  const mod = structure.modules.find((m) => m.id === found.moduleId);
  return {
    state: "ready",
    generation: entry.generation,
    data: {
      moduleId: found.moduleId,
      sourceKind: found.kind,
      dependencies: mod?.dependencies ?? [],
      classpathFingerprint: mod?.classpathFingerprint ?? null,
      moduleRoot: mod?.root ?? entry.workspaceRoot,
      isExcluded,
    },
    reason: null,
  };
}

/**
 * 2. Semantic Query Scope Consumer
 * Classifies file ownership, source set, and indexability for semantic search/navigation.
 */
export interface SemanticQueryScopeFacts {
  moduleId: string | null;
  sourceKind: ProjectSourceSetKind | "excluded" | "external";
  isIndexed: boolean;
  moduleDependencies: readonly string[];
}

export function consumeSemanticQueryScope(
  entry: WorkspaceProjectFactsEntry,
  targetPath: string,
  expectedGeneration?: number,
): ConsumerResult<SemanticQueryScopeFacts> {
  const gate = evaluateConsumerGate(entry, expectedGeneration);
  if (gate.state !== "ready" || !entry.structure) {
    return {
      state: gate.state,
      generation: entry.generation,
      data: null,
      reason: gate.reason,
    };
  }

  const structure = entry.structure;
  if (isPathExcluded(structure, targetPath)) {
    return {
      state: "ready",
      generation: entry.generation,
      data: {
        moduleId: null,
        sourceKind: "excluded",
        isIndexed: false,
        moduleDependencies: [],
      },
      reason: null,
    };
  }

  const found = findPathSourceSet(structure, targetPath);
  if (!found) {
    return {
      state: "ready",
      generation: entry.generation,
      data: {
        moduleId: null,
        sourceKind: "external",
        isIndexed: true,
        moduleDependencies: [],
      },
      reason: null,
    };
  }

  const mod = structure.modules.find((m) => m.id === found.moduleId);
  return {
    state: "ready",
    generation: entry.generation,
    data: {
      moduleId: found.moduleId,
      sourceKind: found.kind,
      isIndexed: true,
      moduleDependencies: mod?.dependencies ?? [],
    },
    reason: null,
  };
}

/**
 * 3. Rename / Refactor Coverage Consumer
 * Computes impacted modules and source roots that must participate in refactor validation.
 */
export interface RefactorCoverageFacts {
  targetModuleId: string;
  affectedModuleIds: readonly string[];
  affectedRoots: readonly string[];
}

export function consumeRefactorCoverage(
  entry: WorkspaceProjectFactsEntry,
  targetModuleId: string,
  expectedGeneration?: number,
): ConsumerResult<RefactorCoverageFacts> {
  const gate = evaluateConsumerGate(entry, expectedGeneration);
  if (gate.state !== "ready" || !entry.structure) {
    return {
      state: gate.state,
      generation: entry.generation,
      data: null,
      reason: gate.reason,
    };
  }

  const structure = entry.structure;
  const targetMod = structure.modules.find((m) => m.id === targetModuleId);
  if (!targetMod) {
    return {
      state: "failed",
      generation: entry.generation,
      data: null,
      reason: `Module ${targetModuleId} not found in project structure`,
    };
  }

  // Find all modules directly or transitively depending on targetModuleId
  const affected = new Set<string>([targetModuleId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const mod of structure.modules) {
      if (!affected.has(mod.id)) {
        const hasDep = mod.dependencies.some(
          (dep) =>
            dep.includes(targetModuleId) ||
            dep.includes(targetMod.name) ||
            affected.has(dep),
        );
        if (hasDep) {
          affected.add(mod.id);
          expanded = true;
        }
      }
    }
  }

  const affectedRoots: string[] = [];
  for (const modId of affected) {
    const m = structure.modules.find((mod) => mod.id === modId);
    if (m) {
      affectedRoots.push(m.root);
      for (const ss of m.sourceSets) {
        affectedRoots.push(...ss.roots);
      }
    }
  }

  return {
    state: "ready",
    generation: entry.generation,
    data: {
      targetModuleId,
      affectedModuleIds: Array.from(affected).sort(),
      affectedRoots: Array.from(new Set(affectedRoots)).sort(),
    },
    reason: null,
  };
}

function evaluateConsumerGate(
  entry: WorkspaceProjectFactsEntry,
  expectedGeneration?: number,
): { state: ConsumerState; reason: string | null } {
  if (entry.status === "untrusted") {
    return {
      state: "untrusted",
      reason: entry.reason || "Workspace is untrusted; build facts consumer refused",
    };
  }

  if (entry.status === "loading") {
    return {
      state: "loading",
      reason: entry.reason || "Loading project facts...",
    };
  }

  if (entry.status === "failed") {
    return {
      state: "failed",
      reason: entry.reason || "Project facts resolution failed",
    };
  }

  if (entry.status === "degraded") {
    return {
      state: "degraded",
      reason: entry.reason || "Project facts are in degraded state",
    };
  }

  if (entry.isStale) {
    return {
      state: "stale",
      reason: entry.reason || "Project structure is stale; re-evaluation in progress",
    };
  }

  if (expectedGeneration !== undefined && entry.generation !== expectedGeneration) {
    return {
      state: "stale",
      reason: `Generation mismatch: expected G${expectedGeneration} but current is G${entry.generation}`,
    };
  }

  if (entry.status !== "ready" || !entry.structure) {
    return {
      state: "failed",
      reason: "No ready project structure snapshot available",
    };
  }

  return { state: "ready", reason: null };
}
