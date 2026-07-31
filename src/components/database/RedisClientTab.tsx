import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { AlertTriangle, Bot, ChevronDown, Files, KeyRound } from "lucide-react";
import type { DbConnectInfo } from "../../types";
import {
  dbConnect,
  dbDisconnect,
  dbSaveSavedQuery,
  redisDelKey,
  redisExec,
  type DbSavedQuery,
} from "../../lib/ipc";
import { RedisKeyBrowser } from "./RedisKeyBrowser";
import { RedisValuePanel } from "./RedisValuePanel";
import { RedisCli, type RedisCliHandle } from "./RedisCli";
import { RedisNewKeyDialog } from "./RedisNewKeyDialog";
import { useDbSessionFontSize } from "./useDbSessionFontSize";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import { useAppStore } from "../../stores/appStore";
import { TabActions } from "../tabbar/TabActionSlot";
import { FT_BUTTON_ACTIVE_OVERRIDE, FT_ICON_BUTTON_STYLE } from "../floating-toolbar/floatingToolbarStyles";
import { useT } from "../../lib/i18n";
import { QueryLibraryPanel } from "./QueryLibraryPanel";
import { registerQueryTab } from "../../lib/queryRegistry";

function createRuntimeDbSessionId(baseSessionId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${baseSessionId}::${suffix}`;
}

interface RedisClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
  /** Toggle the per-tab Claude Code chat drawer bound to this Redis session. */
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
}

export default function RedisClientTab({ tabId, info, visible, chatToggle }: RedisClientTabProps) {
  const sessionId = info.sessionId;
  const setTabDbConn = useAppStore((s) => s.setTabDbConn);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const t = useT();
  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dbIndex, setDbIndex] = useState<number>(info.dbIndex ?? 0);
  const [reloadToken, setReloadToken] = useState(0);
  const [showNewKey, setShowNewKey] = useState(false);
  const [cliCollapsed, setCliCollapsed] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"keys" | "queries">("keys");
  const [commandDraft, setCommandDraft] = useState("");
  const [linkedQuery, setLinkedQuery] = useState<DbSavedQuery | null>(null);
  const queryTriggerRef = useRef<(() => void) | null>(null);
  const cliRef = useRef<RedisCliHandle | null>(null);
  const commandDraftRef = useRef("");
  const linkedQueryRef = useRef<DbSavedQuery | null>(null);
  const linkedSaveInFlightRef = useRef<Promise<void> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { fontSize: dbFontSize } = useDbSessionFontSize(visible, rootRef);
  const dbFontStyle = useMemo(
    () => ({
      "--taomni-db-font-size": `${dbFontSize}px`,
      "--taomni-db-font-size-sm": `${Math.max(10, dbFontSize - 2)}px`,
    }) as CSSProperties,
    [dbFontSize],
  );

  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeDbSessionId(sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    void dbConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void dbDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
        // Phase 6 — publish the live connection id for the CC Redis MCP.
        setTabDbConn(tabId, runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void dbDisconnect(runtimeSessionId).catch(() => undefined);
      setTabDbConn(tabId, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  const updateCommandDraft = useCallback((value: string) => {
    commandDraftRef.current = value;
    setCommandDraft(value);
  }, []);

  const updateLinkedQuery = useCallback((query: DbSavedQuery | null) => {
    linkedQueryRef.current = query;
    setLinkedQuery(query);
  }, []);

  const flushLinkedQuery = useCallback(async () => {
    if (linkedSaveInFlightRef.current) return linkedSaveInFlightRef.current;
    const query = linkedQueryRef.current;
    const content = commandDraftRef.current;
    if (!query || query.content === content) return;
    const save = dbSaveSavedQuery({ ...query, content, updatedAt: Date.now() })
      .then((saved) => {
        if (linkedQueryRef.current?.id === saved.id) updateLinkedQuery(saved);
      })
      .catch((error) => {
        setStatusMessage(`Redis saved query auto-save failed: ${String(error)}`);
      })
      .finally(() => {
        if (linkedSaveInFlightRef.current === save) linkedSaveInFlightRef.current = null;
      });
    linkedSaveInFlightRef.current = save;
    return save;
  }, [setStatusMessage, updateLinkedQuery]);

  useEffect(() => {
    if (!linkedQuery || linkedQuery.content === commandDraft) return;
    const timer = setTimeout(() => void flushLinkedQuery(), 2000);
    return () => clearTimeout(timer);
  }, [commandDraft, flushLinkedQuery, linkedQuery]);

  useEffect(() => () => {
    void flushLinkedQuery();
  }, [flushLinkedQuery]);

  useEffect(() => registerQueryTab({
    tabId,
    title: `Redis ${info.host}:${info.port}`,
    engine: "Redis",
    insertQuery: (command, options) => {
      setCliCollapsed(false);
      updateLinkedQuery(null);
      updateCommandDraft(command);
      if (options?.run) void cliRef.current?.runCommand(command);
    },
    appendEchoSql: (command) => {
      setCliCollapsed(false);
      updateLinkedQuery(null);
      const current = commandDraftRef.current;
      updateCommandDraft(`${current}${current.trim() ? "\n" : ""}${command}`);
    },
    flushWorkspace: flushLinkedQuery,
  }), [flushLinkedQuery, info.host, info.port, tabId, updateCommandDraft, updateLinkedQuery]);

  const openQuerySave = useCallback(() => {
    setLeftPanelTab("queries");
    setTimeout(() => queryTriggerRef.current?.(), 0);
  }, []);

  const switchDbIndex = async (idx: number) => {
    if (!connectionSessionId) return;
    try {
      await redisExec(connectionSessionId, `SELECT ${idx}`);
      setDbIndex(idx);
      setSelectedKey(null);
      updateLinkedQuery(null);
      reload();
    } catch {
      /* surfaced by the CLI on the next command */
    }
  };

  return (
    <div ref={rootRef} className="h-full w-full flex flex-col" style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
      {chatToggle && (
        <TabActions active={visible}>
          <button
            type="button"
            data-testid="redis-chat-toggle"
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            style={{
              ...FT_ICON_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
          </button>
        </TabActions>
      )}
      {connError && (
        <div
          className="h-7 shrink-0 px-2 flex items-center gap-2 text-[11px] border-b"
          style={{ color: "#d9534f", borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          title={connError}
          data-testid="redis-connection-error-banner"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold">Connection failed.</span>
          <span className="truncate text-[var(--taomni-text-muted)]">The Query Library remains available. {connError}</span>
        </div>
      )}
      {/* Toolbar: DB index switcher */}
      <div
        className="h-7 shrink-0 flex items-center gap-2 px-2 text-[11px]"
        style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
      >
        <span className="font-semibold" style={{ color: "var(--taomni-accent)" }}>
          {info.host}:{info.port}
        </span>
        <span className="text-[var(--taomni-text-muted)]">DB</span>
        <div className="relative inline-flex items-center">
          <select
            className="taomni-input pr-5 appearance-none"
            style={{ height: 20, paddingTop: 0, paddingBottom: 0 }}
            value={dbIndex}
            aria-label="Redis DB index"
            onChange={(e) => void switchDbIndex(Number(e.target.value))}
          >
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
          <ChevronDown className="w-3 h-3 absolute right-1 pointer-events-none text-[var(--taomni-text-muted)]" />
        </div>
      </div>

      <PanelGroup orientation="vertical" className="flex-1 min-h-0">
        <Panel defaultSize={`${cliCollapsed ? 92 : 70}%`} minSize="30%">
          <PanelGroup
            orientation="horizontal"
            id="redis-client"
            defaultLayout={loadResizableLayout("redis-client", ["keys", "value"])}
            onLayoutChanged={saveResizableLayout("redis-client")}
            className="h-full"
          >
            <Panel id="keys" defaultSize="32%" minSize="18%" maxSize="55%">
              <div className="h-full flex flex-col" style={{ borderRight: "1px solid var(--taomni-divider)" }}>
                <div className="h-7 shrink-0 flex border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
                  <button
                    type="button"
                    className="flex-1 text-[11px] font-semibold inline-flex items-center justify-center gap-1"
                    style={{ color: leftPanelTab === "keys" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
                    onClick={() => setLeftPanelTab("keys")}
                  >
                    <KeyRound className="w-3.5 h-3.5" /> Keys
                  </button>
                  <button
                    type="button"
                    className="flex-1 text-[11px] font-semibold inline-flex items-center justify-center gap-1 border-l border-[var(--taomni-divider)]"
                    style={{ color: leftPanelTab === "queries" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
                    onClick={() => setLeftPanelTab("queries")}
                  >
                    <Files className="w-3.5 h-3.5" /> Queries
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  {leftPanelTab === "keys" ? (
                    connectionSessionId && (
                      <RedisKeyBrowser
                        sessionId={connectionSessionId}
                        separator=":"
                        reloadToken={reloadToken}
                        selectedKey={selectedKey}
                        onSelectKey={setSelectedKey}
                        onAddKey={() => setShowNewKey(true)}
                        onDeleteKey={async (key) => {
                          const confirmed = await confirmAppDialog({
                            message: `Delete key "${key}"?`,
                            confirmLabel: "Delete",
                            danger: true,
                          });
                          if (!confirmed) return;
                          if (!connectionSessionId) return;
                          await redisDelKey(connectionSessionId, key).catch(() => undefined);
                          if (selectedKey === key) setSelectedKey(null);
                          reload();
                        }}
                        onSetTtl={async (key) => {
                          const input = await promptAppDialog({
                            title: "Set TTL",
                            label: `Set TTL (seconds) for "${key}" (-1 = persist):`,
                            initialValue: "60",
                            allowEmpty: true,
                          });
                          if (input === null) return;
                          const secs = parseInt(input, 10);
                          if (Number.isNaN(secs)) return;
                          if (!connectionSessionId) return;
                          if (secs === -1) await redisExec(connectionSessionId, `PERSIST ${key}`).catch(() => undefined);
                          else await redisExec(connectionSessionId, `EXPIRE ${key} ${secs}`).catch(() => undefined);
                          reload();
                        }}
                      />
                    )
                  ) : (
                    <QueryLibraryPanel
                      engine="Redis"
                      connectionId={info.workspaceSessionId ?? info.sessionId}
                      databaseName={String(dbIndex)}
                      activeContent={commandDraft}
                      contentLabel="Redis command"
                      onOpenQuery={(query) => {
                        setCliCollapsed(false);
                        updateCommandDraft(query.content);
                        updateLinkedQuery(query);
                      }}
                      onRunQuery={(query) => {
                        setCliCollapsed(false);
                        updateCommandDraft("");
                        void cliRef.current?.runCommand(query.content);
                      }}
                      onSavedQuery={(query, created) => {
                        if (created || linkedQueryRef.current?.id === query.id) {
                          updateLinkedQuery(query);
                        }
                      }}
                      onAddTriggerRef={queryTriggerRef}
                    />
                  )}
                </div>
              </div>
            </Panel>
            <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
            <Panel id="value">
              <RedisValuePanel
                sessionId={connectionSessionId ?? ""}
                redisKey={selectedKey}
                onDeleted={() => {
                  setSelectedKey(null);
                  reload();
                }}
                onChanged={reload}
              />
            </Panel>
          </PanelGroup>
        </Panel>
        {!cliCollapsed && (
          <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize" />
        )}
        <Panel
          defaultSize={`${cliCollapsed ? 8 : 30}%`}
          minSize={`${cliCollapsed ? 4 : 12}%`}
          maxSize={`${cliCollapsed ? 8 : 70}%`}
        >
          <RedisCli
            ref={cliRef}
            sessionId={connectionSessionId ?? ""}
            collapsed={cliCollapsed}
            onToggleCollapse={() => setCliCollapsed((v) => !v)}
            input={commandDraft}
            onInputChange={updateCommandDraft}
            onSaveQuery={openQuerySave}
          />
        </Panel>
      </PanelGroup>

      {showNewKey && (
        <RedisNewKeyDialog
          sessionId={connectionSessionId ?? ""}
          onClose={() => setShowNewKey(false)}
          onCreated={(key) => {
            setShowNewKey(false);
            setSelectedKey(key);
            reload();
          }}
        />
      )}
    </div>
  );
}
