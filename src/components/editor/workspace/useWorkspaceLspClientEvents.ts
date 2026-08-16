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

/**
 * jdtls reports its own "Publish Diagnostics" / "Validate documents" jobs on
 * every validation cycle, so a single keystroke can produce several
 * begin/report/end triples. Publishing each one straight into React state
 * re-renders the whole workspace shell per event and makes the status bar
 * flicker between task names. Fold them into one trailing update instead: work
 * that starts and finishes inside the window never reaches the UI at all.
 */
const PROGRESS_FLUSH_INTERVAL_MS = 150;

function progressKey(event: Pick<LspWorkDoneProgressEvent, "presetId" | "rootUri" | "token">): string {
  return `${event.presetId}\u0000${event.rootUri}\u0000${typeof event.token}:${String(event.token)}`;
}

function sameProgress(a: LspWorkDoneProgressEvent, b: LspWorkDoneProgressEvent): boolean {
  return a.kind === b.kind
    && a.title === b.title
    && a.message === b.message
    && a.percentage === b.percentage
    && a.cancellable === b.cancellable
    && progressKey(a) === progressKey(b);
}

function sameProgressList(
  previous: readonly LspWorkDoneProgressEvent[],
  next: readonly LspWorkDoneProgressEvent[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((entry, index) => sameProgress(entry, next[index]));
}

function reduceProgress(
  current: readonly LspWorkDoneProgressEvent[],
  progress: LspWorkDoneProgressEvent,
): LspWorkDoneProgressEvent[] {
  const key = progressKey(progress);
  if (progress.kind === "end") {
    return current.filter((entry) => progressKey(entry) !== key);
  }
  const previous = current.find((entry) => progressKey(entry) === key);
  const next = { ...previous, ...progress, title: progress.title ?? previous?.title ?? null };
  return [...current.filter((entry) => progressKey(entry) !== key), next].slice(-20);
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
  // Pending (authoritative) progress list. React state trails it by at most one
  // flush window so event bursts cost one render instead of one render each.
  const pendingProgressesRef = useRef<LspWorkDoneProgressEvent[]>([]);
  const publishedProgressesRef = useRef<LspWorkDoneProgressEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStatusTextRef = useRef<string | null>(null);

  const flushProgresses = useCallback(() => {
    flushTimerRef.current = null;
    if (!mountedRef.current) return;
    const next = pendingProgressesRef.current;
    if (sameProgressList(publishedProgressesRef.current, next)) return;
    publishedProgressesRef.current = next;
    setProgresses(next);
  }, []);

  const scheduleProgressFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(flushProgresses, PROGRESS_FLUSH_INTERVAL_MS);
  }, [flushProgresses]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    cancelledMessageIdsRef.current.clear();
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingProgressesRef.current = [];
    publishedProgressesRef.current = [];
    lastStatusTextRef.current = null;
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
            // Another writer took over the status line, so the progress dedupe
            // key no longer describes what is on screen.
            lastStatusTextRef.current = null;
            onStatusRef.current(notificationText(payload));
          }),
          listen<LspWorkDoneProgressEvent>(LSP_WORK_DONE_PROGRESS_EVENT, (event) => {
            const progress = normalizeProgress(event.payload);
            if (!progress || progress.workspaceId !== workspaceId) return;
            const key = progressKey(progress);
            // Only tasks that actually surfaced in the UI are worth announcing.
            // Per-keystroke validations begin and end inside a single flush
            // window, so they never reach `publishedProgressesRef` and no longer
            // churn the shared status bar.
            const wasPublished = publishedProgressesRef.current.some((entry) => progressKey(entry) === key);
            pendingProgressesRef.current = reduceProgress(pendingProgressesRef.current, progress);
            scheduleProgressFlush();
            if (
              visibleRef.current
              && wasPublished
              && progress.kind === "end"
              && (progress.message || progress.title)
            ) {
              const text = `${progress.title ?? "Language server task"}${progress.message ? `: ${progress.message}` : " completed"}`;
              if (text !== lastStatusTextRef.current) {
                lastStatusTextRef.current = text;
                onStatusRef.current(text);
              }
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
  }, [scheduleProgressFlush, workspaceId]);

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
    // User-initiated, so publish straight away rather than waiting for a flush.
    const disable = (entries: readonly LspWorkDoneProgressEvent[]) => entries.map((entry) => (
      progressKey(entry) === progressKey(progress) ? { ...entry, cancellable: false } : entry
    ));
    pendingProgressesRef.current = disable(pendingProgressesRef.current);
    publishedProgressesRef.current = disable(publishedProgressesRef.current);
    setProgresses(publishedProgressesRef.current);
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
