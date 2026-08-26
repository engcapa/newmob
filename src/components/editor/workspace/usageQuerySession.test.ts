import { describe, expect, it } from "vitest";
import type { LspLocation } from "../../../lib/editor/lsp";
import {
  DEFAULT_SCOPE_SELECTION,
  scopeLocations,
  UsageQuerySession,
  usagesScopeOptions,
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
    expect(session.getRecent().length).toBeLessThanOrEqual(10);
    const first = session.getRecent().at(-1)!;
    const restored = session.restore(first.id);
    expect(restored?.symbol.displayName).toBe("sym2");
    session.dispose();
  });

  it("pin replace guard + staleness on generation and fingerprint change", () => {
    const session = new UsageQuerySession();
    session.start({ symbol, selection, evidence: evidenceInput(), locations: [location("/repo/src/main/B.java")] });
    expect(session.requiresPinConfirm()).toBe(false);
    session.setPinned(true);
    expect(session.requiresPinConfirm()).toBe(true);

    // Same generation + fingerprint → fresh.
    session.applyStaleness({ providerGeneration: 3, projectFingerprint: "d".repeat(64), documentRevision: 7 }, "d".repeat(64));
    expect(session.getCurrent()!.state).toBe("ready");

    // Provider restart → stale with reason.
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
  it("offers declaration/libraries/tests toggles with no fake provider scopes", () => {
    const options = usagesScopeOptions(DEFAULT_SCOPE_SELECTION);
    expect(options.map((option) => option.id)).toEqual(["declaration", "libraries", "tests"]);
    for (const option of options) {
      expect(option.disabled).toBe(false);
      expect(option.reason).toBeNull();
    }
    const toggled = options[0]!.toggle(DEFAULT_SCOPE_SELECTION);
    expect(toggled.includeDeclaration).toBe(false);
  });
});
