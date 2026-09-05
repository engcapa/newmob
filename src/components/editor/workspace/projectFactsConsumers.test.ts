import { describe, expect, it, beforeEach } from "vitest";
import type { WorkspaceProjectFactsEntry } from "../../../stores/projectFactsStore";
import { useProjectFactsStore } from "../../../stores/projectFactsStore";
import {
  consumeCompletionScope,
  consumeSemanticQueryScope,
  consumeRefactorCoverage,
  selectQueryProjectGeneration,
} from "./projectFactsConsumers";
import { buildProjectStructureSnapshotV2 } from "./projectStructureModel";

describe("ED-PROJECT-005: project facts three-consumer adapters", () => {
  beforeEach(() => {
    useProjectFactsStore.setState({ workspaces: {} });
  });

  const mockStructure = buildProjectStructureSnapshotV2({
    generation: 3,
    modules: [
      {
        id: "com.example:core",
        buildSystem: "maven",
        root: "/workspace/core",
        sourceRoots: ["/workspace/core/src/main/java"],
        testRoots: ["/workspace/core/src/test/java"],
        generatedRoots: [],
        excludedRoots: [],
        dependencyFingerprint: "cp-core",
      },
      {
        id: "com.example:app",
        buildSystem: "maven",
        root: "/workspace/app",
        sourceRoots: ["/workspace/app/src/main/java"],
        testRoots: ["/workspace/app/src/test/java"],
        generatedRoots: [],
        excludedRoots: [],
        dependencyFingerprint: "cp-app",
      },
    ],
    userExcludedRoots: ["/workspace/build-output", "/workspace/target"],
    dependenciesByModule: {
      "com.example:core": ["org.slf4j:slf4j-api:2.0.7"],
      "com.example:app": ["com.example:core", "org.springframework:spring-web:6.0.0"],
    },
    classpathFingerprintsByModule: {
      "com.example:core": "cp-core",
      "com.example:app": "cp-app",
    },
    source: "maven-model",
  });

  const readyEntry: WorkspaceProjectFactsEntry = {
    workspaceRoot: "/workspace",
    generation: 3,
    status: "ready",
    reason: null,
    fingerprint: "mvnw:abc1234:/opt/jdk21",
    structure: mockStructure,
    provenance: null,
    isStale: false,
    abortController: null,
  };

  describe("Fail-closed gating across consumers", () => {
    it("fails closed when untrusted", () => {
      const untrusted: WorkspaceProjectFactsEntry = {
        ...readyEntry,
        status: "untrusted",
        reason: "Workspace untrusted",
      };

      const comp = consumeCompletionScope(untrusted, "/workspace/core/src/main/java/Main.java");
      expect(comp.state).toBe("untrusted");
      expect(comp.data).toBeNull();

      const query = consumeSemanticQueryScope(untrusted, "/workspace/core/src/main/java/Main.java");
      expect(query.state).toBe("untrusted");
      expect(query.data).toBeNull();

      const refactor = consumeRefactorCoverage(untrusted, "com.example:core");
      expect(refactor.state).toBe("untrusted");
      expect(refactor.data).toBeNull();
    });

    it("fails closed when stale or generation mismatched", () => {
      const stale: WorkspaceProjectFactsEntry = {
        ...readyEntry,
        isStale: true,
        reason: "pom.xml modified",
      };

      const compStale = consumeCompletionScope(stale, "/workspace/core/src/main/java/Main.java");
      expect(compStale.state).toBe("stale");

      const compGenMismatch = consumeCompletionScope(readyEntry, "/workspace/core/src/main/java/Main.java", 2);
      expect(compGenMismatch.state).toBe("stale");
      expect(compGenMismatch.reason).toContain("Generation mismatch");
    });

    it("fails closed for cross-workspace paths without leaking facts (A3)", () => {
      const comp = consumeCompletionScope(readyEntry, "/other/project/src/Main.java");
      expect(comp.state).toBe("failed");
      expect(comp.data).toBeNull();
      expect(comp.reason).toContain("/other/project/src/Main.java");
      expect(comp.reason).toContain("/workspace");

      const query = consumeSemanticQueryScope(readyEntry, "/other/project/src/Main.java");
      expect(query.state).toBe("failed");
      expect(query.data).toBeNull();

      // A path that merely shares a string prefix is still outside the root.
      const prefix = consumeCompletionScope(readyEntry, "/workspace-evil/Main.java");
      expect(prefix.state).toBe("failed");
      expect(prefix.data).toBeNull();
    });
  });

  describe("1. Completion Scope Consumer", () => {
    it("resolves module, source set, and classpath fingerprint for source file", () => {
      const res = consumeCompletionScope(
        readyEntry,
        "/workspace/core/src/main/java/com/example/Service.java",
        3,
      );

      expect(res.state).toBe("ready");
      expect(res.data?.moduleId).toBe("com.example:core");
      expect(res.data?.sourceKind).toBe("main");
      expect(res.data?.dependencies).toContain("org.slf4j:slf4j-api:2.0.7");
      expect(res.data?.classpathFingerprint).toBe("cp-core");
      expect(res.data?.isExcluded).toBe(false);
    });

    it("resolves test source set for test files", () => {
      const res = consumeCompletionScope(
        readyEntry,
        "/workspace/core/src/test/java/com/example/ServiceTest.java",
        3,
      );

      expect(res.state).toBe("ready");
      expect(res.data?.sourceKind).toBe("test");
    });
  });

  describe("2. Semantic Query Consumer", () => {
    it("identifies source kind and excluded directory paths", () => {
      const sourceRes = consumeSemanticQueryScope(
        readyEntry,
        "/workspace/app/src/main/java/App.java",
      );
      expect(sourceRes.data?.moduleId).toBe("com.example:app");
      expect(sourceRes.data?.sourceKind).toBe("main");
      expect(sourceRes.data?.isIndexed).toBe(true);

      const excludedRes = consumeSemanticQueryScope(
        readyEntry,
        "/workspace/target/compiled/App.class",
      );
      expect(excludedRes.data?.sourceKind).toBe("excluded");
      expect(excludedRes.data?.isIndexed).toBe(false);
    });
  });

  describe("3. Refactor Coverage Consumer", () => {
    it("computes transitive dependents for refactor impact analysis", () => {
      const res = consumeRefactorCoverage(readyEntry, "com.example:core", 3);

      expect(res.state).toBe("ready");
      expect(res.data?.targetModuleId).toBe("com.example:core");
      // app depends on core, so both core and app are affected
      expect(res.data?.affectedModuleIds).toEqual(["com.example:app", "com.example:core"]);
      expect(res.data?.affectedRoots).toContain("/workspace/core");
      expect(res.data?.affectedRoots).toContain("/workspace/app");
    });
  });

  describe("4. Query generation pinning helper", () => {
    it("returns the ready generation only for owned ready paths", () => {
      useProjectFactsStore.setState({ workspaces: { "/workspace": readyEntry } });

      expect(selectQueryProjectGeneration("/workspace", "/workspace/core/src/main/java/Main.java")).toBe(3);
      // Unknown workspace, foreign path, and empty inputs pin nothing.
      expect(selectQueryProjectGeneration("/other", "/other/src/Main.java")).toBeUndefined();
      expect(selectQueryProjectGeneration("/workspace", "/other/src/Main.java")).toBeUndefined();
      expect(selectQueryProjectGeneration("", "/workspace/core/src/main/java/Main.java")).toBeUndefined();
      expect(selectQueryProjectGeneration("/workspace", null)).toBeUndefined();
    });

    it("pins nothing while facts are not ready", () => {
      useProjectFactsStore.setState({
        workspaces: {
          "/workspace": { ...readyEntry, status: "loading", structure: null },
        },
      });
      expect(selectQueryProjectGeneration("/workspace", "/workspace/core/src/main/java/Main.java")).toBeUndefined();

      useProjectFactsStore.setState({
        workspaces: {
          "/workspace": { ...readyEntry, isStale: true },
        },
      });
      expect(selectQueryProjectGeneration("/workspace", "/workspace/core/src/main/java/Main.java")).toBeUndefined();
    });
  });
});
