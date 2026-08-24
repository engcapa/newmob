/**
 * §8.19.8 Generate Code workflow runner. Applies provider-selected generate
 * actions strictly sequentially, re-checking the semantic identity before
 * EVERY action (class identity / revision / generation staleness proxy) and
 * stopping at the first failure so the dialog can offer Retry/Cancel without
 * ever inserting a locally fabricated member template.
 */

export interface GenerateCandidate {
  /** Stable id within one dialog session (index into provider results). */
  id: string;
  title: string;
  kind: string;
}

export interface GenerateApplyOutcome {
  applied: number;
  /** Index into the submitted selection of the first failure, if any. */
  failedIndex: number | null;
  message: string | null;
}

export interface GenerateApplyDeps<TAction> {
  /** Resolve a candidate to its provider action payload. */
  actionFor: (candidate: GenerateCandidate) => TAction;
  /**
   * True when the workspace/document/provider state moved since the
   * candidates were requested — apply must stop before touching anything.
   */
  isStale: () => boolean;
  run: (action: TAction) => Promise<{ ok: boolean; message: string | null }>;
}

export async function applyGenerateSelection<TAction>(
  selection: readonly GenerateCandidate[],
  deps: GenerateApplyDeps<TAction>,
): Promise<GenerateApplyOutcome> {
  let applied = 0;
  for (let index = 0; index < selection.length; index += 1) {
    const candidate = selection[index];
    if (deps.isStale()) {
      return {
        applied,
        failedIndex: index,
        message: "Generate result became stale because the class or document changed; request it again",
      };
    }
    const result = await deps.run(deps.actionFor(candidate));
    if (!result.ok) {
      return { applied, failedIndex: index, message: result.message ?? "Generate action failed" };
    }
    applied += 1;
  }
  return { applied, failedIndex: null, message: null };
}
