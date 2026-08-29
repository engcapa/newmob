import { describe, expect, it, vi } from "vitest";
import {
  workspaceIngestMavenProject,
  type MavenToolingRequest,
  type MavenToolingResult,
} from "./workspaceTooling";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

describe("ED-PROJECT-002: workspaceTooling IPC bridge", () => {
  it("invokes workspace_ingest_maven_project command with request payload", async () => {
    const mockResult: MavenToolingResult = {
      status: "ready",
      modules: [
        {
          id: "com.example:app",
          name: "app",
          root: "/repo/app",
          pomPath: "/repo/app/pom.xml",
          sourceRoots: ["/repo/app/src/main/java"],
          testRoots: ["/repo/app/src/test/java"],
          resourceRoots: ["/repo/app/src/main/resources"],
          outputDir: "/repo/app/target/classes",
          dependencies: ["org.slf4j:slf4j-api:2.0.7"],
          classpath: ["org.slf4j:slf4j-api:2.0.7"],
        },
      ],
      provenance: {
        toolKind: "mvnw",
        toolVersion: null,
        javaHome: "/opt/jdk21",
        javaVersion: null,
        argv: ["/repo/mvnw", "--offline", "help:effective-pom"],
        cwd: "/repo",
        pomHash: "abc1234",
        resolvedAt: "2026-08-29T12:00:00Z",
      },
      errorMessage: null,
    };

    coreMocks.invoke.mockResolvedValue(mockResult);

    const request: MavenToolingRequest = {
      workspaceRoot: "/repo",
      trusted: true,
      javaHome: "/opt/jdk21",
      offline: true,
    };

    const res = await workspaceIngestMavenProject(request);

    expect(coreMocks.invoke).toHaveBeenCalledWith("workspace_ingest_maven_project", { request });
    expect(res).toEqual(mockResult);
    expect(res.status).toBe("ready");
    expect(res.modules).toHaveLength(1);
    expect(res.provenance?.toolKind).toBe("mvnw");
  });
});
