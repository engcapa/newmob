import type { LspPosition, LspSignatureInfo } from "../../../lib/editor/lsp";
import type {
  ReferenceInfoRequestV3,
  ReferenceProviderOutcome,
} from "./referenceInfoController";
import { ReferenceInfoController } from "./referenceInfoController";
import type { WorkspaceIntelligencePreferences } from "./intelligencePreferences";

/**
 * §8.20.2 W1 Parameter single channel. This module owns the WHOLE lifecycle
 * of the Parameter Info popup — request identity construction, auto-popup
 * gating/delay, supersede, stale checks and dismissal policy. The editor host
 * stays a pure display adapter: it emits trigger/invalidate events and renders
 * whatever display state this session publishes; it holds no request sequence
 * of its own and mints no request ids (only the controller does).
 */

export interface ReferenceSessionContext {
  fileKey: string;
  uri: string;
  languageId: string;
  documentRevision: number;
  providerGeneration: number;
}

export interface ParameterTriggerInput {
  position: LspPosition;
  /** CodeMirror caret offset at trigger time — the tooltip anchor. */
  anchorOffset: number;
  triggerCharacter: string | null;
  origin: "explicit" | "typing";
}

export interface ParameterPopupView {
  signatures: readonly LspSignatureInfo[];
  activeSignature: number;
  activeParameter: number;
  anchorOffset: number;
}

export type ParameterDisplayState =
  | { phase: "hidden" }
  | { phase: "pending"; anchorOffset: number }
  | { phase: "shown"; view: ParameterPopupView };

export type ParameterProviderAdapter = (
  request: ReferenceInfoRequestV3,
  ticket: { signal: AbortSignal },
) => Promise<ReferenceProviderOutcome | null>;

export type ParameterInvalidateReason =
  | "doc-changed"
  | "caret-moved"
  | "closing-char"
  | "provider-changed";

function sameContext(left: ReferenceSessionContext, right: ReferenceSessionContext): boolean {
  return left.fileKey === right.fileKey
    && left.uri === right.uri
    && left.languageId === right.languageId
    && left.documentRevision === right.documentRevision
    && left.providerGeneration === right.providerGeneration;
}

export class ParameterInfoSession {
  private preferences: WorkspaceIntelligencePreferences["parameterInfo"];
  private context: ReferenceSessionContext | null = null;
  private display: ParameterDisplayState = { phase: "hidden" };
  private timer: number | null = null;
  private disposed = false;
  private readonly listeners = new Set<(state: ParameterDisplayState) => void>();

  constructor(
    private readonly controller: ReferenceInfoController,
    options: { preferences?: WorkspaceIntelligencePreferences["parameterInfo"] } = {},
  ) {
    this.preferences = options.preferences ?? { autoPopup: true, delayMs: 0, showFullSignatures: false };
  }

  subscribe(listener: (state: ParameterDisplayState) => void): () => void {
    this.listeners.add(listener);
    listener(this.display);
    return () => this.listeners.delete(listener);
  }

  getState(): ParameterDisplayState {
    return this.display;
  }

  setPreferences(preferences: WorkspaceIntelligencePreferences["parameterInfo"]): void {
    // 迁移时保留用户现值: persisted delay/auto-popup values win; this module
    // never writes defaults over them.
    this.preferences = preferences;
  }

  /**
   * Publish the live file identity. Any dimension change (switched file,
   * edited document, restarted provider) closes the old tooltip and cancels
   * the in-flight request — §8.20.2 "caret/document/provider 变化关闭旧
   * tooltip".
   */
  setContext(context: ReferenceSessionContext | null): void {
    const previous = this.context;
    this.context = context;
    if (!context || !previous || !sameContext(previous, context)) {
      this.hide({ cancelInFlight: true });
    }
  }

  request(
    input: ParameterTriggerInput,
    provider: ParameterProviderAdapter,
  ): boolean {
    if (this.disposed) return false;
    const contextAtSchedule = this.context;
    if (!contextAtSchedule) return false;
    // Auto popup honours the preference gate + delay; explicit actions are
    // always zero-delay (§8.20.2).
    if (input.origin === "typing" && !this.preferences.autoPopup) return false;
    this.clearTimer();
    this.controller.cancel("parameter-info");

    const run = () => {
      this.timer = null;
      // Identity may have moved between scheduling and firing (fast typing);
      // a stale schedule must not reach the provider.
      const current = this.context;
      if (!current || !sameContext(current, contextAtSchedule)) return;
      this.setDisplay({ phase: "pending", anchorOffset: input.anchorOffset });
      const request: ReferenceInfoRequestV3 = {
        kind: "parameter-info",
        workspaceId: this.controller.workspaceId,
        fileKey: current.fileKey,
        uri: current.uri,
        languageId: current.languageId,
        position: input.position,
        documentRevision: current.documentRevision,
        providerGeneration: current.providerGeneration,
      };
      void this.controller.requestTyped(request, ({ signal }) => provider(request, { signal }))
        .then((result) => {
          if (result.state === "cancelled" || result.state === "stale") return;
          if (
            result.state !== "ready"
            || !this.context
            || !sameContext(this.context, contextAtSchedule)
          ) {
            this.hide({ cancelInFlight: false });
            return;
          }
          if (result.payload.kind !== "parameter-info") return;
          this.setDisplay({
            phase: "shown",
            view: {
              signatures: result.payload.signatures,
              activeSignature: result.payload.activeSignature,
              activeParameter: result.payload.activeParameter,
              anchorOffset: input.anchorOffset,
            },
          });
        })
        .catch(() => {
          this.hide({ cancelInFlight: false });
        });
    };

    const delayMs = input.origin === "explicit" ? 0 : Math.max(0, this.preferences.delayMs);
    if (delayMs > 0 && typeof window !== "undefined") {
      this.timer = window.setTimeout(run, delayMs);
    } else {
      run();
    }
    return true;
  }

  /**
   * Host-reported viewport churn. Closing characters and caret moves dismiss
   * outright; a plain document edit closes the OLD tooltip too (the next
   * trigger character opens a fresh one).
   */
  invalidate(reason: ParameterInvalidateReason): void {
    if (reason === "provider-changed") this.setContext(null);
    else this.hide({ cancelInFlight: true });
  }

  /** Esc scoped to THIS kind only — completion and snippet stacks untouched. */
  escape(): boolean {
    const hadUi = this.display.phase !== "hidden" || this.timer !== null;
    this.clearTimer();
    this.hide({ cancelInFlight: true });
    return hadUi;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.controller.cancel("parameter-info");
    this.listeners.clear();
    this.display = { phase: "hidden" };
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  private hide(options: { cancelInFlight: boolean }): void {
    this.clearTimer();
    if (options.cancelInFlight) this.controller.cancel("parameter-info");
    if (this.display.phase !== "hidden") {
      this.setDisplay({ phase: "hidden" });
    }
  }

  private setDisplay(state: ParameterDisplayState): void {
    this.display = state;
    for (const listener of this.listeners) listener(state);
  }
}
