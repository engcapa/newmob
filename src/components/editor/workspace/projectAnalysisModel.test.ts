import { describe, expect, it } from "vitest";
import {
  classifyProgressTitle,
  computeProjectFingerprint,
  deriveProjectAnalysisSnapshot,
  modulesFromProviderModel,
  projectSnapshotStaleFor,
  sha256Hex,
  type ProjectAnalysisSnapshotInputs,
} from "./projectAnalysisModel";

function inputs(overrides: Partial<ProjectAnalysisSnapshotInputs> = {}): ProjectAnalysisSnapshotInputs {
  return {
    workspaceId: "ws",
    generation: 3,
    provider: {
      configured: true,
      active: true,
      opening: false,
      lastError: null,
      processId: 4242,
      serverName: "jdt.ls",
      serverVersion: "1.61.0",
      registeredCommands: ["java.project.list", "java.project.getClasspaths"],
    },
    progress: [],
    probe: { kind: "not-run", reason: null, rootUri: null, entryCount: null, entriesSha256: null, completedAt: null },
    modules: null,
    build: {
      roots: ["/repo/maven-single"],
      buildFiles: [{ path: "pom.xml", sha256: "aa".repeat(32) }],
      sdk: { homeHash: "bb".repeat(32), version: "21.0.4", languageLevel: "21" },
    },
    now: 1_000,
    ...overrides,
  };
}

describe("sha256Hex (sync fingerprint hash)", () => {
  it("matches known SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });
});

describe("classifyProgressTitle", () => {
  it("buckets provider job titles into importing vs analyzing", () => {
    expect(classifyProgressTitle("Importing Gradle project")).toBe("importing");
    expect(classifyProgressTitle("Configuring Maven dependencies")).toBe("importing");
    expect(classifyProgressTitle("Analyzing sources")).toBe("analyzing");
    expect(classifyProgressTitle("Validate documents")).toBe("analyzing");
    expect(classifyProgressTitle("Publish Diagnostics")).toBe("analyzing");
  });

  it("treats unknown titles as live analysis work, never ready-underneath", () => {
    expect(classifyProgressTitle("Mystery job")).toBe("analyzing");
    expect(classifyProgressTitle(null)).toBeNull();
  });
});

describe("deriveProjectAnalysisSnapshot §8.20.3 state machine", () => {
  it("reports unconfigured before any java provider exists", () => {
    const snapshot = deriveProjectAnalysisSnapshot(inputs({
      provider: { ...inputs().provider, configured: false, active: false, opening: false },
    }));
    expect(snapshot.phase).toBe("unconfigured");
    expect(snapshot.completeness).toBe("unknown");
    expect(snapshot.startedAt).toBeNull();
  });

  it("reports offline when configured but no session is live", () => {
    const snapshot = deriveProjectAnalysisSnapshot(inputs({
      provider: { ...inputs().provider, active: false, opening: false },
    }));
    expect(snapshot.phase).toBe("offline");
  });

  it("reports error with the provider message after a failed start", () => {
    const snapshot = deriveProjectAnalysisSnapshot(inputs({
      provider: { ...inputs().provider, active: false, lastError: "jdtls crashed on startup" },
    }));
    expect(snapshot.phase).toBe("error");
    expect(snapshot.diagnostics).toContain("jdtls crashed on startup");
  });

  it("scanning covers the opening window; import/analyze titles map phases", () => {
    expect(deriveProjectAnalysisSnapshot(inputs({
      provider: { ...inputs().provider, active: false, opening: true },
    })).phase).toBe("scanning");

    expect(deriveProjectAnalysisSnapshot(inputs({
      progress: [{ token: "t1", title: "Importing Maven project", percentage: 40 }],
    })).phase).toBe("importing");

    expect(deriveProjectAnalysisSnapshot(inputs({
      progress: [{ token: "t2", title: "Analyzing sources", percentage: null }],
    })).phase).toBe("analyzing");
  });

  it("ready requires settled progress AND a successful semantic probe", () => {
    // No probe yet → readiness unproven.
    expect(deriveProjectAnalysisSnapshot(inputs()).phase).toBe("analyzing");

    // Probe succeeded → ready with complete module facts.
    const ready = deriveProjectAnalysisSnapshot(inputs({
      probe: {
        kind: "ok",
        reason: null,
        rootUri: "file:///repo/maven-single",
        entryCount: 7,
        entriesSha256: "cc".repeat(32),
        completedAt: 900,
      },
      modules: [{
        id: "/repo/maven-single",
        buildSystem: "maven",
        root: "/repo/maven-single",
        sourceRoots: [],
        testRoots: [],
        generatedRoots: [],
        excludedRoots: [],
        dependencyFingerprint: "dd".repeat(32),
      }],
    }));
    expect(ready.phase).toBe("ready");
    expect(ready.completeness).toBe("complete");
    expect(ready.completedAt).toBe(1_000);
  });

  it("lifecycle-only providers degrade to partial and never claim complete", () => {
    const degraded = deriveProjectAnalysisSnapshot(inputs({
      probe: {
        kind: "unavailable",
        reason: "command-not-registered:java.project.getClasspaths",
        rootUri: null,
        entryCount: null,
        entriesSha256: null,
        completedAt: 900,
      },
    }));
    expect(degraded.phase).toBe("degraded");
    expect(degraded.completeness).toBe("partial");
    expect(degraded.diagnostics[0]).toContain("command-not-registered");
  });

  it("a failed probe degrades with the reason recorded", () => {
    const failed = deriveProjectAnalysisSnapshot(inputs({
      probe: {
        kind: "failed",
        reason: "executeCommand timed out",
        rootUri: null,
        entryCount: null,
        entriesSha256: null,
        completedAt: 900,
      },
    }));
    expect(failed.phase).toBe("degraded");
    expect(failed.completeness).toBe("partial");
  });

  it("carries provider identity (id/version/pid) into the snapshot", () => {
    const snapshot = deriveProjectAnalysisSnapshot(inputs());
    expect(snapshot.provider).toEqual({ id: "jdtls", version: "1.61.0", processId: 4242 });
    expect(snapshot.schemaVersion).toBe(1);
  });
});

describe("computeProjectFingerprint", () => {
  const base = {
    roots: ["/repo/a"] as readonly string[],
    buildFiles: [{ path: "pom.xml", sha256: "aa".repeat(32) }],
    sdk: { homeHash: "bb".repeat(32), version: "21", languageLevel: "21" } as const,
    providerId: "jdtls",
    providerVersion: "1.61.0",
    classpathEntriesSha256: null,
    moduleFingerprints: [] as readonly string[],
  };

  it("is stable across equal inputs and order-insensitive over roots/files", () => {
    expect(computeProjectFingerprint(base)).toBe(computeProjectFingerprint({ ...base }));
    expect(computeProjectFingerprint({
      ...base,
      roots: ["/repo/b", "/repo/a"],
    })).toBe(computeProjectFingerprint({ ...base, roots: ["/repo/a", "/repo/b"] }));
  });

  it("moves on every identity dimension", () => {
    const original = computeProjectFingerprint(base);
    for (const mutated of [
      computeProjectFingerprint({ ...base, roots: ["/repo/other"] }),
      computeProjectFingerprint({ ...base, buildFiles: [{ path: "pom.xml", sha256: "ab".repeat(32) }] }),
      computeProjectFingerprint({ ...base, sdk: { homeHash: "bb".repeat(32), version: "17", languageLevel: "17" } }),
      computeProjectFingerprint({ ...base, providerVersion: "1.62.0" }),
      computeProjectFingerprint({ ...base, classpathEntriesSha256: "ee".repeat(32) }),
      computeProjectFingerprint({ ...base, moduleFingerprints: ["ff".repeat(32)] }),
    ]) {
      expect(mutated, "mutated dimension must change the fingerprint").not.toBe(original);
    }
  });
});

describe("modulesFromProviderModel §8.20.3", () => {
  const buildFiles = [{ path: "/repo/maven-single/pom.xml" }];

  it("binds the classpath fingerprint only to the matching project root", () => {
    const modules = modulesFromProviderModel({
      javaProjects: [
        { id: "/repo/maven-single", rootUri: "file:///repo/maven-single" },
        { id: "/repo/maven-other", rootUri: "file:///repo/maven-other" },
      ],
      classpathProbe: { kind: "ok", rootUri: "file:///repo/maven-single", entriesSha256: "cc".repeat(32) },
      buildFiles,
    });
    expect(modules).toHaveLength(2);
    expect(modules[0]!.dependencyFingerprint).toBe("cc".repeat(32));
    // The unprobed module stays fingerprint-less — never fabricated.
    expect(modules[1]!.dependencyFingerprint).toBe("");
  });

  it("classifies build systems from local descriptors and keeps roots honest", () => {
    const modules = modulesFromProviderModel({
      javaProjects: [
        { id: "/repo/maven-single", rootUri: "file:///repo/maven-single" },
        { id: "/repo/gradle-x", rootUri: "file:///repo/gradle-x" },
        { id: "/repo/bare", rootUri: "file:///repo/bare" },
      ],
      classpathProbe: null,
      buildFiles: [
        ...buildFiles,
        { path: "/repo/gradle-x/build.gradle.kts" },
      ],
    });
    expect(modules[0]!.buildSystem).toBe("maven");
    expect(modules[1]!.buildSystem).toBe("gradle");
    // No descriptor at this root → plain, never guessed.
    expect(modules[2]!.buildSystem).toBe("plain");
    // source/test/generated/excluded roots stay empty until a provider
    // channel supplies them — no local guessing.
    for (const module of modules) {
      expect(module.sourceRoots).toEqual([]);
      expect(module.testRoots).toEqual([]);
    }
  });
});

describe("projectSnapshotStaleFor", () => {
  const snapshot = deriveProjectAnalysisSnapshot(inputs({
    probe: {
      kind: "ok",
      reason: null,
      rootUri: "file:///repo/maven-single",
      entryCount: 7,
      entriesSha256: "cc".repeat(32),
      completedAt: 900,
    },
    modules: [{
      id: "/repo/maven-single",
      buildSystem: "maven",
      root: "/repo/maven-single",
      sourceRoots: [],
      testRoots: [],
      generatedRoots: [],
      excludedRoots: [],
      dependencyFingerprint: "dd".repeat(32),
    }],
  }));

  const candidate = {
    generation: snapshot.generation,
    roots: ["/repo/maven-single"] as readonly string[],
    buildFiles: [{ path: "pom.xml", sha256: "aa".repeat(32) }],
    sdk: { homeHash: "bb".repeat(32), version: "21.0.4", languageLevel: "21" } as const,
    providerVersion: "1.61.0",
    classpathEntriesSha256: "cc".repeat(32),
  };

  it("stays fresh while every identity dimension holds", () => {
    expect(projectSnapshotStaleFor(snapshot, candidate)).toBe(false);
  });

  it("goes stale on restart (generation bump) and any build/JDK/classpath move", () => {
    expect(projectSnapshotStaleFor(snapshot, { ...candidate, generation: candidate.generation + 1 })).toBe(true);
    expect(projectSnapshotStaleFor(snapshot, {
      ...candidate,
      buildFiles: [{ path: "pom.xml", sha256: "ab".repeat(32) }],
    })).toBe(true);
    expect(projectSnapshotStaleFor(snapshot, {
      ...candidate,
      sdk: { homeHash: "bb".repeat(32), version: "17", languageLevel: "17" },
    })).toBe(true);
    expect(projectSnapshotStaleFor(snapshot, {
      ...candidate,
      classpathEntriesSha256: "ee".repeat(32),
    })).toBe(true);
  });
});
