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
  source: "jdtls-command" | "maven-model" | "gradle-model" | "user-config" | "descriptor-only";
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
      source: inputs.source ?? "descriptor-only",
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

    const modSource = inputs.source ?? (mod.buildSystem === "gradle" ? "gradle-model" : mod.buildSystem === "maven" ? "maven-model" : "descriptor-only");
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
 * §8.22.10 U5: Infer project structure directly from build descriptors.
 * Supports Cargo.toml, package.json, pom.xml, and build.gradle.
 */
export interface BuildDescriptorInput {
  path: string;
  content: string;
}

export function inferProjectStructureFromBuildFiles(
  descriptors: readonly BuildDescriptorInput[],
  generation: number = 1,
): { snapshot: ProjectStructureSnapshotV2 | null; status: "resolved" | "unresolved"; diagnostics: string[] } {
  if (descriptors.length === 0) {
    return {
      snapshot: null,
      status: "unresolved",
      diagnostics: ["No build descriptors found in workspace"],
    };
  }

  const modules: JavaProjectModuleV1[] = [];
  const buildExcludes: string[] = [];
  const depsByModule: Record<string, string[]> = {};
  const facts: Record<string, ProjectStructureFact> = {};
  const now = new Date().toISOString();

  for (const desc of descriptors) {
    const parentDir = desc.path.split("/").slice(0, -1).join("/") || "/";
    const fileName = desc.path.split("/").pop() ?? "";

    if (fileName === "Cargo.toml") {
      const pkgMatch = /name\s*=\s*"([^"]+)"/.exec(desc.content);
      const modName = pkgMatch ? pkgMatch[1] : "cargo-package";
      modules.push({
        id: `cargo:${modName}`,
        root: parentDir,
        sourceRoots: [`${parentDir}/src`],
        testRoots: [`${parentDir}/tests`],
        generatedRoots: [],
        excludedRoots: [`${parentDir}/target`],
        dependencyFingerprint: "",
        buildSystem: "plain",
      });
      buildExcludes.push(`${parentDir}/target`);
      facts[`descriptor.${desc.path}`] = { source: "user-config", freshness: now };
    } else if (fileName === "package.json") {
      try {
        const pkg = JSON.parse(desc.content);
        const modName = pkg.name || "node-module";
        const deps = Object.keys(pkg.dependencies || {});
        depsByModule[`npm:${modName}`] = deps;
        modules.push({
          id: `npm:${modName}`,
          root: parentDir,
          sourceRoots: [`${parentDir}/src`],
          testRoots: [`${parentDir}/test`, `${parentDir}/__tests__`],
          generatedRoots: [],
          excludedRoots: [`${parentDir}/node_modules`, `${parentDir}/dist`],
          dependencyFingerprint: "",
          buildSystem: "plain",
        });
        buildExcludes.push(`${parentDir}/node_modules`, `${parentDir}/dist`);
        facts[`descriptor.${desc.path}`] = { source: "user-config", freshness: now };
      } catch {
        // invalid JSON
      }
    } else if (fileName === "pom.xml") {
      const artMatch = /<artifactId>([^<]+)<\/artifactId>/.exec(desc.content);
      const modName = artMatch ? artMatch[1].trim() : "maven-module";
      modules.push({
        id: `mvn:${modName}`,
        root: parentDir,
        sourceRoots: [`${parentDir}/src/main/java`],
        testRoots: [`${parentDir}/src/test/java`],
        generatedRoots: [`${parentDir}/target/generated-sources`],
        excludedRoots: [`${parentDir}/target`],
        dependencyFingerprint: "",
        buildSystem: "maven",
      });
      buildExcludes.push(`${parentDir}/target`);
      facts[`descriptor.${desc.path}`] = { source: "descriptor-only", freshness: now };
    } else if (fileName === "build.gradle" || fileName === "build.gradle.kts") {
      const modName = parentDir.split("/").pop() || "gradle-module";
      modules.push({
        id: `gradle:${modName}`,
        root: parentDir,
        sourceRoots: [`${parentDir}/src/main/java`, `${parentDir}/src/main/kotlin`],
        testRoots: [`${parentDir}/src/test/java`],
        generatedRoots: [`${parentDir}/build/generated`],
        excludedRoots: [`${parentDir}/build`, `${parentDir}/.gradle`],
        dependencyFingerprint: "",
        buildSystem: "gradle",
      });
      buildExcludes.push(`${parentDir}/build`, `${parentDir}/.gradle`);
      facts[`descriptor.${desc.path}`] = { source: "descriptor-only", freshness: now };
    }
  }

  if (modules.length === 0) {
    return {
      snapshot: null,
      status: "unresolved",
      diagnostics: ["Build descriptors present but could not be parsed into modules"],
    };
  }

  const snapshot = buildProjectStructureSnapshotV2({
    generation,
    modules,
    buildExcludedRoots: buildExcludes,
    dependenciesByModule: depsByModule,
  });

  return {
    snapshot: {
      ...snapshot,
      facts: { ...snapshot.facts, ...facts },
    },
    status: "resolved",
    diagnostics: [],
  };
}

export interface WorkspaceProjectStructureState {
  status: "idle" | "loading" | "resolved" | "unresolved" | "error";
  snapshot: ProjectStructureSnapshotV2 | null;
  diagnostics: readonly string[];
  generation: number;
  lastRefreshed: number | null;
}

export class WorkspaceProjectStructureStore {
  private state: WorkspaceProjectStructureState = {
    status: "idle",
    snapshot: null,
    diagnostics: [],
    generation: 0,
    lastRefreshed: null,
  };

  getState(): WorkspaceProjectStructureState {
    return { ...this.state };
  }

  refresh(descriptors: readonly BuildDescriptorInput[]): WorkspaceProjectStructureState {
    const nextGen = this.state.generation + 1;
    const result = inferProjectStructureFromBuildFiles(descriptors, nextGen);
    this.state = {
      status: result.status,
      snapshot: result.snapshot,
      diagnostics: result.diagnostics,
      generation: nextGen,
      lastRefreshed: Date.now(),
    };
    return this.getState();
  }

  clear(): void {
    this.state = {
      status: "idle",
      snapshot: null,
      diagnostics: [],
      generation: 0,
      lastRefreshed: null,
    };
  }
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
