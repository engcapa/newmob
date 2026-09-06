import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FILE_TEMPLATE_PREFERENCES,
  FILE_TEMPLATE_PREFERENCES_STORAGE_KEY,
  loadJavaTemplatePreferences,
  normalizeFileTemplatePreferences,
  resetJavaTemplatePreferences,
  saveJavaTemplatePreferences,
  subscribeFileTemplatePreferences,
} from "./fileTemplatePreferences";

describe("ED-TEMPLATE-001: fileTemplatePreferences persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("normalizeFileTemplatePreferences", () => {
    it("returns defaults for undefined or null inputs", () => {
      expect(normalizeFileTemplatePreferences(undefined)).toEqual(
        DEFAULT_FILE_TEMPLATE_PREFERENCES,
      );
      expect(normalizeFileTemplatePreferences(null)).toEqual(
        DEFAULT_FILE_TEMPLATE_PREFERENCES,
      );
      expect(normalizeFileTemplatePreferences("invalid")).toEqual(
        DEFAULT_FILE_TEMPLATE_PREFERENCES,
      );
    });

    it("accepts custom templates and falls back to defaults for missing kinds", () => {
      const customClass = "package ${PACKAGE_NAME};\n\n// Custom\npublic class ${NAME} {\n}\n";
      const normalized = normalizeFileTemplatePreferences({
        templates: {
          class: customClass,
        },
      });

      expect(normalized.templates.class).toBe(customClass);
      expect(normalized.templates.interface).toBe(
        DEFAULT_FILE_TEMPLATE_PREFERENCES.templates.interface,
      );
    });

    it("rejects empty or excessively long templates", () => {
      const normalized = normalizeFileTemplatePreferences({
        templates: {
          class: "   ",
          record: "a".repeat(20000),
        },
      });

      expect(normalized.templates.class).toBe(
        DEFAULT_FILE_TEMPLATE_PREFERENCES.templates.class,
      );
      expect(normalized.templates.record).toBe(
        DEFAULT_FILE_TEMPLATE_PREFERENCES.templates.record,
      );
    });
  });

  describe("Storage and events", () => {
    it("loads defaults when localStorage is empty", () => {
      const prefs = loadJavaTemplatePreferences();
      expect(prefs).toEqual(DEFAULT_FILE_TEMPLATE_PREFERENCES);
    });

    it("persists edited templates to localStorage and emits change event", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeFileTemplatePreferences(listener);

      const next = {
        templates: {
          ...DEFAULT_FILE_TEMPLATE_PREFERENCES.templates,
          class: "// Custom Class\npublic class ${NAME} {}",
        },
      };

      saveJavaTemplatePreferences(next);

      const raw = localStorage.getItem(FILE_TEMPLATE_PREFERENCES_STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!).templates.class).toContain("// Custom Class");

      expect(loadJavaTemplatePreferences().templates.class).toContain("// Custom Class");
      expect(listener).toHaveBeenCalledWith(next);

      unsubscribe();
    });

    it("resets preferences to default", () => {
      saveJavaTemplatePreferences({
        templates: {
          ...DEFAULT_FILE_TEMPLATE_PREFERENCES.templates,
          class: "// Modified",
        },
      });
      expect(loadJavaTemplatePreferences().templates.class).toBe("// Modified");

      const reset = resetJavaTemplatePreferences();
      expect(reset).toEqual(DEFAULT_FILE_TEMPLATE_PREFERENCES);
      expect(loadJavaTemplatePreferences()).toEqual(DEFAULT_FILE_TEMPLATE_PREFERENCES);
    });
  });
});
