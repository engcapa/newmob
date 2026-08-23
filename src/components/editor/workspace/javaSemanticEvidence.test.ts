import { describe, expect, it } from "vitest";
import {
  applyUsageFilters,
  buildUsageSession,
  projectFingerprint,
  refactorApplyGate,
  safeDeleteBlocked,
  USAGE_BATCH_SIZE,
  usageBatch,
  type RefactorEvidence,
} from "./javaSemanticEvidence";

function identity(overrides: Partial<Parameters<typeof buildUsageSession>[0]["identity"]> = {}) {
  return {
    workspaceId: "ws",
    fileKey: "k",
    uri: "file:///p/A.java",
    position: { line: 0, character: 6 },
    documentRevision: 3,
    providerGeneration: 2,
    projectFingerprint: "pf-x",
    requestId: "r1",
    ...overrides,
  };
}

function loc(uri: string, line: number) {
  return { uri, path: uri.replace("file://", ""), range: { start: { line, character: 0 }, end: { line, character: 4 } } };
}

describe("§8.18.7 project fingerprint", () => {
  const base = {
    workspaceRoots: ["/repo/app"],
    buildFileStates: [{ path: "pom.xml", hash: "aaa" }],
    languageLevel: "17",
    jdkVersion: "21",
    classpathGeneration: "cp1",
    providerGeneration: 5,
  };

  it("is stable for identical inputs and changes for any build/classpath/provider change", () => {
    expect(projectFingerprint(base)).toBe(projectFingerprint({ ...base }));
    expect(projectFingerprint(base)).not.toBe(projectFingerprint({ ...base, buildFileStates: [{ path: "pom.xml", hash: "bbb" }] }));
    expect(projectFingerprint(base)).not.toBe(projectFingerprint({ ...base, classpathGeneration: "cp2" }));
    expect(projectFingerprint(base)).not.toBe(projectFingerprint({ ...base, providerGeneration: 6 }));
    expect(projectFingerprint(base)).not.toBe(projectFingerprint({ ...base, jdkVersion: "17" }));
  });
});

describe("§8.18.7 usage session", () => {
  it("keeps roles unknown and marks role classification unavailable (honest filters)", () => {
    const session = buildUsageSession({
      identity: identity(),
      symbolName: "Foo",
      locations: [loc("file:///p/A.java", 0), loc("file:///p/B.java", 9)],
    });
    expect(session.items.every((item) => item.role === "unknown")).toBe(true);
    expect(session.roleClassificationAvailable).toBe(false);
  });

  it("groups by file and windows results into explicit batches with continuation", () => {
    const locations = Array.from({ length: USAGE_BATCH_SIZE + 10 }, (_, index) =>
      loc(index % 2 === 0 ? "file:///p/A.java" : "file:///p/B.java", index));
    const session = buildUsageSession({ identity: identity(), symbolName: "Foo", locations });
    const { visibleIds } = applyUsageFilters(session);
    const first = usageBatch(session, visibleIds, 0);
    expect(first.items).toHaveLength(USAGE_BATCH_SIZE);
    expect(first.nextCursor).toBe(USAGE_BATCH_SIZE);
    expect(first.totalVisible).toBe(USAGE_BATCH_SIZE + 10);
    const second = usageBatch(session, visibleIds, first.nextCursor!);
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
  });

  it("library filter removes non-workspace owners only when owners are classified", () => {
    const session = buildUsageSession({
      identity: identity(),
      symbolName: "Foo",
      locations: [loc("file:///p/A.java", 0), loc("jar:file:///lib/x.jar!/C.class", 3)],
      isLibraryUri: (uri) => uri.startsWith("jar:"),
    });
    const filtered = applyUsageFilters(session, { libraries: false });
    // Roles are unclassified but owner classification still works.
    expect(filtered.visibleIds.has(session.items[0].id)).toBe(true);
    expect(filtered.visibleIds.has(session.items[1].id)).toBe(false);
  });
});

describe("§8.18.7 refactor gates", () => {
  function evidence(overrides: Partial<RefactorEvidence> = {}): RefactorEvidence {
    return {
      actionId: "rename",
      kind: "rename",
      identity: identity(),
      scope: "workspace",
      completeness: "available-complete",
      conflicts: [],
      editRevisionCoverage: [{ uri: "file:///p/A.java", version: 3 }],
      ...overrides,
    };
  }

  it("hard-blocks Safe Delete without complete knowledge or with error conflicts", () => {
    expect(safeDeleteBlocked(evidence())).toBeNull();
    expect(safeDeleteBlocked(evidence({ completeness: "available-partial" }))).toContain("completeness");
    const blocked = safeDeleteBlocked(evidence({
      conflicts: [{ severity: "error", message: "Symbol is used in library source" }],
    }));
    expect(blocked).toContain("library");
  });

  it("warnings require confirm; errors forbid apply", () => {
    const warn = refactorApplyGate(evidence({
      conflicts: [{ severity: "warning", message: "Overloads share the name" }],
    }));
    expect(warn.allowed).toBe(true);
    expect(warn.requiresConfirm).toBe(true);

    const error = refactorApplyGate(evidence({
      conflicts: [{ severity: "error", message: "Cannot refactor element" }],
    }));
    expect(error.allowed).toBe(false);
  });

  it("records per-uri revision coverage captured before apply", () => {
    const ev = evidence();
    expect(ev.editRevisionCoverage).toEqual([{ uri: "file:///p/A.java", version: 3 }]);
  });
});
