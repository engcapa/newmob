/**
 * §ED-QA-001: Daily Editor Linux Release Scope & Observation Contract.
 * Provides machine-readable release scope parsing, observation policy rules,
 * and compliance auditing for editor capabilities.
 */

export type ReleaseScopePlatform = "linux" | "macos" | "windows" | "cross-platform";

export type EvidenceLayer = "unit" | "browser" | "native" | "integration" | "perf";

export interface DailyEditorScopeObservationPolicy {
  readOnly: boolean;
  productionDisabled: boolean;
  redaction: "hashes-and-counts-only" | "full-redaction";
  disallowedActions: readonly string[];
}

export interface DailyEditorCapabilityRequirement {
  id: string;
  name: string;
  priority: "P0" | "P1" | "P2";
  testcaseId: string;
  controls: readonly string[];
  requiredEffects: readonly string[];
  requiredLayers: readonly EvidenceLayer[];
  providerRequirement: string;
}

export interface DailyEditorReleaseScope {
  $schema?: string;
  releaseScopeId: string;
  version: string;
  platform: ReleaseScopePlatform;
  description: string;
  observationPolicy: DailyEditorScopeObservationPolicy;
  capabilities: readonly DailyEditorCapabilityRequirement[];
}

export interface ReleaseScopeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  capabilityCount: number;
}

export interface ReleaseScopeAuditResult {
  compliant: boolean;
  coveredCapabilities: string[];
  uncoveredCapabilities: string[];
  missingControls: string[];
  disallowedActionsEnforced: boolean;
  readOnlyEnforced: boolean;
  redactionEnforced: boolean;
}

/**
 * Validates the structure and observation constraints of a release scope.
 */
export function validateEditorReleaseScope(scope: unknown): ReleaseScopeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!scope || typeof scope !== "object") {
    return { valid: false, errors: ["Release scope must be a non-null object"], warnings, capabilityCount: 0 };
  }

  const s = scope as Partial<DailyEditorReleaseScope>;

  if (!s.releaseScopeId || typeof s.releaseScopeId !== "string") {
    errors.push("Missing or invalid releaseScopeId");
  }

  if (!s.version || typeof s.version !== "string") {
    errors.push("Missing or invalid version string");
  }

  if (s.platform !== "linux" && s.platform !== "macos" && s.platform !== "windows" && s.platform !== "cross-platform") {
    errors.push(`Invalid platform: ${s.platform}`);
  }

  if (!s.observationPolicy) {
    errors.push("Missing observationPolicy");
  } else {
    if (s.observationPolicy.readOnly !== true) {
      errors.push("observationPolicy.readOnly must be strictly true");
    }
    if (s.observationPolicy.productionDisabled !== true) {
      errors.push("observationPolicy.productionDisabled must be strictly true");
    }
    if (s.observationPolicy.redaction !== "hashes-and-counts-only" && s.observationPolicy.redaction !== "full-redaction") {
      errors.push("observationPolicy.redaction must be 'hashes-and-counts-only' or 'full-redaction'");
    }
    if (!Array.isArray(s.observationPolicy.disallowedActions) || s.observationPolicy.disallowedActions.length === 0) {
      warnings.push("observationPolicy.disallowedActions should list mutation actions");
    }
  }

  if (!Array.isArray(s.capabilities) || s.capabilities.length === 0) {
    errors.push("Release scope must declare at least one capability");
  } else {
    const seenIds = new Set<string>();
    for (const cap of s.capabilities) {
      if (!cap.id || typeof cap.id !== "string") {
        errors.push("Capability entry missing id");
      } else if (seenIds.has(cap.id)) {
        errors.push(`Duplicate capability id: ${cap.id}`);
      } else {
        seenIds.add(cap.id);
      }

      if (!cap.testcaseId || typeof cap.testcaseId !== "string") {
        errors.push(`Capability ${cap.id || "unknown"} missing testcaseId`);
      }
      if (!Array.isArray(cap.controls) || cap.controls.length === 0) {
        errors.push(`Capability ${cap.id || "unknown"} must list at least one control`);
      }
      if (!Array.isArray(cap.requiredEffects) || cap.requiredEffects.length === 0) {
        errors.push(`Capability ${cap.id || "unknown"} must list at least one required effect`);
      }
      if (!Array.isArray(cap.requiredLayers) || cap.requiredLayers.length === 0) {
        errors.push(`Capability ${cap.id || "unknown"} must list required evidence layers`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    capabilityCount: Array.isArray(s.capabilities) ? s.capabilities.length : 0,
  };
}

/**
 * Audits a release scope against known available controls and testcases.
 */
export function auditEditorReleaseScopeCompliance(
  scope: DailyEditorReleaseScope,
  availableTestcases: readonly string[],
  availableControls: readonly string[],
): ReleaseScopeAuditResult {
  const coveredCapabilities: string[] = [];
  const uncoveredCapabilities: string[] = [];
  const missingControls: string[] = [];

  const testcaseSet = new Set(availableTestcases);
  const controlSet = new Set(availableControls);

  for (const cap of scope.capabilities) {
    if (testcaseSet.has(cap.testcaseId)) {
      coveredCapabilities.push(cap.id);
    } else {
      uncoveredCapabilities.push(cap.id);
    }

    for (const control of cap.controls) {
      if (!controlSet.has(control)) {
        missingControls.push(control);
      }
    }
  }

  const readOnlyEnforced = scope.observationPolicy.readOnly === true;
  const redactionEnforced = scope.observationPolicy.redaction === "hashes-and-counts-only" || scope.observationPolicy.redaction === "full-redaction";
  const disallowedActionsEnforced = Array.isArray(scope.observationPolicy.disallowedActions) && scope.observationPolicy.disallowedActions.length > 0;

  return {
    compliant: uncoveredCapabilities.length === 0 && missingControls.length === 0 && readOnlyEnforced && redactionEnforced,
    coveredCapabilities,
    uncoveredCapabilities,
    missingControls,
    disallowedActionsEnforced,
    readOnlyEnforced,
    redactionEnforced,
  };
}
