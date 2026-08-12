import type { LspDiagnostic } from "../../../lib/editor/lsp";

export type InspectionSeverity = 1 | 2 | 3 | 4;

export interface InspectionRule {
  enabled: boolean;
  /** Null keeps the severity reported by the language server. */
  severity: InspectionSeverity | null;
}

export interface InspectionProfile {
  version: 1;
  rules: Record<string, InspectionRule>;
}

export const INSPECTION_PROFILE_STORAGE_PREFIX = "taomni.codeWorkspace.inspectionProfile.v1.";

export function defaultInspectionProfile(): InspectionProfile {
  return { version: 1, rules: {} };
}

function normalizeSeverity(value: unknown): InspectionSeverity | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

export function normalizeInspectionProfile(value: unknown): InspectionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultInspectionProfile();
  const source = value as { rules?: unknown };
  if (!source.rules || typeof source.rules !== "object" || Array.isArray(source.rules)) {
    return defaultInspectionProfile();
  }
  const rules: Record<string, InspectionRule> = {};
  for (const [id, value] of Object.entries(source.rules)) {
    if (!id.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = value as { enabled?: unknown; severity?: unknown };
    const rule: InspectionRule = {
      enabled: candidate.enabled !== false,
      severity: normalizeSeverity(candidate.severity),
    };
    if (!rule.enabled || rule.severity !== null) rules[id] = rule;
  }
  return { version: 1, rules };
}

function storageKey(workspaceInstanceId: string): string {
  return `${INSPECTION_PROFILE_STORAGE_PREFIX}${workspaceInstanceId}`;
}

export function readInspectionProfile(workspaceInstanceId: string): InspectionProfile {
  if (!workspaceInstanceId || typeof window === "undefined") return defaultInspectionProfile();
  try {
    return normalizeInspectionProfile(JSON.parse(
      window.localStorage.getItem(storageKey(workspaceInstanceId)) ?? "{}",
    ));
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
    window.localStorage.setItem(storageKey(workspaceInstanceId), JSON.stringify(normalized));
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
  if (!id.trim()) return profile;
  const current = inspectionRuleFor(profile, id);
  const nextRule: InspectionRule = {
    enabled: patch.enabled ?? current.enabled,
    severity: patch.severity === undefined ? current.severity : normalizeSeverity(patch.severity),
  };
  const rules = { ...profile.rules };
  if (nextRule.enabled && nextRule.severity === null) delete rules[id];
  else rules[id] = nextRule;
  return { version: 1, rules };
}

export function applyInspectionProfile(
  diagnostic: LspDiagnostic,
  profile: InspectionProfile,
): LspDiagnostic | null {
  const rule = inspectionRuleFor(profile, diagnostic);
  if (!rule.enabled) return null;
  if (rule.severity === null || rule.severity === diagnostic.severity) return diagnostic;
  return { ...diagnostic, severity: rule.severity };
}

export function applyInspectionProfileToDiagnostics(
  diagnostics: readonly LspDiagnostic[],
  profile: InspectionProfile,
): LspDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    const profiled = applyInspectionProfile(diagnostic, profile);
    return profiled ? [profiled] : [];
  });
}
