import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  compileWhenExpr,
  type WorkspaceActionContext,
  type ActionState,
  type ActionResult,
  type WorkspaceFocus,
} from "./workspaceActionRegistry";
import {
  type WorkspaceCommand,
  type WorkspaceCommandMenuItem,
  type WorkspaceCommandRegistration,
  type KeyboardEventLike,
  workspaceCommandMatchesKeybinding,
} from "./workspaceCommands";
import { WorkspaceActionHost } from "./workspaceActionHost";

export interface UseWorkspaceActionsControllerOptions {
  workspaceId?: string;
  commands: readonly WorkspaceCommand[];
  activeFocus: WorkspaceFocus;
  contextData?: Partial<WorkspaceActionContext>;
  onCommandExecuted?: (commandId: string, result?: ActionResult) => void;
}

export interface WorkspaceActionsController {
  host: WorkspaceActionHost;
  executeCommand: (commandId: string, payload?: unknown) => boolean;
  executeAction: (commandId: string, payload?: unknown, signal?: AbortSignal) => Promise<ActionResult>;
  dispatchKeydown: (event: KeyboardEventLike) => WorkspaceCommand | null;
  getActionState: (commandId: string) => ActionState;
  menuItems: WorkspaceCommandMenuItem[];
  searchableCommands: WorkspaceCommandMenuItem[];
  commandRegistration: WorkspaceCommandRegistration;
}

/**
 * Controller hook managing workspace action registration, keydown dispatch,
 * state evaluation, and menu integration (E0.1, E0.2, N0.1).
 */
export function useWorkspaceActionsController({
  workspaceId = "default-workspace",
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

  const [revision, setRevision] = useState(0);

  // Build current unified action context
  const getActionContext = useCallback((payload?: unknown): WorkspaceActionContext => {
    return {
      focus: activeFocusRef.current,
      payload,
      ...contextDataRef.current,
    };
  }, []);

  // Create stable workspace action host instance
  const host = useMemo(() => {
    return new WorkspaceActionHost({
      workspaceId,
      getContext: () => getActionContext(),
      onExecuted: onCommandExecuted,
    });
  }, [workspaceId, getActionContext, onCommandExecuted]);

  // Synchronize registered commands with the host
  useEffect(() => {
    const unregister = host.registerCommands(commands);
    setRevision((r) => r + 1);
    return unregister;
  }, [host, commands]);

  const executeAction = useCallback(
    async (commandId: string, payload?: unknown, signal?: AbortSignal): Promise<ActionResult> => {
      return host.execute(commandId, payload, signal);
    },
    [host],
  );

  const executeCommand = useCallback(
    (commandId: string, payload?: unknown): boolean => {
      const cmd = commandsRef.current.find((c) => c.id === commandId);
      if (!cmd) return false;
      const ctx = getActionContext(payload);
      const res = cmd.run(ctx as any) as unknown;
      const success = res !== false;
      if (success && onCommandExecuted) {
        onCommandExecuted(commandId, { kind: "applied" });
      }
      return Boolean(success);
    },
    [getActionContext, onCommandExecuted],
  );

  const dispatchKeydown = useCallback(
    (event: KeyboardEventLike): WorkspaceCommand | null => {
      const ctx = getActionContext();
      for (const cmd of commandsRef.current) {
        if (!cmd.keybinding && !cmd.keybindings?.length) continue;
        if (workspaceCommandMatchesKeybinding(cmd, event)) {
          if (cmd.when && !compileWhenExpr(cmd.when)(ctx)) {
            continue;
          }
          event.preventDefault?.();
          event.stopPropagation?.();
          const ok = cmd.run(ctx as any) as unknown;
          if (ok !== false && onCommandExecuted) {
            onCommandExecuted(cmd.id, { kind: "applied" });
          }
          return cmd;
        }
      }
      return null;
    },
    [getActionContext, onCommandExecuted],
  );

  const getActionState = useCallback(
    (commandId: string): ActionState => {
      const ctx = getActionContext();
      return host.getState(commandId, ctx);
    },
    [getActionContext, host],
  );

  const menuItems = useMemo<WorkspaceCommandMenuItem[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    revision;
    const ctx = getActionContext();
    return host.getMenuItems(ctx);
  }, [host, getActionContext, revision]);

  const searchableCommands = useMemo<WorkspaceCommandMenuItem[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    revision;
    const ctx = getActionContext();
    return host.search("", ctx);
  }, [host, getActionContext, revision]);

  const commandRegistration = useMemo<WorkspaceCommandRegistration>(
    () => ({
      items: menuItems,
      execute: (commandId) => executeCommand(commandId),
    }),
    [menuItems, executeCommand],
  );

  return {
    host,
    executeCommand,
    executeAction,
    dispatchKeydown,
    getActionState,
    menuItems,
    searchableCommands,
    commandRegistration,
  };
}
