/**
 * Workspace-Scoped Action Host (N0.1, Gate R0).
 *
 * Provides a dedicated, isolated action registry and execution host for each workspace/window instance.
 * Eliminates dual execution paths between WorkspaceCommand and WorkspaceActionRegistry by unifying
 * keymap dispatch, Search Everywhere, menus, and direct invocations under a single async execution lifecycle.
 */

import {
  compileWhenExpr,
  type WorkspaceActionDefinition,
  type WorkspaceActionContext,
  type ActionState,
  type ActionResult,
  type ActionPlatformKeybindings,
  type WorkspaceFocus,
} from "./workspaceActionRegistry";
import {
  type WorkspaceCommand,
  type WorkspaceCommandContext,
  type WorkspaceCommandMenuItem,
  type KeyboardEventLike,
  parseKeybinding,
  eventLogicalKey,
  workspaceCommandMatchesKeybinding,
} from "./workspaceCommands";

export interface ActionInvocation {
  context?: Partial<WorkspaceActionContext>;
  payload?: unknown;
  eventTarget?: EventTarget | null;
  signal?: AbortSignal;
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
  return (
    binding.key === eventKey &&
    binding.ctrl === !!event.ctrlKey &&
    binding.shift === !!event.shiftKey &&
    binding.alt === !!event.altKey &&
    binding.meta === !!event.metaKey
  );
}

export class WorkspaceActionHost {
  private readonly workspaceId: string;
  private readonly getContext?: () => WorkspaceActionContext;
  private readonly getDefaultContext?: () => Partial<WorkspaceActionContext>;
  private readonly resolveFocus?: (target: EventTarget | null) => WorkspaceFocus;
  private readonly getDefaultFocus?: () => WorkspaceFocus;
  private readonly onExecuted?: (actionId: string, result: ActionResult) => void;

  private actions = new Map<string, WorkspaceActionDefinition>();
  private commands = new Map<string, WorkspaceCommand>();
  private inFlightActions = new Set<string>();
  private generation: number = 0;
  private disposed: boolean = false;

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
    this.disposed = true;
    this.inFlightActions.clear();
    this.actions.clear();
    this.commands.clear();
  }

  registerAction(action: WorkspaceActionDefinition): () => void {
    if (this.disposed) return () => {};
    this.actions.set(action.id, action);
    this.generation += 1;
    return () => {
      if (this.actions.get(action.id) === action) {
        this.actions.delete(action.id);
        this.generation += 1;
      }
    };
  }

  registerActions(actions: readonly WorkspaceActionDefinition[]): () => void {
    if (this.disposed) return () => {};
    for (const a of actions) {
      this.actions.set(a.id, a);
    }
    this.generation += 1;
    return () => {
      for (const a of actions) {
        if (this.actions.get(a.id) === a) {
          this.actions.delete(a.id);
        }
      }
      this.generation += 1;
    };
  }

  registerCommands(commands: readonly WorkspaceCommand[]): () => void {
    if (this.disposed) return () => {};
    const installedAdapters = new Map<string, WorkspaceActionDefinition>();

    for (const cmd of commands) {
      this.commands.set(cmd.id, cmd);
      // Also adapt into action definition if not already present
      if (!this.actions.has(cmd.id)) {
        const adapter: WorkspaceActionDefinition = {
          id: cmd.id,
          title: cmd.title,
          category: (cmd.category as any) ?? "Edit",
          keybinding: cmd.keybinding,
          when: cmd.when,
          provenance: cmd.provenance ?? "local",
          run: async (ctx, signal) => {
            if (signal?.aborted) {
              return { kind: "cancelled", message: "Command cancelled via AbortSignal." };
            }
            try {
              const res = await Promise.resolve(cmd.run(ctx as WorkspaceCommandContext));
              if (signal?.aborted) {
                return { kind: "cancelled", message: "Command cancelled after execution." };
              }
              return (res as unknown) !== false ? { kind: "applied" } : { kind: "no-op" };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { kind: "failed", message };
            }
          },
        };
        installedAdapters.set(cmd.id, adapter);
        this.actions.set(cmd.id, adapter);
      }
    }
    this.generation += 1;
    return () => {
      for (const cmd of commands) {
        if (this.commands.get(cmd.id) === cmd) {
          this.commands.delete(cmd.id);
        }
        const adapter = installedAdapters.get(cmd.id);
        if (adapter && this.actions.get(cmd.id) === adapter) {
          this.actions.delete(cmd.id);
        }
      }
      this.generation += 1;
    };
  }

  getAction(id: string): WorkspaceActionDefinition | undefined {
    return this.actions.get(id);
  }

  /**
   * Single unified context constructor (Gate R0).
   * Priority: explicit invocation.context > eventTarget resolution > host default focus / context.
   */
  buildContext(invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown): WorkspaceActionContext {
    const base: Partial<WorkspaceActionContext> = this.getDefaultContext
      ? this.getDefaultContext()
      : this.getContext
      ? this.getContext()
      : {};

    if (invocation === undefined || invocation === null) {
      const defaultFocus = (this.getDefaultFocus ? this.getDefaultFocus() : undefined)
        ?? (base.focus as WorkspaceFocus | undefined)
        ?? "workspace";
      return {
        focus: defaultFocus,
        ...base,
      };
    }

    let explicitCtx: Partial<WorkspaceActionContext> | undefined;
    let payload: unknown = undefined;
    let target: EventTarget | null = null;

    if (typeof invocation === "object" && invocation !== null) {
      const inv = invocation as Record<string, unknown>;
      if ("context" in inv || "eventTarget" in inv || "signal" in inv) {
        explicitCtx = inv.context as Partial<WorkspaceActionContext> | undefined;
        payload = inv.payload;
        target = (inv.eventTarget as EventTarget | null) ?? null;
      } else if ("focus" in inv || "payload" in inv) {
        // WorkspaceCommandContext object passed directly
        explicitCtx = inv as Partial<WorkspaceActionContext>;
        payload = inv.payload !== undefined ? inv.payload : undefined;
      } else {
        // Raw payload
        payload = invocation;
      }
    } else {
      payload = invocation;
    }

    const resolvedFocus: WorkspaceFocus = explicitCtx?.focus
      ?? (target && this.resolveFocus ? this.resolveFocus(target) : undefined)
      ?? (this.getDefaultFocus ? this.getDefaultFocus() : undefined)
      ?? (base.focus as WorkspaceFocus | undefined)
      ?? "workspace";

    return {
      ...base,
      ...explicitCtx,
      focus: resolvedFocus,
      payload: payload !== undefined ? payload : base.payload,
    };
  }

  getState(id: string, invocationOrContext?: ActionInvocation | WorkspaceActionContext | unknown): ActionState {
    const action = this.actions.get(id);
    const cmd = this.commands.get(id);
    if (!action && !cmd) {
      return {
        availability: "unsupported",
        disabledReason: "unsupported",
        source: "unsupported",
        scope: "workspace",
        freshness: "unknown",
        completeness: "unavailable",
      };
    }

    if (this.inFlightActions.has(id)) {
      return {
        availability: "disabled",
        disabledReason: "busy",
        source: action?.provenance ?? cmd?.provenance ?? "local",
        scope: "workspace",
        freshness: "current",
        completeness: "complete",
      };
    }

    const ctx = this.buildContext(invocationOrContext);
    const whenCheck = action?.when ?? cmd?.when;
    if (whenCheck) {
      const ok = typeof whenCheck === "function" ? whenCheck(ctx as any) : compileWhenExpr(whenCheck)(ctx);
      if (!ok) {
        return {
          availability: "disabled",
          disabledReason: "capability",
          source: action?.provenance ?? cmd?.provenance ?? "local",
          scope: "workspace",
          freshness: "current",
          completeness: "complete",
        };
      }
    }

    return {
      availability: "available",
      source: action?.provenance ?? cmd?.provenance ?? "local",
      scope: "workspace",
      freshness: "current",
      completeness: "complete",
    };
  }

  async execute(
    id: string,
    invocationOrPayload?: ActionInvocation | unknown,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    if (this.disposed) {
      return { kind: "failed", message: "Action host is disposed." };
    }

    const sig = (invocationOrPayload && typeof invocationOrPayload === "object" && "signal" in invocationOrPayload)
      ? (invocationOrPayload as ActionInvocation).signal ?? signal
      : signal;

    if (sig?.aborted) {
      return { kind: "cancelled", message: "Action cancelled via AbortSignal." };
    }

    const action = this.actions.get(id);
    const cmd = this.commands.get(id);

    if (!action && !cmd) {
      return { kind: "failed", message: `Action "${id}" not found.` };
    }

    if (this.inFlightActions.has(id)) {
      return { kind: "no-op", message: `Action "${id}" is already executing.` };
    }

    const ctx = this.buildContext(invocationOrPayload);
    const whenCheck = action?.when ?? cmd?.when;
    if (whenCheck) {
      const ok = typeof whenCheck === "function" ? whenCheck(ctx as any) : compileWhenExpr(whenCheck)(ctx);
      if (!ok) {
        return { kind: "no-op", message: `Action "${id}" condition not met.` };
      }
    }

    this.inFlightActions.add(id);

    try {
      if (sig?.aborted) {
        return { kind: "cancelled", message: "Action cancelled before run." };
      }

      let result: ActionResult;
      if (action?.run) {
        const runRes = await action.run(ctx, sig);
        result = runRes ?? { kind: "applied" };
      } else if (cmd?.run) {
        const res = await Promise.resolve(cmd.run(ctx as WorkspaceCommandContext));
        result = (res as unknown) !== false ? { kind: "applied" } : { kind: "no-op" };
      } else {
        result = { kind: "applied" };
      }

      this.onExecuted?.(id, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const res: ActionResult = { kind: "failed", message };
      this.onExecuted?.(id, res);
      return res;
    } finally {
      this.inFlightActions.delete(id);
    }
  }

  async dispatchKeydown(
    event: KeyboardEventLike,
    options?: { eventTarget?: EventTarget | null } | ActionInvocation,
  ): Promise<{ id: string; result: ActionResult } | null> {
    if (this.disposed) return null;

    const ctx = this.buildContext(options ?? { eventTarget: (event as any).target });

    // 1. Check explicit actions with keybindings first
    for (const action of this.actions.values()) {
      if (!action.keybinding) continue;
      const patterns = typeof action.keybinding === "string"
        ? [action.keybinding]
        : [
            action.keybinding.default,
            action.keybinding.macos,
            action.keybinding.windows,
            action.keybinding.linux,
          ].filter((p): p is string => Boolean(p));
      const matched = patterns.some((pattern) => matchesKeybinding(pattern, event));
      if (matched) {
        if (action.when && !compileWhenExpr(action.when)(ctx)) {
          continue;
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        const result = await this.execute(action.id, { context: ctx, payload: ctx.payload });
        return { id: action.id, result };
      }
    }

    // 2. Check registered commands with keybinding string
    for (const cmd of this.commands.values()) {
      if (!cmd.keybinding && !cmd.keybindings?.length) continue;
      if (workspaceCommandMatchesKeybinding(cmd, event)) {
        if (cmd.when) {
          const ok = typeof cmd.when === "function" ? cmd.when(ctx as any) : compileWhenExpr(cmd.when)(ctx);
          if (!ok) continue;
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        const result = await this.execute(cmd.id, { context: ctx, payload: ctx.payload });
        return { id: cmd.id, result };
      }
    }

    return null;
  }

  search(query: string, customContext?: ActionInvocation | WorkspaceActionContext | unknown): WorkspaceCommandMenuItem[] {
    const ctx = this.buildContext(customContext);
    const q = query.trim().toLowerCase();
    const items: WorkspaceCommandMenuItem[] = [];

    for (const action of this.actions.values()) {
      const state = this.getState(action.id, ctx);
      const title = action.title.toLowerCase();
      const id = action.id.toLowerCase();
      const category = (action.category ?? "Edit").toLowerCase();

      if (!q || title.includes(q) || id.includes(q) || category.includes(q)) {
        const kb = typeof action.keybinding === "string"
          ? action.keybinding
          : (action.keybinding as ActionPlatformKeybindings | undefined)?.default;
        items.push({
          id: action.id,
          title: action.title,
          category: action.category ?? "Edit",
          keybinding: kb,
          enabled: state.availability === "available",
          provenance: state.source,
        });
      }
    }

    return items;
  }

  getMenuItems(customContext?: ActionInvocation | WorkspaceActionContext | unknown): WorkspaceCommandMenuItem[] {
    return this.search("", customContext);
  }
}

export function createWorkspaceActionHost(
  options: WorkspaceActionHostOptions,
): WorkspaceActionHost {
  return new WorkspaceActionHost(options);
}
