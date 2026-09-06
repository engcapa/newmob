import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_IMPORT_PREFERENCES_STORAGE_KEY,
  DEFAULT_AUTO_IMPORT_SETTINGS,
  loadAutoImportPreferences,
  normalizeAutoImportPreferences,
  resetAutoImportPreferences,
  saveAutoImportPreferences,
  subscribeAutoImportPreferences,
} from "./autoImportPreferences";

describe("ED-IMPORT-001: autoImportPreferences persistence and independence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("normalizeAutoImportPreferences", () => {
    it("returns defaults for undefined or null inputs", () => {
      expect(normalizeAutoImportPreferences(undefined)).toEqual(
        DEFAULT_AUTO_IMPORT_SETTINGS,
      );
      expect(normalizeAutoImportPreferences(null)).toEqual(
        DEFAULT_AUTO_IMPORT_SETTINGS,
      );
      expect(normalizeAutoImportPreferences("invalid")).toEqual(
        DEFAULT_AUTO_IMPORT_SETTINGS,
      );
    });

    it("accepts independent paste and on-the-fly settings (ED-IMPORT-001-A2)", () => {
      const custom = normalizeAutoImportPreferences({
        addUnambiguousImportsOnTheFly: false,
        optimizeImportsOnTheFly: true,
        pasteImportMode: "all",
        excludedPackages: ["org.dummy.*"],
      });

      expect(custom.addUnambiguousImportsOnTheFly).toBe(false);
      expect(custom.optimizeImportsOnTheFly).toBe(true);
      expect(custom.pasteImportMode).toBe("all");
      expect(custom.excludedPackages).toEqual(["org.dummy.*"]);
    });

    it("falls back to defaults for invalid pasteImportMode", () => {
      const normalized = normalizeAutoImportPreferences({
        pasteImportMode: "invalid-mode",
      });
      expect(normalized.pasteImportMode).toBe(DEFAULT_AUTO_IMPORT_SETTINGS.pasteImportMode);
    });
  });

  describe("Storage and reactivity", () => {
    it("loads defaults when localStorage is empty", () => {
      const prefs = loadAutoImportPreferences();
      expect(prefs).toEqual(DEFAULT_AUTO_IMPORT_SETTINGS);
    });

    it("persists saved preferences to localStorage", () => {
      saveAutoImportPreferences({
        addUnambiguousImportsOnTheFly: false,
        pasteImportMode: "none",
      });

      const loaded = loadAutoImportPreferences();
      expect(loaded.addUnambiguousImportsOnTheFly).toBe(false);
      expect(loaded.pasteImportMode).toBe("none");
      expect(loaded.excludedPackages).toEqual(DEFAULT_AUTO_IMPORT_SETTINGS.excludedPackages);

      const raw = localStorage.getItem(AUTO_IMPORT_PREFERENCES_STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual(loaded);
    });

    it("notifies subscribers when preferences change", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeAutoImportPreferences(listener);

      saveAutoImportPreferences({
        pasteImportMode: "all",
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          pasteImportMode: "all",
        }),
      );

      unsubscribe();
      listener.mockClear();

      saveAutoImportPreferences({
        pasteImportMode: "ask",
      });
      expect(listener).not.toHaveBeenCalled();
    });

    it("resets preferences to default", () => {
      saveAutoImportPreferences({
        pasteImportMode: "none",
        addUnambiguousImportsOnTheFly: false,
      });

      const reset = resetAutoImportPreferences();
      expect(reset).toEqual(DEFAULT_AUTO_IMPORT_SETTINGS);
      expect(loadAutoImportPreferences()).toEqual(DEFAULT_AUTO_IMPORT_SETTINGS);
    });
  });
});
