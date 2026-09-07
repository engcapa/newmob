import type { JavaProjectAnalysisSnapshotV1, JavaProjectModuleV1 } from "./projectAnalysisModel";
import { sha256Hex } from "./projectAnalysisModel";
import { fsPathComparisonKey, relativePathWithinRoot } from "./codeWorkspaceModel";

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
  source?: "jdtls-command" | "maven-model" | "gradle-model" | "user-config" | "descriptor-only";
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

    const modSource = inputs.source ?? "descriptor-only";
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
  } else if (inputs.source === "descriptor-only" || !inputs.source || rawModules.some((m) => m.sourceRoots.length === 0)) {
    completenessLevel = "partial";
    if (rawModules.some((m) => m.sourceRoots.length === 0)) {
      missing.push("some modules lack resolved source roots");
    } else {
      missing.push("static descriptor inference only");
    }
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
 * §8.22.10 U5: Project Descriptor Discovery & Inference.
 * Supports Cargo.toml, package.json, pom.xml, and build.gradle.
 */
export interface BuildDescriptorInput {
  path: string;
  content: string;
}

export interface ProjectDiscoveredDescriptor {
  path: string;
  buildSystem: "cargo" | "npm" | "maven" | "gradle" | "plain";
  name: string;
  root: string;
  rawContentSha256: string;
  inferredExcludedRoots: readonly string[];
}

export interface ProjectDescriptorDiscoveryV1 {
  status: "descriptor-only" | "unresolved";
  generation: number;
  descriptors: readonly ProjectDiscoveredDescriptor[];
  excludedRoots: readonly string[];
  diagnostics: readonly string[];
}

export function discoverProjectDescriptors(
  descriptors: readonly BuildDescriptorInput[],
  generation: number = 1,
): ProjectDescriptorDiscoveryV1 {
  if (descriptors.length === 0) {
    return {
      status: "unresolved",
      generation,
      descriptors: [],
      excludedRoots: [],
      diagnostics: ["No build descriptors found in workspace"],
    };
  }

  const discovered: ProjectDiscoveredDescriptor[] = [];
  const buildExcludes: string[] = [];

  for (const desc of descriptors) {
    const parentDir = desc.path.split("/").slice(0, -1).join("/") || "/";
    const fileName = desc.path.split("/").pop() ?? "";
    const hash = sha256Hex(desc.content);

    if (fileName === "Cargo.toml") {
      const pkgMatch = /name\s*=\s*"([^"]+)"/.exec(desc.content);
      const modName = pkgMatch ? pkgMatch[1] : "cargo-package";
      const excludes = [`${parentDir}/target`];
      discovered.push({
        path: desc.path,
        buildSystem: "cargo",
        name: modName,
        root: parentDir,
        rawContentSha256: hash,
        inferredExcludedRoots: excludes,
      });
      buildExcludes.push(...excludes);
    } else if (fileName === "package.json") {
      try {
        const pkg = JSON.parse(desc.content);
        const modName = pkg.name || "node-module";
        const excludes = [`${parentDir}/node_modules`, `${parentDir}/dist`];
        discovered.push({
          path: desc.path,
          buildSystem: "npm",
          name: modName,
          root: parentDir,
          rawContentSha256: hash,
          inferredExcludedRoots: excludes,
        });
        buildExcludes.push(...excludes);
      } catch {
        // invalid JSON
      }
    } else if (fileName === "pom.xml") {
      const artMatch = /<artifactId>([^<]+)<\/artifactId>/.exec(desc.content);
      const modName = artMatch ? artMatch[1].trim() : "maven-module";
      const excludes = [`${parentDir}/target`];
      discovered.push({
        path: desc.path,
        buildSystem: "maven",
        name: modName,
        root: parentDir,
        rawContentSha256: hash,
        inferredExcludedRoots: excludes,
      });
      buildExcludes.push(...excludes);
    } else if (fileName === "build.gradle" || fileName === "build.gradle.kts") {
      const modName = parentDir.split("/").pop() || "gradle-module";
      const excludes = [`${parentDir}/build`, `${parentDir}/.gradle`];
      discovered.push({
        path: desc.path,
        buildSystem: "gradle",
        name: modName,
        root: parentDir,
        rawContentSha256: hash,
        inferredExcludedRoots: excludes,
      });
      buildExcludes.push(...excludes);
    }
  }

  if (discovered.length === 0) {
    return {
      status: "unresolved",
      generation,
      descriptors: [],
      excludedRoots: [],
      diagnostics: ["Build descriptors present but could not be parsed into modules"],
    };
  }

  const allExcluded = Array.from(new Set(buildExcludes)).sort();

  return {
    status: "descriptor-only",
    generation,
    descriptors: discovered,
    excludedRoots: allExcluded,
    diagnostics: [],
  };
}

export function inferProjectStructureFromBuildFiles(
  descriptors: readonly BuildDescriptorInput[],
  generation: number = 1,
): {
  snapshot: ProjectStructureSnapshotV2 | null;
  discovery: ProjectDescriptorDiscoveryV1;
  status: "descriptor-only" | "unresolved";
  diagnostics: string[];
} {
  const discovery = discoverProjectDescriptors(descriptors, generation);
  if (discovery.status === "unresolved" || discovery.descriptors.length === 0) {
    return {
      snapshot: null,
      discovery,
      status: "unresolved",
      diagnostics: [...discovery.diagnostics],
    };
  }

  const modules: JavaProjectModuleV1[] = [];
  const buildExcludes: string[] = [...discovery.excludedRoots];
  const depsByModule: Record<string, string[]> = {};
  const facts: Record<string, ProjectStructureFact> = {};
  const now = new Date().toISOString();

  for (const desc of discovery.descriptors) {
    const parentDir = desc.root;
    if (desc.buildSystem === "cargo") {
      modules.push({
        id: `cargo:${desc.name}`,
        root: parentDir,
        sourceRoots: [`${parentDir}/src`],
        testRoots: [`${parentDir}/tests`],
        generatedRoots: [],
        excludedRoots: [`${parentDir}/target`],
        dependencyFingerprint: "",
        buildSystem: "plain",
      });
      facts[`descriptor.${desc.path}`] = { source: "user-config", freshness: now };
    } else if (desc.buildSystem === "npm") {
      modules.push({
        id: `npm:${desc.name}`,
        root: parentDir,
        sourceRoots: [`${parentDir}/src`],
        testRoots: [`${parentDir}/test`, `${parentDir}/__tests__`],
        generatedRoots: [],
        excludedRoots: [`${parentDir}/node_modules`, `${parentDir}/dist`],
        dependencyFingerprint: "",
        buildSystem: "plain",
      });
      facts[`descriptor.${desc.path}`] = { source: "user-config", freshness: now };
    } else if (desc.buildSystem === "maven") {
      modules.push({
        id: `mvn:${desc.name}`,
        root: parentDir,
        sourceRoots: [`${parentDir}/src/main/java`],
        testRoots: [`${parentDir}/src/test/java`],
        generatedRoots: [`${parentDir}/target/generated-sources`],
        excludedRoots: [`${parentDir}/target`],
        dependencyFingerprint: "",
        buildSystem: "maven",
      });
      facts[`descriptor.${desc.path}`] = { source: "descriptor-only", freshness: now };
    } else if (desc.buildSystem === "gradle") {
      modules.push({
        id: `gradle:${desc.name}`,
        root: parentDir,
        sourceRoots: [`${parentDir}/src/main/java`, `${parentDir}/src/main/kotlin`],
        testRoots: [`${parentDir}/src/test/java`],
        generatedRoots: [`${parentDir}/build/generated`],
        excludedRoots: [`${parentDir}/build`, `${parentDir}/.gradle`],
        dependencyFingerprint: "",
        buildSystem: "gradle",
      });
      facts[`descriptor.${desc.path}`] = { source: "descriptor-only", freshness: now };
    }
  }

  const snapshot = buildProjectStructureSnapshotV2({
    generation,
    source: "descriptor-only",
    modules,
    buildExcludedRoots: buildExcludes,
    dependenciesByModule: depsByModule,
  });

  return {
    snapshot: {
      ...snapshot,
      facts: { ...snapshot.facts, ...facts },
    },
    discovery,
    status: "descriptor-only",
    diagnostics: [],
  };
}

export interface WorkspaceProjectStructureState {
  status: "idle" | "loading" | "resolved" | "ready" | "unresolved" | "descriptor-only" | "error";
  snapshot: ProjectStructureSnapshotV2 | null;
  discovery: ProjectDescriptorDiscoveryV1 | null;
  diagnostics: readonly string[];
  generation: number;
  lastRefreshed: number | null;
}

export type ProjectSnapshotConsumerOutcome<T> =
  | { state: "ready"; snapshot: ProjectStructureSnapshotV2; data: T }
  | { state: "descriptor-only"; generation: number; reason: string }
  | { state: "stale-generation"; expectedGeneration: number; currentGeneration: number }
  | { state: "unresolved"; diagnostics: readonly string[] };

/**
 * Validates that the project structure snapshot is ready and generation-aligned
 * before consumer access. Prevents unready descriptor-only or stale snapshot leaks.
 */
export function consumeProjectReadySnapshot<T>(
  state: WorkspaceProjectStructureState,
  expectedGeneration: number | undefined,
  accessor: (snapshot: ProjectStructureSnapshotV2) => T,
): ProjectSnapshotConsumerOutcome<T> {
  if (state.status === "descriptor-only") {
    return {
      state: "descriptor-only",
      generation: state.generation,
      reason: "Build descriptors discovered but live tooling/LSP model ingestion has not resolved ready classpath or source roots",
    };
  }
  if (state.status !== "resolved" && state.status !== "ready") {
    return {
      state: "unresolved",
      diagnostics: state.diagnostics,
    };
  }
  if (expectedGeneration !== undefined && state.generation !== expectedGeneration) {
    return {
      state: "stale-generation",
      expectedGeneration,
      currentGeneration: state.generation,
    };
  }
  if (!state.snapshot) {
    return {
      state: "unresolved",
      diagnostics: ["No snapshot available in ready state"],
    };
  }
  return {
    state: "ready",
    snapshot: state.snapshot,
    data: accessor(state.snapshot),
  };
}

export class WorkspaceProjectStructureStore {
  private state: WorkspaceProjectStructureState = {
    status: "idle",
    snapshot: null,
    discovery: null,
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
      discovery: result.discovery,
      diagnostics: result.diagnostics,
      generation: nextGen,
      lastRefreshed: Date.now(),
    };
    return this.getState();
  }

  setResolved(snapshot: ProjectStructureSnapshotV2): WorkspaceProjectStructureState {
    this.state = {
      status: "resolved",
      snapshot,
      discovery: this.state.discovery,
      diagnostics: [],
      generation: snapshot.generation,
      lastRefreshed: Date.now(),
    };
    return this.getState();
  }

  clear(): void {
    this.state = {
      status: "idle",
      snapshot: null,
      discovery: null,
      diagnostics: [],
      generation: 0,
      lastRefreshed: null,
    };
  }
}

/**
 * Tests whether a path belongs to an excluded root.
 */
export function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  if (relativePathWithinRoot(rootPath, filePath) !== null) return true;

  // Project facts can be produced before a provider has returned fully
  // qualified paths. Keep the fallback lexical, but preserve path boundaries
  // so `/repo/app` does not match `/repo/application`.
  const normalizedRoot = fsPathComparisonKey(rootPath).replace(/\/+$/, "");
  const normalizedFile = fsPathComparisonKey(filePath);
  return normalizedFile === normalizedRoot
    || (normalizedRoot.length > 0 && normalizedFile.startsWith(`${normalizedRoot}/`));
}

export function isPathExcluded(
  structure: ProjectStructureSnapshotV2 | null,
  path: string,
): boolean {
  if (!structure) return false;
  return structure.excludedRoots.some((excluded) => isPathWithinRoot(path, excluded));
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
        if (isPathWithinRoot(path, root)) {
          return { moduleId: mod.id, kind: ss.kind };
        }
      }
    }
  }
  return null;
}
