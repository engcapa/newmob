import type { LspDiagnostic } from "../../../lib/editor/lsp";

export type InspectionSeverity = 1 | 2 | 3 | 4;
export type InspectionSuppressionScope = "file" | "line";

export interface InspectionRule {
  enabled: boolean;
  /** Null keeps the severity reported by the language server. */
  severity: InspectionSeverity | null;
}

export interface InspectionSuppression {
  inspectionId: string;
  path: string;
  /** Null suppresses the inspection for the whole file. */
  line: number | null;
}

export interface InspectionBaselineEntry {
  inspectionId: string;
  path: string;
  /** Normalized provider message. Deliberately excludes line/column for stable matching. */
  message: string;
}

export interface InspectionBaseline {
  createdAt: number | null;
  entries: InspectionBaselineEntry[];
}

export interface InspectionProfile {
  version: 2;
  rules: Record<string, InspectionRule>;
  suppressions: InspectionSuppression[];
  baseline: InspectionBaseline;
}

export interface InspectionDiagnosticContext {
  path?: string | null;
}

export interface InspectionDiagnosticSource extends InspectionDiagnosticContext {
  diagnostic: LspDiagnostic;
}

export const INSPECTION_PROFILE_STORAGE_PREFIX = "taomni.codeWorkspace.inspectionProfile.v2.";
export const LEGACY_INSPECTION_PROFILE_STORAGE_PREFIX = "taomni.codeWorkspace.inspectionProfile.v1.";
export const INSPECTION_BASELINE_SCHEMA = "taomni.codeWorkspace.inspectionBaseline";

const MAX_SUPPRESSIONS = 5_000;
const MAX_BASELINE_ENTRIES = 20_000;
const MAX_INSPECTION_ID_LENGTH = 512;
const MAX_INSPECTION_PATH_LENGTH = 4_096;
const MAX_INSPECTION_MESSAGE_LENGTH = 2_000;

export function defaultInspectionProfile(): InspectionProfile {
  return {
    version: 2,
    rules: {},
    suppressions: [],
    baseline: { createdAt: null, entries: [] },
  };
}

function normalizeSeverity(value: unknown): InspectionSeverity | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

function normalizedBoundedString(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function normalizeInspectionPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function normalizeInspectionMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ").slice(0, MAX_INSPECTION_MESSAGE_LENGTH);
}

function normalizeInspectionId(value: unknown): string {
  return normalizedBoundedString(value, MAX_INSPECTION_ID_LENGTH);
}

function normalizeSuppression(value: unknown): InspectionSuppression | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as { inspectionId?: unknown; path?: unknown; line?: unknown };
  const inspectionId = normalizeInspectionId(source.inspectionId);
  const path = normalizeInspectionPath(normalizedBoundedString(source.path, MAX_INSPECTION_PATH_LENGTH));
  if (source.line != null
    && (typeof source.line !== "number" || !Number.isSafeInteger(source.line) || source.line < 0)) {
    return null;
  }
  const line = source.line == null ? null : source.line;
  if (!inspectionId || !path) return null;
  return { inspectionId, path, line };
}

function normalizeBaselineEntry(value: unknown): InspectionBaselineEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as { inspectionId?: unknown; path?: unknown; message?: unknown };
  const inspectionId = normalizeInspectionId(source.inspectionId);
  const path = normalizeInspectionPath(normalizedBoundedString(source.path, MAX_INSPECTION_PATH_LENGTH));
  const message = normalizeInspectionMessage(normalizedBoundedString(
    source.message,
    MAX_INSPECTION_MESSAGE_LENGTH,
  ));
  if (!inspectionId || !path || !message) return null;
  return { inspectionId, path, message };
}

export function inspectionSuppressionKey(suppression: InspectionSuppression): string {
  return JSON.stringify([
    suppression.inspectionId,
    normalizeInspectionPath(suppression.path),
    suppression.line,
  ]);
}

export function inspectionBaselineEntryKey(entry: InspectionBaselineEntry): string {
  return JSON.stringify([
    entry.inspectionId,
    normalizeInspectionPath(entry.path),
    normalizeInspectionMessage(entry.message),
  ]);
}

function uniqueBounded<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
  limit: number,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeInspectionBaseline(value: unknown): InspectionBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { createdAt: null, entries: [] };
  }
  const source = value as { createdAt?: unknown; entries?: unknown };
  const createdAt = typeof source.createdAt === "number"
    && Number.isFinite(source.createdAt)
    && source.createdAt >= 0
    ? source.createdAt
    : null;
  const entries = Array.isArray(source.entries)
    ? uniqueBounded(
        source.entries.flatMap((entry) => {
          const normalized = normalizeBaselineEntry(entry);
          return normalized ? [normalized] : [];
        }),
        inspectionBaselineEntryKey,
        MAX_BASELINE_ENTRIES,
      )
    : [];
  return { createdAt, entries };
}

export function normalizeInspectionProfile(value: unknown): InspectionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultInspectionProfile();
  const source = value as { rules?: unknown; suppressions?: unknown; baseline?: unknown };
  const rules: Record<string, InspectionRule> = {};
  if (source.rules && typeof source.rules === "object" && !Array.isArray(source.rules)) {
    for (const [id, value] of Object.entries(source.rules)) {
      const normalizedId = normalizeInspectionId(id);
      if (!normalizedId || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as { enabled?: unknown; severity?: unknown };
      const rule: InspectionRule = {
        enabled: candidate.enabled !== false,
        severity: normalizeSeverity(candidate.severity),
      };
      if (!rule.enabled || rule.severity !== null) rules[normalizedId] = rule;
    }
  }
  const suppressions = Array.isArray(source.suppressions)
    ? uniqueBounded(
        source.suppressions.flatMap((entry) => {
          const normalized = normalizeSuppression(entry);
          return normalized ? [normalized] : [];
        }),
        inspectionSuppressionKey,
        MAX_SUPPRESSIONS,
      )
    : [];
  return {
    version: 2,
    rules,
    suppressions,
    baseline: normalizeInspectionBaseline(source.baseline),
  };
}

function storageKey(prefix: string, workspaceInstanceId: string): string {
  return `${prefix}${workspaceInstanceId}`;
}

export function readInspectionProfile(workspaceInstanceId: string): InspectionProfile {
  if (!workspaceInstanceId || typeof window === "undefined") return defaultInspectionProfile();
  try {
    const current = window.localStorage.getItem(storageKey(
      INSPECTION_PROFILE_STORAGE_PREFIX,
      workspaceInstanceId,
    ));
    const legacy = window.localStorage.getItem(storageKey(
      LEGACY_INSPECTION_PROFILE_STORAGE_PREFIX,
      workspaceInstanceId,
    ));
    return normalizeInspectionProfile(JSON.parse(current ?? legacy ?? "{}"));
  } catch {
    return defaultInspectionProfile();
  }
}

export function writeInspectionProfile(
  workspaceInstanceId: string,
  profile: InspectionProfile,
): InspectionProfile {
  const normalized = normalizeInspectionProfile(profile);
  if (!workspaceInstanceId || typeof window === "undefined") return normalized;
  try {
    window.localStorage.setItem(
      storageKey(INSPECTION_PROFILE_STORAGE_PREFIX, workspaceInstanceId),
      JSON.stringify(normalized),
    );
  } catch {
    // Restricted webviews may reject localStorage writes.
  }
  return normalized;
}

/** Stable provider inspection id. `*` groups diagnostics whose provider omits a code. */
export function diagnosticInspectionId(diagnostic: LspDiagnostic): string {
  const source = diagnostic.source?.trim() || "language-server";
  const code = diagnostic.code?.trim() || "*";
  return `${source}:${code}`;
}

export function inspectionRuleFor(
  profile: InspectionProfile,
  diagnosticOrId: LspDiagnostic | string,
): InspectionRule {
  const id = typeof diagnosticOrId === "string"
    ? diagnosticOrId
    : diagnosticInspectionId(diagnosticOrId);
  return profile.rules[id] ?? { enabled: true, severity: null };
}

export function updateInspectionRule(
  profile: InspectionProfile,
  id: string,
  patch: Partial<InspectionRule>,
): InspectionProfile {
  const normalizedId = normalizeInspectionId(id);
  if (!normalizedId) return profile;
  const current = inspectionRuleFor(profile, normalizedId);
  const nextRule: InspectionRule = {
    enabled: patch.enabled ?? current.enabled,
    severity: patch.severity === undefined ? current.severity : normalizeSeverity(patch.severity),
  };
  const rules = { ...profile.rules };
  if (nextRule.enabled && nextRule.severity === null) delete rules[normalizedId];
  else rules[normalizedId] = nextRule;
  return { ...profile, version: 2, rules };
}

export function addInspectionSuppression(
  profile: InspectionProfile,
  diagnostic: LspDiagnostic,
  path: string,
  scope: InspectionSuppressionScope,
): InspectionProfile {
  const normalizedPath = normalizeInspectionPath(path);
  if (!normalizedPath) return profile;
  const suppression: InspectionSuppression = {
    inspectionId: diagnosticInspectionId(diagnostic),
    path: normalizedPath,
    line: scope === "line" ? diagnostic.range.start.line : null,
  };
  return {
    ...profile,
    suppressions: uniqueBounded(
      [...profile.suppressions, suppression],
      inspectionSuppressionKey,
      MAX_SUPPRESSIONS,
    ),
  };
}

export function removeInspectionSuppression(
  profile: InspectionProfile,
  key: string,
): InspectionProfile {
  const suppressions = profile.suppressions.filter((entry) => inspectionSuppressionKey(entry) !== key);
  return suppressions.length === profile.suppressions.length ? profile : { ...profile, suppressions };
}

export function inspectionBaselineEntryFor(
  diagnostic: LspDiagnostic,
  path: string,
): InspectionBaselineEntry | null {
  const normalizedPath = normalizeInspectionPath(path);
  const message = normalizeInspectionMessage(diagnostic.message);
  if (!normalizedPath || !message) return null;
  return {
    inspectionId: diagnosticInspectionId(diagnostic),
    path: normalizedPath,
    message,
  };
}

export function addDiagnosticToInspectionBaseline(
  profile: InspectionProfile,
  diagnostic: LspDiagnostic,
  path: string,
  now = Date.now(),
): InspectionProfile {
  const entry = inspectionBaselineEntryFor(diagnostic, path);
  if (!entry) return profile;
  return {
    ...profile,
    baseline: {
      createdAt: profile.baseline.createdAt ?? now,
      entries: uniqueBounded(
        [...profile.baseline.entries, entry],
        inspectionBaselineEntryKey,
        MAX_BASELINE_ENTRIES,
      ),
    },
  };
}

export function replaceInspectionBaseline(
  profile: InspectionProfile,
  diagnostics: readonly InspectionDiagnosticSource[],
  now = Date.now(),
): InspectionProfile {
  const entries = diagnostics.flatMap(({ diagnostic, path }) => {
    const entry = inspectionBaselineEntryFor(diagnostic, path ?? "");
    return entry ? [entry] : [];
  });
  return {
    ...profile,
    baseline: {
      createdAt: now,
      entries: uniqueBounded(entries, inspectionBaselineEntryKey, MAX_BASELINE_ENTRIES),
    },
  };
}

export function removeInspectionBaselineEntry(
  profile: InspectionProfile,
  key: string,
): InspectionProfile {
  const entries = profile.baseline.entries.filter((entry) => inspectionBaselineEntryKey(entry) !== key);
  return entries.length === profile.baseline.entries.length
    ? profile
    : { ...profile, baseline: { ...profile.baseline, entries } };
}

export function clearInspectionBaseline(profile: InspectionProfile): InspectionProfile {
  return profile.baseline.createdAt === null && profile.baseline.entries.length === 0
    ? profile
    : { ...profile, baseline: { createdAt: null, entries: [] } };
}

export function serializeInspectionBaseline(profile: InspectionProfile): string {
  return JSON.stringify({
    schema: INSPECTION_BASELINE_SCHEMA,
    version: 1,
    createdAt: profile.baseline.createdAt,
    entries: profile.baseline.entries,
  }, null, 2);
}

export function importInspectionBaseline(
  profile: InspectionProfile,
  text: string,
): InspectionProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Inspection baseline is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Inspection baseline must be a JSON object");
  }
  const source = parsed as { schema?: unknown; version?: unknown; entries?: unknown };
  if (source.schema !== INSPECTION_BASELINE_SCHEMA || source.version !== 1) {
    throw new Error("Unsupported inspection baseline schema or version");
  }
  if (!Array.isArray(source.entries)) {
    throw new Error("Inspection baseline entries must be an array");
  }
  const baseline = normalizeInspectionBaseline(source);
  if (baseline.entries.length !== source.entries.length) {
    throw new Error("Inspection baseline contains invalid or duplicate entries");
  }
  return { ...profile, baseline };
}

function diagnosticIsSuppressed(
  diagnostic: LspDiagnostic,
  profile: InspectionProfile,
  path: string,
): boolean {
  if (!path) return false;
  const inspectionId = diagnosticInspectionId(diagnostic);
  const line = diagnostic.range.start.line;
  return profile.suppressions.some((entry) => (
    entry.inspectionId === inspectionId
    && normalizeInspectionPath(entry.path) === path
    && (entry.line === null || entry.line === line)
  ));
}

function diagnosticIsInBaseline(
  diagnostic: LspDiagnostic,
  profile: InspectionProfile,
  path: string,
): boolean {
  const candidate = inspectionBaselineEntryFor(diagnostic, path);
  if (!candidate) return false;
  const key = inspectionBaselineEntryKey(candidate);
  return profile.baseline.entries.some((entry) => inspectionBaselineEntryKey(entry) === key);
}

export function applyInspectionProfile(
  diagnostic: LspDiagnostic,
  profile: InspectionProfile,
  context: InspectionDiagnosticContext = {},
): LspDiagnostic | null {
  const rule = inspectionRuleFor(profile, diagnostic);
  if (!rule.enabled) return null;
  const path = normalizeInspectionPath(context.path ?? "");
  if (diagnosticIsSuppressed(diagnostic, profile, path)) return null;
  if (diagnosticIsInBaseline(diagnostic, profile, path)) return null;
  if (rule.severity === null || rule.severity === diagnostic.severity) return diagnostic;
  return { ...diagnostic, severity: rule.severity };
}

export function applyInspectionProfileToDiagnostics(
  diagnostics: readonly LspDiagnostic[],
  profile: InspectionProfile,
  context: InspectionDiagnosticContext = {},
): LspDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    const profiled = applyInspectionProfile(diagnostic, profile, context);
    return profiled ? [profiled] : [];
  });
}
