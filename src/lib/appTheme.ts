import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type AppThemeMode = "light" | "dark" | "system";
export type ResolvedAppTheme = "light" | "dark";

const APP_THEME_STORAGE_KEY = "newmob.appTheme.v1";
const APP_THEME_MODES: AppThemeMode[] = ["light", "dark", "system"];
const listeners = new Set<() => void>();

let currentMode: AppThemeMode = loadInitialAppThemeMode();

export function getAppThemeMode(): AppThemeMode {
  return currentMode;
}

export function setAppThemeMode(mode: AppThemeMode): void {
  const nextMode = normalizeAppThemeMode(mode);
  if (nextMode === currentMode) return;

  currentMode = nextMode;
  saveAppThemeMode(nextMode);
  listeners.forEach((listener) => listener());
}

export function getSystemAppTheme(): ResolvedAppTheme {
  if (typeof window === "undefined") return "light";
  if (typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveAppThemeMode(mode: AppThemeMode): ResolvedAppTheme {
  return mode === "system" ? getSystemAppTheme() : mode;
}

export function appThemeModeLabel(mode: AppThemeMode): string {
  if (mode === "system") return "Follow system";
  return mode === "dark" ? "Dark" : "Light";
}

export function useAppTheme() {
  const mode = useSyncExternalStore(subscribeAppTheme, getAppThemeMode, getAppThemeMode);
  const [systemTheme, setSystemTheme] = useState<ResolvedAppTheme>(() => getSystemAppTheme());

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") return;

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(query.matches ? "dark" : "light");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const setMode = useCallback((nextMode: AppThemeMode) => {
    setAppThemeMode(nextMode);
  }, []);

  return {
    mode,
    resolvedTheme: mode === "system" ? systemTheme : mode,
    setMode,
  };
}

function subscribeAppTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== APP_THEME_STORAGE_KEY) return;
    const nextMode = normalizeAppThemeMode(
      event.newValue ?? (() => {
        try {
          return window.localStorage.getItem(APP_THEME_STORAGE_KEY);
        } catch {
          return null;
        }
      })(),
    );
    if (nextMode === currentMode) return;
    currentMode = nextMode;
    listeners.forEach((listener) => listener());
  });
}

function loadInitialAppThemeMode(): AppThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    return normalizeAppThemeMode(window.localStorage.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function saveAppThemeMode(mode: AppThemeMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, mode);
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

function normalizeAppThemeMode(value: unknown): AppThemeMode {
  return typeof value === "string" && APP_THEME_MODES.includes(value as AppThemeMode)
    ? value as AppThemeMode
    : "system";
}
