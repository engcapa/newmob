import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDITOR_APPEARANCE_PROFILE,
  EDITOR_APPEARANCE_PROFILE_SCHEMA,
  EDITOR_APPEARANCE_PROFILE_VERSION,
  cloneEditorAppearanceProfile,
  defaultEditorAppearanceProfile,
  editorAppearanceProfileStorageKey,
  matchesBreadcrumbLanguage,
  matchesEditorAppearancePath,
  matchesSoftWrapPath,
  migrateLegacyCodeViewProfile,
  normalizeEditorAppearanceProfile,
  readEditorAppearanceProfile,
  readEditorAppearanceProfileWithDiagnostics,
  resetEditorAppearanceProfile,
  sameEditorAppearanceProfile,
  writeEditorAppearanceProfile,
} from "./editorAppearanceProfile";

beforeEach(() => {
  window.localStorage.clear();
});

describe("editorAppearanceProfile", () => {
  it("provides defaults and clamps malformed values without widening lists", () => {
    const normalized = normalizeEditorAppearanceProfile({
      fontSizePx: 100,
      lineHeight: -1,
      ligatures: "yes",
      highContrast: true,
      zoomScope: "invalid",
      softWrap: {
        patterns: ["  **/*.md  ", "**/*.md", 3, ""],
        useOriginalIndent: false,
        additionalIndent: 99,
        showMarkers: true,
      },
      virtualSpace: { afterLineEnd: true, atFileBottom: "yes" },
      breadcrumbs: { visible: false, placement: "invalid", languages: [] },
      clipboard: { historyEnabled: "no", historyMaxItems: 1000, historyMaxTotalBytes: 50 },
    });

    expect(normalized).toMatchObject({
      fontFamily: DEFAULT_EDITOR_APPEARANCE_PROFILE.fontFamily,
      fontSizePx: 32,
      lineHeight: 1,
      ligatures: true,
      highContrast: true,
      zoomScope: "all-editors",
      softWrap: {
        patterns: ["**/*.md"],
        useOriginalIndent: false,
        additionalIndent: 16,
        showMarkers: true,
      },
      virtualSpace: { afterLineEnd: true, atFileBottom: false },
      breadcrumbs: { visible: false, placement: "top", languages: ["*"] },
      clipboard: { historyEnabled: true, historyMaxItems: 50, historyMaxTotalBytes: 1024 },
    });
    expect(defaultEditorAppearanceProfile()).toEqual(DEFAULT_EDITOR_APPEARANCE_PROFILE);
  });

  it("migrates an explicitly supplied legacy code-view object without importing global state", () => {
    const migrated = migrateLegacyCodeViewProfile({
      fontFamily: "Fira Code",
      fontSize: 19,
      fontLigatures: false,
      theme: "dark-plus",
      softWrap: true,
    });

    expect(migrated).toMatchObject({
      fontFamily: "Fira Code",
      fontSizePx: 19,
      ligatures: false,
      colorSchemeId: "app",
      softWrap: { patterns: ["**"] },
    });
    expect(migrated.breadcrumbs.languages).toEqual(["*"]);
  });

  it("reads, writes, resets, and isolates versioned workspace storage", () => {
    const profile = normalizeEditorAppearanceProfile({
      fontSizePx: 18,
      zoomScope: "active-editor",
      breadcrumbs: { languages: ["typescript"] },
    });
    writeEditorAppearanceProfile("workspace-a", profile);

    const stored = JSON.parse(
      window.localStorage.getItem(editorAppearanceProfileStorageKey("workspace-a")) ?? "null",
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      schema: EDITOR_APPEARANCE_PROFILE_SCHEMA,
      version: EDITOR_APPEARANCE_PROFILE_VERSION,
    });
    expect(readEditorAppearanceProfile("workspace-a")).toEqual(profile);
    expect(readEditorAppearanceProfile("workspace-b")).toEqual(DEFAULT_EDITOR_APPEARANCE_PROFILE);

    expect(resetEditorAppearanceProfile("workspace-a")).toEqual(DEFAULT_EDITOR_APPEARANCE_PROFILE);
    expect(readEditorAppearanceProfile("workspace-a")).toEqual(DEFAULT_EDITOR_APPEARANCE_PROFILE);
  });

  it("reports missing and corrupt storage and falls back safely", () => {
    const missing = readEditorAppearanceProfileWithDiagnostics("missing");
    expect(missing.profile).toEqual(DEFAULT_EDITOR_APPEARANCE_PROFILE);
    expect(missing.diagnostic?.kind).toBe("missing");

    window.localStorage.setItem(editorAppearanceProfileStorageKey("broken"), "{not-json");
    const corrupt = readEditorAppearanceProfileWithDiagnostics("broken");
    expect(corrupt.profile).toEqual(DEFAULT_EDITOR_APPEARANCE_PROFILE);
    expect(corrupt.diagnostic?.kind).toBe("corrupt");

    const migrated = readEditorAppearanceProfileWithDiagnostics("legacy", {
      fontSize: 21,
      theme: "app",
    });
    expect(migrated.source).toBe("migrated");
    expect(migrated.diagnostic?.kind).toBe("migrated");
    expect(migrated.profile.fontSizePx).toBe(21);
  });

  it("clones and compares nested profiles by value", () => {
    const clone = cloneEditorAppearanceProfile(DEFAULT_EDITOR_APPEARANCE_PROFILE);
    expect(clone).toEqual(DEFAULT_EDITOR_APPEARANCE_PROFILE);
    expect(clone).not.toBe(DEFAULT_EDITOR_APPEARANCE_PROFILE);
    expect(clone.softWrap).not.toBe(DEFAULT_EDITOR_APPEARANCE_PROFILE.softWrap);
    expect(clone.breadcrumbs.languages).not.toBe(DEFAULT_EDITOR_APPEARANCE_PROFILE.breadcrumbs.languages);
    expect(sameEditorAppearanceProfile(clone, DEFAULT_EDITOR_APPEARANCE_PROFILE)).toBe(true);

    clone.breadcrumbs.languages.push("typescript");
    expect(sameEditorAppearanceProfile(clone, DEFAULT_EDITOR_APPEARANCE_PROFILE)).toBe(false);
  });

  it("matches path globs with star, double-star, and question mark", () => {
    expect(matchesEditorAppearancePath("README.md", "*.md")).toBe(true);
    expect(matchesEditorAppearancePath("docs/README.md", "*.md")).toBe(false);
    expect(matchesEditorAppearancePath("docs/README.md", "**/*.md")).toBe(true);
    expect(matchesEditorAppearancePath("src/a/test.ts", "src/**/test.??")).toBe(true);
    expect(matchesSoftWrapPath("src/nested/README.md", ["*.ts", "**/*.md"])).toBe(true);
    expect(matchesEditorAppearancePath("src\\nested\\README.md", "**/*.md")).toBe(true);
  });

  it("matches breadcrumb language ids case-insensitively with globs", () => {
    expect(matchesBreadcrumbLanguage("TypeScript", ["typescript"])).toBe(true);
    expect(matchesBreadcrumbLanguage("javascriptreact", ["javascript*"])).toBe(true);
    expect(matchesBreadcrumbLanguage("rust", ["java", "python"])).toBe(false);
  });

  it("keeps storage writes best-effort when localStorage rejects writes", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeEditorAppearanceProfile("blocked", DEFAULT_EDITOR_APPEARANCE_PROFILE)).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    setItem.mockRestore();
  });
});
