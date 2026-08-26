import type { LspLocation, LspRange } from "../../../lib/editor/lsp";
import {
  buildCapabilityEvidence,
  type BuildEvidenceInput,
  type CapabilityEvidenceV3,
} from "./capabilityEvidence";

/**
 * §8.20.5 W4 typed semantic query envelope. Every navigation/usages/hierarchy
 * result set travels in one of these so the UI can always show WHICH provider,
 * generation, fingerprint and scope produced it — and whether coverage was
 * complete (it never is by default for plain LSP fan-out).
 */

/** §8.20.5 role vocabulary. Plain LSP references carry NO role: jdtls-classified
 * roles stay unavailable until a provider actually supplies them. */
export type UsageRole =
  | "declaration"
  | "read"
  | "write"
  | "call"
  | "type"
  | "unknown";

export type SemanticQueryKind =
  | "declaration"
  | "type"
  | "implementation"
  | "symbol"
  | "usages"
  | "call-hierarchy"
  | "type-hierarchy";

export interface SemanticQueryEnvelopeV3<T> {
  queryId: string;
  kind: SemanticQueryKind;
  evidence: CapabilityEvidenceV3;
  results: readonly T[];
  nextPageToken: string | null;
}

export interface UsageQueryV3 {
  symbol: { uri: string; range: LspRange; displayName: string; providerSymbolId: string | null };
  scope: CapabilityEvidenceV3["scope"];
  includeDeclaration: boolean;
  includeLibraries: boolean;
  roleFilter: readonly UsageRole[];
}

export interface BuildSemanticEnvelopeInput<T> {
  kind: SemanticQueryKind;
  evidence: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">;
  results: readonly T[];
  nextPageToken?: string | null;
}

const CAPABILITY_BY_KIND: Record<SemanticQueryKind, string> = {
  declaration: "navigation.declaration",
  type: "navigation.typeDefinition",
  implementation: "navigation.implementation",
  symbol: "search.workspaceSymbol",
  usages: "usages.find",
  "call-hierarchy": "hierarchy.call",
  "type-hierarchy": "hierarchy.type",
};

/**
 * The ONLY envelope factory. Plain LSP fan-out never claims completeness:
 * single provider, document-scope request, no paging token unless the caller
 * tracked one.
 */
export function buildSemanticEnvelope<T>(
  input: BuildSemanticEnvelopeInput<T>,
): SemanticQueryEnvelopeV3<T> {
  const evidence = buildCapabilityEvidence({
    ...input.evidence,
    capabilityId: CAPABILITY_BY_KIND[input.kind],
    complete: false,
    reason: "single-provider LSP fan-out; completeness not claimed",
  });
  return {
    queryId: `${input.kind}:${evidence.requestId}`,
    kind: input.kind,
    evidence,
    results: Object.freeze([...input.results]),
    nextPageToken: input.nextPageToken ?? null,
  };
}

/**
 * Role filter rule (§8.20.5 DoD): reads/writes/declarations may only filter
 * when the provider classified roles. Unknown-role results ALWAYS stay in the
 * output regardless of filter state — text guessing is forbidden.
 */
export function applyRoleFilter<T extends { role?: UsageRole }>(
  results: readonly T[],
  roleFilter: readonly UsageRole[],
): readonly T[] {
  if (roleFilter.length === 0) return results;
  const allowed = new Set(roleFilter);
  return results.filter((result) => {
    const role = result.role ?? "unknown";
    // Unclassified entries are never filtered out.
    return role === "unknown" ? true : allowed.has(role);
  });
}

/** True only when every result carries a provider-assigned, non-unknown role. */
export function roleClassificationAvailable(
  results: ReadonlyArray<{ role?: UsageRole }>,
): boolean {
  return results.length > 0 && results.every((result) => (result.role ?? "unknown") !== "unknown");
}

/** Typed location row inside a usages envelope. */
export interface UsageEnvelopeLocation extends LspLocation {
  role: UsageRole;
}
