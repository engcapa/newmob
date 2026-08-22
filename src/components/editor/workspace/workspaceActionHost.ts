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
}

export interface ActionBindingConflictDiagnostic {
  kind: "binding-conflict";
  keybinding: string;
  actionIds: string[];
  winnerId: string;
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

function matchesKeybinding(pattern: string, event: KeyboardEventLike): boolean {
  const binding = parseKeybinding(pattern);
  if (!binding) return false;
  const eventKey = eventLogicalKey(event);
  return binding.key === eventKey
    && binding.ctrl === !!event.ctrlKey
    && binding.shift === !!event.shiftKey
    && binding.alt === !!event.altKey
    && binding.meta === !!event.metaKey;
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
    this.inFlightActions.clear();
    this.actions.clear();
    this.commands.clear();
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
    return Object.freeze({
      workspaceId: this.workspaceId,
      hostGeneration: this.generation,
      actionId: id,
      invocationKind: kind,
      context,
      state: this.evaluateAction(action ?? undefined, context),
      ownerToken: this.ownerToken,
      action,
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
        reason: prepared.state.availability === "busy" ? "busy" : "condition-not-met",
        message: `Action "${prepared.actionId}" is ${prepared.state.availability} (${prepared.state.disabledReason ?? "context blocked"}).`,
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

  async dispatchKeydown(
    event: KeyboardEventLike,
    options?: { eventTarget?: EventTarget | null } | ActionInvocation,
  ): Promise<{ id: string; result: ActionResult } | null> {
    if (this.disposed) return null;
    const context = freezeContext(this.buildContext(
      options ?? { kind: "keyboard", eventTarget: (event as KeyboardEventLike & { target?: EventTarget }).target },
    ));

    for (const action of this.actions.values()) {
      if (!actionKeybindings(action).some((pattern) => matchesKeybinding(pattern, event))) continue;
      const prepared = this.prepareWithContext(action.id, context, "keyboard");
      if (prepared.state.availability !== "available") continue;
      event.preventDefault();
      event.stopPropagation();
      const invocationSignal = options && "signal" in options ? options.signal : undefined;
      return {
        id: action.id,
        result: await this.executePrepared(prepared, invocationSignal),
      };
    }
    return null;
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

  getSnapshot(
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): ActionSnapshotItem[] {
    const context = freezeContext(this.buildContext(customContext));
    const items = Array.from(this.actions.values()).map((action): ActionSnapshotItem => {
      const keybindings = actionKeybindings(action);
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
