import { useCallback, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, CirclePlay, Pause, RotateCcw } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import type { DebugStackFrame } from "../../dapDebugModel";
import { useContextMenu, type MenuItem } from "../../../../ContextMenu";
import { Empty } from "./debugPanelShared";
import { DebugSessionControls, DebugStepControls } from "./DebugToolbar";

export interface DebugFramesPaneProps {
  debug: CodeDebugSession;
  activeRunning: boolean;
  stopped: boolean;
  onOpenFrame: (frame: DebugStackFrame) => void;
}

export function DebugFramesPane({
  debug,
  activeRunning,
  stopped,
  onOpenFrame,
}: DebugFramesPaneProps) {
  const { state } = debug;
  const canRestartFrame = debug.capabilities.supportsRestartFrame === true;
  const frameMenu = useContextMenu();
  const [expandedThreads, setExpandedThreads] = useState<Record<number, boolean>>({});

  const handleFrameContextMenu = useCallback(
    (e: MouseEvent, frame: DebugStackFrame) => {
      e.preventDefault();
      const items: MenuItem[] = [];
      if (frame.path || frame.sourceReference > 0) {
        items.push({
          label: "Jump to Source",
          testId: "debug-frame-menu-jump-source",
          onClick: () => onOpenFrame(frame),
        });
      }
      if (canRestartFrame && stopped) {
        items.push({
          label: "Drop Frame / Restart from Here",
          testId: "debug-frame-menu-restart-frame",
          icon: <RotateCcw className="w-3.5 h-3.5" />,
          onClick: () => debug.restartFrame(frame.id),
        });
      }
      items.push({
        label: "Copy Frame Name",
        testId: "debug-frame-menu-copy-name",
        onClick: () => {
          void navigator.clipboard.writeText(frame.name);
        },
      });
      items.push({
        label: "Copy Call Stack",
        testId: "debug-frame-menu-copy-stack",
        onClick: () => {
          const text =
            state?.frames
              .map(
                (f) =>
                  `${f.name} (${f.path?.split(/[\\/]/).pop() ?? f.sourceName ?? "unknown"}:${f.line})`,
              )
              .join("\n") ?? frame.name;
          void navigator.clipboard.writeText(text);
        },
      });
      frameMenu.show(e, items);
    },
    [canRestartFrame, stopped, onOpenFrame, debug, state?.frames, frameMenu],
  );

  const renderFrameItem = (frame: DebugStackFrame) => {
    const isSelected = frame.id === state?.selectedFrameId;
    return (
      <div
        key={frame.id}
        className={`group flex items-center hover:bg-[var(--taomni-hover-bg)] ${
          isSelected ? "bg-[var(--taomni-code-selection-match-bg)]/40 font-medium" : ""
        }`}
      >
        <button
          type="button"
          data-testid={`debug-frame-${frame.id}`}
          className="min-w-0 flex-1 flex items-center gap-2 px-2 py-0.5 text-left select-none"
          onClick={() => {
            debug.selectFrame(frame.id);
            if (frame.path || frame.sourceReference > 0) onOpenFrame(frame);
          }}
          onContextMenu={(e) => handleFrameContextMenu(e, frame)}
        >
          <span
            className={`truncate ${
              frame.path || frame.sourceReference > 0
                ? "text-[var(--taomni-text)]"
                : "text-[var(--taomni-text-muted)]"
            }`}
          >
            {frame.name}
          </span>
          {(frame.path || frame.sourceName) && (
            <span className="ml-auto shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
              {(frame.path?.split(/[\\/]/).pop()) ?? frame.sourceName}:{frame.line}
            </span>
          )}
        </button>
        {canRestartFrame && stopped && (
          <button
            type="button"
            data-testid={`debug-restart-frame-${frame.id}`}
            className="shrink-0 px-1 opacity-0 group-hover:opacity-100 hover:text-emerald-500"
            onClick={() => debug.restartFrame(frame.id)}
            title="Restart frame (re-enter from its start)"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      data-testid="debug-frames-pane"
      className="h-full min-h-0 min-w-0 flex flex-row bg-[var(--taomni-code-bg)] text-[11px]"
    >
      <DebugSessionControls
        debug={debug}
        activeRunning={activeRunning}
        stopped={stopped}
      />

      <div className="flex-1 min-w-0 flex flex-col h-full">
        {/* Multi-session selector */}
        {debug.sessions.length > 1 && (
          <div className="h-7 shrink-0 flex items-center gap-1.5 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/30 px-2">
            <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">Session:</span>
            <select
              data-testid="debug-active-session"
              aria-label="Debug session"
              title="Select compound debug session"
              value={debug.activeSessionId ?? debug.sessions[0].id}
              onChange={(event) => debug.selectSession(event.target.value)}
              className="h-5 min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
            >
              {debug.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.label} [{session.status}
                  {session.stoppedReason ? `: ${session.stoppedReason}` : ""}]
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Exception banner */}
        {state?.exceptionInfo && (
          <div
            data-testid="debug-exception-info"
            className="border-b border-[var(--taomni-code-border)] bg-rose-500/10 px-2.5 py-1.5 shrink-0"
          >
            <div className="font-medium text-rose-600 dark:text-rose-400">
              {state.exceptionInfo.exceptionId}
            </div>
            {state.exceptionInfo.description && (
              <div className="text-[10px] text-rose-600/90 dark:text-rose-400/90">
                {state.exceptionInfo.description}
              </div>
            )}
            {state.exceptionInfo.details && (
              <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap font-mono text-[9px] text-[var(--taomni-text-muted)]">
                {state.exceptionInfo.details}
              </pre>
            )}
          </div>
        )}

        {/* Frames & Threads tree */}
        <div className="flex-1 min-h-0 overflow-auto py-1">
          {state && state.threads.length > 0 ? (
            <div className="space-y-0.5">
              {state.threads.map((thread) => {
                const isSelected = thread.id === (state.selectedThreadId ?? state.stoppedThreadId);
                const isStopped = thread.id === state.stoppedThreadId;
                const isExpanded = expandedThreads[thread.id] ?? (isSelected || state.threads.length === 1);
                return (
                  <div key={thread.id}>
                    <div
                      data-testid={`debug-thread-${thread.id}`}
                      className={`flex items-center gap-1.5 px-2 py-0.5 cursor-pointer select-none hover:bg-[var(--taomni-hover-bg)] ${
                        isSelected ? "bg-[var(--taomni-hover-bg)]" : ""
                      }`}
                      onClick={() => {
                        debug.selectThread(thread.id);
                      }}
                    >
                      <button
                        type="button"
                        aria-label={isExpanded ? `Collapse thread ${thread.name}` : `Expand thread ${thread.name}`}
                        className="shrink-0 p-0.5 text-[var(--taomni-text-muted)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedThreads((prev) => ({
                            ...prev,
                            [thread.id]: !isExpanded,
                          }));
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                      {isStopped ? (
                        <Pause className="h-3 w-3 shrink-0 text-amber-500" />
                      ) : (
                        <CirclePlay className="h-3 w-3 shrink-0 text-emerald-500" />
                      )}
                      <span className="truncate font-medium">{thread.name}</span>
                      {isStopped && (
                        <span className="ml-auto text-[10px] text-amber-500">stopped</span>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="pl-4 border-l border-[var(--taomni-code-border)]/40 ml-3 my-0.5">
                        {isSelected ? (
                          state.frames.length === 0 ? (
                            <Empty text={stopped ? "No frames" : "Running…"} />
                          ) : (
                            state.frames.map(renderFrameItem)
                          )
                        ) : (
                          <div
                            className="px-2 py-0.5 text-[10px] text-[var(--taomni-text-muted)] cursor-pointer italic"
                            onClick={() => debug.selectThread(thread.id)}
                          >
                            Click to inspect frames
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-0.5">
              {!state || state.frames.length === 0 ? (
                <Empty text={stopped ? "No frames" : "Running…"} />
              ) : (
                state.frames.map(renderFrameItem)
              )}
            </div>
          )}
        </div>

        {/* Step controls footer */}
        <DebugStepControls
          debug={debug}
          stopped={stopped}
          onShowExecutionPoint={() => {
            const frame = state?.frames.find((f) => f.id === state.selectedFrameId) ?? state?.frames[0];
            if (frame && (frame.path || frame.sourceReference > 0)) {
              onOpenFrame(frame);
            }
          }}
        />
      </div>

      {frameMenu.render}
    </div>
  );
}
