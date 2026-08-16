import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  workspaceActionRegistry,
  compileWhenExpr,
  type WorkspaceActionContext,
  type ActionState,
  type ActionResult,
  type WorkspaceFocus,
} from "./workspaceActionRegistry";
import {
  type WorkspaceCommand,
  type WorkspaceCommandContext,
  type WorkspaceCommandMenuItem,
  type WorkspaceCommandRegistration,
  type KeyboardEventLike,
  dispatchWorkspaceCommandKeydown,
  runWorkspaceCommand,
  workspaceCommandMenuItems,
  registerWorkspaceCommands,
} from "./workspaceCommands";

export interface UseWorkspaceActionsControllerOptions {
  commands: readonly WorkspaceCommand[];
  activeFocus: WorkspaceFocus;
  contextData?: Partial<WorkspaceActionContext>;
  onCommandExecuted?: (commandId: string, result?: ActionResult) => void;
}

export interface WorkspaceActionsController {
  executeCommand: (commandId: string, payload?: unknown) => boolean;
  dispatchKeydown: (event: KeyboardEventLike) => WorkspaceCommand | null;
  getActionState: (commandId: string) => ActionState;
  menuItems: WorkspaceCommandMenuItem[];
  searchableCommands: WorkspaceCommandMenuItem[];
  commandRegistration: WorkspaceCommandRegistration;
}

/**
 * Controller hook managing workspace action registration, keydown dispatch,
 * state evaluation, and menu integration (E0.1 & E0.2).
 */
export function useWorkspaceActionsController({
  commands,
  activeFocus,
  contextData,
  onCommandExecuted,
}: UseWorkspaceActionsControllerOptions): WorkspaceActionsController {
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const activeFocusRef = useRef(activeFocus);
  activeFocusRef.current = activeFocus;

  const contextDataRef = useRef(contextData);
  contextDataRef.current = contextData;

  // Build current unified action context
  const getActionContext = useCallback((payload?: unknown): WorkspaceActionContext => {
    return {
      focus: activeFocusRef.current,
      payload,
      ...contextDataRef.current,
    };
  }, []);

  // Register commands with the global action registry on mount / change
  useEffect(() => {
    const unregister = registerWorkspaceCommands(commands);
    return unregister;
  }, [commands]);

  const executeCommand = useCallback((commandId: string, payload?: unknown): boolean => {
    const ctx = getActionContext(payload);
    const success = runWorkspaceCommand(commandsRef.current, commandId, ctx as WorkspaceCommandContext);
    if (success && onCommandExecuted) {
      onCommandExecuted(commandId, { kind: "applied" });
    }
    return success;
  }, [getActionContext, onCommandExecuted]);

  const dispatchKeydown = useCallback((event: KeyboardEventLike): WorkspaceCommand | null => {
    const ctx = getActionContext();
    const cmd = dispatchWorkspaceCommandKeydown(commandsRef.current, ctx as WorkspaceCommandContext, event);
    if (cmd && onCommandExecuted) {
      onCommandExecuted(cmd.id, { kind: "applied" });
    }
    return cmd;
  }, [getActionContext, onCommandExecuted]);

  const getActionState = useCallback((commandId: string): ActionState => {
    const ctx = getActionContext();
    return workspaceActionRegistry.getState(commandId, ctx);
  }, [getActionContext]);

  const menuItems = useMemo<WorkspaceCommandMenuItem[]>(() => {
    const ctx = getActionContext();
    return workspaceCommandMenuItems(commands, ctx as WorkspaceCommandContext);
  }, [commands, getActionContext]);

  const searchableCommands = useMemo<WorkspaceCommandMenuItem[]>(() => {
    const ctx = getActionContext();
    return commands.map((c) => {
      const regAction = workspaceActionRegistry.get(c.id);
      const whenCompiled = compileWhenExpr(c.when);
      return {
        id: c.id,
        title: c.title,
        category: c.category,
        keybinding: c.keybinding,
        enabled: whenCompiled(ctx),
        provenance: c.provenance ?? regAction?.provenance ?? "local",
      };
    });
  }, [commands, getActionContext]);

  const commandRegistration = useMemo<WorkspaceCommandRegistration>(() => ({
    items: menuItems,
    execute: (commandId) => executeCommand(commandId),
  }), [menuItems, executeCommand]);

  return {
    executeCommand,
    dispatchKeydown,
    getActionState,
    menuItems,
    searchableCommands,
    commandRegistration,
  };
}
