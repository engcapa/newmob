import type { JavaProjectAnalysisSnapshotV1, JavaProjectModuleV1 } from "./projectAnalysisModel";
import { sha256Hex } from "./projectAnalysisModel";

/**
 * §8.21.6 V5 Project Structure With Provenance.
 * Provides an orthogonal engineering snapshot of project structure derived
 * from real Maven/Gradle execution models or JDTLS commands, tracking fact
 * sources, freshness, and completeness level.
 */

export type ProjectSourceSetKind = "main" | "test" | "generated" | "resource";

export interface ProjectStructureModuleV2 {
  id: string;
  name: string;
  root: string;
  sourceSets: readonly { kind: ProjectSourceSetKind; roots: readonly string[] }[];
  classpathFingerprint: string | null;
  dependencies: readonly string[];
}

export interface ProjectStructureFact {
  source: "jdtls-command" | "maven-model" | "gradle-model" | "user-config";
  freshness: string;
}

export interface ProjectStructureSnapshotV2 {
  projectFingerprint: string;
  generation: number;
  modules: readonly ProjectStructureModuleV2[];
  excludedRoots: readonly string[];
  facts: Record<string, ProjectStructureFact>;
  completeness: { level: "complete" | "partial" | "unknown"; missing: readonly string[] };
}

export interface WorkspaceProjectContextV2 {
  analysis: JavaProjectAnalysisSnapshotV1;
  structure: ProjectStructureSnapshotV2 | null;
}

export interface BuildProjectStructureInputs {
  generation: number;
  projectFingerprint?: string;
  modules?: readonly JavaProjectModuleV1[] | null;
  userExcludedRoots?: readonly string[];
  buildExcludedRoots?: readonly string[];
  dependenciesByModule?: Record<string, readonly string[]>;
  classpathFingerprintsByModule?: Record<string, string>;
  source?: "jdtls-command" | "maven-model" | "gradle-model" | "user-config";
}

/**
 * Computes deterministic module structure snapshot from build model inputs.
 */
export function buildProjectStructureSnapshotV2(
  inputs: BuildProjectStructureInputs,
): ProjectStructureSnapshotV2 {
  const generation = inputs.generation;
  const userExcludes = inputs.userExcludedRoots ?? [];
  const buildExcludes = inputs.buildExcludedRoots ?? [];
  const allExcluded = Array.from(new Set([...userExcludes, ...buildExcludes])).sort();

  const facts: Record<string, ProjectStructureFact> = {};
  const now = new Date().toISOString();

  if (userExcludes.length > 0) {
    facts["excludedRoots.user"] = { source: "user-config", freshness: now };
  }
  if (buildExcludes.length > 0) {
    facts["excludedRoots.build"] = {
      source: inputs.source ?? "maven-model",
      freshness: now,
    };
  }

  const rawModules = inputs.modules ?? [];
  const missing: string[] = [];

  const modules: ProjectStructureModuleV2[] = rawModules.map((mod) => {
    const deps = inputs.dependenciesByModule?.[mod.id] ?? [];
    const cpFp = inputs.classpathFingerprintsByModule?.[mod.id] ?? (mod.dependencyFingerprint || null);

    const sourceSets: { kind: ProjectSourceSetKind; roots: readonly string[] }[] = [];
    if (mod.sourceRoots.length > 0) {
      sourceSets.push({ kind: "main", roots: [...mod.sourceRoots].sort() });
    }
    if (mod.testRoots.length > 0) {
      sourceSets.push({ kind: "test", roots: [...mod.testRoots].sort() });
    }
    if (mod.generatedRoots.length > 0) {
      sourceSets.push({ kind: "generated", roots: [...mod.generatedRoots].sort() });
    }

    const modSource = mod.buildSystem === "gradle" ? "gradle-model" : "maven-model";
    facts[`module.${mod.id}`] = { source: modSource, freshness: now };

    return {
      id: mod.id,
      name: mod.id.split(":").pop() ?? mod.id,
      root: mod.root,
      sourceSets,
      classpathFingerprint: cpFp,
      dependencies: deps,
    };
  });

  if (rawModules.length === 0) {
    missing.push("no modules discovered");
  }

  let completenessLevel: "complete" | "partial" | "unknown" = "complete";
  if (rawModules.length === 0) {
    completenessLevel = "unknown";
  } else if (rawModules.some((m) => m.sourceRoots.length === 0)) {
    completenessLevel = "partial";
    missing.push("some modules lack resolved source roots");
  }

  const digestInput = [
    generation,
    modules.map((m) => `${m.id}:${m.root}:${m.classpathFingerprint}`).join("|"),
    allExcluded.join(","),
  ].join("::");

  const projectFingerprint = inputs.projectFingerprint ?? sha256Hex(digestInput);

  return {
    projectFingerprint,
    generation,
    modules,
    excludedRoots: allExcluded,
    facts,
    completeness: { level: completenessLevel, missing },
  };
}

/**
 * Combines analysis and structure into WorkspaceProjectContextV2.
 */
export function createWorkspaceProjectContext(
  analysis: JavaProjectAnalysisSnapshotV1,
  structure: ProjectStructureSnapshotV2 | null,
): WorkspaceProjectContextV2 {
  return { analysis, structure };
}

/**
 * Tests whether a path belongs to an excluded root.
 */
export function isPathExcluded(
  structure: ProjectStructureSnapshotV2 | null,
  path: string,
): boolean {
  if (!structure) return false;
  return structure.excludedRoots.some((excluded) => path.startsWith(excluded));
}

/**
 * Identifies the module and source set owning a path.
 */
export function findPathSourceSet(
  structure: ProjectStructureSnapshotV2 | null,
  path: string,
): { moduleId: string; kind: ProjectSourceSetKind } | null {
  if (!structure) return null;
  for (const mod of structure.modules) {
    for (const ss of mod.sourceSets) {
      for (const root of ss.roots) {
        if (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)) {
          return { moduleId: mod.id, kind: ss.kind };
        }
      }
    }
  }
  return null;
}
