import { isCodeThemeId } from "../../../lib/codeThemes";
import { makeTerminalFontFamily } from "../../../lib/systemFonts";

export interface EditorAppearanceProfile {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  ligatures: boolean;
  colorSchemeId: string;
  highContrast: boolean;
  zoomScope: "active-editor" | "all-editors";
  /** §8.18.9.5 highlighting level: none < syntax < all-problems. */
  highlighting: "none" | "syntax" | "all-problems";
  softWrap: {
    patterns: string[];
    useOriginalIndent: boolean;
    additionalIndent: number;
    showMarkers: boolean;
  };
  virtualSpace: {
    afterLineEnd: boolean;
    atFileBottom: boolean;
  };
  breadcrumbs: {
    visible: boolean;
    placement: "top" | "bottom";
    languages: string[];
  };
  clipboard: {
    historyEnabled: boolean;
    historyMaxItems: number;
    historyMaxTotalBytes: number;
  };
}

export interface LegacyCodeViewProfileLike {
  fontFamily?: unknown;
  fontSize?: unknown;
  fontSizePx?: unknown;
  fontLigatures?: unknown;
  ligatures?: unknown;
  theme?: unknown;
  colorSchemeId?: unknown;
  softWrap?: unknown;
}

export interface EditorAppearanceProfileEnvelope {
  schema: typeof EDITOR_APPEARANCE_PROFILE_SCHEMA;
  version: typeof EDITOR_APPEARANCE_PROFILE_VERSION;
  profile: EditorAppearanceProfile;
}

export type EditorAppearanceProfileDiagnosticKind =
  | "missing"
  | "corrupt"
  | "storage-unavailable"
  | "migrated";

export interface EditorAppearanceProfileDiagnostic {
  kind: EditorAppearanceProfileDiagnosticKind;
  message: string;
}

export interface EditorAppearanceProfileReadResult {
  profile: EditorAppearanceProfile;
  source: "stored" | "default" | "migrated";
  diagnostic: EditorAppearanceProfileDiagnostic | null;
  diagnostics: EditorAppearanceProfileDiagnostic[];
}

export const EDITOR_APPEARANCE_PROFILE_SCHEMA = "taomni.codeWorkspace.editorAppearance" as const;
export const EDITOR_APPEARANCE_PROFILE_VERSION = 1 as const;
export const EDITOR_APPEARANCE_PROFILE_STORAGE_PREFIX =
  "taomni.codeWorkspace.editorAppearance.v1.";

const DEFAULT_FONT_FAMILY = makeTerminalFontFamily("JetBrains Mono");
const MAX_PATTERN_COUNT = 128;
const MAX_LANGUAGE_COUNT = 128;
const MAX_PATTERN_LENGTH = 256;
const MAX_LANGUAGE_LENGTH = 96;

export const DEFAULT_EDITOR_APPEARANCE_PROFILE: EditorAppearanceProfile = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSizePx: 13,
  lineHeight: 1.5,
  ligatures: true,
  colorSchemeId: "app",
  highContrast: false,
  zoomScope: "all-editors",
  highlighting: "all-problems",
  softWrap: {
    patterns: [],
    useOriginalIndent: true,
    additionalIndent: 0,
    showMarkers: false,
  },
  virtualSpace: {
    afterLineEnd: false,
    atFileBottom: false,
  },
  breadcrumbs: {
    visible: true,
    placement: "top",
    languages: ["*"],
  },
  clipboard: {
    historyEnabled: true,
    historyMaxItems: 30,
    historyMaxTotalBytes: 1024 * 1024,
  },
};

export function defaultEditorAppearanceProfile(): EditorAppearanceProfile {
  return cloneEditorAppearanceProfile(DEFAULT_EDITOR_APPEARANCE_PROFILE);
}

export function cloneEditorAppearanceProfile(
  profile: EditorAppearanceProfile,
): EditorAppearanceProfile {
  const normalized = normalizeEditorAppearanceProfile(profile);
  return {
    ...normalized,
    softWrap: {
      ...normalized.softWrap,
      patterns: [...normalized.softWrap.patterns],
    },
    virtualSpace: { ...normalized.virtualSpace },
    breadcrumbs: {
      ...normalized.breadcrumbs,
      languages: [...normalized.breadcrumbs.languages],
    },
    clipboard: { ...normalized.clipboard },
  };
}

export function sameEditorAppearanceProfile(
  left: EditorAppearanceProfile,
  right: EditorAppearanceProfile,
): boolean {
  const a = normalizeEditorAppearanceProfile(left);
  const b = normalizeEditorAppearanceProfile(right);
  return JSON.stringify(a) === JSON.stringify(b);
}

export function normalizeEditorAppearanceProfile(value: unknown): EditorAppearanceProfile {
  const source = isRecord(value) ? value : {};
  const softWrap = isRecord(source.softWrap) ? source.softWrap : {};
  const virtualSpace = isRecord(source.virtualSpace) ? source.virtualSpace : {};
  const breadcrumbs = isRecord(source.breadcrumbs) ? source.breadcrumbs : {};
  const clipboard = isRecord(source.clipboard) ? source.clipboard : {};

  return {
    fontFamily: readString(source.fontFamily, DEFAULT_FONT_FAMILY),
    fontSizePx: clampNumber(source.fontSizePx, 13, 8, 32, 2),
    lineHeight: clampNumber(source.lineHeight, 1.5, 1, 3, 2),
    ligatures: readBoolean(source.ligatures, true),
    colorSchemeId: readColorSchemeId(source.colorSchemeId),
    highContrast: readBoolean(source.highContrast, false),
    zoomScope: source.zoomScope === "active-editor" ? "active-editor" : "all-editors",
    highlighting: source.highlighting === "none" || source.highlighting === "syntax"
      ? source.highlighting
      : "all-problems",
    softWrap: {
      patterns: normalizeStringList(softWrap.patterns, [], MAX_PATTERN_COUNT, MAX_PATTERN_LENGTH),
      useOriginalIndent: readBoolean(softWrap.useOriginalIndent, true),
      additionalIndent: clampNumber(softWrap.additionalIndent, 0, 0, 16, 0),
      showMarkers: readBoolean(softWrap.showMarkers, false),
    },
    virtualSpace: {
      afterLineEnd: readBoolean(virtualSpace.afterLineEnd, false),
      atFileBottom: readBoolean(virtualSpace.atFileBottom, false),
    },
    breadcrumbs: {
      visible: readBoolean(breadcrumbs.visible, true),
      placement: breadcrumbs.placement === "bottom" ? "bottom" : "top",
      languages: normalizeLanguageList(breadcrumbs.languages),
    },
    clipboard: {
      historyEnabled: readBoolean(clipboard.historyEnabled, true),
      historyMaxItems: clampNumber(clipboard.historyMaxItems, 30, 1, 50, 0),
      historyMaxTotalBytes: clampNumber(
        clipboard.historyMaxTotalBytes,
        1024 * 1024,
        1024,
        16 * 1024 * 1024,
        0,
      ),
    },
  };
}

/**
 * Convert the old global code-view shape without importing that module. A
 * legacy `softWrap: true` means every path should retain wrapping enabled.
 */
export function migrateLegacyCodeViewProfile(
  legacy: LegacyCodeViewProfileLike | unknown,
): EditorAppearanceProfile {
  const source = isRecord(legacy) ? legacy : {};
  const legacySoftWrap = source.softWrap;
  const patterns = legacySoftWrap === true
    ? ["**"]
    : Array.isArray(legacySoftWrap)
      ? legacySoftWrap
      : [];

  return normalizeEditorAppearanceProfile({
    fontFamily: source.fontFamily,
    fontSizePx: source.fontSizePx ?? source.fontSize,
    ligatures: source.ligatures ?? source.fontLigatures,
    colorSchemeId: source.colorSchemeId ?? source.theme,
    softWrap: { patterns },
  });
}

export function editorAppearanceProfileStorageKey(workspaceInstanceId: string): string {
  return `${EDITOR_APPEARANCE_PROFILE_STORAGE_PREFIX}${workspaceInstanceId}`;
}

export function readEditorAppearanceProfile(
  workspaceInstanceId: string,
  legacyProfile?: LegacyCodeViewProfileLike | unknown,
): EditorAppearanceProfile {
  return readEditorAppearanceProfileWithDiagnostics(workspaceInstanceId, legacyProfile).profile;
}

export function readEditorAppearanceProfileWithDiagnostics(
  workspaceInstanceId: string,
  legacyProfile?: LegacyCodeViewProfileLike | unknown,
): EditorAppearanceProfileReadResult {
  const fallback = defaultEditorAppearanceProfile();
  if (!workspaceInstanceId) {
    return makeReadResult(fallback, "default", {
      kind: "missing",
      message: "No workspace instance id was provided.",
    });
  }
  if (typeof window === "undefined") {
    return makeReadResult(fallback, "default", {
      kind: "storage-unavailable",
      message: "Editor appearance storage is unavailable outside a window.",
    });
  }

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(editorAppearanceProfileStorageKey(workspaceInstanceId));
  } catch {
    return makeReadResult(fallback, "default", {
      kind: "storage-unavailable",
      message: "Editor appearance storage could not be read.",
    });
  }

  if (raw === null) {
    if (legacyProfile !== undefined) {
      return makeReadResult(migrateLegacyCodeViewProfile(legacyProfile), "migrated", {
        kind: "migrated",
        message: "Editor appearance was migrated from an explicitly supplied legacy profile.",
      });
    }
    return makeReadResult(fallback, "default", {
      kind: "missing",
      message: "No workspace editor appearance profile was stored.",
    });
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)
      || parsed.schema !== EDITOR_APPEARANCE_PROFILE_SCHEMA
      || parsed.version !== EDITOR_APPEARANCE_PROFILE_VERSION
      || !isRecord(parsed.profile)) {
      throw new Error("Unsupported editor appearance profile envelope.");
    }
    return makeReadResult(normalizeEditorAppearanceProfile(parsed.profile), "stored", null);
  } catch {
    return makeReadResult(fallback, "default", {
      kind: "corrupt",
      message: "The stored workspace editor appearance profile was invalid.",
    });
  }
}

export function writeEditorAppearanceProfile(
  workspaceInstanceId: string,
  profile: EditorAppearanceProfile,
): EditorAppearanceProfile {
  const normalized = normalizeEditorAppearanceProfile(profile);
  if (!workspaceInstanceId || typeof window === "undefined") return normalized;
  const envelope: EditorAppearanceProfileEnvelope = {
    schema: EDITOR_APPEARANCE_PROFILE_SCHEMA,
    version: EDITOR_APPEARANCE_PROFILE_VERSION,
    profile: normalized,
  };
  try {
    window.localStorage.setItem(
      editorAppearanceProfileStorageKey(workspaceInstanceId),
      JSON.stringify(envelope),
    );
  } catch {
    // Restricted webviews may reject localStorage writes.
  }
  return normalized;
}

export function resetEditorAppearanceProfile(workspaceInstanceId: string): EditorAppearanceProfile {
  if (workspaceInstanceId && typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(editorAppearanceProfileStorageKey(workspaceInstanceId));
    } catch {
      // Restricted webviews may reject localStorage writes.
    }
  }
  return defaultEditorAppearanceProfile();
}

export function migrateAndWriteEditorAppearanceProfile(
  workspaceInstanceId: string,
  legacyProfile: LegacyCodeViewProfileLike | unknown,
): EditorAppearanceProfile {
  return writeEditorAppearanceProfile(
    workspaceInstanceId,
    migrateLegacyCodeViewProfile(legacyProfile),
  );
}

/** Match one path against a soft-wrap glob. `*` and `?` do not cross `/`; `**` does. */
export function matchesEditorAppearancePath(path: string, pattern: string): boolean {
  if (typeof path !== "string" || typeof pattern !== "string") return false;
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedPattern = pattern.trim().replace(/\\/g, "/");
  if (!normalizedPattern) return false;
  return new RegExp(`^${globSource(normalizedPattern)}$`).test(normalizedPath);
}

export function matchesSoftWrapPattern(path: string, pattern: string): boolean {
  return matchesEditorAppearancePath(path, pattern);
}

export function matchesSoftWrapPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesEditorAppearancePath(path, pattern));
}

export function matchesPathGlob(pattern: string, path: string): boolean {
  return matchesEditorAppearancePath(path, pattern);
}

/** Match a language id against breadcrumb language globs, case-insensitively. */
export function matchesBreadcrumbLanguage(
  language: string,
  languages: readonly string[],
): boolean {
  if (typeof language !== "string") return false;
  const normalizedLanguage = language.trim().toLowerCase();
  if (!normalizedLanguage) return false;
  return languages.some((pattern) => {
    if (typeof pattern !== "string" || !pattern.trim()) return false;
    return matchesEditorAppearancePath(normalizedLanguage, pattern.toLowerCase());
  });
}

export function matchesBreadcrumbLanguageId(
  language: string,
  languages: readonly string[],
): boolean {
  return matchesBreadcrumbLanguage(language, languages);
}

function makeReadResult(
  profile: EditorAppearanceProfile,
  source: EditorAppearanceProfileReadResult["source"],
  diagnostic: EditorAppearanceProfileDiagnostic | null,
): EditorAppearanceProfileReadResult {
  return {
    profile: cloneEditorAppearanceProfile(profile),
    source,
    diagnostic,
    diagnostics: diagnostic ? [diagnostic] : [],
  };
}

function normalizeLanguageList(value: unknown): string[] {
  const normalized = normalizeStringList(
    value,
    ["*"],
    MAX_LANGUAGE_COUNT,
    MAX_LANGUAGE_LENGTH,
  );
  return normalized.length > 0 ? normalized : ["*"];
}

function normalizeStringList(
  value: unknown,
  fallback: readonly string[],
  maxCount: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().slice(0, maxLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxCount) break;
  }
  return result;
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        source += "(?:.*/)?";
        index += 1;
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
}

function readColorSchemeId(value: unknown): string {
  if (value === "app") return "app";
  return typeof value === "string" && isCodeThemeId(value) ? value : "app";
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  decimals: number,
): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.min(max, Math.max(min, numeric));
  const multiplier = 10 ** decimals;
  return Math.round(clamped * multiplier) / multiplier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const loadEditorAppearanceProfile = readEditorAppearanceProfile;
export const saveEditorAppearanceProfile = writeEditorAppearanceProfile;
