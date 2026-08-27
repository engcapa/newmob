import { describe, expect, it } from "vitest";
import type { JavaProjectAnalysisSnapshotV1, JavaProjectModuleV1 } from "./projectAnalysisModel";
import {
  buildProjectStructureSnapshotV2,
  createWorkspaceProjectContext,
  findPathSourceSet,
  isPathExcluded,
} from "./projectStructureModel";

const sampleModule1: JavaProjectModuleV1 = {
  id: "com.example:core",
  buildSystem: "maven",
  root: "/workspace/core",
  sourceRoots: ["/workspace/core/src/main/java"],
  testRoots: ["/workspace/core/src/test/java"],
  generatedRoots: ["/workspace/core/target/generated-sources"],
  excludedRoots: ["/workspace/core/target"],
  dependencyFingerprint: "dep-core-sha",
};

const sampleModule2: JavaProjectModuleV1 = {
  id: "com.example:app",
  buildSystem: "maven",
  root: "/workspace/app",
  sourceRoots: ["/workspace/app/src/main/java"],
  testRoots: ["/workspace/app/src/test/java"],
  generatedRoots: [],
  excludedRoots: ["/workspace/app/target"],
  dependencyFingerprint: "dep-app-sha",
};

const mockAnalysis: JavaProjectAnalysisSnapshotV1 = {
  schemaVersion: 1,
  workspaceId: "ws-1",
  generation: 3,
  provider: { id: "jdtls", version: "1.61.0", processId: 100 },
  phase: "ready",
  projectFingerprint: "fp-analysis-123",
  sdk: { homeHash: "hash-jdk", version: "21", languageLevel: "21" },
  modules: [sampleModule1, sampleModule2],
  progress: [],
  completeness: "complete",
  diagnostics: [],
  startedAt: 1000,
  completedAt: 2000,
};

describe("§8.21.6 V5 projectStructureModel", () => {
  it("builds ProjectStructureSnapshotV2 with provenance facts and completeness", () => {
    const snapshot = buildProjectStructureSnapshotV2({
      generation: 3,
      modules: [sampleModule1, sampleModule2],
      userExcludedRoots: ["/workspace/.git"],
      buildExcludedRoots: ["/workspace/core/target", "/workspace/app/target"],
      dependenciesByModule: {
        "com.example:app": ["com.example:core"],
      },
    });

    expect(snapshot.generation).toBe(3);
    expect(snapshot.modules).toHaveLength(2);
    expect(snapshot.modules[0].id).toBe("com.example:core");
    expect(snapshot.modules[0].sourceSets).toEqual([
      { kind: "main", roots: ["/workspace/core/src/main/java"] },
      { kind: "test", roots: ["/workspace/core/src/test/java"] },
      { kind: "generated", roots: ["/workspace/core/target/generated-sources"] },
    ]);
    expect(snapshot.modules[1].dependencies).toEqual(["com.example:core"]);

    // Excluded roots merged with provenance facts
    expect(snapshot.excludedRoots).toEqual([
      "/workspace/.git",
      "/workspace/app/target",
      "/workspace/core/target",
    ]);
    expect(snapshot.facts["excludedRoots.user"].source).toBe("user-config");
    expect(snapshot.facts["excludedRoots.build"].source).toBe("maven-model");
    expect(snapshot.facts["module.com.example:core"].source).toBe("maven-model");

    // Completeness
    expect(snapshot.completeness.level).toBe("complete");
    expect(snapshot.completeness.missing).toHaveLength(0);
    expect(snapshot.projectFingerprint).toBeDefined();
  });

  it("marks partial completeness when a module lacks source roots", () => {
    const brokenModule: JavaProjectModuleV1 = {
      ...sampleModule1,
      sourceRoots: [],
    };
    const snapshot = buildProjectStructureSnapshotV2({
      generation: 1,
      modules: [brokenModule],
    });

    expect(snapshot.completeness.level).toBe("partial");
    expect(snapshot.completeness.missing).toContain("some modules lack resolved source roots");
  });

  it("creates WorkspaceProjectContextV2 combining analysis and structure", () => {
    const structure = buildProjectStructureSnapshotV2({
      generation: 3,
      modules: [sampleModule1],
    });
    const context = createWorkspaceProjectContext(mockAnalysis, structure);

    expect(context.analysis.phase).toBe("ready");
    expect(context.structure).not.toBeNull();
    expect(context.structure?.modules).toHaveLength(1);
  });

  it("checks path exclusion and resolves source set provenance", () => {
    const structure = buildProjectStructureSnapshotV2({
      generation: 3,
      modules: [sampleModule1, sampleModule2],
      userExcludedRoots: ["/workspace/.git"],
      buildExcludedRoots: ["/workspace/core/target"],
    });

    expect(isPathExcluded(structure, "/workspace/.git/config")).toBe(true);
    expect(isPathExcluded(structure, "/workspace/core/target/classes")).toBe(true);
    expect(isPathExcluded(structure, "/workspace/core/src/main/java/A.java")).toBe(false);

    expect(findPathSourceSet(structure, "/workspace/core/src/main/java/com/example/Main.java")).toEqual({
      moduleId: "com.example:core",
      kind: "main",
    });
    expect(findPathSourceSet(structure, "/workspace/core/src/test/java/com/example/MainTest.java")).toEqual({
      moduleId: "com.example:core",
      kind: "test",
    });
    expect(findPathSourceSet(structure, "/workspace/other/file.txt")).toBeNull();
  });
});
