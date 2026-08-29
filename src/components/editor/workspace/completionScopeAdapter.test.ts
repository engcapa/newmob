import { beforeEach, describe, expect, it } from "vitest";
import { useProjectFactsStore, type WorkspaceProjectFactsEntry } from "../../../stores/projectFactsStore";
import {
  resolveCompletionScopeFacts,
  getCompletionScopeDisplay,
} from "./completionScopeAdapter";
import { buildProjectStructureSnapshotV2 } from "./projectStructureModel";

describe("ED-COMP-004: completionScopeAdapter ready project scope facts", () => {
  beforeEach(() => {
    useProjectFactsStore.setState({ workspaces: {} });
  });

  const mockStructure = buildProjectStructureSnapshotV2({
    generation: 5,
    modules: [
      {
        id: "com.example:service",
        root: "/ws1/service",
        sourceRoots: ["/ws1/service/src/main/java"],
        testRoots: ["/ws1/service/src/test/java"],
        generatedRoots: [],
        outputDirectory: "",
        testOutputDirectory: "",
        dependencies: ["com.example:model", "io.grpc:grpc-stub:1.58.0"],
        dependencyFingerprint: "cp-service-fp",
        isCurrent: true,
      },
    ],
    dependenciesByModule: {
      "com.example:service": ["com.example:model", "io.grpc:grpc-stub:1.58.0"],
    },
    classpathFingerprintsByModule: {
      "com.example:service": "cp-service-fp",
    },
    source: "maven-model",
  });

  const readyEntryWs1: WorkspaceProjectFactsEntry = {
    workspaceRoot: "/ws1",
    generation: 5,
    status: "ready",
    reason: null,
    fingerprint: "mvnw:hash123:/opt/jdk21",
    structure: mockStructure,
    provenance: null,
    isStale: false,
    abortController: null,
  };

  it("always provides document scope without depending on project facts", () => {
    const res = resolveCompletionScopeFacts("/ws1", "/ws1/service/src/main/java/Main.java", "document");
    expect(res.status).toBe("ready");
    expect(res.scope).toBe("document");
    const display = getCompletionScopeDisplay(res);
    expect(display.label).toBe("Document Scope");
    expect(display.isFallback).toBe(false);
  });

  it("resolves module scope from ready project facts generation", () => {
    useProjectFactsStore.setState({
      workspaces: { "/ws1": readyEntryWs1 },
    });

    const res = resolveCompletionScopeFacts(
      "/ws1",
      "/ws1/service/src/main/java/com/example/Main.java",
      "module",
      5,
    );

    expect(res.status).toBe("ready");
    if (res.status === "ready") {
      expect(res.moduleId).toBe("com.example:service");
      expect(res.sourceKind).toBe("main");
      expect(res.dependencies).toContain("io.grpc:grpc-stub:1.58.0");
      expect(res.classpathFingerprint).toBe("cp-service-fp");
      expect(res.generation).toBe(5);
    }

    const display = getCompletionScopeDisplay(res);
    expect(display.label).toContain("Module Scope (com.example:service, G5)");
    expect(display.isFallback).toBe(false);
  });

  it("returns scope-facts-missing when project facts are untrusted, loading, or failed", () => {
    useProjectFactsStore.setState({
      workspaces: {
        "/ws1": {
          ...readyEntryWs1,
          status: "untrusted",
          reason: "Workspace is untrusted",
        },
      },
    });

    const res = resolveCompletionScopeFacts(
      "/ws1",
      "/ws1/service/src/main/java/com/example/Main.java",
      "module",
    );

    expect(res.status).toBe("scope-facts-missing");
    if (res.status === "scope-facts-missing") {
      expect(res.fallbackScope).toBe("document");
      expect(res.reason).toContain("untrusted");
    }

    const display = getCompletionScopeDisplay(res);
    expect(display.isFallback).toBe(true);
    expect(display.label).toContain("Scope facts missing");
  });

  it("returns scope-facts-missing when project facts generation is stale", () => {
    useProjectFactsStore.setState({
      workspaces: {
        "/ws1": {
          ...readyEntryWs1,
          isStale: true,
          reason: "pom.xml modified",
        },
      },
    });

    const res = resolveCompletionScopeFacts(
      "/ws1",
      "/ws1/service/src/main/java/com/example/Main.java",
      "module",
    );

    expect(res.status).toBe("scope-facts-missing");
  });

  it("maintains strict workspace isolation with dual workspace roots", () => {
    const readyEntryWs2: WorkspaceProjectFactsEntry = {
      workspaceRoot: "/ws2",
      generation: 1,
      status: "ready",
      reason: null,
      fingerprint: "gradlew:hash999:/opt/jdk17",
      structure: buildProjectStructureSnapshotV2({
        generation: 1,
        modules: [
          {
            id: ":ws2-module",
            root: "/ws2/app",
            sourceRoots: ["/ws2/app/src/main/kotlin"],
            testRoots: [],
            generatedRoots: [],
            outputDirectory: "",
            testOutputDirectory: "",
            dependencies: ["com.google.guava:guava:32.1.2-jre"],
            dependencyFingerprint: "cp-ws2",
            isCurrent: true,
          },
        ],
        source: "gradle-model",
      }),
      provenance: null,
      isStale: false,
      abortController: null,
    };

    useProjectFactsStore.setState({
      workspaces: {
        "/ws1": readyEntryWs1,
        "/ws2": readyEntryWs2,
      },
    });

    const ws1Res = resolveCompletionScopeFacts("/ws1", "/ws1/service/src/main/java/Main.java", "module");
    const ws2Res = resolveCompletionScopeFacts("/ws2", "/ws2/app/src/main/kotlin/App.kt", "module");

    expect(ws1Res.status).toBe("ready");
    expect(ws2Res.status).toBe("ready");

    if (ws1Res.status === "ready" && ws2Res.status === "ready") {
      expect(ws1Res.moduleId).toBe("com.example:service");
      expect(ws1Res.generation).toBe(5);

      expect(ws2Res.moduleId).toBe(":ws2-module");
      expect(ws2Res.generation).toBe(1);
    }
  });
});
