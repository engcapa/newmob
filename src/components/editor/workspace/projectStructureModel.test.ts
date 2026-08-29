import { describe, expect, it } from "vitest";
import type { JavaProjectAnalysisSnapshotV1, JavaProjectModuleV1 } from "./projectAnalysisModel";
import {
  buildProjectStructureSnapshotV2,
  consumeProjectReadySnapshot,
  createWorkspaceProjectContext,
  discoverProjectDescriptors,
  findPathSourceSet,
  inferProjectStructureFromBuildFiles,
  isPathExcluded,
  WorkspaceProjectStructureStore,
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
      source: "maven-model",
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

  describe("§8.22.10 U5 Project Structure Production Ingestion", () => {
    it("infers multi-build modules from Cargo.toml, package.json, and pom.xml", () => {
      const descriptors = [
        {
          path: "/repo/Cargo.toml",
          content: '[package]\nname = "my-crate"\nversion = "0.1.0"',
        },
        {
          path: "/repo/frontend/package.json",
          content: JSON.stringify({ name: "my-ui", dependencies: { react: "^19.0.0" } }),
        },
        {
          path: "/repo/backend/pom.xml",
          content: "<project><artifactId>backend-service</artifactId></project>",
        },
      ];

      const result = inferProjectStructureFromBuildFiles(descriptors);
      expect(result.status).toBe("descriptor-only");
      expect(result.snapshot).not.toBeNull();
      expect(result.snapshot?.modules).toHaveLength(3);

      const modIds = result.snapshot!.modules.map((m) => m.id);
      expect(modIds).toContain("cargo:my-crate");
      expect(modIds).toContain("npm:my-ui");
      expect(modIds).toContain("mvn:backend-service");

      expect(result.snapshot?.excludedRoots).toContain("/repo/target");
      expect(result.snapshot?.excludedRoots).toContain("/repo/frontend/node_modules");
      expect(result.snapshot?.excludedRoots).toContain("/repo/backend/target");
    });

    it("returns honest unresolved status when no descriptors exist without fabricating JDK", () => {
      const result = inferProjectStructureFromBuildFiles([]);
      expect(result.status).toBe("unresolved");
      expect(result.snapshot).toBeNull();
      expect(result.diagnostics).toContain("No build descriptors found in workspace");
    });

    it("WorkspaceProjectStructureStore manages refresh lifecycle and increments generation", () => {
      const store = new WorkspaceProjectStructureStore();
      expect(store.getState().status).toBe("idle");
      expect(store.getState().generation).toBe(0);

      const state1 = store.refresh([
        {
          path: "/repo/Cargo.toml",
          content: '[package]\nname = "taomni-cli"',
        },
      ]);

      expect(state1.status).toBe("descriptor-only");
      expect(state1.generation).toBe(1);
      expect(state1.snapshot?.modules[0].id).toBe("cargo:taomni-cli");
      expect(state1.lastRefreshed).not.toBeNull();
    });
  });

  describe("§ED-PROJECT-001: Project Descriptor Discovery Isolation & Ready Snapshot Consumer Guards", () => {
    it("discovers all four descriptor families (Cargo, npm, Maven, Gradle) without fabricating ready classpath", () => {
      const descriptors = [
        { path: "/workspace/rust-tool/Cargo.toml", content: '[package]\nname = "rust-tool"\nversion = "1.0.0"' },
        { path: "/workspace/web-app/package.json", content: '{"name": "web-app", "dependencies": {"vue": "3.0"}}' },
        { path: "/workspace/service-a/pom.xml", content: "<project><artifactId>service-a</artifactId></project>" },
        { path: "/workspace/service-b/build.gradle", content: "// gradle script" },
      ];

      const discovery = discoverProjectDescriptors(descriptors, 4);
      expect(discovery.status).toBe("descriptor-only");
      expect(discovery.generation).toBe(4);
      expect(discovery.descriptors).toHaveLength(4);

      const systems = discovery.descriptors.map((d) => d.buildSystem);
      expect(systems).toEqual(["cargo", "npm", "maven", "gradle"]);

      for (const d of discovery.descriptors) {
        expect(d.rawContentSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(d.inferredExcludedRoots.length).toBeGreaterThan(0);
      }

      // Excluded roots merged across all descriptors
      expect(discovery.excludedRoots).toEqual([
        "/workspace/rust-tool/target",
        "/workspace/service-a/target",
        "/workspace/service-b/.gradle",
        "/workspace/service-b/build",
        "/workspace/web-app/dist",
        "/workspace/web-app/node_modules",
      ]);
    });

    it("handles partial/malformed descriptors and empty descriptor sets gracefully", () => {
      // Empty
      const emptyDiscovery = discoverProjectDescriptors([]);
      expect(emptyDiscovery.status).toBe("unresolved");
      expect(emptyDiscovery.descriptors).toHaveLength(0);

      // Malformed JSON package.json
      const malformedDiscovery = discoverProjectDescriptors([
        { path: "/workspace/broken/package.json", content: "{ invalid json" },
      ]);
      expect(malformedDiscovery.status).toBe("unresolved");
      expect(malformedDiscovery.diagnostics).toContain("Build descriptors present but could not be parsed into modules");

      // Mixed valid and malformed
      const mixedDiscovery = discoverProjectDescriptors([
        { path: "/workspace/broken/package.json", content: "{ invalid json" },
        { path: "/workspace/valid/pom.xml", content: "<project><artifactId>valid-service</artifactId></project>" },
      ]);
      expect(mixedDiscovery.status).toBe("descriptor-only");
      expect(mixedDiscovery.descriptors).toHaveLength(1);
      expect(mixedDiscovery.descriptors[0].name).toBe("valid-service");
    });

    it("blocks consumers when snapshot is descriptor-only, stale-generation, or unresolved", () => {
      const store = new WorkspaceProjectStructureStore();

      // 1. Initial idle/unresolved state -> blocked
      const outcome1 = consumeProjectReadySnapshot(store.getState(), undefined, (s) => s.modules);
      expect(outcome1.state).toBe("unresolved");

      // 2. Refreshed with descriptors -> status is "descriptor-only" -> blocked from ready consumption
      store.refresh([{ path: "/workspace/pom.xml", content: "<project><artifactId>api</artifactId></project>" }]);
      const outcome2 = consumeProjectReadySnapshot(store.getState(), 1, (s) => s.modules);
      expect(outcome2.state).toBe("descriptor-only");
      if (outcome2.state === "descriptor-only") {
        expect(outcome2.reason).toContain("live tooling/LSP model ingestion has not resolved ready classpath");
      }

      // 3. Stale generation check: even if resolved, older generation expectation is blocked
      const readySnapshot = buildProjectStructureSnapshotV2({
        generation: 2,
        source: "maven-model",
        modules: [sampleModule1],
      });
      store.setResolved(readySnapshot);

      const outcomeStale = consumeProjectReadySnapshot(store.getState(), 1, (s) => s.modules);
      expect(outcomeStale.state).toBe("stale-generation");
      if (outcomeStale.state === "stale-generation") {
        expect(outcomeStale.expectedGeneration).toBe(1);
        expect(outcomeStale.currentGeneration).toBe(2);
      }

      // 4. Valid resolved snapshot with matching generation -> allowed!
      const outcomeReady = consumeProjectReadySnapshot(store.getState(), 2, (s) => s.modules);
      expect(outcomeReady.state).toBe("ready");
      if (outcomeReady.state === "ready") {
        expect(outcomeReady.data).toHaveLength(1);
        expect(outcomeReady.data[0].id).toBe("com.example:core");
      }
    });
  });
});
