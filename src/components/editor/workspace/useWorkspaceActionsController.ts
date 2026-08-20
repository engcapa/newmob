import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
} from "./workspaceCommands";
import { type ActionInvocation, WorkspaceActionHost } from "./workspaceActionHost";

export interface UseWorkspaceActionsControllerOptions {
  workspaceId?: string;
  commands: readonly WorkspaceCommand[];
  activeFocus?: WorkspaceFocus;
  resolveFocus?: (target: EventTarget | null) => WorkspaceFocus;
  getDefaultFocus?: () => WorkspaceFocus;
  contextData?: Partial<WorkspaceActionContext>;
  onCommandExecuted?: (commandId: string, result?: ActionResult) => void;
}

export interface WorkspaceActionsController {
  host: WorkspaceActionHost;
  executeCommand: (commandId: string, payload?: unknown) => boolean;
  executeAction: (commandId: string, payload?: unknown, signal?: AbortSignal) => Promise<ActionResult>;
  dispatchKeydown: (
    event: KeyboardEventLike,
    options?: { eventTarget?: EventTarget | null } | ActionInvocation,
  ) => Promise<{ id: string; result: ActionResult } | null>;
  getActionState: (commandId: string, payload?: unknown) => ActionState;
  menuItems: WorkspaceCommandMenuItem[];
  searchableCommands: WorkspaceCommandMenuItem[];
  commandRegistration: WorkspaceCommandRegistration;
}

/**
 * Controller hook managing workspace action registration, keydown dispatch,
 * state evaluation, and menu integration (E0.1, E0.2, N0.1, Gate R0).
 */
export function useWorkspaceActionsController({
  workspaceId = "default-workspace",
  commands,
  activeFocus = "workspace",
  resolveFocus,
  getDefaultFocus,
  contextData,
  onCommandExecuted,
}: UseWorkspaceActionsControllerOptions): WorkspaceActionsController {
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const activeFocusRef = useRef(activeFocus);
  activeFocusRef.current = activeFocus;

  const resolveFocusRef = useRef(resolveFocus);
  resolveFocusRef.current = resolveFocus;

  const getDefaultFocusRef = useRef(getDefaultFocus);
  getDefaultFocusRef.current = getDefaultFocus;

  const contextDataRef = useRef(contextData);
  contextDataRef.current = contextData;

  const onCommandExecutedRef = useRef(onCommandExecuted);
  onCommandExecutedRef.current = onCommandExecuted;

  const [revision, setRevision] = useState(0);

  // Create stable workspace action host instance with lifecycle disposal
  const host = useMemo(() => {
    return new WorkspaceActionHost({
      workspaceId,
      getDefaultContext: () => ({ ...contextDataRef.current }),
      resolveFocus: (target) =>
        resolveFocusRef.current ? resolveFocusRef.current(target) : (activeFocusRef.current ?? "workspace"),
      getDefaultFocus: () =>
        getDefaultFocusRef.current ? getDefaultFocusRef.current() : (activeFocusRef.current ?? "workspace"),
      onExecuted: (id, res) => onCommandExecutedRef.current?.(id, res),
    });
  }, [workspaceId]);



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
      const state = host.getState(commandId, payload);
      if (state.availability !== "available") return false;
      void host.execute(commandId, payload);
      return true;
    },
    [host],
  );

  const dispatchKeydown = useCallback(
    async (
      event: KeyboardEventLike,
      options?: { eventTarget?: EventTarget | null } | ActionInvocation,
    ): Promise<{ id: string; result: ActionResult } | null> => {
      return host.dispatchKeydown(event, options);
    },
    [host],
  );

  const getActionState = useCallback(
    (commandId: string, payload?: unknown): ActionState => {
      return host.getState(commandId, payload);
    },
    [host],
  );

  const menuItems = useMemo<WorkspaceCommandMenuItem[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    revision;
    return host.getMenuItems();
  }, [host, revision]);

  const searchableCommands = useMemo<WorkspaceCommandMenuItem[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    revision;
    return host.search("");
  }, [host, revision]);

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
