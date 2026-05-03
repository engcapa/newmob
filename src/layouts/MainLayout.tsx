import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { MenuBar } from "../components/menubar/MenuBar";
import { Ribbon, type RibbonCommand } from "../components/menubar/Ribbon";
import { QuickConnect } from "../components/quickconnect/QuickConnect";
import { Sidebar } from "../components/sidebar/Sidebar";
import { TabBar } from "../components/tabbar/TabBar";
import { StatusBar } from "../components/statusbar/StatusBar";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { SessionEditor } from "../components/session/SessionEditor";
import { AuthPrompt } from "../components/session/AuthPrompt";
import { SettingsPanel } from "../components/settings/SettingsPanel";
import { TunnelManager } from "../components/tunnel/TunnelManager";
import { FileBrowser } from "../components/filebrowser/FileBrowser";
import { SftpSidebar } from "../components/filebrowser/SftpSidebar";
import { isTauriRuntime } from "../lib/runtime";
import { openSftpWindow } from "../lib/sftp";
import { writeTerminal } from "../lib/ipc";
import { encodeBase64 } from "../lib/ipc";
import { parseSessionOptions } from "../lib/terminalProfile";
import {
  clearDetachedHandoff,
  detachedWindowUrl,
  writeDetachedHandoff,
} from "../components/filebrowser/SftpDetachedWindow";
import { FolderOpen } from "lucide-react";
import type { SftpTabInfo } from "../types";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import { WelcomePanel } from "../components/WelcomePanel";
import { parseQuickConnectInput } from "../lib/quickConnect";
import { exitApp, type SessionConfig } from "../lib/ipc";
import { getSessionTerminalProfile, type TerminalProfile } from "../lib/terminalProfile";
import type { LocalShellSelection } from "../types";

interface PendingAuth {
  session: SessionConfig;
}

export function MainLayout() {
  const {
    tabs,
    activeTabId,
    sidebarCollapsed,
    xServerEnabled,
    addTab,
    removeTab,
    setActiveTab,
    toggleSidebar,
    setSidebarCollapsed,
    toggleXServer,
    setStatusMessage,
  } = useAppStore();
  const { loadSessions, markConnected } = useSessionStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const tabsRef = useRef(tabs);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const lastSidebarSizeRef = useRef(22);
  const [showSessionEditor, setShowSessionEditor] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | undefined>();
  const [newSessionGroupPath, setNewSessionGroupPath] = useState<string | null>(null);
  const [newSessionInitialProto, setNewSessionInitialProto] = useState<string | undefined>();
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [attachedSidebars, setAttachedSidebars] = useState<Record<string, boolean>>({});
  const [terminalCwds, setTerminalCwds] = useState<Record<string, string>>({});

  const toggleAttachedSidebar = useCallback((tabId: string) => {
    setAttachedSidebars((prev) => ({ ...prev, [tabId]: !prev[tabId] }));
  }, []);

  const handleTerminalCwd = useCallback((tabId: string, cwd: string) => {
    setTerminalCwds((prev) => (prev[tabId] === cwd ? prev : { ...prev, [tabId]: cwd }));
    // Mirror the new cwd to any same-origin window (e.g. a detached SFTP
    // popup) so its FileBrowser can follow OSC 7 even though only the
    // main window hosts the terminal. We publish under both the raw tab
    // id AND the `attached-${tabId}` key, because a detached window that
    // was split off from an attached SSH sidebar uses the prefixed id as
    // its SFTP session id and would otherwise never see these updates.
    void import("../lib/sftpSync").then(({ broadcastCwdHint }) => {
      broadcastCwdHint(tabId, cwd);
      broadcastCwdHint(`attached-${tabId}`, cwd);
    });
  }, []);

  const openDetachedSftp = useCallback((params: SftpTabInfo, title: string) => {
    // Use a DIFFERENT session id for the detached window so its backend
    // SFTP channel is independent from the sidebar's. Without this, the
    // popup and the sidebar share one `Arc<Mutex<SftpSession>>` and any
    // long transfer in one window stalls clicks/listings in the other.
    // The suffix is stable per parent so re-clicking "Detach" focuses the
    // existing popup instead of opening a second one.
    const detachedSessionId = `${params.sessionId}__detached`;
    writeDetachedHandoff({
      ...params,
      sessionId: detachedSessionId,
      parentSessionId: params.sessionId,
      title,
    });
    if (isTauriRuntime()) {
      // Native: open a real OS window via the Rust command. The handoff
      // payload was just written to localStorage above so the new window
      // can read it on mount. If launching the OS window fails we must
      // wipe the handoff immediately — otherwise the credentials sit on
      // disk for the rest of the run with no one waiting to consume them.
      void openSftpWindow(detachedSessionId, title).catch((err) => {
        clearDetachedHandoff(detachedSessionId);
        setStatusMessage(`Could not open SFTP window: ${err instanceof Error ? err.message : err}`);
      });
      return;
    }
    const url = detachedWindowUrl(detachedSessionId);
    const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
    const handle = window.open(url, `newmob_sftp_${detachedSessionId}`, features);
    if (!handle) {
      // Pop-up blocked — clean up the credential blob right away so it
      // doesn't linger in localStorage waiting for a window that never
      // arrives.
      clearDetachedHandoff(detachedSessionId);
      setStatusMessage("Browser blocked the SFTP window. Allow pop-ups for this site.");
    }
  }, [setStatusMessage]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;

    const frame = requestAnimationFrame(() => {
      if (sidebarCollapsed) {
        panel.collapse();
      } else {
        panel.resize(lastSidebarSizeRef.current);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [sidebarCollapsed]);

  const confirmExitWithOpenTabs = useCallback(() => {
    const currentTabs = tabsRef.current;
    const terminalCount = currentTabs.filter((tab) => tab.type === "terminal" && tab.closable).length;
    const tabCount = currentTabs.filter((tab) => tab.closable).length;
    if (tabCount === 0) return true;

    return window.confirm(
      `There ${tabCount === 1 ? "is" : "are"} ${tabCount} open tab${tabCount === 1 ? "" : "s"}${terminalCount > 0 ? `, including ${terminalCount} terminal session${terminalCount === 1 ? "" : "s"}` : ""}. Exit NewMob and close them?`,
    );
  }, []);

  const requestAppExit = useCallback(() => {
    if (confirmExitWithOpenTabs()) {
      void exitApp();
    }
  }, [confirmExitWithOpenTabs]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow.onCloseRequested(async (event) => {
      if (!confirmExitWithOpenTabs()) {
        event.preventDefault();
        return;
      }
      await exitApp().catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [confirmExitWithOpenTabs]);

  const handleNewSession = useCallback((groupPath: string | null = null) => {
    setEditingSession(undefined);
    setNewSessionGroupPath(groupPath);
    setNewSessionInitialProto(undefined);
    setShowSessionEditor(true);
  }, []);

  const handleNewSftpSession = useCallback(() => {
    setEditingSession(undefined);
    setNewSessionGroupPath(null);
    setNewSessionInitialProto("SFTP");
    setShowSessionEditor(true);
  }, []);

  const openLocalTab = useCallback((
    title = "Local terminal",
    sessionId?: string,
    terminalProfile?: TerminalProfile,
    localShell?: LocalShellSelection,
  ) => {
    const id = `local-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title,
      sessionId,
      localShell,
      terminalProfile,
      closable: true,
    });
    if (sessionId) void markConnected(sessionId);
  }, [addTab, markConnected]);

  const handleEditSession = useCallback((session: SessionConfig) => {
    setEditingSession(session);
    setNewSessionGroupPath(null);
    setShowSessionEditor(true);
  }, []);

  const openSftpTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const tabId = `sftp-${session.id}-${Date.now()}`;
    addTab({
      id: tabId,
      type: "sftp",
      title: `${session.name || `${session.username ?? "user"}@${session.host}`} (SFTP)`,
      sessionId: session.id,
      closable: true,
      sftp: {
        sessionId: tabId,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        attachedToTerminal: false,
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const handleConnectSession = useCallback((session: SessionConfig) => {
    const resolveAuth = (): { method: string; data: string | null } => {
      const method = typeof session.auth_method === "string"
        ? session.auth_method
        : "PrivateKey";
      const data = typeof session.auth_method === "object" && "PrivateKey" in session.auth_method
        ? session.auth_method.PrivateKey.key_path
        : null;
      return { method, data };
    };

    if (session.session_type === "SSH") {
      const { method, data } = resolveAuth();
      if (method === "Password") {
        setPendingAuth({ session });
      } else {
        openSshTab(session, method, data);
      }
    } else if (session.session_type === "SFTP") {
      const { method, data } = resolveAuth();
      if (method === "Password") {
        setPendingAuth({ session });
      } else {
        openSftpTab(session, method, data);
      }
    } else if (session.session_type === "LocalShell") {
      openLocalTab(session.name || "Local terminal", session.id, getSessionTerminalProfile(session.options_json));
    } else {
      openUnsupportedTab(session);
      void markConnected(session.id);
    }
  }, [markConnected, openLocalTab, openSftpTab]);

  const openSshTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const id = `ssh-${session.id}-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: session.name || `${session.username}@${session.host}`,
      sessionId: session.id,
      closable: true,
      ssh: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        optionsJson: session.options_json,
        // Default ON for backwards compatibility — only suppress when the
        // user explicitly disables OSC 7 auto-injection in the editor.
        osc7AutoInject:
          parseSessionOptions(session.options_json).osc7AutoInject !== false,
      },
      terminalProfile: getSessionTerminalProfile(session.options_json),
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openUnsupportedTab = useCallback((session: SessionConfig) => {
    const id = `${session.session_type.toLowerCase()}-${session.id}-${Date.now()}`;
    const kind = ["SFTP", "RDP", "VNC"].includes(session.session_type)
      ? session.session_type.toLowerCase()
      : "placeholder";
    addTab({
      id,
      type: kind as "sftp" | "rdp" | "vnc" | "placeholder",
      title: session.name || session.host || session.session_type,
      sessionId: session.id,
      closable: true,
      message: `${session.session_type} connection UI is present, but its backend is outside Phase 1-2. Session data is saved and can be edited from the sidebar.`,
    });
  }, [addTab]);

  const handleAuthSubmit = useCallback((password: string) => {
    if (!pendingAuth) return;
    if (pendingAuth.session.session_type === "SFTP") {
      openSftpTab(pendingAuth.session, "Password", password);
    } else {
      openSshTab(pendingAuth.session, "Password", password);
    }
    setPendingAuth(null);
  }, [pendingAuth, openSftpTab, openSshTab]);

  const handleQuickConnect = useCallback((value: string) => {
    try {
      const parsed = parseQuickConnectInput(value);
      const session = parsed.config;
      if (session.session_type === "LocalShell") {
        openLocalTab(session.name);
      } else if (session.session_type === "SSH" || session.session_type === "SFTP") {
        if (session.auth_method === "Password") {
          setPendingAuth({ session });
        } else {
          const authMethod = typeof session.auth_method === "string" ? session.auth_method : "PrivateKey";
          if (session.session_type === "SFTP") {
            openSftpTab(session, authMethod, parsed.authData);
          } else {
            openSshTab(session, authMethod, parsed.authData);
          }
        }
      } else {
        openUnsupportedTab(session);
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  }, [openLocalTab, openSftpTab, openSshTab, openUnsupportedTab, setStatusMessage]);

  const openPlaceholderTab = useCallback((title: string, message: string) => {
    addTab({
      id: `placeholder-${Date.now()}`,
      type: "placeholder",
      title,
      closable: true,
      message,
    });
  }, [addTab]);

  const openSettingsTab = useCallback(() => {
    const existing = tabsRef.current.find((tab) => tab.type === "settings");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }

    addTab({
      id: "settings",
      type: "settings",
      title: "Settings",
      closable: true,
    });
  }, [addTab, setActiveTab]);

  const handleCommand = useCallback((command: RibbonCommand | "close-active" | "reload-sessions") => {
    switch (command) {
      case "new-session":
        handleNewSession();
        break;
      case "new-sftp":
        handleNewSftpSession();
        break;
      case "new-terminal":
        openLocalTab();
        break;
      case "close-active":
        if (activeTab?.closable) removeTab(activeTab.id);
        break;
      case "reload-sessions":
        void loadSessions();
        setStatusMessage("Sessions reloaded");
        break;
      case "toggle-xserver":
        toggleXServer();
        break;
      case "view":
        toggleSidebar();
        break;
      case "servers":
      case "sessions":
        setSidebarCollapsed(false);
        break;
      case "split":
      case "multiexec":
        setStatusMessage(`${command === "split" ? "Split view" : "MultiExec"} is not active in this phase`);
        break;
      case "exit":
        requestAppExit();
        break;
      case "tunneling": {
        const existing = tabsRef.current.find((tab) => tab.type === "nettools");
        if (existing) {
          setActiveTab(existing.id);
        } else {
          addTab({
            id: "nettools-tunnels",
            type: "nettools",
            title: "SSH tunnels",
            closable: true,
          });
        }
        break;
      }
      case "tools":
        openPlaceholderTab("Network tools", "Additional network utilities will be added in a later phase.");
        break;
      case "packages":
        openPlaceholderTab("Packages", "Package management is not part of Phase 1-2.");
        break;
      case "settings":
        openSettingsTab();
        break;
      case "games":
      case "macros":
        openPlaceholderTab(command === "games" ? "Games" : "Macros", "This module is intentionally inactive in the MVP.");
        break;
      case "help":
        setActiveTab("welcome");
        break;
      default:
        setStatusMessage("Command is not available in this phase");
    }
  }, [
    activeTab,
    handleNewSession,
    handleNewSftpSession,
    loadSessions,
    openLocalTab,
    openPlaceholderTab,
    openSettingsTab,
    removeTab,
    requestAppExit,
    setActiveTab,
    setStatusMessage,
    setSidebarCollapsed,
    toggleSidebar,
    toggleXServer,
  ]);

  const terminalTabs = tabs.filter((t) => t.type === "terminal");
  const sftpTabs = tabs.filter((t) => t.type === "sftp" && t.sftp);

  return (
    <div
      className="w-full h-full flex flex-col"
      style={{ background: "var(--moba-chrome-bg)" }}
    >
      <MenuBar activeTabClosable={!!activeTab?.closable} onCommand={handleCommand} />
      <Ribbon xServerEnabled={xServerEnabled} onCommand={handleCommand} />
      <QuickConnect
        onConnectInput={handleQuickConnect}
        onConnectSession={handleConnectSession}
        onHome={() => setActiveTab("welcome")}
      />

      <div className="flex-1 flex min-h-0">
        <PanelGroup direction="horizontal" autoSaveId="main-layout">
          <Panel
            ref={sidebarPanelRef}
            defaultSize={22}
            minSize={15}
            maxSize={40}
            collapsible
            collapsedSize={2}
            onCollapse={() => setSidebarCollapsed(true)}
            onExpand={() => setSidebarCollapsed(false)}
            onResize={(size) => {
              if (size > 2) {
                lastSidebarSizeRef.current = size;
              }
            }}
          >
            <div className="h-full overflow-hidden">
              <Sidebar
                compact={sidebarCollapsed}
                onNewSession={handleNewSession}
                onNewSftpSession={handleNewSftpSession}
                onEditSession={handleEditSession}
                onConnectSession={handleConnectSession}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />

          <Panel>
            <div className="h-full flex flex-col min-w-0">
              <TabBar />
              <div className="flex-1 min-h-0 overflow-hidden relative">
                {/* Welcome panel */}
                {(activeTab?.type === "welcome" || !activeTab) && (
                  <WelcomePanel
                    onStartLocalTerminal={(localShell) => openLocalTab(localShell?.name ?? "Local terminal", undefined, undefined, localShell)}
                    onNewSession={handleNewSession}
                  />
                )}

                {/* All terminal tabs stay mounted, hidden via display.
                    Each SSH terminal also hosts an attached SFTP sidebar
                    that the user can toggle on the top-right corner. */}
                {terminalTabs.map((tab) => {
                  const isActive = activeTabId === tab.id;
                  const sidebarOpen = !!attachedSidebars[tab.id] && !!tab.ssh;
                  const terminalNode = (
                    <div className="h-full w-full relative">
                      <TerminalPanel
                        tabId={tab.id}
                        tabTitle={tab.title}
                        ssh={tab.ssh}
                        localShell={tab.localShell}
                        terminalProfile={tab.terminalProfile}
                        visible={isActive}
                        onCwdChange={tab.ssh ? (cwd) => handleTerminalCwd(tab.id, cwd) : undefined}
                      />
                      {tab.ssh && (
                        <button
                          type="button"
                          data-testid="attached-sftp-toggle"
                          className="absolute top-1 right-2 z-30 px-2 py-0.5 text-[11px] rounded shadow flex items-center gap-1"
                          style={{
                            background: sidebarOpen ? "var(--moba-accent)" : "var(--moba-quick-bg)",
                            color: sidebarOpen ? "#fff" : "var(--moba-text)",
                            border: "1px solid var(--moba-divider)",
                          }}
                          title={sidebarOpen ? "Hide SFTP browser" : "Open SFTP browser"}
                          onClick={() => toggleAttachedSidebar(tab.id)}
                        >
                          <FolderOpen className="w-3 h-3" />
                          SFTP
                        </button>
                      )}
                    </div>
                  );
                  const sftpSidebarNode = sidebarOpen && tab.ssh ? (
                    <SftpSidebar
                      sessionId={`attached-${tab.id}`}
                      host={tab.ssh.host}
                      port={tab.ssh.port}
                      username={tab.ssh.username}
                      authMethod={tab.ssh.authMethod}
                      authData={tab.ssh.authData}
                      cwdHint={terminalCwds[tab.id] ?? null}
                      title={`SFTP — ${tab.ssh.username}@${tab.ssh.host}`}
                      onClose={() => toggleAttachedSidebar(tab.id)}
                      onOpenTerminalHere={(p) => {
                        const escaped = p.replace(/'/g, "'\\''");
                        void writeTerminal(tab.id, encodeBase64(`cd '${escaped}'\n`));
                      }}
                      onDetach={() =>
                        openDetachedSftp(
                          {
                            sessionId: `attached-${tab.id}`,
                            host: tab.ssh!.host,
                            port: tab.ssh!.port,
                            username: tab.ssh!.username,
                            authMethod: tab.ssh!.authMethod,
                            authData: tab.ssh!.authData,
                            initialPath: terminalCwds[tab.id],
                            attachedToTerminal: true,
                          },
                          `${tab.title} — SFTP`,
                        )
                      }
                    />
                  ) : null;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      {/* Always render the PanelGroup so the terminal Panel
                          stays mounted across sidebar open/close. Without
                          this, toggling the sidebar would unmount and rebuild
                          the xterm instance, dropping scrollback/state. */}
                      <PanelGroup
                        direction="horizontal"
                        autoSaveId={`terminal-sftp-${tab.id}`}
                      >
                        <Panel defaultSize={62} minSize={25} className="min-w-0">
                          <div className="h-full">{terminalNode}</div>
                        </Panel>
                        {sftpSidebarNode && (
                          <>
                            <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />
                            <Panel
                              defaultSize={38}
                              minSize={20}
                              maxSize={70}
                              className="min-w-0"
                            >
                              <div
                                className="h-full"
                                style={{
                                  borderLeft: "1px solid var(--moba-divider)",
                                  background: "var(--moba-bg)",
                                }}
                              >
                                {sftpSidebarNode}
                              </div>
                            </Panel>
                          </>
                        )}
                      </PanelGroup>
                    </div>
                  );
                })}

                {/* SFTP standalone tabs stay mounted so transfers can finish
                    even when the user switches to another tab. */}
                {sftpTabs.map((tab) => {
                  if (!tab.sftp) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <FileBrowser
                        sessionId={tab.sftp.sessionId}
                        host={tab.sftp.host}
                        port={tab.sftp.port}
                        username={tab.sftp.username}
                        authMethod={tab.sftp.authMethod}
                        authData={tab.sftp.authData}
                        initialPath={tab.sftp.initialPath}
                        detachable
                        onDetach={() => openDetachedSftp(tab.sftp!, tab.title)}
                      />
                    </div>
                  );
                })}

                {activeTab?.type === "settings" && <SettingsPanel />}

                {activeTab?.type === "nettools" && (
                  <TunnelManager
                    onStatusMessage={setStatusMessage}
                    onClose={() => removeTab(activeTab.id)}
                  />
                )}

                {/* Non-terminal, non-sftp, non-welcome, non-settings, non-nettools tabs */}
                {activeTab &&
                  activeTab.type !== "welcome" &&
                  activeTab.type !== "terminal" &&
                  activeTab.type !== "sftp" &&
                  activeTab.type !== "settings" &&
                  activeTab.type !== "nettools" && (
                  <UnavailablePanel title={activeTab.title} message={activeTab.message} />
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <StatusBar />

      {showSessionEditor && (
        <SessionEditor
          session={editingSession}
          defaultGroupPath={newSessionGroupPath}
          initialProto={newSessionInitialProto}
          onClose={() => {
            setShowSessionEditor(false);
            setEditingSession(undefined);
            setNewSessionGroupPath(null);
            setNewSessionInitialProto(undefined);
          }}
        />
      )}

      {pendingAuth && (
        <AuthPrompt
          host={pendingAuth.session.host}
          username={pendingAuth.session.username ?? "root"}
          onSubmit={handleAuthSubmit}
          onCancel={() => setPendingAuth(null)}
        />
      )}
    </div>
  );
}

function UnavailablePanel({ title, message }: { title: string; message?: string }) {
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm p-6"
      style={{ background: "var(--moba-term-bg)", color: "var(--moba-term-text)" }}
    >
      <div className="max-w-md text-center">
        <div className="text-lg font-semibold mb-2">{title}</div>
        <div className="text-[12px] text-slate-300">
          {message ?? "This module is not active in the current MVP."}
        </div>
      </div>
    </div>
  );
}
