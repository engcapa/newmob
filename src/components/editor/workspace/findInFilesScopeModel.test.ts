import { describe, expect, it } from "vitest";
import type { WorkspaceProjectFactsEntry } from "../../../stores/projectFactsStore";
import {
  parseFileMask,
  matchesFileMask,
  planFindInFilesScope,
  isFileInScopePlan,
} from "./findInFilesScopeModel";
import { buildProjectStructureSnapshotV2 } from "./projectStructureModel";

describe("ED-FIND-003: findInFilesScopeModel scope and file-mask filtering", () => {
  describe("File mask parsing and matching", () => {
    it("parses multiple masks separated by comma and semicolon", () => {
      expect(parseFileMask("*.java, *.kt; *.scala")).toEqual(["*.java", "*.kt", "*.scala"]);
      expect(parseFileMask("")).toEqual([]);
      expect(parseFileMask(null)).toEqual([]);
    });

    it("matches positive file masks", () => {
      expect(matchesFileMask("/path/to/UserService.java", "*.java")).toBe(true);
      expect(matchesFileMask("/path/to/App.kt", "*.java, *.kt")).toBe(true);
      expect(matchesFileMask("/path/to/style.css", "*.java, *.kt")).toBe(false);
    });

    it("evaluates negative file masks", () => {
      expect(matchesFileMask("/path/to/UserService.java", "*.java, !*Test.java")).toBe(true);
      expect(matchesFileMask("/path/to/UserServiceTest.java", "*.java, !*Test.java")).toBe(false);
    });
  });

  describe("Scope planning", () => {
    const mockStructure = buildProjectStructureSnapshotV2({
      generation: 2,
      modules: [
        {
          id: "com.example:core",
          buildSystem: "maven",
          root: "/workspace/core",
          sourceRoots: ["/workspace/core/src/main/java"],
          testRoots: ["/workspace/core/src/test/java"],
          generatedRoots: [],
          excludedRoots: [],
          dependencyFingerprint: "",
        },
      ],
      userExcludedRoots: ["/workspace/target"],
    });

    const readyFacts: WorkspaceProjectFactsEntry = {
      workspaceRoot: "/workspace",
      generation: 2,
      status: "ready",
      reason: null,
      fingerprint: "hash",
      structure: mockStructure,
      provenance: null,
      isStale: false,
      abortController: null,
    };

    it("plans project, directory, and recent scopes", () => {
      const projectPlan = planFindInFilesScope({
        kind: "project",
        workspaceRoot: "/workspace",
        fileMask: "*.java",
      });
      expect(projectPlan.status).toBe("ready");
      expect(projectPlan.roots).toEqual(["/workspace"]);

      const dirPlan = planFindInFilesScope({
        kind: "directory",
        workspaceRoot: "/workspace",
        targetDirectory: "/workspace/core/src",
      });
      expect(dirPlan.status).toBe("ready");
      expect(dirPlan.roots).toEqual(["/workspace/core/src"]);

      const recentPlan = planFindInFilesScope({
        kind: "recent",
        workspaceRoot: "/workspace",
        recentFiles: ["/workspace/core/src/main/java/Main.java"],
      });
      expect(recentPlan.status).toBe("ready");
      // `explicitFiles` only exists on the ready variant.
      if (recentPlan.status !== "ready") throw new Error(`expected ready, got ${recentPlan.status}`);
      expect(recentPlan.explicitFiles).toContain("/workspace/core/src/main/java/Main.java");
    });

    it("plans module scope from ready project facts", () => {
      const modulePlan = planFindInFilesScope(
        {
          kind: "module",
          workspaceRoot: "/workspace",
          moduleId: "com.example:core",
          expectedGeneration: 2,
        },
        readyFacts,
      );

      expect(modulePlan.status).toBe("ready");
      expect(modulePlan.roots).toContain("/workspace/core");
      expect(modulePlan.roots).toContain("/workspace/core/src/main/java");
    });

    it("fails closed when module scope facts are missing, untrusted, or stale", () => {
      // Missing facts
      const noFactsPlan = planFindInFilesScope({
        kind: "module",
        workspaceRoot: "/workspace",
        moduleId: "com.example:core",
      });
      expect(noFactsPlan.status).toBe("unresolved");

      // Untrusted
      const untrustedPlan = planFindInFilesScope(
        { kind: "module", workspaceRoot: "/workspace", moduleId: "com.example:core" },
        { ...readyFacts, status: "untrusted" },
      );
      expect(untrustedPlan.status).toBe("unresolved");
      if (untrustedPlan.status === "unresolved") {
        expect(untrustedPlan.reason).toContain("untrusted");
      }

      // Stale
      const stalePlan = planFindInFilesScope(
        { kind: "module", workspaceRoot: "/workspace", moduleId: "com.example:core" },
        { ...readyFacts, isStale: true },
      );
      expect(stalePlan.status).toBe("unresolved");
    });

    it("checks file containment and exclusion in planned scope", () => {
      const plan = planFindInFilesScope(
        {
          kind: "module",
          workspaceRoot: "/workspace",
          moduleId: "com.example:core",
          fileMask: "*.java, !*Test.java",
        },
        readyFacts,
      );

      expect(isFileInScopePlan("/workspace/core/src/main/java/Service.java", plan, mockStructure)).toBe(true);
      // Rejects excluded root
      expect(isFileInScopePlan("/workspace/target/Generated.java", plan, mockStructure)).toBe(false);
      // Rejects test mask
      expect(isFileInScopePlan("/workspace/core/src/test/java/ServiceTest.java", plan, mockStructure)).toBe(false);
      // Rejects other directory outside module roots
      expect(isFileInScopePlan("/workspace/app/src/main/java/App.java", plan, mockStructure)).toBe(false);
    });

    it("normalizes Windows separators, drive casing, and root boundaries", () => {
      const windowsPlan = {
        status: "ready" as const,
        kind: "module" as const,
        roots: ["C:\\Workspace\\core"],
        fileMask: "*.java",
      };
      const windowsStructure = {
        ...mockStructure,
        excludedRoots: ["C:\\Workspace\\target"],
      };

      expect(isFileInScopePlan(
        "c:/workspace/CORE/src/main/java/Service.java",
        windowsPlan,
        windowsStructure,
      )).toBe(true);
      expect(isFileInScopePlan(
        "C:\\WORKSPACE\\target\\Generated.java",
        windowsPlan,
        windowsStructure,
      )).toBe(false);
      expect(isFileInScopePlan(
        "C:\\Workspace\\core-legacy\\Service.java",
        windowsPlan,
        windowsStructure,
      )).toBe(false);
    });
  });
});
