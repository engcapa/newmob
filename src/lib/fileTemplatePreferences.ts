import { useEffect, useState } from "react";
import {
  DEFAULT_JAVA_TEMPLATES,
  type JavaTemplateKind,
} from "../components/editor/workspace/fileTemplateModel";

/**
 * User preferences for Code Workspace IDEA-style File and Code Templates.
 * Persisted globally in localStorage under taomni.fileTemplatePreferences.v1.
 */

export interface FileTemplatePreferences {
  templates: Record<JavaTemplateKind, string>;
}

export const DEFAULT_FILE_TEMPLATE_PREFERENCES: FileTemplatePreferences = {
  templates: { ...DEFAULT_JAVA_TEMPLATES },
};

export const FILE_TEMPLATE_PREFERENCES_STORAGE_KEY = "taomni.fileTemplatePreferences.v1";
export const FILE_TEMPLATE_PREFERENCES_EVENT = "taomni:file-template-preferences-changed";

const TEMPLATE_KINDS: readonly JavaTemplateKind[] = [
  "class",
  "interface",
  "record",
  "enum",
  "annotation",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeFileTemplatePreferences(raw: unknown): FileTemplatePreferences {
  if (!isRecord(raw)) {
    return { ...DEFAULT_FILE_TEMPLATE_PREFERENCES };
  }

  const rawTemplates = isRecord(raw.templates) ? raw.templates : {};
  const templates: Record<JavaTemplateKind, string> = { ...DEFAULT_JAVA_TEMPLATES };

  for (const kind of TEMPLATE_KINDS) {
    const custom = rawTemplates[kind];
    if (typeof custom === "string" && custom.trim().length > 0 && custom.length <= 16384) {
      templates[kind] = custom;
    }
  }

  return { templates };
}

export function loadJavaTemplatePreferences(): FileTemplatePreferences {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...DEFAULT_FILE_TEMPLATE_PREFERENCES };
  }
  try {
    const raw = window.localStorage.getItem(FILE_TEMPLATE_PREFERENCES_STORAGE_KEY);
    return normalizeFileTemplatePreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_FILE_TEMPLATE_PREFERENCES };
  }
}

export function saveJavaTemplatePreferences(preferences: FileTemplatePreferences): void {
  const normalized = normalizeFileTemplatePreferences(preferences);
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(
        FILE_TEMPLATE_PREFERENCES_STORAGE_KEY,
        JSON.stringify(normalized),
      );
      window.dispatchEvent(
        new CustomEvent<FileTemplatePreferences>(FILE_TEMPLATE_PREFERENCES_EVENT, {
          detail: normalized,
        }),
      );
    } catch {
      // Storage quota or permission error: fail gracefully
    }
  }
}

export function resetJavaTemplatePreferences(): FileTemplatePreferences {
  const defaults: FileTemplatePreferences = {
    templates: { ...DEFAULT_JAVA_TEMPLATES },
  };
  saveJavaTemplatePreferences(defaults);
  return defaults;
}

export function subscribeFileTemplatePreferences(
  listener: (preferences: FileTemplatePreferences) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const handleCustomEvent = (event: Event) => {
    listener(
      normalizeFileTemplatePreferences(
        (event as CustomEvent<FileTemplatePreferences>).detail,
      ),
    );
  };

  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key === FILE_TEMPLATE_PREFERENCES_STORAGE_KEY) {
      listener(loadJavaTemplatePreferences());
    }
  };

  window.addEventListener(FILE_TEMPLATE_PREFERENCES_EVENT, handleCustomEvent);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    window.removeEventListener(FILE_TEMPLATE_PREFERENCES_EVENT, handleCustomEvent);
    window.removeEventListener("storage", handleStorageEvent);
  };
}

export function useFileTemplatePreferences(): FileTemplatePreferences {
  const [prefs, setPrefs] = useState<FileTemplatePreferences>(loadJavaTemplatePreferences);

  useEffect(() => {
    setPrefs(loadJavaTemplatePreferences());
    return subscribeFileTemplatePreferences(setPrefs);
  }, []);

  return prefs;
}
