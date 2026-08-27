import type { LspPosition, LspRange } from "../../../lib/editor/lsp";

/**
 * §8.20.0 shared evidence envelope (W3+). Every provider-backed capability
 * result carries one of these; `complete` may only come from an explicit
 * provider statement or a pinned single-provider scope protocol — never from
 * "the request succeeded".
 */

export type CapabilityEvidenceScope =
  | "document"
  | "open-files"
  | "project"
  | "tests"
  | "libraries"
  | "custom";

export interface CapabilityEvidenceV3 {
  capabilityId: string;
  languageId: string;
  provider: { id: string; version: string | null; generation: number };
  projectFingerprint: string;
  document: { uri: string; revision: number; position?: LspPosition; range?: LspRange };
  scope: CapabilityEvidenceScope;
  coverage: {
    complete: boolean;
    truncated: boolean;
    providerCount: number;
    failedProviderCount: number;
    skippedProviderCount: number;
    reason: string | null;
  };
  requestId: string;
  startedAt: number;
  completedAt: number | null;
}

export interface BuildEvidenceInput {
  capabilityId: string;
  languageId: string;
  provider: { id: string; version: string | null; generation: number };
  projectFingerprint: string;
  uri: string;
  revision: number;
  position?: LspPosition;
  range?: LspRange;
  scope?: CapabilityEvidenceScope;
  /** Defaults to single-provider document scope: complete only when stated. */
  complete?: boolean;
  reason?: string | null;
}

let evidenceRequestSequence = 0;

/**
 * The ONLY factory for CapabilityEvidenceV3 in the workspace. Single pinned
 * provider per session: providerCount=1, and completeness defaults to false
 * with an explicit reason unless the caller can cite a provider statement.
 */
export function buildCapabilityEvidence(input: BuildEvidenceInput): CapabilityEvidenceV3 {
  evidenceRequestSequence += 1;
  return {
    capabilityId: input.capabilityId,
    languageId: input.languageId,
    provider: {
      id: input.provider.id,
      version: input.provider.version,
      generation: input.provider.generation,
    },
    projectFingerprint: input.projectFingerprint,
    document: {
      uri: input.uri,
      revision: input.revision,
      ...(input.position ? { position: input.position } : {}),
      ...(input.range ? { range: input.range } : {}),
    },
    scope: input.scope ?? "document",
    coverage: {
      complete: input.complete === true,
      truncated: false,
      providerCount: 1,
      failedProviderCount: 0,
      skippedProviderCount: 0,
      reason: input.reason ?? (input.complete === true
        ? null
        : "single-provider on-the-fly results; completeness not claimed"),
    },
    requestId: `${input.capabilityId}:${input.provider.generation}:${evidenceRequestSequence}`,
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
}

/** Compact human line satisfying the W3 DoD: every diagnostic shows
 * provider/scope/revision/completeness. Never includes source text. */
export function evidencePresentationLine(evidence: CapabilityEvidenceV3): string {
  const completeness = evidence.coverage.complete
    ? "complete"
    : `incomplete${evidence.coverage.reason ? "" : ""}`;
  return [
    `${evidence.provider.id}${evidence.provider.version ? ` ${evidence.provider.version}` : ""}`,
    `gen ${evidence.provider.generation}`,
    `scope ${evidence.scope}`,
    `rev ${evidence.document.revision}`,
    completeness,
  ].join(" · ");
}
