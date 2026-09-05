import type {
  ClipboardHistoryExclusion,
  ClipboardPermissionState,
  EditorClipboardSession,
  GuardedSystemEffect,
  GuardedSystemReadResult,
  GuardedSystemWriteResult,
} from "./workspaceClipboardSession";

/**
 * Metadata-only projection of a settled guarded clipboard result (ED-CLIP-004).
 *
 * ED-CLIP-002 froze the typed effect contract (`not-performed | performed |
 * unknown`) and the ownership/effect independence rule, but the only thing the
 * product surfaced was a prose status line. A prose sentence cannot prove which
 * enum member the production owner actually chose, so packaged-Linux evidence
 * had no read-only observation seam.
 *
 * This record carries identities, outcome, effect, permission epoch and payload
 * SHAPE only. It never carries clipboard text, history text, or a segment: the
 * observation contract must not leak what the user copied, and a runner must not
 * be able to reconstruct the payload from the DOM.
 */
export type ClipboardObservationOperation = "copy" | "cut" | "paste" | "paste-plain" | "paste-history";

export type ClipboardObservationOutcome =
  | "success"
  | "denied"
  | "stale-generation"
  | "unavailable"
  | "error";

export interface ClipboardObservationRecord {
  readonly operation: ClipboardObservationOperation;
  readonly outcome: ClipboardObservationOutcome;
  /** The OS-boundary effect, never downgraded by a later ownership change. */
  readonly systemEffect: GuardedSystemEffect;
  readonly permission: ClipboardPermissionState;
  readonly permissionGeneration: number;
  /** Generation frozen before the await, when the result reported one. */
  readonly baseGeneration: number | null;
  /** True when the workspace slot answered after the OS boundary failed. */
  readonly usedWorkspaceFallback: boolean;
  /** Payload shape only: never the payload itself. */
  readonly segmentCount: number | null;
  readonly rectangular: boolean;
  readonly payloadLength: number | null;
  readonly historyExclusion: ClipboardHistoryExclusion;
  readonly payloadRevision: number;
  readonly caretCount: number;
  readonly observedAt: number;
}

export interface ClipboardObservationInputBase {
  operation: ClipboardObservationOperation;
  permission: ClipboardPermissionState;
  permissionGeneration: number;
  historyExclusion: ClipboardHistoryExclusion;
  payloadRevision: number;
  caretCount: number;
  observedAt?: number;
}

export interface ClipboardWriteObservationInput extends ClipboardObservationInputBase {
  result: GuardedSystemWriteResult;
  /** Payload the production owner asked the OS to take. */
  payload: { plainText: string; segments?: readonly string[]; rectangular: boolean };
}

export interface ClipboardReadObservationInput extends ClipboardObservationInputBase {
  result: GuardedSystemReadResult;
  /** Session actually pasted when the OS read did not answer. */
  fallbackSession?: EditorClipboardSession | null;
}

function baseGenerationOf(
  result: GuardedSystemWriteResult | GuardedSystemReadResult,
): number | null {
  return result.outcome === "stale-generation" ? result.baseGeneration : null;
}

/**
 * Copy/cut: the payload shape is known locally, so it is always reported. The
 * effect comes verbatim from the guarded result — a `stale-generation` or
 * post-write `denied` outcome keeps `performed`, per ED-CLIP-002.
 */
export function createClipboardWriteObservation(
  input: ClipboardWriteObservationInput,
): ClipboardObservationRecord {
  return {
    operation: input.operation,
    outcome: input.result.outcome,
    systemEffect: input.result.systemEffect,
    permission: input.permission,
    permissionGeneration: input.permissionGeneration,
    baseGeneration: baseGenerationOf(input.result),
    usedWorkspaceFallback: false,
    segmentCount: input.payload.segments ? input.payload.segments.length : null,
    rectangular: input.payload.rectangular,
    payloadLength: input.payload.plainText.length,
    historyExclusion: input.historyExclusion,
    payloadRevision: input.payloadRevision,
    caretCount: input.caretCount,
    observedAt: input.observedAt ?? Date.now(),
  };
}

/**
 * Paste: a non-success outcome that still inserted text did so from the
 * workspace slot, which is the visible fallback ED-CLIP-002-A4 requires. The
 * fallback flag is therefore derived from the effect actually applied, not from
 * the outcome name.
 */
export function createClipboardReadObservation(
  input: ClipboardReadObservationInput,
): ClipboardObservationRecord {
  const fallback = input.result.outcome === "success"
    ? null
    : input.fallbackSession ?? input.result.fallbackSession ?? null;
  const payloadLength = input.result.outcome === "success"
    ? input.result.text.length
    : fallback
      ? fallback.plainText.length
      : null;
  return {
    operation: input.operation,
    outcome: input.result.outcome,
    systemEffect: input.result.systemEffect,
    permission: input.permission,
    permissionGeneration: input.permissionGeneration,
    baseGeneration: baseGenerationOf(input.result),
    usedWorkspaceFallback: input.result.outcome !== "success" && fallback !== null,
    segmentCount: fallback?.segments ? fallback.segments.length : null,
    rectangular: fallback?.rectangular ?? false,
    payloadLength,
    historyExclusion: input.historyExclusion,
    payloadRevision: input.payloadRevision,
    caretCount: input.caretCount,
    observedAt: input.observedAt ?? Date.now(),
  };
}

/**
 * Guard against the observation seam leaking clipboard content. Only used by
 * tests and the DOM projection, so a future field cannot silently add text.
 */
export function assertClipboardObservationIsRedacted(
  record: ClipboardObservationRecord,
): void {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && key !== "operation" && key !== "outcome"
      && key !== "systemEffect" && key !== "permission" && key !== "historyExclusion") {
      throw new Error(`clipboard observation leaked free-form string in ${key}`);
    }
  }
}
