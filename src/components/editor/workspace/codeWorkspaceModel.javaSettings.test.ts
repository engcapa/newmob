import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LSP_JAVA_SETTINGS,
  LSP_JAVA_SETTINGS_KEY,
  normalizeLspJavaSettings,
  readLspJavaSettings,
  writeLspJavaSettings,
} from "./codeWorkspaceModel";

afterEach(() => {
  window.localStorage.clear();
});

describe("jdtls java settings persistence", () => {
  it("returns defaults when nothing is stored", () => {
    expect(readLspJavaSettings()).toEqual(DEFAULT_LSP_JAVA_SETTINGS);
    expect(DEFAULT_LSP_JAVA_SETTINGS.autobuildEnabled).toBe(true);
    expect(DEFAULT_LSP_JAVA_SETTINGS.lombokEnabled).toBe(false);
  });

  it("round-trips a full settings blob through localStorage", () => {
    const next = writeLspJavaSettings({
      ...DEFAULT_LSP_JAVA_SETTINGS,
      lombokEnabled: true,
      lombokJarPath: "/opt/lombok.jar",
      saveActionsOrganizeImports: true,
      completionImportOrder: ["java", "javax", "com"],
      organizeImportsStarThreshold: 5,
    });
    expect(next.lombokEnabled).toBe(true);
    expect(readLspJavaSettings()).toEqual(next);
    expect(window.localStorage.getItem(LSP_JAVA_SETTINGS_KEY)).toContain("lombokJarPath");
  });

  it("fills omitted fields from defaults and drops non-string import entries", () => {
    const normalized = normalizeLspJavaSettings({
      lombokEnabled: true,
      completionImportOrder: ["java", 42, "com", null],
    });
    expect(normalized.lombokEnabled).toBe(true);
    // Untouched fields keep their defaults.
    expect(normalized.autobuildEnabled).toBe(true);
    expect(normalized.guessMethodArguments).toBe(true);
    expect(normalized.completionImportOrder).toEqual(["java", "com"]);
  });

  it("clamps organize-imports thresholds into a sane range", () => {
    expect(normalizeLspJavaSettings({ organizeImportsStarThreshold: 0 }).organizeImportsStarThreshold).toBe(1);
    expect(
      normalizeLspJavaSettings({ organizeImportsStaticStarThreshold: 10_000 }).organizeImportsStaticStarThreshold,
    ).toBe(999);
    expect(
      normalizeLspJavaSettings({ organizeImportsStarThreshold: "not-a-number" }).organizeImportsStarThreshold,
    ).toBe(DEFAULT_LSP_JAVA_SETTINGS.organizeImportsStarThreshold);
  });

  it("recovers defaults from corrupt stored JSON", () => {
    window.localStorage.setItem(LSP_JAVA_SETTINGS_KEY, "{not valid json");
    expect(readLspJavaSettings()).toEqual(DEFAULT_LSP_JAVA_SETTINGS);
  });
});
