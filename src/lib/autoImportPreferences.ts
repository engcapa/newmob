import { useEffect, useState } from "react";
import {
  DEFAULT_AUTO_IMPORT_SETTINGS,
  type AutoImportSettings,
} from "../components/editor/workspace/autoImportModel";

export { DEFAULT_AUTO_IMPORT_SETTINGS, type AutoImportSettings };

export const AUTO_IMPORT_PREFERENCES_STORAGE_KEY = "taomni.autoImportPreferences.v1";
export const AUTO_IMPORT_PREFERENCES_EVENT = "taomni:auto-import-preferences-changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAutoImportPreferences(raw: unknown): AutoImportSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_AUTO_IMPORT_SETTINGS };
  }

  const addUnambiguousImportsOnTheFly =
    typeof raw.addUnambiguousImportsOnTheFly === "boolean"
      ? raw.addUnambiguousImportsOnTheFly
      : DEFAULT_AUTO_IMPORT_SETTINGS.addUnambiguousImportsOnTheFly;

  const optimizeImportsOnTheFly =
    typeof raw.optimizeImportsOnTheFly === "boolean"
      ? raw.optimizeImportsOnTheFly
      : DEFAULT_AUTO_IMPORT_SETTINGS.optimizeImportsOnTheFly;

  const pasteImportMode =
    raw.pasteImportMode === "all" || raw.pasteImportMode === "ask" || raw.pasteImportMode === "none"
      ? raw.pasteImportMode
      : DEFAULT_AUTO_IMPORT_SETTINGS.pasteImportMode;

  let excludedPackages = DEFAULT_AUTO_IMPORT_SETTINGS.excludedPackages;
  if (Array.isArray(raw.excludedPackages)) {
    excludedPackages = raw.excludedPackages
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }

  return {
    addUnambiguousImportsOnTheFly,
    optimizeImportsOnTheFly,
    pasteImportMode,
    excludedPackages,
  };
}

export function loadAutoImportPreferences(): AutoImportSettings {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...DEFAULT_AUTO_IMPORT_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(AUTO_IMPORT_PREFERENCES_STORAGE_KEY);
    return normalizeAutoImportPreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_AUTO_IMPORT_SETTINGS };
  }
}

export function saveAutoImportPreferences(preferences: Partial<AutoImportSettings>): AutoImportSettings {
  const current = loadAutoImportPreferences();
  const next: AutoImportSettings = {
    ...current,
    ...preferences,
  };
  const normalized = normalizeAutoImportPreferences(next);
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(
        AUTO_IMPORT_PREFERENCES_STORAGE_KEY,
        JSON.stringify(normalized),
      );
      window.dispatchEvent(
        new CustomEvent<AutoImportSettings>(AUTO_IMPORT_PREFERENCES_EVENT, {
          detail: normalized,
        }),
      );
    } catch {
      // ignore
    }
  }
  return normalized;
}

export function resetAutoImportPreferences(): AutoImportSettings {
  const defaults: AutoImportSettings = {
    ...DEFAULT_AUTO_IMPORT_SETTINGS,
  };
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(
        AUTO_IMPORT_PREFERENCES_STORAGE_KEY,
        JSON.stringify(defaults),
      );
      window.dispatchEvent(
        new CustomEvent<AutoImportSettings>(AUTO_IMPORT_PREFERENCES_EVENT, {
          detail: defaults,
        }),
      );
    } catch {
      // ignore
    }
  }
  return defaults;
}

export function subscribeAutoImportPreferences(
  listener: (preferences: AutoImportSettings) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const handleCustomEvent = (event: Event) => {
    listener(
      normalizeAutoImportPreferences(
        (event as CustomEvent<AutoImportSettings>).detail,
      ),
    );
  };

  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key === AUTO_IMPORT_PREFERENCES_STORAGE_KEY) {
      listener(loadAutoImportPreferences());
    }
  };

  window.addEventListener(AUTO_IMPORT_PREFERENCES_EVENT, handleCustomEvent);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    window.removeEventListener(AUTO_IMPORT_PREFERENCES_EVENT, handleCustomEvent);
    window.removeEventListener("storage", handleStorageEvent);
  };
}

export function useAutoImportPreferences(): AutoImportSettings {
  const [prefs, setPrefs] = useState<AutoImportSettings>(loadAutoImportPreferences);

  useEffect(() => {
    setPrefs(loadAutoImportPreferences());
    return subscribeAutoImportPreferences(setPrefs);
  }, []);

  return prefs;
}
