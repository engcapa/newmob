import type { LspCodeAction } from "../../../lib/editor/lsp";
import type { CapabilityEvidenceV3 } from "./capabilityEvidence";
import { sha256Hex } from "./projectAnalysisModel";

/**
 * §8.20.4 W3 Intention frozen-candidate session. Alt+Enter, the gutter bulb,
 * Problems quick fix and Search Actions all funnel through ONE session per
 * request: the candidate list is frozen at open time, every entry carries a
 * stable action id (disable/shortcut persistence keys on the id, never on
 * dynamic titles), provider and local actions are grouped, and resolve state
 * is tracked per id with timeout-keeps-candidates + Retry semantics.
 */

export interface IntentionCandidateV2 {
  id: string;
  title: string;
  kind: string;
  source: "provider-code-action" | "local-editor-action";
  preferred: boolean;
  disabledReason: string | null;
  /** True when the server deferred the payload behind data (resolve needed). */
  resolveRequired: boolean;
  evidence: CapabilityEvidenceV3 | null;
  isStale?: boolean;
}

export interface IntentionSessionContext {
  fileKey: string;
  uri: string;
  documentRevision: number;
  providerGeneration: number;
  projectFingerprint: string;
  openedAt: number;
}

export type IntentionResolveState =
  | { status: "idle" }
  | { status: "resolving"; requestId?: string }
  | { status: "resolved" }
  | { status: "failed"; message: string; retryable: true; requestId?: string }
  | { status: "stale"; reason: string };

export interface IntentionSnapshot {
  context: IntentionSessionContext;
  candidates: readonly IntentionCandidateV2[];
  groups: ReadonlyArray<{
    source: IntentionCandidateV2["source"];
    label: string;
    candidates: readonly IntentionCandidateV2[];
  }>;
  resolveStates: Readonly<Record<string, IntentionResolveState>>;
}

/** Stable action id: derived from provider identity fields that survive
 * re-requests. Dynamic titles participate ONLY through their hash — disable/
 * shortcut persistence keys on this id, never on the raw title. */
export function intentionCandidateId(candidate: {
  source: IntentionCandidateV2["source"];
  kind?: string | null;
  title: string;
}): string {
  // Identity fields only - position never enters the id, so the same action
  // keeps its id when a re-request shifts list order. Duplicates inside one
  // freeze are disambiguated by IntentionSession.open.
  const digest = sha256Hex(`${candidate.source} ${candidate.kind ?? ""} ${candidate.title}`)
    .slice(0, 16);
  return `intention.${candidate.source === "provider-code-action" ? "provider" : "local"}.${digest}`;
}

const GROUP_LABELS: Record<IntentionCandidateV2["source"], string> = {
  "provider-code-action": "Provider code actions",
  "local-editor-action": "Editor actions",
};

/** Map one raw provider action into the typed candidate contract. */
export function candidateFromProviderAction(
  action: LspCodeAction,
  evidence: CapabilityEvidenceV3 | null,
  disabledReason: string | null = null,
): IntentionCandidateV2 {
  const raw = action.raw;
  const resolveRequired = raw != null
    && typeof raw === "object"
    && !Array.isArray(raw)
    && "data" in raw;
  return {
    id: intentionCandidateId({
      source: "provider-code-action",
      kind: action.kind ?? null,
      title: action.title,
    }),
    title: action.title,
    kind: action.kind ?? "",
    source: "provider-code-action",
    preferred: action.isPreferred === true,
    disabledReason,
    resolveRequired,
    evidence,
  };
}

export function candidateFromLocalAction(
  local: { id: string; title: string; kind: string; disabledReason?: string | null },
): IntentionCandidateV2 {
  return {
    id: intentionCandidateId({
      source: "local-editor-action",
      kind: local.kind,
      title: local.title,
    }),
    title: local.title,
    kind: local.kind,
    source: "local-editor-action",
    preferred: false,
    disabledReason: local.disabledReason ?? null,
    resolveRequired: false,
    evidence: null,
  };
}

function groupCandidates(
  candidates: readonly IntentionCandidateV2[],
): IntentionSnapshot["groups"] {
  const order: IntentionCandidateV2["source"][] = ["provider-code-action", "local-editor-action"];
  return order
    .map((source) => ({
      source,
      label: GROUP_LABELS[source],
      candidates: candidates.filter((candidate) => candidate.source === source),
    }))
    .filter((group) => group.candidates.length > 0);
}

/**
 * Resolve timeout budget. On timeout the candidate list is KEPT and the
 * failed state is retryable — the popup never loses its frozen options.
 */
export const INTENTION_RESOLVE_TIMEOUT_MS = 15_000;

export class IntentionSession {
  private snapshot: IntentionSnapshot | null = null;
  private disposed = false;

  /**
   * Freeze a candidate list for this request. The snapshot is immutable —
   * later mutations go through markResolveState only.
   */
  open(
    candidates: readonly IntentionCandidateV2[],
    context: Omit<IntentionSessionContext, "openedAt">,
  ): IntentionSnapshot {
    if (this.disposed) throw new Error("IntentionSession was disposed");
    const seen = new Map<string, number>();
    const frozen: IntentionCandidateV2[] = candidates.map((candidate) => {
      const count = seen.get(candidate.id) ?? 0;
      seen.set(candidate.id, count + 1);
      // Second+ identical identity in one freeze gets an occurrence suffix so
      // resolveStates keys stay unique; the first keeps the bare stable id.
      const id = count === 0 ? candidate.id : `${candidate.id}.${count + 1}`;
      return Object.freeze({ ...candidate, id });
    });
    this.snapshot = {
      context: Object.freeze({ ...context, openedAt: Date.now() }),
      candidates: frozen,
      groups: groupCandidates(frozen),
      resolveStates: Object.fromEntries(frozen.map((candidate) => [candidate.id, { status: "idle" as const }])),
    };
    return this.snapshot;
  }

  getState(): IntentionSnapshot | null {
    return this.snapshot;
  }

  getCandidate(id: string): IntentionCandidateV2 | null {
    return this.snapshot?.candidates.find((candidate) => candidate.id === id) ?? null;
  }

  getResolveState(id: string): IntentionResolveState {
    return this.snapshot?.resolveStates[id] ?? { status: "idle" };
  }

  markResolving(id: string, requestId?: string): void {
    this.replaceResolveState(id, { status: "resolving", requestId });
  }

  markResolved(id: string): void {
    this.replaceResolveState(id, { status: "resolved" });
  }

  /** Timeout/failed keeps the candidate list intact and stays retryable. */
  markFailed(id: string, message: string, requestId?: string): void {
    this.replaceResolveState(id, { status: "failed", message, retryable: true, requestId });
  }

  markTimeout(id: string, requestId: string): void {
    this.replaceResolveState(id, {
      status: "failed",
      message: "Provider resolve timed out (request cancelled)",
      retryable: true,
      requestId,
    });
  }

  markStale(id: string, reason: string): void {
    this.replaceResolveState(id, { status: "stale", reason });
  }

  close(): void {
    this.snapshot = null;
  }

  dispose(): void {
    this.disposed = true;
    this.close();
  }

  private replaceResolveState(id: string, next: IntentionResolveState): void {
    if (!this.snapshot || !(id in this.snapshot.resolveStates)) return;
    this.snapshot = {
      ...this.snapshot,
      resolveStates: { ...this.snapshot.resolveStates, [id]: next },
    };
  }
}

/**
 * §8.21.4 V3: Verifies session context against current live document,
 * provider generation, and project fingerprint before applying an intention.
 */
export function verifyIntentionPreconditions(
  context: IntentionSessionContext,
  current: {
    documentRevision: number;
    providerGeneration: number;
    projectFingerprint: string;
  },
): { valid: true } | { valid: false; reason: "revision-changed" | "generation-changed" | "fingerprint-changed" } {
  if (current.documentRevision !== context.documentRevision) {
    return { valid: false, reason: "revision-changed" };
  }
  if (current.providerGeneration !== context.providerGeneration) {
    return { valid: false, reason: "generation-changed" };
  }
  if (
    context.projectFingerprint
    && current.projectFingerprint
    && current.projectFingerprint !== context.projectFingerprint
  ) {
    return { valid: false, reason: "fingerprint-changed" };
  }
  return { valid: true };
}
