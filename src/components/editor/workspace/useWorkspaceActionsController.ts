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
import { type ActionInvocation, type ActionSnapshotItem, WorkspaceActionHost } from "./workspaceActionHost";

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
  /** Instance-scoped snapshot: the single runtime truth for all surfaces. */
  snapshot: ActionSnapshotItem[];
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

  // §8.16.3 Gate-R1 lifecycle: the host lives in lazily-created state (never
  // useMemo, which React may drop). Real unmount disposes the host; StrictMode's
  // transient effect cleanup also runs dispose, so the effect self-heals by
  // minting a fresh host when it observes a disposed instance. Disposed hosts
  // answer typed failed results and never re-register stale commands.
  const createHost = useCallback(() => new WorkspaceActionHost({
    workspaceId,
    getDefaultContext: () => ({ ...contextDataRef.current }),
    resolveFocus: (target) =>
      resolveFocusRef.current ? resolveFocusRef.current(target) : (activeFocusRef.current ?? "workspace"),
    getDefaultFocus: () =>
      getDefaultFocusRef.current ? getDefaultFocusRef.current() : (activeFocusRef.current ?? "workspace"),
    onExecuted: (id, res) => onCommandExecutedRef.current?.(id, res),
  }), [workspaceId]);

  const [host, setHost] = useState(() => createHost());
  const hostRef = useRef(host);
  hostRef.current = host;

  /**
   * Lazy self-heal (§8.16.3): a disposed host (real unmount, or StrictMode's
   * transient cleanup) is replaced on the next accessor call instead of
   * poisoning the controller with typed failures forever.
   */
  const ensureLiveHost = useCallback((): WorkspaceActionHost => {
    const current = hostRef.current;
    if (!current.isDisposed()) return current;
    const fresh = createHost();
    hostRef.current = fresh;
    setHost(fresh);
    return fresh;
  }, [createHost]);

  useEffect(() => {
    const current = hostRef.current;
    if (current.isDisposed()) {
      ensureLiveHost();
      return;
    }
    return () => {
      current.dispose();
    };
  }, [ensureLiveHost, host]);

  // Synchronize registered commands with the host
  useEffect(() => {
    if (host.isDisposed()) return;
    const unregister = host.registerCommands(commands);
    setRevision((r) => r + 1);
    return unregister;
  }, [host, commands]);

  const executeAction = useCallback(
    async (commandId: string, payload?: unknown, signal?: AbortSignal): Promise<ActionResult> => {
      return ensureLiveHost().execute(commandId, payload, signal);
    },
    [ensureLiveHost],
  );

  const executeCommand = useCallback(
    (commandId: string, payload?: unknown): boolean => {
      const live = ensureLiveHost();
      const state = live.getState(commandId, payload);
      if (state.availability !== "available") return false;
      void live.execute(commandId, payload);
      return true;
    },
    [ensureLiveHost],
  );

  const dispatchKeydown = useCallback(
    async (
      event: KeyboardEventLike,
      options?: { eventTarget?: EventTarget | null } | ActionInvocation,
    ): Promise<{ id: string; result: ActionResult } | null> => {
      return ensureLiveHost().dispatchKeydown(event, options);
    },
    [ensureLiveHost],
  );

  const getActionState = useCallback(
    (commandId: string, payload?: unknown): ActionState => {
      return ensureLiveHost().getState(commandId, payload);
    },
    [ensureLiveHost],
  );

  // Build one immutable snapshot first. Every display projection below is derived
  // from this same prepared context/evaluation set.
  const snapshot = useMemo<ActionSnapshotItem[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    revision;
    activeFocus;
    contextData;
    return host.getSnapshot();
  }, [host, revision, activeFocus, contextData]);

  const menuItems = useMemo<WorkspaceCommandMenuItem[]>(() => snapshot.map((entry) => ({
    id: entry.id,
    title: entry.title,
    category: entry.category,
    keybinding: entry.keybinding,
    enabled: entry.state.availability === "available",
    provenance: entry.state.source,
  })), [snapshot]);

  const commandRegistration = useMemo<WorkspaceCommandRegistration>(
    () => ({
      items: menuItems,
      snapshot,
      executeAction,
      execute: (commandId, payload) => executeCommand(commandId, payload),
    }),
    [executeAction, executeCommand, menuItems, snapshot],
  );

  return {
    host,
    executeCommand,
    executeAction,
    dispatchKeydown,
    getActionState,
    menuItems,
    snapshot,
    commandRegistration,
  };
}
