import { describe, expect, it } from "vitest";
import {
  buildFormatPlan,
  DEFAULT_CODE_STYLE_SCHEME,
  findFormatterMarkerRanges,
  pathExcludedByPattern,
  resolveStyleField,
} from "./workspaceCodeStyleScheme";
import {
  detectFullLineHardware,
  fullLineAvailability,
  repositoryUrlPolicy,
  structuralSearchAvailability,
  validateStructuralQuery,
} from "./companionCapabilities";

describe("§8.18.9.4 code style field precedence", () => {
  it("explicit override > editorconfig > scheme > sniffed > default", () => {
    const layers = {
      "explicit-override": 4 as number | undefined,
      editorconfig: 2 as number | undefined,
      scheme: 6 as number | undefined,
      sniffed: 8 as number | undefined,
    };
    expect(resolveStyleField(layers)).toEqual({ value: 4, source: "explicit-override" });
    expect(resolveStyleField({ ...layers, "explicit-override": undefined })).toEqual({ value: 2, source: "editorconfig" });
    expect(resolveStyleField({ ...layers, "explicit-override": undefined, editorconfig: undefined })).toEqual({ value: 6, source: "scheme" });
    expect(resolveStyleField({ ...layers, "explicit-override": undefined, editorconfig: undefined, scheme: undefined })).toEqual({ value: 8, source: "sniffed" });
    expect(resolveStyleField<number>({})).toEqual({ value: undefined, source: "language-default" });
  });

  it("defaults declare no fake provenance", () => {
    expect(DEFAULT_CODE_STYLE_SCHEME.values).toEqual({});
    expect(DEFAULT_CODE_STYLE_SCHEMA_VERSION()).toBe(2);
  });

  function DEFAULT_CODE_STYLE_SCHEMA_VERSION(): number {
    return DEFAULT_CODE_STYLE_SCHEME.schemaVersion;
  }
});

describe("§8.18.9.4 formatter exclusion + markers", () => {
  it("matches exclude globs within and across segments", () => {
    expect(pathExcludedByPattern("gen/Generated.java", ["gen/**"])).toBe(true);
    expect(pathExcludedByPattern("src/gen/File.java", ["**/gen/**"])).toBe(true);
    expect(pathExcludedByPattern("src/App.java", ["*.java"])).toBe(false);
    expect(pathExcludedByPattern("App.java", ["*.java"])).toBe(true);
    expect(pathExcludedByPattern("src/Main.ts", ["**/*.generated.*"])).toBe(false);
  });

  it("finds exact off/on marker regions only", () => {
    const ranges = findFormatterMarkerRanges([
      "// @formatter:off",
      "const ugly=1;;",
      "// @formatter:on",
      "const clean = 1;",
      "// prettier-ignore",
    ]);
    expect(ranges).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: null },
    ]);
  });

  it("builds plans that omit unsupported stages instead of faking them", () => {
    const plan = buildFormatPlan({
      scope: "directory",
      targets: ["src/a.java", "gen/b.java"],
      excludedByPattern: ["gen/**"],
      readOnlyPaths: new Set(),
      capabilities: { formatting: true, rangeFormatting: true, rearrangeSupported: false, cleanupSupported: false },
    });
    // Directory scope has no provider document-format stage; rearrange/cleanup
    // are absent because the provider does not support them.
    expect(plan.stages).toEqual([]);
    expect(plan.excluded).toEqual([{ uri: "gen/b.java", reason: "pattern" }]);

    const filePlan = buildFormatPlan({
      scope: "file",
      targets: ["src/a.java"],
      excludedByPattern: [],
      readOnlyPaths: new Set(["src/locked.java"]),
      capabilities: { formatting: true, rangeFormatting: true, rearrangeSupported: false, cleanupSupported: true },
    });
    expect(filePlan.stages.map((stage) => stage.kind)).toEqual(["format", "cleanup"]);
  });
});

describe("§8.18.9.1 structural search gate", () => {
  it("stays unavailable until a real parser backend exists", () => {
    expect(structuralSearchAvailability("java", false)).toEqual({ available: false, reason: "backend-missing" });
    expect(structuralSearchAvailability("kotlin", true)).toEqual({ available: false, reason: "unsupported-language" });
  });

  it("validates schema and variable bounds", () => {
    const base = {
      schemaVersion: 1 as const,
      languageId: "java",
      pattern: "$var$;",
      variables: {},
      scope: "file" as const,
    };
    expect(validateStructuralQuery(base)).toBeNull();
    expect(validateStructuralQuery({ ...base, variables: { x: { minCount: -1, maxCount: null } } })).toContain("minCount");
    expect(validateStructuralQuery({
      ...base,
      variables: { x: { minCount: 3, maxCount: 1 } },
    })).toContain("maxCount");
  });
});

describe("§8.18.9.2 dependency repository policy", () => {
  it("trusts https, downgrades http to untrusted read, rejects credentials", () => {
    expect(repositoryUrlPolicy("https://repo.maven.apache.org/maven2")).toEqual({ usable: true, trustedRead: true });
    expect(repositoryUrlPolicy("http://intranet/repo")).toEqual({ usable: true, trustedRead: false });
    expect(repositoryUrlPolicy("https://user:pw@repo/maven2").usable).toBe(false);
    expect(repositoryUrlPolicy("ftp://repo/maven2").usable).toBe(false);
    expect(repositoryUrlPolicy("not a url").usable).toBe(false);
  });
});

describe("§8.18.9.3 full line availability", () => {
  const ready = {
    editionEnabled: true,
    hardware: "supported" as const,
    model: { languageId: "java", version: "1.0", state: "ready" as const },
    privacy: { localOnly: true, telemetryContentFree: true } as const,
  };

  it("requires every gate before ghost text may appear", () => {
    expect(fullLineAvailability(ready).available).toBe(true);
    expect(fullLineAvailability({ ...ready, editionEnabled: false }).reason).toBe("edition-disabled");
    expect(fullLineAvailability({ ...ready, hardware: "unknown" }).reason).toBe("hardware-undetected");
    expect(fullLineAvailability({
      ...ready,
      model: { languageId: "java", version: "1.0", state: "downloading" },
    }).reason).toBe("model-not-ready");
  });

  it("treats undetectable hardware as unknown, never optimistically supported", () => {
    expect(detectFullLineHardware(null)).toBe("unknown");
    expect(detectFullLineHardware({ architecture: "arm64" })).toBe("supported");
  });
});
