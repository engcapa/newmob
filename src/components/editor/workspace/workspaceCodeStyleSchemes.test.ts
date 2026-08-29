import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_SCHEME_ID,
  activeSchemeForLanguage,
  copyCodeStyleScheme,
  defaultCodeStyleSchemeStore,
  deleteCodeStyleScheme,
  normalizeCodeStyleSchemeStore,
  readCodeStyleSchemeStore,
  renameCodeStyleScheme,
  resetCodeStyleSchemeValues,
  schemeStyleFields,
  setActiveCodeStyleScheme,
  writeCodeStyleSchemeStore,
} from "./workspaceCodeStyleSchemes";
import {
  buildFormatPlan,
  containsDisabledFormatterMarker,
  filterFormattingRanges,
  isFormatScopeSupported,
  isPathExcluded,
  resolveEffectiveSavePolicy,
} from "./workspaceCodeStyleScheme";

afterEach(() => {
  window.localStorage.clear();
});

describe("§8.19.9 R8-D1 code style scheme store", () => {
  it("always materializes the built-in default, even for corrupt payloads", () => {
    for (const garbage of [null, "x", 42, { schemes: "nope" }, { schemes: [{ id: "default", name: "Fake" }] }]) {
      const store = normalizeCodeStyleSchemeStore(garbage);
      expect(store.schemes).toHaveLength(1);
      expect(store.schemes[0].id).toBe(BUILT_IN_SCHEME_ID);
      expect(store.schemes[0].name).toBe("Default");
    }
    // Corrupt entries are dropped; valid ones survive with typed values only.
    const store = normalizeCodeStyleSchemeStore({
      schemes: [
        { id: "s1", name: "Java", languageId: "java", values: { tabSize: { value: 6, source: "scheme" }, evilKey: { value: 1 } } },
        { name: "no-id" },
        { id: "s2", name: "" },
      ],
      activeByLanguage: { java: "s1", go: "ghost" },
    });
    expect(store.schemes.map((scheme) => scheme.id)).toEqual([BUILT_IN_SCHEME_ID, "s1"]);
    expect(store.schemes[1].values.evilKey).toBeUndefined();
    expect(store.activeByLanguage).toEqual({ java: "s1" });
  });

  it("round-trips through localStorage and drops the built-in from disk", () => {
    const base = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s1", name: "Mine" }],
      activeByLanguage: { shared: "s1" },
    });
    writeCodeStyleSchemeStore(base);
    const raw = JSON.parse(window.localStorage.getItem("taomni.codeWorkspace.codeStyle.schemes.v1")!);
    expect(raw.schemes.map((scheme: { id: string }) => scheme.id)).toEqual(["s1"]);
    expect(readCodeStyleSchemeStore()).toEqual(base);
  });

  it("copies with unique names, refuses duplicates, and records basedOn", () => {
    let store = defaultCodeStyleSchemeStore();
    const first = copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "My Style");
    if ("error" in first) throw new Error("first copy should succeed");
    store = first.state;
    expect(first.scheme.basedOn).toBe(BUILT_IN_SCHEME_ID);
    expect(store.schemes.some((scheme) => scheme.name === "My Style")).toBe(true);

    expect(copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "my style")).toEqual({ error: "duplicate-name" });
    expect(copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "   ")).toEqual({ error: "empty-name" });
    expect(copyCodeStyleScheme(store, "ghost", "X")).toEqual({ error: "unknown-scheme" });
  });

  it("renames customs only, deletes with active-reference cleanup, resets to empty delta", () => {
    const copied = copyCodeStyleScheme(defaultCodeStyleSchemeStore(), BUILT_IN_SCHEME_ID, "Temp");
    if ("error" in copied) throw new Error("seed copy should succeed");
    let store = copied.state;
    const id = copied.scheme.id;

    expect(renameCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "X")).toEqual({ error: "built-in-immutable" });
    const renamed = renameCodeStyleScheme(store, id, "Renamed");
    if ("error" in renamed) throw new Error("rename should succeed");
    store = renamed;
    expect(activeSchemeForLanguage(store, null).id).toBe(BUILT_IN_SCHEME_ID);

    // Activate per language, then verify delete clears dangling references.
    store = setActiveCodeStyleScheme(store, "java", id);
    store = setActiveCodeStyleScheme(store, "shared", BUILT_IN_SCHEME_ID);
    expect(store.activeByLanguage).toEqual({ java: id });
    const deleted = deleteCodeStyleScheme(store, id);
    if ("error" in deleted) throw new Error("delete should succeed");
    store = deleted;
    expect(store.activeByLanguage).toEqual({});
    expect(deleteCodeStyleScheme(store, BUILT_IN_SCHEME_ID)).toEqual({ error: "built-in-immutable" });

    // Reset strips every field back to an empty delta.
    const filled = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s9", name: "F", values: { tabSize: { value: 8 }, insertSpaces: { value: false } } }],
    });
    const reset = resetCodeStyleSchemeValues(filled, "s9");
    if ("error" in reset) throw new Error("reset should succeed");
    expect(reset.schemes[1]?.values).toEqual({});
  });

  it("resolves the active scheme exact → shared → default", () => {
    let store = defaultCodeStyleSchemeStore();
    const copied = copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "Java Scheme");
    if ("error" in copied) throw new Error("seed copy should succeed");
    store = copied.state;
    store = setActiveCodeStyleScheme(store, "java", copied.scheme.id);

    expect(activeSchemeForLanguage(store, "java").name).toBe("Java Scheme");
    expect(activeSchemeForLanguage(store, "py").name).toBe("Default");
    const withShared = setActiveCodeStyleScheme(store, "shared", copied.scheme.id);
    expect(activeSchemeForLanguage(withShared, "py").name).toBe("Java Scheme");
  });

  it("extracts typed scheme fields and ignores junk", () => {
    const store = normalizeCodeStyleSchemeStore({
      schemes: [{
        id: "s",
        name: "T",
        values: {
          tabSize: { value: 6 },
          indentSize: { value: 6 },
          insertSpaces: { value: false },
          endOfLine: { value: "crlf" },
          trimTrailingWhitespace: { value: true },
          continuationIndent: { value: -3 },
          insertFinalNewline: { value: "yes" },
        },
      }],
    });
    const fields = schemeStyleFields(store.schemes[1]);
    expect(fields).toEqual({
      tabSize: 6,
      indentSize: 6,
      insertSpaces: false,
      endOfLine: "crlf",
      trimTrailingWhitespace: true,
    });
  });

  it("resolves EffectiveSavePolicyV4 merging scheme, legacy preference, and exclusions", () => {
    // Scheme with saveActions
    const scheme = {
      schemaVersion: 3 as const,
      id: "custom",
      name: "Custom",
      languageId: "shared",
      basedOn: null,
      values: {},
      saveActions: { format: true, organizeImports: true, rearrange: false, cleanup: false },
      exclusions: { patterns: ["**/dist/**", "*.min.js"], formatterMarkers: true },
    };

    const policyFromScheme = resolveEffectiveSavePolicy(scheme, false);
    expect(policyFromScheme.format).toEqual({ enabled: true, source: "scheme" });
    expect(policyFromScheme.organizeImports).toEqual({ enabled: true, source: "scheme" });
    expect(policyFromScheme.exclusions.patterns).toEqual(["**/dist/**", "*.min.js"]);
    expect(policyFromScheme.unsupported).toEqual(["rearrange", "cleanup", "directory", "module"]);

    // Legacy migrated preference when scheme has undefined saveActions
    const policyFromLegacy = resolveEffectiveSavePolicy(null, true);
    expect(policyFromLegacy.format).toEqual({ enabled: true, source: "legacy-migrated" });
    expect(policyFromLegacy.organizeImports).toEqual({ enabled: false, source: "default" });

    // Exclusions and marker checks
    expect(isPathExcluded("src/dist/bundle.js", policyFromScheme.exclusions.patterns)).toBe(true);
    expect(isPathExcluded("src/main.ts", policyFromScheme.exclusions.patterns)).toBe(false);

    expect(containsDisabledFormatterMarker("hello\n// @formatter:off\nworld")).toBe(true);
    expect(containsDisabledFormatterMarker("hello\n// @formatter:off\n// @formatter:on\nworld")).toBe(false);
  });

  describe("ED-STYLE-001: reformat scopes, exclusions & formatter markers", () => {
    const fullCapabilities = {
      formatting: true,
      rangeFormatting: true,
      rearrangeSupported: true,
      cleanupSupported: true,
    };

    it("verifies format scope support including module facts dependency", () => {
      expect(isFormatScopeSupported("selection")).toBe(true);
      expect(isFormatScopeSupported("file")).toBe(true);
      expect(isFormatScopeSupported("directory")).toBe(true);
      expect(isFormatScopeSupported("module", false)).toBe(false);
      expect(isFormatScopeSupported("module", true)).toBe(true);
    });

    it("builds multi-file format plan with exclusions and read-only files", () => {
      const plan = buildFormatPlan({
        scope: "directory",
        targets: [
          "/repo/src/A.ts",
          "/repo/dist/bundle.js",
          "/repo/src/readonly.ts",
        ],
        excludedByPattern: ["**/dist/**"],
        readOnlyPaths: new Set(["/repo/src/readonly.ts"]),
        capabilities: fullCapabilities,
      });

      expect(plan.state).toBe("ready");
      expect(plan.stages.map((s) => s.kind)).toEqual(["format", "rearrange", "cleanup"]);
      expect(plan.excluded).toHaveLength(2);
      expect(plan.excluded[0]).toEqual({ uri: "/repo/dist/bundle.js", reason: "pattern" });
      expect(plan.excluded[1]).toEqual({ uri: "/repo/src/readonly.ts", reason: "read-only" });
    });

    it("filters formatting ranges honoring @formatter:off ... @formatter:on markers", () => {
      const text = [
        "line 0",
        "// @formatter:off",
        "line 2 unformatted",
        "line 3 unformatted",
        "// @formatter:on",
        "line 5 formatted",
        "/* @formatter:off */",
        "line 7 unformatted",
      ].join("\n");

      // Whole file with markers
      const ranges = filterFormattingRanges(text, null, true);
      expect(ranges).toEqual([
        { startLine: 0, endLine: 0 },
        { startLine: 5, endLine: 5 },
      ]);

      // Selection intersection with markers
      const selectionRanges = filterFormattingRanges(text, { startLine: 4, endLine: 7 }, true);
      expect(selectionRanges).toEqual([
        { startLine: 5, endLine: 5 },
      ]);

      // When honorMarkers is false, full range is returned
      const allRanges = filterFormattingRanges(text, { startLine: 0, endLine: 7 }, false);
      expect(allRanges).toEqual([{ startLine: 0, endLine: 7 }]);
    });
  });
});

