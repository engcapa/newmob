import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectFactsStore } from "./projectFactsStore";
import * as workspaceTooling from "../lib/editor/workspaceTooling";

describe("ED-PROJECT-004: projectFactsStore lifecycle & generation cache", () => {
  beforeEach(() => {
    useProjectFactsStore.setState({ workspaces: {} });
    vi.restoreAllMocks();
  });

  it("fails closed with untrusted status when workspace is not trusted", async () => {
    const mavenSpy = vi.spyOn(workspaceTooling, "workspaceIngestMavenProject");
    const gradleSpy = vi.spyOn(workspaceTooling, "workspaceIngestGradleProject");

    const store = useProjectFactsStore.getState();
    const result = await store.fetchProjectFacts("/untrusted-repo", {
      trusted: false,
    });

    expect(result.status).toBe("untrusted");
    expect(result.reason).toContain("process=0");
    expect(mavenSpy).not.toHaveBeenCalled();
    expect(gradleSpy).not.toHaveBeenCalled();
  });

  it("increments generation and manages multi-workspace isolation", async () => {
    vi.spyOn(workspaceTooling, "workspaceIngestMavenProject").mockResolvedValue({
      status: "ready",
      modules: [
        {
          id: "com.example:core",
          name: "core",
          root: "/repo1/core",
          pomPath: "/repo1/core/pom.xml",
          sourceRoots: ["/repo1/core/src/main/java"],
          testRoots: [],
          resourceRoots: [],
          outputDir: "/repo1/core/target/classes",
          dependencies: [],
          classpath: [],
        },
      ],
      provenance: {
        toolKind: "mvnw",
        toolVersion: null,
        javaHome: "/opt/jdk21",
        javaVersion: null,
        argv: ["/repo1/mvnw", "help:effective-pom"],
        cwd: "/repo1",
        pomHash: "hash1",
        resolvedAt: "2026-08-29T12:00:00Z",
      },
      errorMessage: null,
    });

    const store = useProjectFactsStore.getState();
    const res1 = await store.fetchProjectFacts("/repo1", { trusted: true });
    expect(res1.generation).toBe(1);
    expect(res1.status).toBe("ready");
    expect(res1.structure?.modules).toHaveLength(1);

    // Invalidate repo1
    store.invalidate("/repo1", "pom.xml modified");
    const staleEntry = store.getWorkspaceFacts("/repo1");
    expect(staleEntry.isStale).toBe(true);
    expect(staleEntry.reason).toBe("pom.xml modified");

    // Fetch repo1 again
    const res2 = await store.fetchProjectFacts("/repo1", { trusted: true });
    expect(res2.generation).toBe(2);
    expect(res2.isStale).toBe(false);

    // Repo2 remains unaffected (isolated)
    const repo2Entry = store.getWorkspaceFacts("/repo2");
    expect(repo2Entry.status).toBe("idle");
    expect(repo2Entry.generation).toBe(0);
  });

  it("supports auto-fallback from Maven to Gradle when Maven has no build file", async () => {
    vi.spyOn(workspaceTooling, "workspaceIngestMavenProject").mockResolvedValue({
      status: "failed",
      modules: [],
      provenance: null,
      errorMessage: "pom.xml not found",
    });

    vi.spyOn(workspaceTooling, "workspaceIngestGradleProject").mockResolvedValue({
      status: "ready",
      modules: [
        {
          id: ":app",
          name: "app",
          root: "/gradle-repo/app",
          buildFile: "/gradle-repo/app/build.gradle",
          sourceRoots: ["/gradle-repo/app/src/main/java"],
          testRoots: [],
          resourceRoots: [],
          outputDir: "/gradle-repo/app/build/classes/java/main",
          dependencies: [],
          classpath: [],
        },
      ],
      provenance: {
        toolKind: "gradlew",
        toolVersion: null,
        javaHome: "/opt/jdk21",
        javaVersion: null,
        argv: ["/gradle-repo/gradlew", "projects"],
        cwd: "/gradle-repo",
        settingsHash: "hash-gradle",
        resolvedAt: "2026-08-29T12:00:00Z",
      },
      errorMessage: null,
    });

    const store = useProjectFactsStore.getState();
    const result = await store.fetchProjectFacts("/gradle-repo", {
      trusted: true,
      toolKind: "auto",
    });

    expect(result.status).toBe("ready");
    expect(result.structure?.facts["module.:app"]?.source).toBe("gradle-model");
  });
});
