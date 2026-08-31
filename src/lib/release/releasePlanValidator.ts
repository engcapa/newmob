/**
 * ED-REL-003: Release plan, channel requirements, and evidence artifact root constraints.
 * Enforces that all evidence artifacts reside strictly within committed repo-relative roots,
 * and rejects absolute paths, /tmp paths, directory traversal escapes, and untracked sources.
 */

import type { EvidenceLayer } from "../../components/editor/workspace/editorReleaseScope";

export interface ReleaseChannelConfig {
  platform: "linux" | "macos" | "windows" | "cross-platform";
  requiredCapabilities: readonly string[];
  requiredEvidenceLayers: readonly EvidenceLayer[];
  evidenceRoots: readonly string[];
  performanceBudget?: {
    typingP95Ms?: number;
    localActionP95Ms?: number;
  };
}

export interface ReleasePlan {
  version: number;
  releaseChannels: Record<string, ReleaseChannelConfig>;
}

export interface ArtifactPathValidationResult {
  valid: boolean;
  normalizedPath: string;
  reason?: "absolute-path-rejected" | "traversal-rejected" | "disallowed-root" | "invalid-format";
  message?: string;
}

/**
 * Validates that an artifact path is strictly repo-relative and located under an approved evidence root.
 */
export function validateArtifactPath(
  rawPath: string,
  allowedRoots: readonly string[],
): ArtifactPathValidationResult {
  if (!rawPath || typeof rawPath !== "string") {
    return { valid: false, normalizedPath: "", reason: "invalid-format", message: "Artifact path must be a non-empty string" };
  }

  // 1. Reject absolute paths (POSIX and Windows)
  if (rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith("\\")) {
    return {
      valid: false,
      normalizedPath: rawPath,
      reason: "absolute-path-rejected",
      message: `Absolute artifact paths are forbidden: '${rawPath}'`,
    };
  }

  // 2. Normalize separators and reject path traversal / escape
  const normalized = rawPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.some((seg) => seg === ".." || seg === ".")) {
    return {
      valid: false,
      normalizedPath: normalized,
      reason: "traversal-rejected",
      message: `Path traversal segments ('..' or '.') are forbidden: '${rawPath}'`,
    };
  }

  // 3. Verify that path starts with one of the allowed evidence roots
  const normalizedRoots = allowedRoots.map((r) => r.replace(/\\/g, "/").replace(/\/+$/, ""));
  const matchedRoot = normalizedRoots.find(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );

  if (!matchedRoot) {
    return {
      valid: false,
      normalizedPath: normalized,
      reason: "disallowed-root",
      message: `Artifact path '${normalized}' is not within any allowed evidence roots (${allowedRoots.join(", ")})`,
    };
  }

  return {
    valid: true,
    normalizedPath: normalized,
  };
}

export interface ChannelComplianceResult {
  compliant: boolean;
  channelName: string;
  missingCapabilities: string[];
  missingLayers: EvidenceLayer[];
  invalidArtifacts: Array<{ path: string; reason: string }>;
}

/**
 * Evaluates whether a set of verified capabilities and artifacts satisfies a release channel's requirements.
 */
export function evaluateChannelCompliance(
  channelName: string,
  plan: ReleasePlan,
  verifiedCapabilities: readonly string[],
  verifiedLayers: readonly EvidenceLayer[],
  artifacts: readonly string[],
): ChannelComplianceResult {
  const channel = plan.releaseChannels[channelName];
  if (!channel) {
    return {
      compliant: false,
      channelName,
      missingCapabilities: [],
      missingLayers: [],
      invalidArtifacts: [{ path: "", reason: `Release channel '${channelName}' not found in release plan` }],
    };
  }

  const verifiedCapSet = new Set(verifiedCapabilities);
  const missingCapabilities = channel.requiredCapabilities.filter((c) => !verifiedCapSet.has(c));

  const verifiedLayerSet = new Set(verifiedLayers);
  const missingLayers = channel.requiredEvidenceLayers.filter((l) => !verifiedLayerSet.has(l));

  const invalidArtifacts: Array<{ path: string; reason: string }> = [];
  for (const art of artifacts) {
    const check = validateArtifactPath(art, channel.evidenceRoots);
    if (!check.valid) {
      invalidArtifacts.push({ path: art, reason: check.message || "Invalid artifact path" });
    }
  }

  const compliant =
    missingCapabilities.length === 0 &&
    missingLayers.length === 0 &&
    invalidArtifacts.length === 0;

  return {
    compliant,
    channelName,
    missingCapabilities,
    missingLayers,
    invalidArtifacts,
  };
}
