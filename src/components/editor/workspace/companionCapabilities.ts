/**
 * C8-A/B/C companion capability models (§8.18.9): Structural Search and
 * Replace, Maven/Gradle dependency completion, and Full Line local
 * completion. These modules define the typed contracts, availability gates
 * and safety policies. Backends (tree-sitter Java parser, registry metadata,
 * local model runtime) are separate deliverables — until one is present each
 * capability reports a typed unavailable instead of faking results.
 */

import type { LspTextEdit } from "../../../lib/editor/lsp";

// ---------------------------------------------------------------------------
// C8-A Structural Search and Replace (Java first)
// ---------------------------------------------------------------------------

export interface StructuralQueryVariable {
  minCount: number;
  maxCount: number | null;
  text?: string;
  type?: string;
  reference?: string;
  invert?: boolean;
}

export interface StructuralQuery {
  schemaVersion: 1;
  languageId: string;
  pattern: string;
  variables: Record<string, StructuralQueryVariable>;
  scope: "file" | "module" | "workspace";
  replacement?: { template: string; shortenImports: boolean; reformat: boolean };
}

/** Languages with an official SSR story AND a real local parser backend. */
export const SSR_SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  // Java becomes available once the tree-sitter-java backend lands; the
  // schema below is already final so enabling is additive-only.
]);

export type StructuralSearchAvailability =
  | { available: true; backend: "tree-sitter" }
  | { available: false; reason: "unsupported-language" | "parser-not-ready" | "backend-missing" };

export function structuralSearchAvailability(languageId: string, hasBackend: boolean): StructuralSearchAvailability {
  if (!SSR_SUPPORTED_LANGUAGES.has(languageId)) {
    return { available: false, reason: hasBackend ? "unsupported-language" : "backend-missing" };
  }
  if (!hasBackend) return { available: false, reason: "parser-not-ready" };
  return { available: true, backend: "tree-sitter" };
}

export function validateStructuralQuery(query: StructuralQuery): string | null {
  if (query.schemaVersion !== 1) return "Unsupported structural query schema version";
  if (!query.pattern.trim()) return "Pattern must not be empty";
  for (const [name, variable] of Object.entries(query.variables)) {
    if (variable.minCount < 0) return `Variable ${name}: minCount must be >= 0`;
    if (variable.maxCount !== null && variable.maxCount < variable.minCount) {
      return `Variable ${name}: maxCount must be >= minCount`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// C8-B Maven/Gradle dependency completion
// ---------------------------------------------------------------------------

export type DependencyCoordinatePart = "group" | "artifact" | "version";

export interface DependencyCompletionRequest {
  ecosystem: "maven" | "gradle";
  coordinatePart: DependencyCoordinatePart;
  prefix: string;
  repositories: readonly { id: string; url: string; trusted: boolean }[];
  offline: boolean;
}

export interface DependencyCompletionCandidate {
  group?: string;
  artifact?: string;
  version?: string;
  /** Where the candidate came from — never a hardcoded popular list. */
  source: "repository" | "cache";
  freshness: "live" | "cached";
  prerelease?: boolean;
}

/**
 * Repository URL safety: only http(s), no embedded credentials, and untrusted
 * repositories are downgraded to cache-only reads.
 */
export function repositoryUrlPolicy(url: string): { usable: boolean; trustedRead: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { usable: false, trustedRead: false, reason: "malformed" };
  }
  if (parsed.username || parsed.password) return { usable: false, trustedRead: false, reason: "credentials-in-url" };
  if (parsed.protocol === "https:") return { usable: true, trustedRead: true };
  // Plain http may be used read-only inside controlled environments but is
  // never trusted for automatic metadata refresh.
  if (parsed.protocol === "http:") return { usable: true, trustedRead: false };
  return { usable: false, trustedRead: false, reason: "invalid-scheme" };
}

// ---------------------------------------------------------------------------
// C8-C Full Line local completion
// ---------------------------------------------------------------------------

export interface FullLineModelStatus {
  languageId: string;
  version: string;
  state: "missing" | "downloading" | "ready" | "failed";
}

export interface FullLineRuntimeStatus {
  editionEnabled: boolean;
  hardware: "supported" | "unsupported" | "unknown";
  model: FullLineModelStatus | null;
  privacy: { localOnly: true; telemetryContentFree: true };
}

export interface FullLineSuggestion {
  text: string;
  range: { from: number; to: number };
  segments: readonly { kind: "word" | "line"; from: number; to: number }[];
  additionalEdits: readonly LspTextEdit[];
  modelVersion: string;
}

/**
 * Hardware gate for the local model runtime: AVX2 on x86-64 or any ARM64.
 * Detection runs through navigator.userAgentCPU hints when present; unknown
 * stays unknown rather than optimistically enabling downloads.
 */
export function detectFullLineHardware(userAgentData: { architecture?: string } | null): "supported" | "unsupported" | "unknown" {
  const architecture = userAgentData?.architecture?.toLowerCase();
  if (architecture === "arm" || architecture === "arm64" || architecture === "aarch64") return "supported";
  if (architecture === "x86") {
    // AVX2 detection needs runtime probing that lives in the native runtime.
    return "unknown";
  }
  return "unknown";
}

/**
 * Typed availability for the whole feature. Every gate must pass before the
 * ghost-text extension may request suggestions.
 */
export function fullLineAvailability(status: FullLineRuntimeStatus): { available: boolean; reason: string | null } {
  if (!status.editionEnabled) return { available: false, reason: "edition-disabled" };
  if (status.hardware === "unsupported") return { available: false, reason: "hardware-unsupported" };
  if (status.hardware === "unknown") return { available: false, reason: "hardware-undetected" };
  if (!status.model || status.model.state !== "ready") return { available: false, reason: "model-not-ready" };
  return { available: true, reason: null };
}
