import {
  compileWhenExpr,
  type ActionDisabledReason,
  type ActionResult,
  type ActionState,
  type WorkspaceActionContext,
  type WorkspaceActionDefinition,
  type WorkspaceFocus,
} from "./workspaceActionRegistry";
import {
  type KeyboardEventLike,
  type WorkspaceCommand,
  type WorkspaceCommandContext,
  type WorkspaceCommandMenuItem,
  eventLogicalKey,
  parseKeybinding,
} from "./workspaceCommands";
import {
  type KeymapSchemeV3,
  type Shortcut,
  type ShortcutStroke,
  strokesEqual,
  strokeFromKeyboardEvent,
} from "./workspaceKeymapScheme";

/** Accept KeyboardEventLike whose optional `code` falls back to `key`. */
function strokeFromEvent(event: KeyboardEventLike): ShortcutStroke {
  // jsdom/fireEvent produce `code: ""` (not undefined) for unspecified codes;
  // map `key` to its physical code fallback so matching against definition strokes succeeds.
  const rawCode = event.code && event.code.length > 0 ? event.code : undefined;
  const code = rawCode ?? (event.key ? logicalKeyToCode(event.key) ?? event.key : "");
  return strokeFromKeyboardEvent({
    code,
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  });
}

export type ActionInvocationKind =
  | "direct"
  | "keyboard"
  | "search"
  | "menu"
  | "native-menu"
  | "toolbar"
  | "context-menu"
  | "cheat-sheet"
  | "snapshot";

export interface ActionInvocation {
  kind?: ActionInvocationKind;
  context?: Partial<WorkspaceActionContext>;
  payload?: unknown;
  eventTarget?: EventTarget | null;
  signal?: AbortSignal;
}

export interface PreparedActionEvaluation {
  readonly workspaceId: string;
  readonly hostGeneration: number;
  readonly actionId: string;
  readonly invocationKind: ActionInvocationKind;
  readonly context: Readonly<WorkspaceActionContext>;
  readonly state: ActionState;
  /** Runtime owner identity. Prepared evaluations cannot cross host instances. */
  readonly ownerToken: symbol;
  /** Runtime action identity. A late disposer or replacement invalidates the evaluation. */
  readonly action: WorkspaceActionDefinition | null;
  /** Stable per-evaluation identity (§8.19.2 KeyDispatchResult.evaluationId). */
  readonly evaluationId: string;
}

export interface ActionBindingConflictDiagnostic {
  kind: "binding-conflict";
  keybinding: string;
  actionIds: string[];
  winnerId: string;
}

/** Where a resolved shortcut came from (§8.18.2 ResolvedBinding.source). */
export type ResolvedBindingSource = "user" | "base" | "builtin-editor";

/** Binding resolution result for one keyboard event (§8.18.2). */
export interface ResolvedBinding {
  stroke: ShortcutStroke;
  candidates: readonly {
    actionId: string;
    evaluation: PreparedActionEvaluation;
    contextSpecificity: number;
    source: ResolvedBindingSource;
  }[];
  resolution: "single" | "shadowed" | "conflict" | "unavailable" | "none";
  reason?: string;
}

export interface ActionSnapshotItem {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  keybindings?: string[];
  keywords?: string[];
  state: ActionState;
  evaluation: PreparedActionEvaluation;
  bindingConflicts?: ActionBindingConflictDiagnostic[];
}

export interface WorkspaceActionHostOptions {
  workspaceId: string;
  getContext?: () => WorkspaceActionContext;
  getDefaultContext?: () => Partial<WorkspaceActionContext>;
  resolveFocus?: (target: EventTarget | null) => WorkspaceFocus;
  getDefaultFocus?: () => WorkspaceFocus;
  onExecuted?: (actionId: string, result: ActionResult) => void;
}

/**
 * Matching identity of a stroke: canonical physical code + modifiers, display
 * key dropped. Both definition-derived and event-derived strokes funnel
 * through this so non-US layouts and missing `event.code` resolve alike
 * ("f4"/"F4"/"End"-style inputs converge on one identity).
 */
function normalize(stroke: ShortcutStroke): ShortcutStroke {
  return { ...stroke, key: undefined, code: logicalKeyToCode(stroke.code) ?? stroke.code };
}

function actionKeybindings(action: WorkspaceActionDefinition): string[] {
  const primary = typeof action.keybinding === "string"
    ? [action.keybinding]
    : action.keybinding
      ? [
          action.keybinding.default,
          action.keybinding.macos,
          action.keybinding.windows,
          action.keybinding.linux,
        ]
      : [];
  return Array.from(new Set([
    ...primary,
    ...(action.secondaryKeybindings ?? []),
  ].filter((binding): binding is string => Boolean(binding))));
}

/** Parse an action's built-in default keybinding strings into physical strokes. */
function parseDefinitionKeybindings(action: WorkspaceActionDefinition): readonly Shortcut[] {
  const out: Shortcut[] = [];
  for (const pattern of actionKeybindings(action)) {
    const parsed = parseKeybinding(pattern);
    if (!parsed) continue;
    // parseKeybinding gives a logical key; map back to a stroke whose `key`
    // field carries the display identity and whose `code` is derived from it
    // so matching stays physical-key based for letters/digits/named keys.
    const code = logicalKeyToCode(parsed.key);
    if (!code) continue;
    out.push({
      kind: "keyboard",
      strokes: [{
        code,
        key: parsed.key.toUpperCase(),
        ctrl: parsed.ctrl,
        alt: parsed.alt,
        shift: parsed.shift,
        meta: parsed.meta,
      }],
    });
  }
  return out;
}

/** Map a normalized logical key to the most common KeyboardEvent.code. */
function logicalKeyToCode(logicalKey: string): string | null {  const key = logicalKey.toLowerCase();
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const named: Record<string, string> = {
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
    f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
    ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash",
    ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight",
    "-": "Minus", "=": "Equal", "`": "Backquote",
  };
  return named[key] ?? null;
}

function bindingIdentity(pattern: string): string | null {
  const binding = parseKeybinding(pattern);
  if (!binding) return null;
  return [
    binding.ctrl ? "ctrl" : "",
    binding.shift ? "shift" : "",
    binding.alt ? "alt" : "",
    binding.meta ? "meta" : "",
    binding.key,
  ].filter(Boolean).join("+");
}

function defaultDisabledReason(context: WorkspaceActionContext): ActionDisabledReason {
  if (context.readOnly) return "readOnly";
  if (!context.hasActiveFile && context.focus === "editor") return "noEditor";
  if (!context.hasSelection && context.focus === "editor") return "noSelection";
  return "capability";
}

function unsupportedState(): ActionState {
  return {
    availability: "unsupported",
    disabledReason: "unsupported",
    source: "unsupported",
    scope: "workspace",
    freshness: "unknown",
    completeness: "unavailable",
  };
}

function freezeContext(context: WorkspaceActionContext): Readonly<WorkspaceActionContext> {
  const activeCapabilities = context.activeCapabilities
    ? Object.freeze({ ...context.activeCapabilities })
    : context.activeCapabilities;
  return Object.freeze({ ...context, activeCapabilities });
}

function focusByPriority(
  context: Partial<WorkspaceActionContext>,
  candidate: WorkspaceFocus,
): WorkspaceFocus {
  if (context.modalOpen || candidate === "modal") return "modal";
  if (context.completionActive || candidate === "completion") return "completion";
  if (context.snippetActive || candidate === "snippet") return "snippet";
  return candidate;
}

/** Default chord wait window before a pending first stroke expires. */
const CHORD_TIMEOUT_MS = 1200;

/**
 * §8.19.2 dispatch context. `composing`/`deadKey`/`altGraph` are resolved by
 * the host from the event when the caller does not supply them; the caller
 * may override for tests or platform quirks. `targetViewId` must be a view
 * registered on this host (EditorActionBridge), or null for non-editor
 * surfaces.
 */
export interface KeyDispatchContextV2 {
  event: KeyboardEventLike;
  workspaceId: string;
  targetViewId: string | null;
  composing?: boolean;
  deadKey?: boolean;
  altGraph?: boolean;
}

/** §8.19.2 typed dispatch result — every outcome is explicit. */
export type KeyDispatchResult =
  | { kind: "executed"; actionId: string; evaluationId: string }
  | { kind: "pending-chord"; prefix: ShortcutStroke; expiresAt: number }
  | {
    kind: "rejected";
    reason: "composing" | "dead-key" | "alt-graph" | "conflict" | "disabled" | "no-match" | "stale-owner";
    actionId?: string;
    disabledReason?: string;
  };

/**
 * Synchronously consume a matched event (preventDefault/stopPropagation) and
 * run the prepared action. Execution is async; the event must be consumed in
 * the same tick the match was decided.
 */
function executeConsuming(
  host: WorkspaceActionHost,
  evaluation: PreparedActionEvaluation,
  event: KeyboardEventLike,
): Promise<ActionResult> {
  event.preventDefault();
  event.stopPropagation();
  return host.executePrepared(evaluation);
}

/** A mounted editor view registered with the host's action bridge. */
export interface EditorActionBridgeViewRegistration {
  viewId: string;
  dispose(): void;
}

/**
 * §8.19.2 EditorActionBridge: every mounted EditorView registers here so
 * keyboard dispatch knows the live view set and unmounts release their
 * registrations. The host owns the registry; the bridge is the registration
 * vocabulary used by CodeMirrorHost and the window dispatcher.
 */
export class EditorActionBridge {
  constructor(private readonly host: WorkspaceActionHost) {}

  registerView(viewId: string): EditorActionBridgeViewRegistration {
    this.host.registerDispatchView(viewId);
    return {
      viewId,
      dispose: () => this.host.unregisterDispatchView(viewId),
    };
  }
}

export class WorkspaceActionHost {
  private readonly workspaceId: string;
  private readonly ownerToken = Symbol("workspace-action-host-owner");
  private readonly getContext?: () => WorkspaceActionContext;
  private readonly getDefaultContext?: () => Partial<WorkspaceActionContext>;
  private readonly resolveFocus?: (target: EventTarget | null) => WorkspaceFocus;
  private readonly getDefaultFocus?: () => WorkspaceFocus;
  private readonly onExecuted?: (actionId: string, result: ActionResult) => void;

  private actions = new Map<string, WorkspaceActionDefinition>();
  private commands = new Map<string, WorkspaceCommand>();
  private inFlightActions = new Set<string>();
  private generation = 0;
  private disposed = false;
  /** Monotonic per-host evaluation identity (§8.19.2 evaluationId). */
  private evaluationCounter = 0;
  /** Live editor view ids registered through the EditorActionBridge. */
  private readonly registeredViewIds = new Set<string>();

  /** User-editable keymap delta over definition defaults (§8.18.2). */
  private keymapScheme: KeymapSchemeV3 | null = null;
  /** Pending two-stroke chord: the already-consumed first ShortcutStroke. */
  private pendingChordStroke: ShortcutStroke | null = null;
  private chordTimer: ReturnType<typeof setTimeout> | null = null;
  private onChordStateChange?: (pending: boolean) => void;

  constructor(options: WorkspaceActionHostOptions) {
    this.workspaceId = options.workspaceId;
    this.getContext = options.getContext;
    this.getDefaultContext = options.getDefaultContext;
    this.resolveFocus = options.resolveFocus;
    this.getDefaultFocus = options.getDefaultFocus;
    this.onExecuted = options.onExecuted;
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  getGeneration(): number {
    return this.generation;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    if (this.chordTimer !== null) clearTimeout(this.chordTimer);
    this.chordTimer = null;
    this.pendingChordStroke = null;
    this.inFlightActions.clear();
    this.registeredViewIds.clear();
    this.actions.clear();
    this.commands.clear();
  }

  /**
   * Install the user keymap scheme. User bindings override each action's
   * built-in defaults; disabled ids make actions unavailable everywhere while
   * keeping them visible in Search/Keymap with their reason (§8.18.2).
   */
  setKeymapScheme(scheme: KeymapSchemeV3 | null): void {
    if (this.keymapScheme === scheme) return;
    this.keymapScheme = scheme;
    this.cancelPendingChord("scheme changed");
    this.generation += 1;
  }

  getKeymapScheme(): KeymapSchemeV3 | null {
    return this.keymapScheme;
  }

  setOnChordStateChange(listener: (pending: boolean) => void): void {
    this.onChordStateChange = listener;
  }

  hasPendingChord(): boolean {
    return this.pendingChordStroke !== null;
  }

  /** EditorActionBridge registration: a live mounted editor view. */
  registerDispatchView(viewId: string): void {
    if (this.disposed) return;
    this.registeredViewIds.add(viewId);
  }

  unregisterDispatchView(viewId: string): void {
    this.registeredViewIds.delete(viewId);
  }

  isDispatchViewRegistered(viewId: string): boolean {
    return this.registeredViewIds.has(viewId);
  }

  cancelPendingChord(reason = "cancelled"): void {
    if (this.chordTimer !== null) clearTimeout(this.chordTimer);
    this.chordTimer = null;
    const had = this.pendingChordStroke !== null;
    this.pendingChordStroke = null;
    if (had) this.onChordStateChange?.(false);
    void reason;
  }

  private armChordTimeout(): void {
    if (this.chordTimer !== null) clearTimeout(this.chordTimer);
    this.chordTimer = setTimeout(() => {
      this.cancelPendingChord("chord timeout");
    }, CHORD_TIMEOUT_MS);
  }

  /**
   * Effective shortcuts for one action: user scheme bindings win, then the
   * action's built-in defaults parsed into physical strokes.
   */
  effectiveShortcuts(actionId: string): { shortcuts: readonly Shortcut[]; source: ResolvedBindingSource } {
    const scheme = this.keymapScheme;
    const userBindings = scheme?.bindings[actionId];
    if (userBindings && userBindings.length > 0) {
      return { shortcuts: userBindings, source: "user" };
    }
    const action = this.actions.get(actionId);
    if (!action) return { shortcuts: [], source: "base" };
    return { shortcuts: parseDefinitionKeybindings(action), source: "base" };
  }

  isActionUserDisabled(actionId: string): boolean {
    return !!this.keymapScheme?.disabledActionIds.includes(actionId);
  }

  registerAction(action: WorkspaceActionDefinition): () => void {
    if (this.disposed) return () => {};
    this.actions.set(action.id, action);
    this.generation += 1;
    return () => {
      if (this.actions.get(action.id) !== action) return;
      this.actions.delete(action.id);
      this.generation += 1;
    };
  }

  registerActions(actions: readonly WorkspaceActionDefinition[]): () => void {
    if (this.disposed) return () => {};
    for (const action of actions) this.actions.set(action.id, action);
    this.generation += 1;
    return () => {
      let changed = false;
      for (const action of actions) {
        if (this.actions.get(action.id) !== action) continue;
        this.actions.delete(action.id);
        changed = true;
      }
      if (changed) this.generation += 1;
    };
  }

  registerCommands(commands: readonly WorkspaceCommand[]): () => void {
    if (this.disposed) return () => {};
    const installedAdapters = new Map<string, WorkspaceActionDefinition>();

    for (const command of commands) {
      this.commands.set(command.id, command);
      if (this.actions.has(command.id)) continue;
      const adapter: WorkspaceActionDefinition = {
        id: command.id,
        title: command.title,
        category: command.category as WorkspaceActionDefinition["category"],
        keybinding: command.keybinding,
        secondaryKeybindings: command.keybindings,
        keywords: command.keywords,
        when: command.when,
        isEnabled: command.isEnabled,
        getState: command.getState,
        provenance: command.provenance ?? "local",
        run: async (context, signal) => {
          if (signal?.aborted) {
            return {
              kind: "cancelled",
              reason: "aborted",
              message: "Command cancelled via AbortSignal.",
            };
          }
          try {
            const result = await Promise.resolve(command.run(context as WorkspaceCommandContext));
            if (signal?.aborted) {
              return {
                kind: "cancelled",
                reason: "aborted",
                message: "Command cancelled after execution.",
              };
            }
            return (result as unknown) !== false
              ? { kind: "applied" }
              : { kind: "no-op", reason: "condition-not-met" };
          } catch (error) {
            return {
              kind: "failed",
              reason: "exception",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
      };
      installedAdapters.set(command.id, adapter);
      this.actions.set(command.id, adapter);
    }
    this.generation += 1;

    return () => {
      let changed = false;
      for (const command of commands) {
        if (this.commands.get(command.id) === command) {
          this.commands.delete(command.id);
          changed = true;
        }
        const adapter = installedAdapters.get(command.id);
        if (adapter && this.actions.get(command.id) === adapter) {
          this.actions.delete(command.id);
          changed = true;
        }
      }
      if (changed) this.generation += 1;
    };
  }

  getAction(id: string): WorkspaceActionDefinition | undefined {
    return this.actions.get(id);
  }

  buildContext(
    invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown,
  ): WorkspaceActionContext {
    const base: Partial<WorkspaceActionContext> = this.getDefaultContext
      ? this.getDefaultContext()
      : this.getContext
        ? this.getContext()
        : {};

    let explicitContext: Partial<WorkspaceActionContext> | undefined;
    let payload: unknown;
    let target: EventTarget | null = null;

    if (invocation !== undefined && invocation !== null) {
      if (typeof invocation === "object") {
        const candidate = invocation as Record<string, unknown>;
        if (
          "context" in candidate
          || "eventTarget" in candidate
          || "signal" in candidate
          || "kind" in candidate
        ) {
          explicitContext = candidate.context as Partial<WorkspaceActionContext> | undefined;
          payload = candidate.payload;
          target = (candidate.eventTarget as EventTarget | null) ?? null;
        } else if ("focus" in candidate || "payload" in candidate) {
          explicitContext = candidate as Partial<WorkspaceActionContext>;
          payload = candidate.payload;
        } else {
          payload = invocation;
        }
      } else {
        payload = invocation;
      }
    }

    const merged = { ...base, ...explicitContext };
    const candidateFocus = explicitContext?.focus
      ?? (target && this.resolveFocus ? this.resolveFocus(target) : undefined)
      ?? (this.getDefaultFocus ? this.getDefaultFocus() : undefined)
      ?? base.focus
      ?? "workspace";

    return {
      ...merged,
      focus: focusByPriority(merged, candidateFocus),
      payload: payload !== undefined ? payload : base.payload,
    };
  }

  private evaluateAction(
    action: WorkspaceActionDefinition | undefined,
    context: Readonly<WorkspaceActionContext>,
  ): ActionState {
    if (!action) return unsupportedState();
    if (this.inFlightActions.has(action.id)) {
      return {
        availability: "busy",
        disabledReason: "busy",
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "complete",
      };
    }
    if (action.provenance === "unsupported") return unsupportedState();
    // User-disabled actions stay visible in Search/Keymap with their reason
    // but are never executable (§8.18.2 裁决).
    if (this.isActionUserDisabled(action.id)) {
      return {
        availability: "disabled",
        disabledReason: "userDisabled",
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "complete",
      };
    }

    try {
      if (action.getState) return action.getState(context as WorkspaceActionContext);
      const whenEnabled = compileWhenExpr(action.when)(context as WorkspaceActionContext);
      const explicitlyEnabled = action.isEnabled
        ? action.isEnabled(context as WorkspaceActionContext)
        : true;
      const enabled = whenEnabled && explicitlyEnabled;
      return {
        availability: enabled ? "available" : "disabled",
        disabledReason: enabled
          ? undefined
          : defaultDisabledReason(context as WorkspaceActionContext),
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "complete",
      };
    } catch {
      return {
        availability: "disabled",
        disabledReason: "invalidCondition",
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "failed",
      };
    }
  }

  private prepareWithContext(
    id: string,
    context: Readonly<WorkspaceActionContext>,
    kind: ActionInvocationKind,
  ): PreparedActionEvaluation {
    const action = this.actions.get(id) ?? null;
    this.evaluationCounter += 1;
    return Object.freeze({
      workspaceId: this.workspaceId,
      hostGeneration: this.generation,
      actionId: id,
      invocationKind: kind,
      context,
      state: this.evaluateAction(action ?? undefined, context),
      ownerToken: this.ownerToken,
      action,
      evaluationId: `${this.workspaceId}:e${this.evaluationCounter}`,
    });
  }

  prepare(
    id: string,
    invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown,
    kind?: ActionInvocationKind,
  ): PreparedActionEvaluation {
    const invocationKind = kind
      ?? (invocation && typeof invocation === "object" && "kind" in invocation
        ? (invocation as ActionInvocation).kind
        : undefined)
      ?? "direct";
    return this.prepareWithContext(id, freezeContext(this.buildContext(invocation)), invocationKind);
  }

  getState(
    id: string,
    invocationOrContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): ActionState {
    return this.prepare(id, invocationOrContext).state;
  }

  async executePrepared(
    prepared: PreparedActionEvaluation,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    if (this.disposed) {
      return {
        kind: "failed",
        reason: "disposed",
        message: "Action host is disposed.",
      };
    }
    if (
      prepared.ownerToken !== this.ownerToken
      || prepared.workspaceId !== this.workspaceId
      || prepared.hostGeneration !== this.generation
      || !prepared.action
      || this.actions.get(prepared.actionId) !== prepared.action
    ) {
      return {
        kind: "failed",
        reason: "stale-owner",
        message: `Action "${prepared.actionId}" evaluation is stale.`,
        retryable: true,
      };
    }
    if (signal?.aborted) {
      return {
        kind: "cancelled",
        reason: "aborted",
        message: "Action cancelled via AbortSignal.",
      };
    }
    if (prepared.state.availability !== "available") {
      return {
        kind: "no-op",
        reason: prepared.state.availability === "busy"
          ? "busy"
          : (prepared.state.disabledReason ? "disabled" : "condition-not-met"),
        message: prepared.state.disabledReason ?? `Action "${prepared.actionId}" is ${prepared.state.availability} (context blocked).`,
      };
    }
    if (this.inFlightActions.has(prepared.actionId)) {
      return {
        kind: "no-op",
        reason: "busy",
        message: `Action "${prepared.actionId}" is already executing.`,
      };
    }

    this.inFlightActions.add(prepared.actionId);
    try {
      if (signal?.aborted) {
        return {
          kind: "cancelled",
          reason: "aborted",
          message: "Action cancelled before run.",
        };
      }
      const response = await prepared.action.run(
        prepared.context as WorkspaceActionContext,
        signal,
      );
      const result = response ?? { kind: "applied" as const };
      this.onExecuted?.(prepared.actionId, result);
      return result;
    } catch (error) {
      const result: ActionResult = {
        kind: "failed",
        reason: "exception",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
      this.onExecuted?.(prepared.actionId, result);
      return result;
    } finally {
      this.inFlightActions.delete(prepared.actionId);
    }
  }

  async execute(
    id: string,
    invocationOrPayload?: ActionInvocation | unknown,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    const invocationSignal = invocationOrPayload
      && typeof invocationOrPayload === "object"
      && "signal" in invocationOrPayload
      ? (invocationOrPayload as ActionInvocation).signal
      : undefined;
    return this.executePrepared(
      this.prepare(id, invocationOrPayload),
      invocationSignal ?? signal,
    );
  }

  /**
   * Resolve one keyboard event against the effective keymap (§8.18.2
   * 裁决): candidates ranked by context specificity (enabled > disabled),
   * conflicts never execute. Two-stroke chords are recognized across calls.
   */
  prepareBinding(
    event: KeyboardEventLike,
    invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown,
  ): ResolvedBinding {
    const stroke = strokeFromEvent(event);
    const emptyResult: ResolvedBinding = { stroke, candidates: [], resolution: "none" };
    if (this.disposed) return emptyResult;

    // Escape always cancels a pending chord without matching actions first?
    // No: an action may legitimately bind Escape; chord cancellation happens
    // only when the escape does not resolve to any binding below.

    const secondStroke = this.pendingChordStroke;
    const context = freezeContext(this.buildContext(
      invocation ?? { kind: "keyboard", eventTarget: (event as KeyboardEventLike & { target?: EventTarget }).target },
    ));

    type Candidate = Extract<ResolvedBinding["candidates"], readonly unknown[]>[number];
    const candidates: Candidate[] = [];
    let sawEnabledCandidate = false;

    for (const [actionId] of this.actions) {
      const { shortcuts, source } = this.effectiveShortcuts(actionId);
      for (const shortcut of shortcuts) {
        if (shortcut.kind !== "keyboard") continue;
        let matched = false;
        if (secondStroke && shortcut.strokes.length === 2) {
          matched = strokesEqual(normalize(shortcut.strokes[0]), normalize(secondStroke))
            && strokesEqual(normalize(shortcut.strokes[1]), normalize(stroke));
        } else if (!secondStroke && shortcut.strokes.length === 1) {
          matched = strokesEqual(normalize(shortcut.strokes[0]), normalize(stroke));
        }
        if (!matched) continue;
        const evaluation = this.prepareWithContext(actionId, context, "keyboard");
        candidates.push({
          actionId,
          evaluation,
          contextSpecificity: evaluation.state.availability === "available" ? 1 : 0,
          source,
        });
        if (evaluation.state.availability === "available") sawEnabledCandidate = true;
        break;
      }
    }

    if (candidates.length === 0) {
      if (!secondStroke) {
        // A stroke that starts a registered two-stroke chord is consumed even
        // though it executes nothing itself (§8.18.2 chord wait).
        const startsChord = this.strokeStartsChord(stroke);
        if (startsChord) {
          this.pendingChordStroke = stroke;
          this.armChordTimeout();
          this.onChordStateChange?.(true);
          return {
            stroke,
            candidates: [],
            resolution: "shadowed",
            reason: "chord-pending",
          };
        }
      }
      return emptyResult;
    }

    const enabled = candidates.filter((candidate) => candidate.evaluation.state.availability === "available");
    if (enabled.length === 0) {
      return {
        stroke,
        candidates,
        resolution: "unavailable",
        reason: candidates[0]?.evaluation.state.disabledReason ?? "context blocked",
      };
    }
    if (enabled.length > 1) {
      // Two same-specificity executable candidates must not silently pick a
      // winner — surface the conflict so Keymap settings can resolve it.
      return {
        stroke,
        candidates,
        resolution: "conflict",
        reason: `${enabled.map((candidate) => candidate.actionId).join(", ")}`,
      };
    }

    return {
      stroke,
      candidates,
      resolution: candidates.length > 1 ? "single" : (sawEnabledCandidate ? "single" : "unavailable"),
      reason: undefined,
    };
  }

  private normalizeStrokeRef(stroke: ShortcutStroke): ShortcutStroke {
    return { ...stroke, key: undefined };
  }

  private strokeStartsChord(stroke: ShortcutStroke): boolean {
    const wanted = this.normalizeStrokeRef(stroke);
    for (const actionId of this.actions.keys()) {
      const { shortcuts } = this.effectiveShortcuts(actionId);
      for (const shortcut of shortcuts) {
        if (shortcut.kind !== "keyboard" || shortcut.strokes.length !== 2) continue;
        if (strokesEqual(normalize(shortcut.strokes[0]), wanted)) return true;
      }
    }
    return false;
  }

  /**
   * Dispatch one keyboard event through `prepareBinding`. Only an actually
   * executing binding consumes the event: unavailable candidates and
   * conflicts fall through untouched so other surfaces keep working. A bare
   * Escape cancels a pending chord.
   */
  async dispatchKeydown(
    event: KeyboardEventLike,
    options?: { eventTarget?: EventTarget | null } | ActionInvocation,
  ): Promise<{ id: string; result: ActionResult } | null> {
    if (this.disposed) return null;
    const resolved = this.prepareBinding(event, options);
    const enabled = resolved.candidates.find(
      (candidate) => candidate.evaluation.state.availability === "available",
    );
    if (!enabled || resolved.resolution === "conflict") {
      if (
        eventLogicalKey(event) === "escape"
        && this.hasPendingChord()
        && resolved.resolution === "none"
      ) {
        // Escape with no binding cancels the chord wait (timeout/focus-loss
        // are covered elsewhere).
        this.cancelPendingChord("escape");
        event.preventDefault();
      }
      return null;
    }

    // Executed: clear any chord wait state.
    this.cancelPendingChord("executed");
    event.preventDefault();
    event.stopPropagation();
    const invocationSignal = options && "signal" in options ? options.signal : undefined;
    return {
      id: enabled.actionId,
      result: await this.executePrepared(enabled.evaluation, invocationSignal),
    };
  }

  /**
   * §8.19.2 typed dispatch entry. The gate runs BEFORE any binding match:
   * IME composition, dead keys and AltGr are rejected without triggering an
   * action or swallowing the character (no preventDefault on rejection).
   * Matching stays physical (`KeyboardEvent.code`); chord waits report
   * `pending-chord` with an absolute expiry.
   */
  dispatchKeydownV2(context: KeyDispatchContextV2): KeyDispatchResult {
    const { event } = context;
    if (this.disposed) {
      return { kind: "rejected", reason: "stale-owner" };
    }
    if (context.composing || event.isComposing === true) {
      return { kind: "rejected", reason: "composing" };
    }
    if (event.key === "Dead" || context.deadKey) {
      return { kind: "rejected", reason: "dead-key" };
    }
    if (context.altGraph || event.getModifierState?.("AltGraph") === true) {
      return { kind: "rejected", reason: "alt-graph" };
    }

    if (context.targetViewId !== null && !this.registeredViewIds.has(context.targetViewId)) {
      // A stale view id must never let a foreign surface consume this stroke.
      return { kind: "rejected", reason: "stale-owner" };
    }

    const target = (event as KeyboardEventLike & { target?: EventTarget | null }).target ?? null;
    const targetNode = target instanceof Node ? target : null;
    const targetEl = targetNode instanceof Element ? targetNode : targetNode?.parentElement;
    const isExternalInput = (targetEl instanceof HTMLInputElement || targetEl instanceof HTMLTextAreaElement) && !targetEl.closest?.(".cm-editor");

    const resolved = this.prepareBinding(event, {
      kind: "keyboard",
      eventTarget: target,
      context: (context.targetViewId && !isExternalInput) ? { focus: "editor", hasActiveFile: true } : undefined,
    });
    if (resolved.resolution === "shadowed" && resolved.reason === "chord-pending") {
      return {
        kind: "pending-chord",
        prefix: resolved.stroke,
        expiresAt: Date.now() + CHORD_TIMEOUT_MS,
      };
    }
    if (resolved.resolution === "conflict") {
      return { kind: "rejected", reason: "conflict" };
    }
    const enabled = resolved.candidates.find(
      (candidate) => candidate.evaluation.state.availability === "available",
    );
    if (!enabled) {
      if (
        eventLogicalKey(event) === "escape"
        && this.hasPendingChord()
        && resolved.resolution === "none"
      ) {
        this.cancelPendingChord("escape");
      }
      const firstCandidate = resolved.candidates[0];
      return {
        kind: "rejected",
        reason: resolved.resolution === "unavailable" ? "disabled" : "no-match",
        actionId: firstCandidate?.actionId,
        disabledReason: firstCandidate?.evaluation.state.disabledReason,
      };
    }
    this.cancelPendingChord("executed");
    void executeConsuming(this, enabled.evaluation, event);
    return { kind: "executed", actionId: enabled.actionId, evaluationId: enabled.evaluation.evaluationId };
  }

  getBindingDiagnostics(
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): ActionBindingConflictDiagnostic[] {
    const snapshot = this.getSnapshot(customContext);
    const byBinding = new Map<string, { display: string; actionIds: string[] }>();
    for (const item of snapshot) {
      if (item.state.availability !== "available") continue;
      for (const binding of item.keybindings ?? []) {
        const identity = bindingIdentity(binding);
        if (!identity) continue;
        const current = byBinding.get(identity) ?? { display: binding, actionIds: [] };
        if (!current.actionIds.includes(item.id)) current.actionIds.push(item.id);
        byBinding.set(identity, current);
      }
    }
    return Array.from(byBinding.values())
      .filter((entry) => entry.actionIds.length > 1)
      .map((entry) => ({
        kind: "binding-conflict",
        keybinding: entry.display,
        actionIds: entry.actionIds,
        winnerId: entry.actionIds[0],
      }));
  }

  search(
    query: string,
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): WorkspaceCommandMenuItem[] {
    const q = query.trim().toLowerCase();
    return this.getSnapshot(customContext)
      .filter((item) => !q
        || item.title.toLowerCase().includes(q)
        || item.id.toLowerCase().includes(q)
        || item.category.toLowerCase().includes(q)
        || item.keywords?.some((keyword) => keyword.toLowerCase().includes(q)))
      .map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category,
        keybinding: item.keybinding,
        enabled: item.state.availability === "available",
        provenance: item.state.source,
      }));
  }

  getMenuItems(
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): WorkspaceCommandMenuItem[] {
    return this.search("", customContext);
  }

  /** Display strings for an action's effective shortcuts (user scheme first). */
  effectiveKeybindingDisplay(actionId: string): string[] {
    return this.effectiveShortcuts(actionId).shortcuts
      .map((shortcut) => shortcut.kind === "keyboard"
        ? shortcut.strokes.map((stroke) => [
          stroke.ctrl && "Ctrl",
          stroke.alt && "Alt",
          stroke.shift && "Shift",
          stroke.meta && "Meta",
          stroke.key ?? stroke.code,
        ].filter(Boolean).join("+")).join(" ")
        : `Mouse${shortcut.button}`)
      .filter(Boolean);
  }

  getSnapshot(
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): ActionSnapshotItem[] {
    const context = freezeContext(this.buildContext(customContext));
    const items = Array.from(this.actions.values()).map((action): ActionSnapshotItem => {
      // Snapshot shows the EFFECTIVE bindings (scheme override > defaults)
      // so every surface displays the same truth the dispatcher resolves.
      const keybindings = this.effectiveKeybindingDisplay(action.id);
      const evaluation = this.prepareWithContext(action.id, context, "snapshot");
      return {
        id: action.id,
        title: action.title,
        category: action.category ?? "Edit",
        keybinding: keybindings[0],
        keybindings,
        keywords: action.keywords,
        state: evaluation.state,
        evaluation,
      };
    });

    const byAction = new Map<string, ActionBindingConflictDiagnostic[]>();
    const byBinding = new Map<string, { display: string; actionIds: string[] }>();
    for (const item of items) {
      if (item.state.availability !== "available") continue;
      for (const binding of item.keybindings ?? []) {
        const identity = bindingIdentity(binding);
        if (!identity) continue;
        const current = byBinding.get(identity) ?? { display: binding, actionIds: [] };
        if (!current.actionIds.includes(item.id)) current.actionIds.push(item.id);
        byBinding.set(identity, current);
      }
    }
    for (const entry of byBinding.values()) {
      if (entry.actionIds.length < 2) continue;
      const diagnostic: ActionBindingConflictDiagnostic = {
        kind: "binding-conflict",
        keybinding: entry.display,
        actionIds: entry.actionIds,
        winnerId: entry.actionIds[0],
      };
      for (const id of entry.actionIds) {
        byAction.set(id, [...(byAction.get(id) ?? []), diagnostic]);
      }
    }
    return items.map((item) => ({
      ...item,
      bindingConflicts: byAction.get(item.id),
    }));
  }
}

export function createWorkspaceActionHost(
  options: WorkspaceActionHostOptions,
): WorkspaceActionHost {
  return new WorkspaceActionHost(options);
}
