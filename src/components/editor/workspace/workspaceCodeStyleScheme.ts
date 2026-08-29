/**
 * C8-D Code Style scheme / format plan models (§8.18.9.4).
 *
 * Schemes are named, copyable deltas over defaults with per-field provenance;
 * the effective priority is fixed: explicit file override > EditorConfig >
 * selected language/workspace scheme > sniffed fallback. Format plans record
 * stages and exclusions so partial provider capability is visible instead of
 * silently pretending directory-wide reformat support.
 */

export interface CodeStyleSaveActionsV3 {
  format: boolean;
  organizeImports: boolean;
  rearrange: boolean;
  cleanup: boolean;
}

export interface CodeStyleExclusionsV3 {
  patterns: string[];
  formatterMarkers: boolean;
}

export interface CodeStyleSchemeV3 {
  schemaVersion: 3;
  id: string;
  name: string;
  languageId: string | "shared";
  basedOn: string | null;
  values: Record<string, { value: unknown; source: "scheme" | "default" }>;
  saveActions: CodeStyleSaveActionsV3;
  exclusions: CodeStyleExclusionsV3;
}

export type CodeStyleSchemeV2 = CodeStyleSchemeV3;
export type CodeStyleScheme = CodeStyleSchemeV3;

export const DEFAULT_CODE_STYLE_SCHEME: CodeStyleSchemeV3 = Object.freeze({
  schemaVersion: 3,
  id: "default",
  name: "Default",
  languageId: "shared",
  basedOn: null,
  values: {},
  saveActions: { format: false, organizeImports: false, rearrange: false, cleanup: false },
  exclusions: { patterns: [], formatterMarkers: true },
});

export function migrateSchemeToV3(
  raw: any,
  legacyFormatOnSave?: boolean,
): CodeStyleSchemeV3 {
  if (!raw) return { ...DEFAULT_CODE_STYLE_SCHEME };
  const rawSaveActions = raw.saveActions ?? {};
  const format = rawSaveActions.format === true
    || rawSaveActions.reformat === true
    || legacyFormatOnSave === true;
  const organizeImports = rawSaveActions.organizeImports === true;
  const rearrange = false;
  const cleanup = false;

  const rawExclusions = raw.exclusions ?? {};
  const patterns = Array.isArray(rawExclusions.patterns)
    ? rawExclusions.patterns.filter((p: unknown) => typeof p === "string" && (p as string).trim())
    : [];
  const formatterMarkers = rawExclusions.formatterMarkers !== false;

  return {
    schemaVersion: 3,
    id: raw.id ?? "default",
    name: raw.name ?? "Default",
    languageId: raw.languageId ?? "shared",
    basedOn: raw.basedOn ?? null,
    values: raw.values ?? {},
    saveActions: { format, organizeImports, rearrange, cleanup },
    exclusions: { patterns, formatterMarkers },
  };
}

export function resolveEffectiveSaveActions(
  scheme: CodeStyleSchemeV3 | null | undefined,
  preferenceFormatOnSave?: boolean,
): CodeStyleSaveActionsV3 {
  return {
    format: scheme?.saveActions?.format === true || preferenceFormatOnSave === true,
    organizeImports: scheme?.saveActions?.organizeImports === true,
    rearrange: false,
    cleanup: false,
  };
}

/**
 * §8.21.3 V2-D: Unified EffectiveSavePolicyV4 merging scheme, legacy preference, and exclusions.
 */
export interface EffectiveSavePolicyV4 {
  format: { enabled: boolean; source: "scheme" | "legacy-migrated" | "default" };
  organizeImports: { enabled: boolean; source: "scheme" | "default" };
  exclusions: { patterns: readonly string[]; formatterMarkers: boolean; source: string };
  unsupported: readonly ("rearrange" | "cleanup" | "directory" | "module")[];
}

export function resolveEffectiveSavePolicy(
  scheme: CodeStyleSchemeV3 | null | undefined,
  legacyPreferenceFormatOnSave?: boolean,
  _filePath?: string,
): EffectiveSavePolicyV4 {
  let formatEnabled = false;
  let formatSource: "scheme" | "legacy-migrated" | "default" = "default";

  if (scheme && scheme.id !== "default" && scheme.saveActions?.format !== undefined) {
    formatEnabled = scheme.saveActions.format;
    formatSource = "scheme";
  } else if (scheme?.saveActions?.format === true) {
    formatEnabled = true;
    formatSource = "scheme";
  } else if (legacyPreferenceFormatOnSave !== undefined) {
    formatEnabled = legacyPreferenceFormatOnSave;
    formatSource = "legacy-migrated";
  } else if (scheme?.saveActions?.format !== undefined) {
    formatEnabled = scheme.saveActions.format;
    formatSource = "scheme";
  } else {
    formatEnabled = false;
    formatSource = "default";
  }

  const organizeImportsEnabled = scheme?.saveActions?.organizeImports ?? false;
  const organizeImportsSource: "scheme" | "default" = scheme ? "scheme" : "default";

  const exclusions = {
    patterns: scheme?.exclusions?.patterns ?? [],
    formatterMarkers: scheme?.exclusions?.formatterMarkers ?? true,
    source: scheme ? "scheme" : "default",
  };

  const unsupported: readonly ("rearrange" | "cleanup" | "directory" | "module")[] = Object.freeze([
    "rearrange",
    "cleanup",
    "directory",
    "module",
  ]);

  return {
    format: { enabled: formatEnabled, source: formatSource },
    organizeImports: { enabled: organizeImportsEnabled, source: organizeImportsSource },
    exclusions,
    unsupported,
  };
}

export function isPathExcluded(filePath?: string | null, patterns?: readonly string[]): boolean {
  if (!filePath || !patterns || patterns.length === 0) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const p = pattern.trim().replace(/\\/g, "/");
    if (!p) return false;
    if (normalized.endsWith(p) || normalized.includes(p)) return true;
    const regexPattern = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    try {
      return new RegExp(`(^|/)${regexPattern}($|/)`).test(normalized);
    } catch {
      return false;
    }
  });
}

export function containsDisabledFormatterMarker(text?: string | null): boolean {
  if (!text) return false;
  const offIndex = text.lastIndexOf("@formatter:off");
  if (offIndex === -1) return false;
  const onIndex = text.lastIndexOf("@formatter:on");
  return onIndex < offIndex;
}

export type CodeStyleFieldProvenanceSource =
  | "explicit"
  | "EditorConfig"
  | "scheme"
  | "language"
  | "sniffed"
  | "fallback";

export function normalizeProvenanceLabel(source: string | undefined): CodeStyleFieldProvenanceSource {
  if (!source) return "fallback";
  const lower = source.toLowerCase();
  if (lower.includes("explicit")) return "explicit";
  if (lower.includes("editorconfig")) return "EditorConfig";
  if (lower.includes("scheme")) return "scheme";
  if (lower.includes("sniffed") || lower.includes("detected")) return "sniffed";
  if (lower.includes("language")) return "language";
  return "fallback";
}

export type CodeStyleFieldSource =
  | "explicit-override"
  | "editorconfig"
  | "scheme"
  | "sniffed"
  | "language-default";

/** Effective value of one style field plus where it came from (§8.18.9.4). */
export interface CodeStyleFieldValue<T> {
  value: T;
  source: CodeStyleFieldSource;
}

/**
 * Fixed-precedence resolution for one field. Later layers only fill gaps —
 * an explicit override can never be downgraded by a scheme.
 */
export function resolveStyleField<T>(
  layers: Partial<Record<CodeStyleFieldSource, T | undefined>>,
): CodeStyleFieldValue<T> | { value: undefined; source: "language-default" } {
  if (layers["explicit-override"] !== undefined) return { value: layers["explicit-override"]!, source: "explicit-override" };
  if (layers.editorconfig !== undefined) return { value: layers.editorconfig!, source: "editorconfig" };
  if (layers.scheme !== undefined) return { value: layers.scheme!, source: "scheme" };
  if (layers.sniffed !== undefined) return { value: layers.sniffed!, source: "sniffed" };
  return { value: undefined, source: "language-default" };
}

// -- Formatter exclusion / marker policy ----------------------------------

export type FormatExclusionReason = "pattern" | "marker" | "read-only" | "unsupported";

export function pathExcludedByPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    // Minimal glob semantics: leading "**/" crosses directories, "*" stays
    // within one segment. Enough for formatter exclude lists.
    let regex = "^";
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === "*") {
        if (pattern[index + 1] === "*") {
          regex += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
          index += pattern[index + 2] === "/" ? 2 : 1;
        } else {
          regex += "[^/]*";
        }
      } else if (char === "?") regex += "[^/]";
      else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`${regex}$`).test(path);
  });
}

const FORMATTER_OFF_MARKERS = ["@formatter:off", "fmt: off", "# fmt: off", "// prettier-ignore"];
const FORMATTER_ON_MARKERS = ["@formatter:on", "fmt: on", "# fmt: on"];

/**
 * Detect formatter off/on regions from language comment markers. Only exact
 * marker hits count — never heuristic guessing about code shape.
 */
export function findFormatterMarkerRanges(lines: readonly string[]): Array<{ from: number; to: number | null }> {
  const ranges: Array<{ from: number; to: number | null }> = [];
  let open: number | null = null;
  lines.forEach((line, index) => {
    if (open !== null && FORMATTER_ON_MARKERS.some((marker) => line.includes(marker))) {
      ranges.push({ from: open, to: index });
      open = null;
      return;
    }
    if (open === null && FORMATTER_OFF_MARKERS.some((marker) => line.includes(marker))) {
      open = index;
    }
  });
  if (open !== null) ranges.push({ from: open, to: null });
  return ranges;
}

// -- Format plan ------------------------------------------------------------

export interface FormatPlanStage {
  kind: "format" | "rearrange" | "organize-imports" | "cleanup";
  source: "lsp" | "jdtls" | "local-syntax";
  editsCount: number;
}

export type FormatPlanState = "ready" | "unavailable";

export interface FormatPlan {
  state?: FormatPlanState;
  scope: "selection" | "file" | "directory" | "module";
  stages: readonly FormatPlanStage[];
  excluded: readonly { uri: string; reason: FormatExclusionReason }[];
  /** Provider capability facts the plan was built against. */
  capabilities: { formatting: boolean; rangeFormatting: boolean; rearrangeSupported: boolean; cleanupSupported: boolean };
}

export function filterFormattingRanges(
  text: string,
  selectionRange?: { startLine: number; endLine: number } | null,
  honorMarkers = true,
): Array<{ startLine: number; endLine: number }> {
  if (!text) return [];
  const lines = text.split("\n");
  const totalLines = lines.length;

  const markerRanges = honorMarkers ? findFormatterMarkerRanges(lines) : [];
  if (markerRanges.length === 0) {
    if (selectionRange) {
      const start = Math.max(0, Math.min(selectionRange.startLine, totalLines - 1));
      const end = Math.max(start, Math.min(selectionRange.endLine, totalLines - 1));
      return [{ startLine: start, endLine: end }];
    }
    return [{ startLine: 0, endLine: totalLines - 1 }];
  }

  // Build active formatting ranges by excluding marker regions
  const unformattedLines = new Set<number>();
  for (const range of markerRanges) {
    const end = range.to === null ? totalLines - 1 : range.to;
    for (let i = range.from; i <= end; i += 1) {
      unformattedLines.add(i);
    }
  }

  const result: Array<{ startLine: number; endLine: number }> = [];
  let currentStart: number | null = null;

  const minLine = selectionRange ? Math.max(0, selectionRange.startLine) : 0;
  const maxLine = selectionRange ? Math.min(totalLines - 1, selectionRange.endLine) : totalLines - 1;

  for (let line = minLine; line <= maxLine; line += 1) {
    if (!unformattedLines.has(line)) {
      if (currentStart === null) currentStart = line;
    } else {
      if (currentStart !== null) {
        result.push({ startLine: currentStart, endLine: line - 1 });
        currentStart = null;
      }
    }
  }

  if (currentStart !== null) {
    result.push({ startLine: currentStart, endLine: maxLine });
  }

  return result;
}

export function isFormatScopeSupported(
  scope: FormatPlan["scope"],
  moduleFactsReady?: boolean,
): boolean {
  if (scope === "selection" || scope === "file" || scope === "directory") return true;
  if (scope === "module") return Boolean(moduleFactsReady);
  return false;
}

export interface BuildFormatPlanInput {
  scope: FormatPlan["scope"];
  targets: readonly string[];
  excludedByPattern: readonly string[];
  readOnlyPaths: ReadonlySet<string>;
  capabilities: FormatPlan["capabilities"];
  moduleFactsReady?: boolean;
}

/**
 * Build a plan for the requested scope. Stages without provider/syntax
 * evidence are simply absent — the caller reports them as unavailable
 * rather than faking rearrange/cleanup from formatted text heuristics.
 * Selection, file, and directory scopes are supported; module scope
 * requires ready module facts.
 * Excluded list strictly records genuine pattern/read-only/marker exclusions.
 */
export function buildFormatPlan(input: BuildFormatPlanInput): FormatPlan {
  const isSupported = isFormatScopeSupported(input.scope, input.moduleFactsReady);
  const excluded: Array<{ uri: string; reason: FormatExclusionReason }> = [];
  const eligible: string[] = [];
  for (const target of input.targets) {
    if (pathExcludedByPattern(target, input.excludedByPattern)) {
      excluded.push({ uri: target, reason: "pattern" });
    } else if (input.readOnlyPaths.has(target)) {
      excluded.push({ uri: target, reason: "read-only" });
    } else {
      eligible.push(target);
    }
  }

  const stages: FormatPlanStage[] = [];
  const documentFormat = input.scope === "selection"
    ? input.capabilities.rangeFormatting
    : input.capabilities.formatting;
  if (isSupported && documentFormat && eligible.length > 0) {
    stages.push({ kind: "format", source: "lsp", editsCount: 0 });
  }
  if (isSupported && input.capabilities.rearrangeSupported && eligible.length > 0) {
    stages.push({ kind: "rearrange", source: "jdtls", editsCount: 0 });
  }
  if (isSupported && input.capabilities.cleanupSupported && eligible.length > 0) {
    stages.push({ kind: "cleanup", source: "lsp", editsCount: 0 });
  }
  return {
    state: isSupported && (stages.length > 0 || (eligible.length === 0 && excluded.length > 0)) ? "ready" : "unavailable",
    scope: input.scope,
    stages,
    excluded,
    capabilities: input.capabilities,
  };
}
