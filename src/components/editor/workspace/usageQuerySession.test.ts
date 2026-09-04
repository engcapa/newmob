import { describe, expect, it } from "vitest";
import type { LspLocation } from "../../../lib/editor/lsp";
import {
  DEFAULT_SCOPE_SELECTION,
  getRoleFilterStatus,
  getUsagePreviewSnippet,
  groupUsages,
  hasProviderRoleInformation,
  scopeLocations,
  UsageQuerySession,
  usagesScopeOptions,
  type UsageEnvelopeLocation,
  type UsagesScopeSelection,
} from "./usageQuerySession";

const symbol = {
  uri: "file:///repo/src/main/A.java",
  range: { start: { line: 5, character: 10 }, end: { line: 5, character: 16 } },
  displayName: "doWork",
  providerSymbolId: null,
};

const location = (path: string, line = 1): LspLocation => ({
  uri: `file://${path}`,
  path,
  range: { start: { line, character: 2 }, end: { line, character: 8 } },
});

const evidenceInput = () => ({
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 3 },
  projectFingerprint: "d".repeat(64),
  uri: symbol.uri,
  revision: 7,
});

const isLibraryUri = (uri: string) => uri.includes("/library-jar/");

describe("scopeLocations §8.20.5 client-side scoping", () => {
  const locations = [
    { uri: symbol.uri, path: "/repo/src/main/A.java", range: symbol.range }, // declaration itself
    location("/repo/src/main/B.java"),
    location("/repo/src/test/ATest.java"),
    location("/library-jar/sources/X.java"),
  ];

  it("drops the declaration only when includeDeclaration is false", () => {
    const scoped = scopeLocations(locations, symbol, {
      ...DEFAULT_SCOPE_SELECTION,
      includeDeclaration: false,
    }, isLibraryUri);
    expect(scoped.some((entry) => entry.range.start.line === 5 && entry.path === "/repo/src/main/A.java")).toBe(false);
    // Defaults also drop libraries → declaration + jar removed, two remain.
    expect(scoped).toHaveLength(2);
  });

  it("libraries bucket classifies by URI owner outside workspace roots", () => {
    const withLibs = scopeLocations(locations, symbol, {
      ...DEFAULT_SCOPE_SELECTION,
      includeLibraries: true,
    }, isLibraryUri);
    expect(withLibs.some((entry) => entry.uri.includes("library-jar"))).toBe(true);
    const withoutLibs = scopeLocations(locations, symbol, DEFAULT_SCOPE_SELECTION, isLibraryUri);
    expect(withoutLibs.some((entry) => entry.uri.includes("library-jar"))).toBe(false);
  });

  it("tests bucket classifies by src/test-style paths", () => {
    const withoutTests = scopeLocations(locations, symbol, {
      ...DEFAULT_SCOPE_SELECTION,
      includeTests: false,
    }, isLibraryUri);
    expect(withoutTests.some((entry) => entry.path?.includes("/src/test/"))).toBe(false);
  });
});

describe("UsageQuerySession §8.20.5 shared immutable session", () => {
  const selection: UsagesScopeSelection = { ...DEFAULT_SCOPE_SELECTION };

  it("freezes one snapshot shared by popup and tool window; results immutable", () => {
    const session = new UsageQuerySession();
    const snapshot = session.start({
      symbol,
      selection,
      evidence: evidenceInput(),
      locations: [location("/repo/src/main/B.java")],
      isLibraryUri,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.envelope.results)).toBe(true);
    expect(session.getCurrent()).toBe(snapshot);
    // Both surfaces read the SAME envelope.
    expect(snapshot.envelope.queryId).toMatch(/^usages:usages\.find:3:\d+$/);
    session.dispose();
  });

  it("keeps a bounded recent stack and restores an earlier session view", () => {
    const session = new UsageQuerySession();
    for (let index = 0; index < 12; index += 1) {
      session.start({
        symbol: { ...symbol, displayName: `sym${index}` },
        selection,
        evidence: evidenceInput(),
        locations: [],
      });
    }
    expect(session.getRecent()).toHaveLength(10);
    const oldestVisible = session.getRecent()[9]!;
    expect(oldestVisible.symbol.displayName).toBe("sym2");

    const restored = session.restore(oldestVisible.id);
    expect(restored).toBe(oldestVisible);
    expect(session.getCurrent()).toBe(oldestVisible);
    session.dispose();
  });

  it("pinning persists across patch operations and staleness checks", () => {
    const session = new UsageQuerySession();
    session.start({ symbol, selection, evidence: evidenceInput(), locations: [] });
    expect(session.isPinned()).toBe(false);
    session.setPinned(true);
    expect(session.isPinned()).toBe(true);
    expect(session.requiresPinConfirm()).toBe(true);

    // Generation move (restart) → stale with reason.
    session.applyStaleness({ providerGeneration: 4, projectFingerprint: "d".repeat(64), documentRevision: 7 }, "d".repeat(64));
    expect(session.getCurrent()!.state).toBe("stale");
    expect(session.getCurrent()!.staleReason).toContain("provider restarted");

    // Fingerprint move (build file changed) → stale too.
    session.start({ symbol, selection, evidence: evidenceInput(), locations: [] });
    session.applyStaleness({ providerGeneration: 3, projectFingerprint: "9".repeat(64), documentRevision: 7 }, "9".repeat(64));
    expect(session.getCurrent()!.state).toBe("stale");
    expect(session.getCurrent()!.staleReason).toContain("project model changed");
    session.dispose();
  });

  it("loading placeholder and failure states never enter the recent stack as ready", () => {
    const session = new UsageQuerySession();
    session.startLoading(symbol, selection);
    expect(session.getCurrent()!.state).toBe("loading");
    session.markFailed("references timed out");
    expect(session.getCurrent()!.state).toBe("failed");
    expect(session.getRecent()).toHaveLength(0);
    session.dispose();
  });
});

describe("usagesScopeOptions §8.20.5 dialog model", () => {
  it("offers declaration/libraries/tests toggles with no fake provider scopes and accurate provenance", () => {
    const options = usagesScopeOptions(DEFAULT_SCOPE_SELECTION);
    expect(options.map((option) => option.id)).toEqual(["declaration", "libraries", "tests"]);
    for (const option of options) {
      expect(option.disabled).toBe(false);
      expect(option.reason).toBeNull();
      expect(option.provenance).toBeDefined();
    }
    const toggled = options[0]!.toggle(DEFAULT_SCOPE_SELECTION);
    expect(toggled.includeDeclaration).toBe(false);
  });
});

describe("ED-USAGE-001: usages grouping, role classification & preview snippet", () => {
  const envelopeLocations: UsageEnvelopeLocation[] = [
    {
      uri: "file:///repo/core/A.java",
      path: "/repo/core/A.java",
      range: { start: { line: 10, character: 4 }, end: { line: 10, character: 10 } },
      role: "read",
    },
    {
      uri: "file:///repo/core/A.java",
      path: "/repo/core/A.java",
      range: { start: { line: 20, character: 4 }, end: { line: 20, character: 10 } },
      role: "write",
    },
    {
      uri: "file:///repo/api/B.java",
      path: "/repo/api/B.java",
      range: { start: { line: 5, character: 8 }, end: { line: 5, character: 14 } },
      role: "read",
    },
  ];

  it("groups usages by file", () => {
    const groups = groupUsages(envelopeLocations, "file");
    expect(groups.length).toBe(2);
    expect(groups[0].label).toBe("A.java");
    expect(groups[0].count).toBe(2);
    expect(groups[1].label).toBe("B.java");
    expect(groups[1].count).toBe(1);
  });

  it("groups usages by module", () => {
    const groups = groupUsages(envelopeLocations, "module", (p) => (p?.includes("/core/") ? "core" : "api"));
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.label)).toEqual(["core", "api"]);
  });

  it("groups usages by usage type / role", () => {
    const groups = groupUsages(envelopeLocations, "usage-type");
    expect(groups.length).toBe(2);
    expect(groups.find((g) => g.key === "read")?.label).toBe("Read Access");
    expect(groups.find((g) => g.key === "write")?.label).toBe("Write Access");
  });

  it("determines provider role classification status truthfully", () => {
    expect(hasProviderRoleInformation(envelopeLocations)).toBe(true);
    expect(getRoleFilterStatus(envelopeLocations).enabled).toBe(true);

    const unknownLocations: UsageEnvelopeLocation[] = [
      {
        uri: "file:///repo/A.java",
        path: "/repo/A.java",
        range: { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } },
        role: "unknown",
      },
    ];
    expect(hasProviderRoleInformation(unknownLocations)).toBe(false);
    const status = getRoleFilterStatus(unknownLocations);
    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toContain("Provider does not classify read/write usage roles");
  });

  it("extracts usage preview snippet with highlight offsets", () => {
    const fileContent = `package com.foo;\n\npublic class A {\n    void execute() {\n        doWork();\n    }\n}`;
    const range = { start: { line: 4, character: 8 }, end: { line: 4, character: 14 } };
    const snippet = getUsagePreviewSnippet(fileContent, range);

    expect(snippet.lineIndex).toBe(4);
    expect(snippet.lineText).toBe("        doWork();");
    expect(snippet.highlightFrom).toBe(8);
    expect(snippet.highlightTo).toBe(14);
  });
});

describe("ED-USAGE-002: session records role/source/completeness evidence", () => {
  const selection: UsagesScopeSelection = { ...DEFAULT_SCOPE_SELECTION, includeLibraries: true };

  it("records declaration, workspace, and library rows with unknown roles (A1)", () => {
    const session = new UsageQuerySession();
    const snapshot = session.start({
      symbol,
      selection,
      evidence: evidenceInput(),
      locations: [
        { uri: symbol.uri, path: "/repo/src/main/A.java", range: symbol.range },
        location("/repo/src/main/B.java"),
        {
          uri: "jar:file:///root/.m2/lib.jar!/Lib.class",
          path: null,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
        },
      ],
      workspaceRoots: ["/repo"],
    });

    const report = snapshot.usageEvidence;
    expect(report).not.toBeNull();
    expect(report?.totalFound).toBe(3);
    expect(report?.roleCounts.declaration).toBe(1);
    expect(report?.roleCounts.unknown).toBe(2);
    expect(report?.ownershipCounts.workspace).toBe(2);
    expect(report?.ownershipCounts.library).toBe(1);
    expect(report?.completeness).toBe("complete");
    expect(report?.providerGeneration).toBe(3);
    session.dispose();
  });

  it("leaves loading snapshots without evidence (A1)", () => {
    const session = new UsageQuerySession();
    const loading = session.startLoading(symbol, selection);
    expect(loading.usageEvidence).toBeNull();
    session.dispose();
  });
});
