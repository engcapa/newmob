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

  it("supports auto-fallback from Maven to Gradle when Maven has no build file", async () => {    vi.spyOn(workspaceTooling, "workspaceIngestMavenProject").mockResolvedValue({
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

  it("lets a newer overlapping fetch win and drops the late result (A2)", async () => {
    let resolveSlow: ((value: Awaited<ReturnType<typeof workspaceTooling.workspaceIngestMavenProject>>) => void) | null = null;
    const slowGate = new Promise<Awaited<ReturnType<typeof workspaceTooling.workspaceIngestMavenProject>>>((resolve) => {
      resolveSlow = resolve;
    });
    const mavenSpy = vi.spyOn(workspaceTooling, "workspaceIngestMavenProject")
      .mockReturnValueOnce(slowGate)
      .mockResolvedValueOnce({
        status: "ready",
        modules: [
          {
            id: "com.example:fast",
            name: "fast",
            root: "/race",
            pomPath: "/race/pom.xml",
            sourceRoots: ["/race/src/main/java"],
            testRoots: [],
            resourceRoots: [],
            outputDir: null,
            dependencies: [],
            classpath: [],
          },
        ],
        provenance: {
          toolKind: "mvn",
          toolVersion: null,
          javaHome: null,
          javaVersion: null,
          argv: ["mvn", "help:effective-pom"],
          cwd: "/race",
          pomHash: "fast-hash",
          resolvedAt: "2026-08-29T12:00:00Z",
        },
        errorMessage: null,
      });

    const store = useProjectFactsStore.getState();
    const slowPromise = store.fetchProjectFacts("/race", { trusted: true });
    // Second fetch supersedes the first while it is still in flight.
    const fastResult = await store.fetchProjectFacts("/race", { trusted: true });
    expect(fastResult.status).toBe("ready");
    expect(fastResult.generation).toBe(2);
    expect(fastResult.fingerprint).toContain("fast-hash");

    // The superseded fetch resolves late and must not replace newer state.
    resolveSlow!({
      status: "ready",
      modules: [
        {
          id: "com.example:slow",
          name: "slow",
          root: "/race",
          pomPath: "/race/pom.xml",
          sourceRoots: ["/race/src/main/java"],
          testRoots: [],
          resourceRoots: [],
          outputDir: null,
          dependencies: [],
          classpath: [],
        },
      ],
      provenance: {
        toolKind: "mvn",
        toolVersion: null,
        javaHome: null,
        javaVersion: null,
        argv: ["mvn", "help:effective-pom"],
        cwd: "/race",
        pomHash: "slow-hash",
        resolvedAt: "2026-08-29T12:00:00Z",
      },
      errorMessage: null,
    });
    const lateResult = await slowPromise;
    expect(mavenSpy).toHaveBeenCalledTimes(2);
    // Late winner returns the live entry, and the store keeps the fast facts.
    expect(lateResult.fingerprint).toContain("fast-hash");
    const live = store.getWorkspaceFacts("/race");
    expect(live.generation).toBe(2);
    expect(live.fingerprint).toContain("fast-hash");
    expect(live.structure).toBe(fastResult.structure);
  });

  it("applies an untrusted fetch over an in-flight trusted one with zero processes (A2/A3)", async () => {
    const gate = new Promise<Awaited<ReturnType<typeof workspaceTooling.workspaceIngestMavenProject>>>(() => {});
    const mavenSpy = vi.spyOn(workspaceTooling, "workspaceIngestMavenProject").mockReturnValue(gate);
    const gradleSpy = vi.spyOn(workspaceTooling, "workspaceIngestGradleProject");

    const store = useProjectFactsStore.getState();
    void store.fetchProjectFacts("/trust-race", { trusted: true });
    const untrusted = await store.fetchProjectFacts("/trust-race", { trusted: false });

    expect(untrusted.status).toBe("untrusted");
    expect(untrusted.reason).toContain("process=0");
    expect(mavenSpy).toHaveBeenCalledTimes(1);
    expect(gradleSpy).not.toHaveBeenCalled();
    const live = store.getWorkspaceFacts("/trust-race");
    expect(live.status).toBe("untrusted");
    expect(live.generation).toBe(2);
  });

  it("exposes loading during flight before ready (A1 transitions)", async () => {
    let resolveFetch: ((value: Awaited<ReturnType<typeof workspaceTooling.workspaceIngestMavenProject>>) => void) | null = null;
    const gate = new Promise<Awaited<ReturnType<typeof workspaceTooling.workspaceIngestMavenProject>>>((resolve) => {
      resolveFetch = resolve;
    });
    vi.spyOn(workspaceTooling, "workspaceIngestMavenProject").mockReturnValue(gate);

    const store = useProjectFactsStore.getState();
    const pending = store.fetchProjectFacts("/transition", { trusted: true });
    expect(store.getWorkspaceFacts("/transition").status).toBe("loading");

    resolveFetch!({
      status: "failed",
      modules: [],
      provenance: null,
      errorMessage: "boom",
    });
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.generation).toBe(1);
    expect(store.getWorkspaceFacts("/transition").status).toBe("failed");
  });
});
