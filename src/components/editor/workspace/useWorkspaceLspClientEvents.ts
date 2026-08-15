import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  lspCancelWorkDoneProgress,
  lspResolveShowMessageRequest,
  type LspShowMessageCancelled,
  type LspShowMessageNotification,
  type LspShowMessageRequest,
  type LspWorkDoneProgressEvent,
} from "../../../lib/editor/lsp";

export const LSP_SHOW_MESSAGE_REQUEST_EVENT = "lsp://show-message-request";
export const LSP_SHOW_MESSAGE_CANCELLED_EVENT = "lsp://show-message-cancelled";
export const LSP_SHOW_MESSAGE_EVENT = "lsp://show-message";
export const LSP_WORK_DONE_PROGRESS_EVENT = "lsp://work-done-progress";

function progressKey(event: Pick<LspWorkDoneProgressEvent, "presetId" | "rootUri" | "token">): string {
  return `${event.presetId}\u0000${event.rootUri}\u0000${typeof event.token}:${String(event.token)}`;
}

function normalizeMessageRequest(value: unknown): LspShowMessageRequest | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.requestId !== "string" || typeof source.workspaceId !== "string") return null;
  if (typeof source.message !== "string" || typeof source.serverLabel !== "string") return null;
  const messageType = typeof source.messageType === "number" ? source.messageType : 3;
  const actions = Array.isArray(source.actions)
    ? source.actions.filter((action): action is { title: string } => (
      !!action
      && typeof action === "object"
      && typeof (action as { title?: unknown }).title === "string"
    ))
    : [];
  return {
    requestId: source.requestId,
    workspaceId: source.workspaceId,
    serverLabel: source.serverLabel,
    messageType,
    message: source.message,
    actions,
  };
}

function normalizeProgress(value: unknown): LspWorkDoneProgressEvent | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.workspaceId !== "string"
    || typeof source.presetId !== "string"
    || typeof source.serverLabel !== "string"
    || typeof source.rootUri !== "string"
    || (typeof source.token !== "string" && typeof source.token !== "number")
    || !["begin", "report", "end"].includes(String(source.kind))
  ) return null;
  return {
    workspaceId: source.workspaceId,
    presetId: source.presetId,
    serverLabel: source.serverLabel,
    rootUri: source.rootUri,
    token: source.token,
    kind: source.kind as LspWorkDoneProgressEvent["kind"],
    title: typeof source.title === "string" ? source.title : null,
    message: typeof source.message === "string" ? source.message : null,
    percentage: typeof source.percentage === "number" ? Math.max(0, Math.min(100, source.percentage)) : null,
    cancellable: source.cancellable === true,
  };
}

function notificationText(notification: LspShowMessageNotification): string {
  const prefix = notification.messageType === 1
    ? "Error"
    : notification.messageType === 2
      ? "Warning"
      : "Info";
  return `${notification.serverLabel}: ${prefix}: ${notification.message}`;
}

export interface WorkspaceLspClientEventsController {
  messageRequest: LspShowMessageRequest | null;
  progresses: LspWorkDoneProgressEvent[];
  resolveMessageRequest: (actionIndex: number | null) => void;
  cancelProgress: (progress: LspWorkDoneProgressEvent) => void;
}

interface UseWorkspaceLspClientEventsOptions {
  workspaceId: string;
  visible: boolean;
  onStatus: (message: string) => void;
}

/** Bridges server-initiated LSP UI events into the workspace shell. */
export function useWorkspaceLspClientEvents({
  workspaceId,
  visible,
  onStatus,
}: UseWorkspaceLspClientEventsOptions): WorkspaceLspClientEventsController {
  const [messageRequests, setMessageRequests] = useState<LspShowMessageRequest[]>([]);
  const [progresses, setProgresses] = useState<LspWorkDoneProgressEvent[]>([]);
  const cancelledMessageIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const visibleRef = useRef(visible);
  const onStatusRef = useRef(onStatus);
  visibleRef.current = visible;
  onStatusRef.current = onStatus;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    cancelledMessageIdsRef.current.clear();
    setMessageRequests([]);
    setProgresses([]);
  }, [workspaceId]);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const install = async () => {
      try {
        const registrations = await Promise.all([
          listen<LspShowMessageRequest>(LSP_SHOW_MESSAGE_REQUEST_EVENT, (event) => {
            const request = normalizeMessageRequest(event.payload);
            if (
              !request
              || request.workspaceId !== workspaceId
              || cancelledMessageIdsRef.current.has(request.requestId)
            ) return;
            setMessageRequests((current) => (
              current.some((entry) => entry.requestId === request.requestId)
                ? current
                : [...current, request]
            ));
          }),
          listen<LspShowMessageCancelled>(LSP_SHOW_MESSAGE_CANCELLED_EVENT, (event) => {
            const payload = event.payload;
            if (!payload || payload.workspaceId !== workspaceId) return;
            cancelledMessageIdsRef.current.add(payload.requestId);
            setMessageRequests((current) => current.filter((entry) => entry.requestId !== payload.requestId));
          }),
          listen<LspShowMessageNotification>(LSP_SHOW_MESSAGE_EVENT, (event) => {
            const payload = event.payload;
            if (!payload || payload.workspaceId !== workspaceId || !visibleRef.current) return;
            onStatusRef.current(notificationText(payload));
          }),
          listen<LspWorkDoneProgressEvent>(LSP_WORK_DONE_PROGRESS_EVENT, (event) => {
            const progress = normalizeProgress(event.payload);
            if (!progress || progress.workspaceId !== workspaceId) return;
            const key = progressKey(progress);
            setProgresses((current) => {
              if (progress.kind === "end") {
                return current.filter((entry) => progressKey(entry) !== key);
              }
              const previous = current.find((entry) => progressKey(entry) === key);
              const next = { ...previous, ...progress, title: progress.title ?? previous?.title ?? null };
              return [
                ...current.filter((entry) => progressKey(entry) !== key),
                next,
              ].slice(-20);
            });
            if (visibleRef.current && progress.kind === "end" && (progress.message || progress.title)) {
              onStatusRef.current(
                `${progress.title ?? "Language server task"}${progress.message ? `: ${progress.message}` : " completed"}`,
              );
            }
          }),
        ]);
        if (disposed) {
          registrations.forEach((remove) => remove());
        } else {
          unlisten.push(...registrations);
        }
      } catch {
        // Browser/unit-test runtimes do not expose Tauri's event bridge. The
        // desktop bridge remains active; feature requests simply stay server-side.
      }
    };
    void install();
    return () => {
      disposed = true;
      unlisten.forEach((remove) => remove());
    };
  }, [workspaceId]);

  const resolveMessageRequest = useCallback((actionIndex: number | null) => {
    const request = messageRequests[0];
    if (!request) return;
    setMessageRequests((current) => current.filter((entry) => entry.requestId !== request.requestId));
    cancelledMessageIdsRef.current.add(request.requestId);
    void lspResolveShowMessageRequest(request.requestId, workspaceId, actionIndex).catch((error) => {
      if (mountedRef.current) {
        onStatusRef.current(error instanceof Error ? error.message : String(error));
      }
    });
  }, [messageRequests, workspaceId]);

  const cancelProgress = useCallback((progress: LspWorkDoneProgressEvent) => {
    setProgresses((current) => current.map((entry) => (
      progressKey(entry) === progressKey(progress) ? { ...entry, cancellable: false } : entry
    )));
    void lspCancelWorkDoneProgress(
      progress.workspaceId,
      progress.presetId,
      progress.rootUri,
      progress.token,
    ).catch((error) => {
      if (mountedRef.current) {
        onStatusRef.current(error instanceof Error ? error.message : String(error));
      }
    });
  }, []);

  return {
    messageRequest: messageRequests[0] ?? null,
    progresses,
    resolveMessageRequest,
    cancelProgress,
  };
}
