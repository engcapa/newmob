import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import { useSessionImportExport } from "../components/menubar/useSessionImportExport";
import type { AppCommand } from "../components/menubar/commands";
import { buildAppMenuSpec, installAppMenu, type MenuActionId } from "../lib/nativeAppMenu";
import { QuickConnect } from "../components/quickconnect/QuickConnect";
import { Sidebar } from "../components/sidebar/Sidebar";
import { useConfirmDialog } from "../components/sidebar/ConfirmDialog";
import { ControlBar } from "../components/tabbar/ControlBar";
import { TabActionSlotProvider } from "../components/tabbar/TabActionSlot";
import { StatusBar } from "../components/statusbar/StatusBar";
import { WindowResizeHandles } from "../components/window/WindowResizeHandles";
import { TerminalPanel, type TerminalLocalPathUploadRequest } from "../components/terminal/TerminalPanel";
import { GitPanel } from "../components/git/GitPanel";
import { WorkspaceGitManager } from "../components/git/WorkspaceGitManager";
import { CodeWorkspaceTab, type CodeWorkspaceGitManagerPayload } from "../components/editor/CodeWorkspaceTab";
import type { WorkspaceCommandRegistration } from "../components/editor/workspace/workspaceCommands";
import { decideWorkspaceGitSync } from "../lib/workspaceGitManagerSync";
import { MultiExecBar } from "../components/terminal/MultiExecBar";
import { SessionEditor } from "../components/session/SessionEditor";
import { AuthPrompt } from "../components/session/AuthPrompt";
import { SettingsPanel } from "../components/settings/SettingsPanel";
import { LanChatGate } from "../components/lanchat/LanChatGate";
import { EdgeDrawer } from "../components/lanchat/EdgeDrawer";
import { CallOverlay } from "../components/lanchat/CallOverlay";
import { WhiteboardOverlay } from "../components/lanchat/whiteboard/WhiteboardOverlay";
import { TunnelManager } from "../components/tunnel/TunnelManager";
import { SocksCapPanel } from "../components/sockscap/SocksCapPanel";
import { FileBrowser, type SftpPendingUploadRequest } from "../components/filebrowser/FileBrowser";
import { LocalFileBrowserPanel } from "../components/filebrowser/LocalFileBrowserPanel";
import { ObjectStorageBrowser } from "../components/objectstorage/ObjectStorageBrowser";
import { MailClientTab } from "../components/mail/MailClientTab";
import { sessionToObjectStorageConfig, objectStorageHasVaultSecret } from "../lib/objectStorage";
import { SftpSidebar } from "../components/filebrowser/SftpSidebar";
import { useSftpStore } from "../stores/sftpStore";
import { getAppPlatform, isTauriRuntime } from "../lib/runtime";
import { effectiveFileType, openExternalUrl, openSftpWindow, sftpOpenPath, sftpStat } from "../lib/sftp";
import { openDetachedWindow } from "../lib/detachWindowing";
import { writeTerminal } from "../lib/ipc";
import { encodeBase64 } from "../lib/ipc";
import {
  clearDetachedHandoff,
  detachedWindowUrl,
  writeDetachedHandoff,
} from "../components/filebrowser/SftpDetachedWindow";
import {
  writeDetachedHandoff as writeGenericHandoff,
  clearDetachedHandoff as clearGenericHandoff,
  detachedWindowUrl as detachedGenericUrl,
  subscribeReattach,
  drainPendingReattach,
  clearReattachHandoff,
  type DetachedKind,
  type ReattachMessage,
} from "../lib/detachedSession";
import type { DetachedRdpParams, DetachedVncParams, DetachedTerminalParams, DetachedDbParams } from "../components/detached/DetachedSessionWindow";
import { redactVncHandoff, vncConsumeDetachClaim, vncCreateDetachClaim } from "../lib/vnc";
import { Columns2, Grid2X2, Lock, Rows3, Unlock, X } from "lucide-react";
import type { SftpTabInfo, Tab, DbConnectInfo, HBaseConnectInfo, MailConnectionSecurity, MailTabInfo, MailAuthMode, MailProvider, CodeWorkspaceRootInfo, CodeWorkspaceTabInfo, GitWorkspaceRootInfo, RecentWorkspace } from "../types";
import { computeNewTerminalTitle, newWorkspaceInstanceId, recentWorkspaceIdFromParts, useAppStore, type TerminalSplitLayout } from "../stores/appStore";
import { terminalCwdTitlePrefix } from "../lib/terminalCwd";
import { buildTabDetailSummary } from "../lib/tabDetails";
import { useSessionStore } from "../stores/sessionStore";
import { WelcomePanel } from "../components/WelcomePanel";
import { AboutDialog } from "../components/AboutDialog";
import { UpdateDialog } from "../components/UpdateDialog";
import { useUpdateStore } from "../stores/updateStore";
import { useServersStore } from "../stores/serversStore";
import { parseQuickConnectInput } from "../lib/quickConnect";
import { exitApp, selectFolderPath, type SessionConfig } from "../lib/ipc";
import {
  vaultPut,
  VAULT_LOCKED_EVENT,
} from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { ensureVaultReady } from "../lib/vaultGate";
import { VaultUnlockDialog } from "../components/vault/VaultUnlockDialog";
import { parseSessionOptions } from "../lib/terminalProfile";
import {
  DEFAULT_MAIL_TERMINAL_PROFILE,
  getSessionTerminalProfile,
  loadTerminalDefaultProfile,
  type TerminalProfile,
} from "../lib/terminalProfile";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../lib/networkSettings";
import { loadResizableLayout, saveResizableLayout } from "../lib/resizableLayout";
import { parsePathMappings } from "../components/filebrowser/PathMappingsEditor";
import { parseRdpOptions } from "../types/rdp";
import type { LocalShellSelection } from "../types";
import { ChatDrawer } from "../components/chat/ChatDrawer";
import { TaoRibbon } from "../components/tao/TaoRibbon";
import { FloatingNotesPanel } from "../components/notes/FloatingNotesPanel";
import { TaoAlertPoller } from "../components/tao/TaoAlertPoller";
import { resolveChatDock } from "../lib/chat/chatDock";
import { useViewportSize } from "../hooks/useViewportSize";
import { CcAgentBridge } from "../components/agent/CcAgentBridge";
import { useChatStore, isChatCapableTabType } from "../stores/chatStore";
import { useAiStore } from "../stores/aiStore";
import { useLanChatStore, totalUnread } from "../stores/lanChatStore";
import { setActiveTerminalTab, getTerminal, markTerminalDetachPending, clearTerminalDetachPending } from "../lib/terminal/terminalRegistry";
import { listQueryTabs, setActiveQueryTab } from "../lib/queryRegistry";
import { t as tr, useT } from "../lib/i18n";
import { gitInitRepo, gitProbePath, gitRepoName } from "../lib/git";
import { alertAppDialog, confirmAppDialog } from "../lib/appDialogs";

const VncPanel = lazy(() => import("../components/vnc/VncPanel"));
const RdpPanel = lazy(() => import("../components/rdp/RdpPanel"));
const DbClientTab = lazy(() => import("../components/database/DbClientTab"));
const RedisClientTab = lazy(() => import("../components/database/RedisClientTab"));
const HBaseShellTab = lazy(() => import("../components/database/HBaseShellTab"));
const ProxyTestTab = lazy(() => import("../components/proxy/ProxyTestTab"));

interface PendingSessionAuth {
  kind: "session";
  session: SessionConfig;
}

interface PendingJumpAuth {
  kind: "jump";
  session: SessionConfig;
  jumpSession?: SessionConfig;
  host: string;
  port: number;
  username: string;
  manual: boolean;
  onResolved: (session: SessionConfig) => void;
}

type PendingAuth = PendingSessionAuth | PendingJumpAuth;

interface ControlToolDispatch {
  callId: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
}

type ControlToolExecutor = (dispatch: ControlToolDispatch) => Promise<void>;

type ConnectQueueOutcome = "opened" | "awaiting-auth" | "awaiting-vault";

const MIN_SPLIT_WEIGHT = 0.35;
const SAVED_PASSWORD_VAULT_REASON_KEY = "vault.unlockReasonDefault";
const QUICK_CONNECT_VISIBLE_KEY = "taomni.quickConnectVisible";

function chatBindingIdForTab(tab: Tab | null | undefined): string | null {
  if (!tab || !isChatCapableTabType(tab.type)) return null;
  return tab.chatTabId ?? tab.id;
}

function macCommandDigitIndex(event: KeyboardEvent): number | null {
  if (
    getAppPlatform() !== "macos" ||
    !event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }

  const digit =
    /^[1-9]$/.test(event.key)
      ? event.key
      : event.code.match(/^(?:Digit|Numpad)([1-9])$/)?.[1];
  if (!digit) return null;

  const number = Number.parseInt(digit, 10);
  return number === 9 ? -1 : number - 1;
}

// Whether a local terminal's shell can answer an OSC 7 cwd probe when its tab
// is duplicated. PowerShell and POSIX shells (bash/zsh/git-bash/WSL) can; cmd
// can't emit OSC 7 cleanly, so it's skipped (the duplicate opens in the default
// directory). SSH terminals always run a POSIX remote shell and are handled
// separately. A LocalShellSelection identifies the shell by its executable
// path (see TabBar's shellSelectionFor), so we match on the path/name text.
function localShellSupportsCwdProbe(localShell?: LocalShellSelection): boolean {
  const hint = `${localShell?.id ?? ""} ${localShell?.name ?? ""}`.toLowerCase();
  if (
    hint.includes("cmd.exe") ||
    hint.includes("command prompt") ||
    hint.includes("command-prompt")
  ) {
    return false;
  }
  return true;
}

function readQuickConnectVisible(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(QUICK_CONNECT_VISIBLE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeQuickConnectVisible(visible: boolean) {
  try {
    window.localStorage.setItem(QUICK_CONNECT_VISIBLE_KEY, visible ? "true" : "false");
  } catch {
    // Ignore storage failures; the in-memory visibility state still applies.
  }
}

function localShellSelectionFromSession(session: SessionConfig): LocalShellSelection | undefined {
  const options = parseSessionOptions(session.options_json);
  const path = typeof options.localShellPath === "string" ? options.localShellPath.trim() : "";
  if (!path) return undefined;
  const args = Array.isArray(options.localShellArgs)
    ? options.localShellArgs.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    id: path,
    name: session.name || path,
    ...(args && args.length > 0 ? { args } : {}),
  };
}

function browserUrlFromSession(session: SessionConfig): string | null {
  const target = session.host.trim();
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) return target;
  const withoutSlashes = target.replace(/^\/+/, "");
  const port = session.port > 0 ? `:${session.port}` : "";
  return `https://${withoutSlashes}${port}`;
}

const COMMAND_TERMINAL_SESSION_TYPES = new Set(["FTP", "Telnet", "Rlogin", "Serial", "Mosh"]);

function commandTerminalFromSession(session: SessionConfig): NonNullable<Tab["commandTerminal"]> | null {
  if (!COMMAND_TERMINAL_SESSION_TYPES.has(session.session_type)) return null;
  const host = session.host.trim();
  if (!host) return null;
  return {
    sessionId: session.id,
    kind: session.session_type as NonNullable<Tab["commandTerminal"]>["kind"],
    host,
    port: session.port,
    username: session.username,
    optionsJson: session.options_json,
  };
}

function controlArgRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function controlString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function controlStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function normalizeControlShellType(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function controlLocalShellSelection(args: Record<string, unknown>): {
  localShell?: LocalShellSelection;
  error?: string;
} {
  const nested = controlArgRecord(args.local_shell) ?? controlArgRecord(args.localShell);
  const shellType = controlString(nested?.type)
    ?? controlString(nested?.shell)
    ?? controlString(args.shell)
    ?? controlString(args.shell_type);
  const shellPath = controlString(nested?.path) ?? controlString(args.shell_path);
  const shellArgs = controlStringArray(nested?.args) ?? controlStringArray(args.shell_args);
  const shellName = controlString(nested?.name) ?? controlString(args.shell_name);

  if (!shellType && !shellPath && !shellArgs && !shellName) return {};
  const type = normalizeControlShellType(shellType ?? (shellPath ? "custom" : "default"));
  const withArgs = (id: string, name: string): LocalShellSelection => ({
    id,
    name: shellName ?? name,
    ...(shellArgs ? { args: shellArgs } : {}),
  });

  switch (type) {
    case "default":
      if (shellArgs) return { error: "local_shell.args requires local_shell.type or local_shell.path" };
      return {};
    case "cmd":
    case "cmd.exe":
    case "command-prompt":
      return { localShell: withArgs("command-prompt", "Command Prompt") };
    case "powershell":
    case "powershell7":
    case "pwsh":
    case "ps7":
      return { localShell: withArgs("powershell", "PowerShell") };
    case "windows-powershell":
    case "windows-powershell5":
    case "powershell5":
      return { localShell: withArgs("windows-powershell", "Windows PowerShell") };
    case "git-bash":
    case "gitbash":
      return { localShell: withArgs("git-bash", "Git Bash") };
    case "wsl":
    case "wsl.exe":
      return { localShell: withArgs("wsl.exe", "WSL") };
    case "bash":
    case "zsh":
    case "sh":
      return { localShell: withArgs(type, type) };
    case "custom":
      if (!shellPath) return { error: "local_shell.type=custom requires local_shell.path" };
      return { localShell: withArgs(shellPath, shellPath) };
    default:
      return {
        error: `unsupported local_shell.type: ${shellType ?? shellPath ?? ""}`,
      };
  }
}

function resolveSessionAuth(session: SessionConfig): { method: string; data: string | null } {
  const method = typeof session.auth_method === "string"
    ? session.auth_method
    : "PrivateKey";
  const data = typeof session.auth_method === "object" && "PrivateKey" in session.auth_method
    ? session.auth_method.PrivateKey.key_path
    : null;
  return { method, data };
}

function passwordRefFromOptions(session: SessionConfig): string | null {
  const opts = parseSessionOptions(session.options_json);
  const ref = typeof opts.passwordRef === "string" ? opts.passwordRef : "";
  return ref && ref.startsWith("vault:") ? ref : null;
}

interface MissingJumpPassword {
  session: SessionConfig;
  jumpSession?: SessionConfig;
  host: string;
  port: number;
  username: string;
  manual: boolean;
}

function missingJumpPasswordForSession(
  session: SessionConfig,
  allSessions: SessionConfig[],
): MissingJumpPassword | null {
  const ns = getSessionNetworkSettings(session.options_json);
  if (ns.proxyKind !== "ssh-tunnel") return null;
  if (ns.jumpPassword.trim()) return null;

  const jumpSessionId = ns.jumpSessionId.trim();
  if (jumpSessionId) {
    const jumpSession = allSessions.find((s) => s.id === jumpSessionId);
    if (!jumpSession) return null;
    const { method } = resolveSessionAuth(jumpSession);
    if (method !== "Password") return null;
    if (passwordRefFromOptions(jumpSession)) return null;
    return {
      session,
      jumpSession,
      host: jumpSession.host,
      port: jumpSession.port,
      username: jumpSession.username ?? "root",
      manual: false,
    };
  }

  if (ns.jumpAuthKind !== "Password") return null;
  if (!ns.jumpHost.trim()) return null;
  return {
    session,
    host: ns.jumpHost.trim(),
    port: parseInt(ns.jumpPort, 10) || 22,
    username: ns.jumpUser.trim() || "root",
    manual: true,
  };
}

function sessionWithJumpPassword(
  session: SessionConfig,
  password: string,
  saveAuth = false,
): SessionConfig {
  const opts = parseSessionOptions(session.options_json);
  const ns = getSessionNetworkSettings(session.options_json);
  const updated = {
    ...opts,
    networkSettings: {
      ...ns,
      jumpPassword: password,
      jumpSaveAuth: saveAuth || ns.jumpSaveAuth,
    },
  };
  return { ...session, options_json: JSON.stringify(updated) };
}

function mailSmtpPasswordRefFromOptions(session: SessionConfig): string | null {
  const opts = parseSessionOptions(session.options_json);
  const useImapAuth = opts.mailSmtpUseImapAuth !== false;
  if (useImapAuth) return null;
  const ref = typeof opts.mailSmtpPasswordRef === "string" ? opts.mailSmtpPasswordRef : "";
  return ref && ref.startsWith("vault:") ? ref : null;
}

function mailSecurityFromOptions(value: unknown, fallback: MailConnectionSecurity): MailConnectionSecurity {
  if (value === "STARTTLS" || value === "starttls") return "starttls";
  if (value === "None" || value === "none") return "none";
  if (value === "TLS" || value === "tls") return "tls";
  return fallback;
}

function mailProviderFromOptions(value: unknown, imapHost: string): MailProvider {
  if (value === "gmail" || value === "outlook" || value === "custom") return value;
  const host = imapHost.trim().toLowerCase();
  if (host === "imap.gmail.com") return "gmail";
  if (host === "outlook.office365.com") return "outlook";
  return "custom";
}

function mailAuthModeFromOptions(value: unknown): MailAuthMode {
  return value === "oauth2" ? "oauth2" : "password";
}

function mailNumberOption(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
  min = 0,
): number {
  const raw = options[key];
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}

function sessionToMailTabInfo(
  session: SessionConfig,
  password?: string,
  smtpPassword?: string,
): MailTabInfo {
  const opts = parseSessionOptions(session.options_json);
  const str = (key: string, fallback = ""): string =>
    typeof opts[key] === "string" ? (opts[key] as string) : fallback;
  const smtpUseImapAuth = opts.mailSmtpUseImapAuth !== false;
  const emailAddress = session.username || str("mailEmailAddress");
  const provider = mailProviderFromOptions(opts.mailProvider, session.host);
  const authMode = mailAuthModeFromOptions(opts.mailAuthMode);
  const ns = getSessionNetworkSettings(session.options_json);
  const networkSettings = ns.proxyKind !== "none" ? toNetworkSettingsPayload(ns) : null;
  return {
    sessionId: session.id,
    emailAddress,
    provider,
    authMode,
    displayName: str("mailDisplayName") || null,
    replyTo: str("mailReplyTo") || null,
    signature: str("mailSignature") || null,
    terminalProfile: getSessionTerminalProfile(session.options_json) ?? DEFAULT_MAIL_TERMINAL_PROFILE,
    imap: {
      host: session.host,
      port: session.port,
      username: session.username || emailAddress || null,
      password,
      security: mailSecurityFromOptions(opts.mailImapSecurity, "tls"),
    },
    smtp: {
      host: str("mailSmtpHost"),
      port: mailNumberOption(opts, "mailSmtpPort", 465, 1),
      username: smtpUseImapAuth ? (session.username || emailAddress || null) : (str("mailSmtpUsername") || emailAddress || null),
      password: smtpUseImapAuth ? password : smtpPassword,
      security: mailSecurityFromOptions(opts.mailSmtpSecurity, "tls"),
      useImapAuth: smtpUseImapAuth,
    },
    oauth: {
      clientId: str("mailOauthClientId") || null,
      clientSecret: str("mailOauthClientSecretRef") || undefined,
      tokenRef: str("mailOauthTokenRef") || null,
      refreshTokenRef: str("mailOauthRefreshTokenRef") || null,
      expiresAt: mailNumberOption(opts, "mailOauthExpiresAt", 0, 0) || null,
      scope: str("mailOauthScope") || null,
    },
    networkSettings,
    sync: {
      onOpen: opts.mailSyncOnOpen !== false,
      intervalMinutes: mailNumberOption(opts, "mailSyncIntervalMinutes", 5, 1),
      maxFetchPerSync: mailNumberOption(opts, "mailMaxFetchPerSync", 200, 1),
    },
    cache: {
      enabled: opts.mailCacheEnabled !== false,
      headerRetentionDays: mailNumberOption(opts, "mailHeaderRetentionDays", 30, 1),
      headerLimitPerFolder: mailNumberOption(opts, "mailHeaderLimitPerFolder", 2000, 1),
      bodyRecentLimit: mailNumberOption(opts, "mailBodyRecentLimit", 200, 0),
      bodyMaxBytes: mailNumberOption(opts, "mailBodyMaxBytes", 262144, 1024),
      attachmentCache: opts.mailAttachmentCache === true,
      saveDirectory: str("mailSaveDirectory") || null,
    },
    ai: {
      enabled: opts.mailAiEnabled !== false,
      skipBodyConfirm: opts.mailAiSkipBodyConfirm === true,
    },
  };
}

/**
 * Build a {@link DbConnectInfo} from a saved DB session. Engine-specific
 * options (ClickHouse HTTP port / protocol, Presto catalog / dialect, Redis
 * DB index, SSL, timeout, default database) live in `options_json` under the
 * `db*` keys the session editor writes. `password` is the resolved credential
 * (plaintext or a `vault:` reference) the connect path already worked out.
 */
function sessionToDbConnectInfo(session: SessionConfig, password?: string): DbConnectInfo {
  const opts = parseSessionOptions(session.options_json);
  const str = (key: string, fallback = ""): string =>
    typeof opts[key] === "string" ? (opts[key] as string) : fallback;
  const num = (key: string): number | null => {
    const raw = opts[key];
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  const engine = session.session_type as DbConnectInfo["engine"];
  // Only attach network settings when a proxy / SSH jump host is actually
  // selected; a direct connection sends none so the backend skips the
  // loopback forwarder entirely.
  const ns = getSessionNetworkSettings(session.options_json);
  const networkSettings = ns.proxyKind !== "none" ? toNetworkSettingsPayload(ns) : null;
  const prestoDialectRaw = str("dbPrestoDialect", "presto").toLowerCase();
  return {
    sessionId: session.id,
    workspaceSessionId: session.id,
    engine,
    host: session.host,
    port: session.port,
    username: session.username,
    password,
    catalog: engine === "Presto" ? str("dbCatalog") || null : null,
    database: str("dbDatabase") || null,
    ssl: opts.dbSsl === true,
    timeoutSecs: num("dbTimeout"),
    httpPort: engine === "ClickHouse" ? (num("dbHttpPort") ?? 8123) : null,
    protocol: engine === "ClickHouse" ? str("dbChProtocol", "HTTP").toLowerCase() : null,
    prestoDialect:
      engine === "Presto"
        ? (prestoDialectRaw === "trino" ? "trino" : "presto")
        : null,
    dbIndex: engine === "Redis" ? (num("dbRedisIndex") ?? 0) : null,
    networkSettings,
  };
}

function sessionToHBaseConnectInfo(session: SessionConfig, password?: string): HBaseConnectInfo {
  const opts = parseSessionOptions(session.options_json);
  const str = (key: string, fallback = ""): string =>
    typeof opts[key] === "string" ? (opts[key] as string) : fallback;
  const num = (key: string): number | null => {
    const raw = opts[key];
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    sessionId: session.id,
    workspaceSessionId: session.id,
    host: session.host,
    port: session.port,
    username: session.username,
    password,
    ssl: opts.dbSsl === true,
    timeoutSecs: num("dbTimeout"),
    restPath: str("hbaseRestPath") || null,
    namespace: str("hbaseNamespace") || null,
    connectionMode:
      str("hbaseConnectionMode") === "rest"
        ? "rest"
        : str("hbaseConnectionMode") === "thrift"
          ? "thrift"
          : "native",
    zkQuorum: str("hbaseZkQuorum") || null,
    zkRoot: str("hbaseZkRoot") || null,
    effectiveUser: str("hbaseEffectiveUser") || null,
    authMethod: (str("hbaseAuthMethod") as any) || null,
    servicePrincipal: str("hbaseServicePrincipal") || null,
    principal: str("hbasePrincipal") || null,
    keytabPath: str("hbaseKeytabPath") || null,
    krb5ConfPath: str("hbaseKrb5ConfPath") || null,
    hbaseSitePath: str("hbaseSitePath") || null,
  };
}

function normalizeGitWorkspaceRoots(roots: readonly GitWorkspaceRootInfo[]): GitWorkspaceRootInfo[] {
  const seen = new Set<string>();
  const next: GitWorkspaceRootInfo[] = [];
  for (const root of roots) {
    const repoRoot = root.repoRoot.trim();
    if (!repoRoot || seen.has(repoRoot)) continue;
    seen.add(repoRoot);
    next.push({
      ...root,
      repoRoot,
      name: root.name || gitRepoName(repoRoot),
      rootIds: root.rootIds ?? [],
    });
  }
  return next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function gitWorkspaceRootsKey(roots: readonly GitWorkspaceRootInfo[]): string {
  return roots.map((root) => root.repoRoot).sort((a, b) => a.localeCompare(b)).join("\n");
}

export function MainLayout() {
  const t = useT();
  const {
    tabs,
    activeTabId,
    sidebarCollapsed,
    xServerEnabled,
    refreshXServer,
    addTab,
    removeTab,
    duplicateTab,
    updateTabTitle,
    assignTerminalAutoTitle,
    updateGitTabInfo,
    setActiveTab,
    moveTabToIndex,
    toggleSidebar,
    setSidebarCollapsed,
    setActiveSideTab,
    toggleXServer,
    setStatusMessage,
    multiExecActive,
    multiExecSelectedTabIds,
    terminalSplitActive,
    terminalSplitLayout,
    terminalSplitInputLockedTabIds,
    terminalRuntimeByTab,
    welcomeRecentSessionLimit,
    recentWorkspaces,
    toggleMultiExec,
    selectAllTerminalTabs,
    clearMultiExecSelection,
    setTerminalSplitActive,
    toggleTerminalSplit,
    setTerminalSplitLayout,
    toggleTerminalSplitInputLock,
    clearTerminalSplitInputLocks,
    setTabHasNewOutput,
    removeRecentWorkspace,
    clearRecentWorkspaces,
  } = useAppStore();
  const { loadSessions, markConnected, sessions, updateSession, setSelectedSession, setSearchQuery } = useSessionStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const terminalProfilesBySessionId = useMemo(() => {
    const profiles = new Map<string, TerminalProfile | undefined>();
    for (const session of sessions) {
      profiles.set(session.id, getSessionTerminalProfile(session.options_json));
    }
    return profiles;
  }, [sessions]);
  const terminalProfileSignaturesBySessionId = useMemo(() => {
    const signatures = new Map<string, string | null>();
    for (const session of sessions) {
      const profile = getSessionTerminalProfile(session.options_json);
      signatures.set(session.id, profile ? JSON.stringify(profile) : null);
    }
    return signatures;
  }, [sessions]);
  const [terminalProfileOverrides, setTerminalProfileOverrides] = useState<Record<string, TerminalProfile>>({});
  const previousTerminalProfileSignaturesRef = useRef<Map<string, string | null> | null>(null);

  useEffect(() => {
    setTerminalProfileOverrides((current) => {
      const liveTabIds = new Set(tabs.map((tab) => tab.id));
      let changed = false;
      const next = { ...current };
      for (const tabId of Object.keys(next)) {
        if (!liveTabIds.has(tabId)) {
          delete next[tabId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tabs]);

  useEffect(() => {
    const previous = previousTerminalProfileSignaturesRef.current;
    previousTerminalProfileSignaturesRef.current = terminalProfileSignaturesBySessionId;
    if (!previous) return;

    setTerminalProfileOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const tab of tabs) {
        if (tab.type !== "terminal" || !tab.sessionId || !(tab.id in next)) continue;
        const before = previous.get(tab.sessionId);
        const after = terminalProfileSignaturesBySessionId.get(tab.sessionId) ?? null;
        if (before !== undefined && before !== after) {
          delete next[tab.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tabs, terminalProfileSignaturesBySessionId]);

  const handleTerminalProfileChange = useCallback((tabId: string, profile: TerminalProfile) => {
    setTerminalProfileOverrides((current) => {
      const currentProfile = current[tabId];
      if (currentProfile && JSON.stringify(currentProfile) === JSON.stringify(profile)) return current;
      return { ...current, [tabId]: profile };
    });
  }, []);
  const welcomeRecentSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.last_connected_at)
        .slice()
        .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
        .slice(0, welcomeRecentSessionLimit),
    [sessions, welcomeRecentSessionLimit],
  );
  const welcomeMailSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.session_type === "Mail")
        .slice()
        .sort((a, b) => (a.name || a.host || "").localeCompare(b.name || b.host || "")),
    [sessions],
  );
  const tabsRef = useRef(tabs);
  const executeControlToolRef = useRef<ControlToolExecutor | null>(null);
  const seenControlToolCallsRef = useRef<Set<string>>(new Set());
  const sidebarPanelRef = useRef<PanelImperativeHandle>(null);
  const lastSidebarSizeRef = useRef(22);
  const [showSessionEditor, setShowSessionEditor] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | undefined>();
  const [newSessionGroupPath, setNewSessionGroupPath] = useState<string | null>(null);
  const [newSessionInitialProto, setNewSessionInitialProto] = useState<string | undefined>();
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [attachedSidebars, setAttachedSidebars] = useState<Record<string, boolean>>({});
  const [sftpDetachedTabs, setSftpDetachedTabs] = useState<Record<string, boolean>>({});
  const [pendingSftpUploadRequests, setPendingSftpUploadRequests] = useState<Record<string, SftpPendingUploadRequest>>({});
  const [quickConnectVisible, setQuickConnectVisible] = useState(readQuickConnectVisible);
  // The active tab's contextual action toolbar (Capture / Detach / Maximize …)
  // portals into this slot, which lives inside the ControlBar.
  const [tabActionSlot, setTabActionSlot] = useState<HTMLDivElement | null>(null);
  const [workspaceCommandRegistrations, setWorkspaceCommandRegistrations] = useState<Record<string, WorkspaceCommandRegistration>>({});
  const handleWorkspaceCommandsChange = useCallback((tabId: string, registration: WorkspaceCommandRegistration | null) => {
    setWorkspaceCommandRegistrations((current) => {
      if (registration) return current[tabId] === registration ? current : { ...current, [tabId]: registration };
      if (!(tabId in current)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, []);
  const activeWorkspaceCommandRegistration = activeTabId
    ? workspaceCommandRegistrations[activeTabId] ?? null
    : null;
  // On macOS we render a native global menu bar instead of the in-app app menu.
  // The native menu lives at the top of the screen, matching standard macOS
  // apps; the in-bar menu button is hidden there.
  const nativeMenu = isTauriRuntime() && getAppPlatform() === "macos";
  const importExport = useSessionImportExport();
  const exitRequestInFlightRef = useRef(false);
  const { confirm: confirmAppExit, render: appExitConfirmDialog } = useConfirmDialog();
  const [terminalCwds, setTerminalCwds] = useState<Record<string, string>>({});
  const [terminalCwdVersions, setTerminalCwdVersions] = useState<Record<string, number>>({});
  const [terminalCwdRequestTokens, setTerminalCwdRequestTokens] = useState<Record<string, number>>({});
  const [splitPaneWeights, setSplitPaneWeights] = useState<Record<string, number>>({});
  const [splitGridColumnWeights, setSplitGridColumnWeights] = useState<number[]>([]);
  const [splitGridRowWeights, setSplitGridRowWeights] = useState<number[]>([]);
  const [vaultUnlockReason, setVaultUnlockReason] = useState<string | null>(null);
  const pendingVaultActionRef = useRef<(() => void) | null>(null);
  const connectQueueRef = useRef<SessionConfig[]>([]);
  const connectQueueRunningRef = useRef(false);
  const awaitingManualAuthRef = useRef(false);
  const awaitingVaultUnlockRef = useRef(false);
  const continueConnectQueueRef = useRef<() => void>(() => undefined);
  const splitPanesRef = useRef<HTMLDivElement>(null);
  const refreshVault = useVaultStore((s) => s.refresh);
  const unlockVault = useVaultStore((s) => s.unlock);
  const aiFullyDisabled = useAiStore((s) => s.config?.fully_disabled === true);
  const toggleTabChat = useChatStore((s) => s.toggleTabChat);
  const syncTabChatWithActiveTab = useChatStore((s) => s.syncTabChatWithActiveTab);
  const chatDrawerOpen = useChatStore((s) => s.drawerOpen);
  const chatDrawerPosition = useChatStore((s) => s.drawerPosition);
  const chatDrawerPinned = useChatStore((s) => s.drawerPinned);

  // Pull initial vault status so dialogs that consult it (SessionEditor,
  // TunnelEditor, AuthPrompt) render against fresh state.
  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

  // Auto-update: silently check shortly after launch and then every 6 hours.
  // Checks are non-intrusive — they only flip the store to "available" so the
  // title-bar indicator lights up; the update window opens when the user clicks
  // it (or "Check for updates" in About), never on its own. No-op outside the
  // desktop app.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const runCheck = () => {
      const st = useUpdateStore.getState();
      // Don't disturb the user mid-flow: skip while the window is open or a
      // check/download/staged-install is in progress.
      if (st.dialogOpen) return;
      if (st.status === "checking" || st.status === "downloading" || st.status === "ready") return;
      void st.check();
    };
    const initial = window.setTimeout(runCheck, 4000);
    const interval = window.setInterval(runCheck, 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  // Listen for VAULT_LOCKED events emitted by ipc helpers (e.g. when an
  // SSH connect tries to resolve a vault: reference while the vault is
  // locked). Surface the unlock dialog so the user can resolve it without
  // hunting through settings.
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ reason?: string }>).detail;
      const reason =
        detail?.reason ??
        tr(SAVED_PASSWORD_VAULT_REASON_KEY);
      setVaultUnlockReason((prev) => prev ?? reason);
    };
    window.addEventListener(VAULT_LOCKED_EVENT, handler);
    return () => window.removeEventListener(VAULT_LOCKED_EVENT, handler);
  }, []);
  // Maps tab.id → backend terminal session ID (set once the SSH/local session connects).
  const terminalSessionIds = useRef<Record<string, string>>({});
  // Latest known cwd per tab, mirrored from terminalCwds so handleDuplicateTab
  // can read it synchronously without taking terminalCwds as a dependency
  // (which changes on every prompt once shell integration is active).
  const terminalCwdsRef = useRef<Record<string, string>>({});
  // Pending one-shot resolvers waiting on the next cwd report for a tab. Used
  // by queryTerminalCwd to turn the fire-and-forget OSC 7 round trip into an
  // awaitable promise (e.g. when duplicating a terminal tab).
  const cwdQueryResolversRef = useRef<Record<string, Array<(cwd: string | null) => void>>>({});
  const sftpUploadRequestSeqRef = useRef(0);

  const toggleAttachedSidebar = useCallback((tabId: string) => {
    setAttachedSidebars((prev) => ({ ...prev, [tabId]: !prev[tabId] }));
  }, []);

  const prevTabIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const currentIds = tabs.filter((t) => t.type === "terminal").map((t) => t.id);
    const prevIds = prevTabIdsRef.current;

    // Find closed tabs
    const closedIds = prevIds.filter((id) => !currentIds.includes(id));
    if (closedIds.length > 0) {
      const store = useSftpStore.getState();
      for (const closedId of closedIds) {
        const sftpSessionId = `attached-${closedId}`;
        const detachedSessionId = `attached-${closedId}__detached`;
        void store.detach(sftpSessionId);
        void store.detach(detachedSessionId);
      }
      setSftpDetachedTabs((prev) => {
        const next = { ...prev };
        for (const closedId of closedIds) {
          delete next[closedId];
        }
        return next;
      });
      setPendingSftpUploadRequests((prev) => {
        const next = { ...prev };
        for (const closedId of closedIds) {
          delete next[`attached-${closedId}`];
          delete next[`attached-${closedId}__detached`];
        }
        return next;
      });
    }

    prevTabIdsRef.current = currentIds;
  }, [tabs]);

  const handleTerminalCwd = useCallback((tabId: string, cwd: string) => {
    terminalCwdsRef.current[tabId] = cwd;
    setTerminalCwds((prev) => (prev[tabId] === cwd ? prev : { ...prev, [tabId]: cwd }));
    setTerminalCwdVersions((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    // Mirror into the app store so the AI chat store can read the bound tab's
    // live cwd when sending a turn to Claude Code (Phase 3.3).
    useAppStore.getState().setTabCwd(tabId, cwd);
    assignTerminalAutoTitle(tabId, cwd);
    // Hand the freshly reported cwd to anyone awaiting it (e.g. a pending tab
    // duplication) before broadcasting to other windows.
    const resolvers = cwdQueryResolversRef.current[tabId];
    if (resolvers && resolvers.length > 0) {
      cwdQueryResolversRef.current[tabId] = [];
      for (const resolve of resolvers) resolve(cwd);
    }
    // Mirror the new cwd to any same-origin window (e.g. a detached SFTP
    // popup) so it can offer the same last-known terminal cwd for explicit
    // sync even though only the main window hosts the terminal. We publish
    // under both the raw tab
    // id AND the `attached-${tabId}` key, because a detached window that
    // was split off from an attached SSH sidebar uses the prefixed id as
    // its SFTP session id and would otherwise never see these updates.
    void import("../lib/sftpSync").then(({ broadcastCwdHint }) => {
      broadcastCwdHint(tabId, cwd);
      broadcastCwdHint(`attached-${tabId}`, cwd);
    });
  }, [assignTerminalAutoTitle]);

  // Ask a terminal tab for its current working directory and resolve once the
  // shell reports back via OSC 7. Resolves null if the terminal isn't ready or
  // the reply doesn't arrive in time (so callers can fall back gracefully).
  const queryTerminalCwd = useCallback((tabId: string): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!terminalSessionIds.current[tabId]) {
        resolve(null);
        return;
      }
      const list = cwdQueryResolversRef.current[tabId] ?? [];
      list.push(resolve);
      cwdQueryResolversRef.current[tabId] = list;
      setTerminalCwdRequestTokens((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
      window.setTimeout(() => {
        const pending = cwdQueryResolversRef.current[tabId];
        if (pending && pending.includes(resolve)) {
          cwdQueryResolversRef.current[tabId] = pending.filter((r) => r !== resolve);
          resolve(null);
        }
      }, 1200);
    });
  }, []);

  const duplicateTerminalProfileFor = useCallback((source: Tab): TerminalProfile | undefined => {
    if (source.type !== "terminal") return undefined;
    const liveProfile = terminalProfileOverrides[source.id]
      ?? (source.sessionId ? terminalProfilesBySessionId.get(source.sessionId) : undefined)
      ?? source.terminalProfile;
    return liveProfile ?? loadTerminalDefaultProfile();
  }, [terminalProfileOverrides, terminalProfilesBySessionId]);

  // Duplicate a tab. Terminal tabs try to open the copy in the source's current
  // directory. Shell integration makes shells report their cwd via OSC 7 on
  // every prompt, so we read the last-known cwd (terminalCwdsRef) with no
  // injection — nothing to echo, and a half-typed line in the source is never
  // touched. Only when no cwd was ever reported (integration absent, e.g.
  // cmd/zsh/custom local shells) do we fall back to a one-shot probe, and only
  // for local shells: the probe is skipped if a command is typed, and SSH never
  // probes its source (a duplicate with no known cwd just opens in the remote
  // default directory).
  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      const source = useAppStore.getState().tabs.find((t) => t.id === tabId);
      if (!source) return;
      let initialCwd: string | undefined;
      if (source.type === "terminal" && !source.adoptedTerminal) {
        const tracked = terminalCwdsRef.current[tabId];
        if (tracked) {
          initialCwd = tracked;
        } else if (!source.ssh && !source.commandTerminal && localShellSupportsCwdProbe(source.localShell)) {
          const cwd = await queryTerminalCwd(tabId);
          initialCwd = cwd ?? undefined;
        }
      }
      const terminalProfile = duplicateTerminalProfileFor(source);
      const terminalTitlePrefix = initialCwd ? terminalCwdTitlePrefix(initialCwd) ?? undefined : undefined;
      duplicateTab(tabId, {
        ...(initialCwd ? { terminalInitialCwd: initialCwd } : {}),
        ...(terminalProfile ? { terminalProfile } : {}),
        ...(terminalTitlePrefix ? { terminalTitlePrefix } : {}),
      });
    },
    [duplicateTab, duplicateTerminalProfileFor, queryTerminalCwd],
  );

  const requestTerminalCwd = useCallback((tabId: string): boolean => {
    if (!terminalSessionIds.current[tabId]) {
      setStatusMessage(tr("status.terminalNotReady"));
      return false;
    }
    setTerminalCwdRequestTokens((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    return true;
  }, [setStatusMessage]);

  const handleTerminalLocalPathUpload = useCallback(
    async (tabId: string, request: TerminalLocalPathUploadRequest): Promise<void> => {
      if (request.paths.length === 0) return;
      const remoteDir = request.cwd ?? terminalCwdsRef.current[tabId] ?? null;
      if (!remoteDir) {
        throw new Error(tr("status.terminalCwdUnknown"));
      }

      const sftpSessionId = `attached-${tabId}`;
      const id = ++sftpUploadRequestSeqRef.current;
      setTerminalSplitActive(false);
      setSftpDetachedTabs((prev) => ({ ...prev, [tabId]: false }));
      setAttachedSidebars((prev) => ({ ...prev, [tabId]: true }));
      setPendingSftpUploadRequests((prev) => ({
        ...prev,
        [sftpSessionId]: {
          id,
          paths: request.paths,
          remoteDir,
        },
      }));
    },
    [setTerminalSplitActive, tr],
  );

  const broadcastToSelectedTerminals = useCallback((data: string, sourceTabId?: string) => {
    const {
      multiExecSelectedTabIds: selectedIds,
      terminalSplitActive: splitActive,
      terminalSplitInputLockedTabIds: lockedIds,
    } = useAppStore.getState();
    for (const tabId of selectedIds) {
      if (tabId === sourceTabId) continue; // skip the source terminal — it handles its own input
      if (splitActive && lockedIds.has(tabId)) continue;
      const sessionId = terminalSessionIds.current[tabId];
      if (sessionId) {
        writeTerminal(sessionId, encodeBase64(data)).catch(console.error);
      }
    }
  }, []);

  const handleTerminalOutput = useCallback((tabId: string) => {
    if (tabId === useAppStore.getState().activeTabId) return;
    setTabHasNewOutput(tabId, true);
  }, [setTabHasNewOutput]);

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
        setStatusMessage(tr("status.sftpWindowError", {
          error: err instanceof Error ? err.message : String(err),
        }));
      });
      return;
    }
    const url = detachedWindowUrl(detachedSessionId);
    const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
    const handle = window.open(url, `taomni_sftp_${detachedSessionId}`, features);
    if (!handle) {
      // Pop-up blocked — clean up the credential blob right away so it
      // doesn't linger in localStorage waiting for a window that never
      // arrives.
      clearDetachedHandoff(detachedSessionId);
      setStatusMessage(tr("status.sftpPopupBlocked"));
    }
  }, [setStatusMessage]);

  /**
   * Hand off the credentials of a non-SFTP tab to a new OS window and
   * remove the source tab from this window. The new window opens its own
   * backend session of the same kind. Reattach reverses the move via the
   * `BroadcastChannel('taomni.detach.sync')` subscriber wired below.
   */
  const openDetachedGenericWindow = useCallback(
    <T,>(
      kind: DetachedKind,
      sourceTabId: string,
      detachedId: string,
      payload: T,
      title: string,
    ) => {
      writeGenericHandoff(kind, detachedId, payload);
      if (isTauriRuntime()) {
        void openDetachedWindow({
          kind,
          sessionId: detachedId,
          title,
        })
          .then(() => {
            // Once the OS window is up the source tab is no longer the
            // owner of this connection. Drop it; the detached window owns
            // a fresh connection of its own.
            removeTab(sourceTabId);
          })
          .catch((err) => {
            clearGenericHandoff(kind, detachedId);
            if (kind === "terminal") clearTerminalDetachPending(sourceTabId);
            setStatusMessage(
              tr("status.detachWindowError", {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          });
        return;
      }
      const url = detachedGenericUrl(kind, detachedId);
      const features = "width=1280,height=800,resizable=yes,scrollbars=yes";
      const handle = window.open(url, `taomni_${kind}_${detachedId}`, features);
      if (!handle) {
        clearGenericHandoff(kind, detachedId);
        if (kind === "terminal") clearTerminalDetachPending(sourceTabId);
        setStatusMessage(tr("status.detachPopupBlocked"));
        return;
      }
      removeTab(sourceTabId);
    },
    [removeTab, setStatusMessage],
  );

  const openDetachedRdp = useCallback(
    (tabId: string, info: NonNullable<Tab["rdp"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      const payload: DetachedRdpParams = {
        tabId,
        sessionId: info.sessionId,
        host: info.host,
        port: info.port,
        username: info.username ?? null,
        password: info.password,
        options: info.options,
        networkSettingsJson: info.networkSettingsJson ?? null,
        title,
      };
      openDetachedGenericWindow("rdp", tabId, detachedId, payload, title);
    },
    [openDetachedGenericWindow],
  );

  const openDetachedVnc = useCallback(
    (tabId: string, info: NonNullable<Tab["vnc"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      void vncCreateDetachClaim({
        host: info.host,
        port: info.port,
        username: info.username ?? null,
        password: info.password,
        network_settings_json: info.networkSettingsJson ?? null,
        security_policy: info.securityPolicy ?? "prefer-encryption",
        view_only: info.viewOnly ?? false,
        clipboard_policy: info.clipboardPolicy ?? "bidirectional",
      }).then((claimId) => {
        // The browser-persisted handoff contains only an opaque one-time id;
        // password/proxy secrets stay in backend memory.
        const payload = redactVncHandoff<DetachedVncParams>({
          tabId,
          sessionId: info.sessionId,
          host: info.host,
          port: info.port,
          username: info.username,
          networkSettingsJson: info.networkSettingsJson,
          title,
        }, claimId);
        openDetachedGenericWindow("vnc", tabId, detachedId, payload, title);
      }).catch((error) => {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      });
    },
    [openDetachedGenericWindow, setStatusMessage],
  );

  const openDetachedTerminal = useCallback(
    (
      tabId: string,
      tab: Tab,
      title: string,
    ) => {
      // Capture the live backend session id + scrollback snapshot so the
      // detached window can adopt the existing PTY/SSH session instead of
      // spawning a fresh one. The TerminalPanel cleanup on the source tab
      // honours the detach-pending flag and skips its `closeTerminal`
      // call so the backend session survives the React unmount.
      const detachedId = `${tabId}__detached`;
      const liveSessionId = terminalSessionIds.current[tabId];
      const liveEntry = getTerminal(tabId);
      const snapshotText = liveEntry ? liveEntry.getBufferText() : undefined;
      const reattach = liveSessionId
        ? { terminalSessionId: liveSessionId, snapshotText }
        : undefined;
      const terminalProfile = terminalProfileOverrides[tabId]
        ?? (tab.sessionId ? terminalProfilesBySessionId.get(tab.sessionId) : undefined)
        ?? tab.terminalProfile
        ?? null;
      const payload: DetachedTerminalParams = {
        tabId,
        title,
        terminalTitleMode: tab.terminalTitleMode,
        terminalTitleOperation: tab.terminalTitleOperation,
        terminalTitleSessionName: tab.terminalTitleSessionName,
        ssh: tab.ssh ?? null,
        commandTerminal: tab.commandTerminal ?? null,
        localShell: tab.localShell ?? null,
        terminalProfile,
        reattach,
      };
      if (liveSessionId) {
        markTerminalDetachPending(tabId);
      }
      try {
        openDetachedGenericWindow("terminal", tabId, detachedId, payload, title);
      } catch (err) {
        clearTerminalDetachPending(tabId);
        throw err;
      }
    },
    [openDetachedGenericWindow, terminalProfileOverrides, terminalProfilesBySessionId],
  );

  const openDetachedDatabase = useCallback(
    (tabId: string, info: NonNullable<Tab["db"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      const payload: DetachedDbParams = {
        tabId,
        title,
        // Give the detached window its own connection handle so the source
        // tab's unmount disconnect cannot race and close the detached query
        // workspace connection.
        info: {
          ...info,
          sessionId: detachedId,
          workspaceSessionId: info.workspaceSessionId ?? info.sessionId,
        },
      };
      openDetachedGenericWindow("database", tabId, detachedId, payload, title);
    },
    [openDetachedGenericWindow],
  );

  const handleDetachActiveTab = useCallback(() => {
    const state = useAppStore.getState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (!tab) return;
    if (tab.type === "terminal" && !state.terminalSplitActive) {
      openDetachedTerminal(tab.id, tab, tab.title);
    } else if (tab.type === "rdp" && tab.rdp) {
      openDetachedRdp(tab.id, tab.rdp, tab.title);
    } else if (tab.type === "vnc" && tab.vnc) {
      openDetachedVnc(tab.id, tab.vnc, tab.title);
    } else if (tab.type === "database" && tab.db) {
      openDetachedDatabase(tab.id, tab.db, tab.title);
    } else if (tab.type === "sftp" && tab.sftp) {
      openDetachedSftp(tab.sftp, tab.title);
    }
  }, [openDetachedDatabase, openDetachedRdp, openDetachedSftp, openDetachedTerminal, openDetachedVnc]);

  /**
   * Subscribe to reattach messages broadcast by detached windows. Each
   * time a detached window asks to come back, recreate the equivalent
   * tab in this window using the credential payload from the reattach
   * envelope. localStorage envelopes left behind by abrupt closes are
   * also drained on subscribe.
   */
  useEffect(() => {
    // Collapse a single close "burst" into one tab. Closing a detached
    // window can fan a reattach out across several transports/listeners
    // (BroadcastChannel + localStorage backstop, leaked onCloseRequested
    // listeners, beforeunload+pagehide double-fire). They all carry the
    // same (kind,id) within a few hundred ms, so a short per-(kind,id)
    // window dedupes them without blocking a legitimate later re-detach.
    const recentReattach = new Map<string, number>();
    const BURST_WINDOW_MS = 1500;
    const handle = async (msg: ReattachMessage) => {
      const burstKey = `${msg.kind}.${msg.id}`;
      const now = Date.now();
      const last = recentReattach.get(burstKey);
      if (last !== undefined && now - last < BURST_WINDOW_MS) {
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      recentReattach.set(burstKey, now);
      if (msg.kind === "lan-chat") {
        const p = msg.payload as { activeConvId?: string; title?: string } | undefined;
        const convId = p?.activeConvId || msg.id;
        const existing = tabsRef.current.find((tab) => tab.type === "lan-chat");
        if (existing) {
          setActiveTab(existing.id);
        } else {
          addTab({
            id: "lan-chat",
            type: "lan-chat",
            title: tr("tabs.lanChat"),
            closable: true,
          });
        }
        if (convId) {
          if (convId.startsWith("direct:") || convId.startsWith("group:")) {
            void useLanChatStore.getState().openConversation(convId);
          }
        }
        setStatusMessage(tr("status.reattached"));
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      // Idempotent tab identity: use the original source tab id when the
      // payload has it so chat threads stay bound across detach/reattach.
      // Older handoffs fall back to the detached id-derived shape.
      const payloadTabId =
        typeof (msg.payload as { tabId?: unknown } | undefined)?.tabId === "string"
          ? ((msg.payload as { tabId: string }).tabId.trim() || null)
          : null;
      const reattachTabId = payloadTabId ?? `${msg.kind}-reattach-${msg.id}`;
      if (tabsRef.current.some((t) => t.id === reattachTabId)) {
        setActiveTab(reattachTabId);
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      switch (msg.kind) {
        case "rdp": {
          const p = msg.payload as DetachedRdpParams | undefined;
          if (!p?.host) return;
          addTab({
            id: reattachTabId,
            type: "rdp",
            title: p.title || `${p.host}:${p.port}`,
            sessionId: p.sessionId,
            closable: true,
            rdp: {
              sessionId: p.sessionId,
              host: p.host,
              port: p.port,
              username: p.username ?? undefined,
              password: p.password,
              options: p.options,
              networkSettingsJson: p.networkSettingsJson ?? null,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "vnc": {
          let p = msg.payload as DetachedVncParams | undefined;
          if (p?.claimId && !p.host) {
            const claim = await vncConsumeDetachClaim(p.claimId);
            p = {
              ...p,
              claimId: undefined,
              host: claim.host,
              port: claim.port,
              username: claim.username,
              password: claim.password,
              networkSettingsJson: claim.network_settings_json,
              securityPolicy: claim.security_policy,
              viewOnly: claim.view_only,
              clipboardPolicy: claim.clipboard_policy as DetachedVncParams["clipboardPolicy"],
            };
          }
          if (!p?.host) return;
          addTab({
            id: reattachTabId,
            type: "vnc",
            title: p.title || `${p.host}:${p.port}`,
            sessionId: p.sessionId,
            closable: true,
            vnc: {
              sessionId: p.sessionId,
              host: p.host,
              port: p.port,
              username: p.username ?? undefined,
              password: p.password,
              networkSettingsJson: p.networkSettingsJson ?? null,
              securityPolicy: p.securityPolicy,
              viewOnly: p.viewOnly,
              clipboardPolicy: p.clipboardPolicy,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "terminal": {
          const p = msg.payload as DetachedTerminalParams | undefined;
          if (!p) return;
          const adopted = p.reattach?.terminalSessionId
            ? {
                sessionId: p.reattach.terminalSessionId,
                snapshotText: p.reattach.snapshotText,
              }
            : undefined;
          addTab({
            id: reattachTabId,
            type: "terminal",
            title: p.title || tr("tabs.localTerminal"),
            terminalTitleMode: p.terminalTitleMode,
            terminalTitleOperation: p.terminalTitleOperation,
            terminalTitleSessionName: p.terminalTitleSessionName,
            closable: true,
            ssh: p.ssh ?? undefined,
            commandTerminal: p.commandTerminal ?? undefined,
            localShell: p.localShell ?? undefined,
            terminalProfile: p.terminalProfile ?? undefined,
            adoptedTerminal: adopted,
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "database": {
          const p = msg.payload as DetachedDbParams | undefined;
          if (!p?.info) return;
          addTab({
            id: reattachTabId,
            type: "database",
            title: p.title || `${p.info.engine} ${p.info.host}`,
            sessionId: reattachTabId,
            closable: true,
            db: {
              ...p.info,
              sessionId: reattachTabId,
              workspaceSessionId: p.info.workspaceSessionId ?? p.info.sessionId,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        default:
          /* SFTP reattach not wired — SFTP detach is co-existing, not exclusive. */
          break;
      }
      clearReattachHandoff(msg.kind, msg.id);
    };
    const unsub = subscribeReattach((msg) => { void handle(msg); });
    // Drain any envelopes left by detached windows that closed abruptly
    // before we subscribed.
    drainPendingReattach().forEach((msg) => { void handle(msg); });
    return unsub;
  }, [addTab, setActiveTab, setStatusMessage]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Probe the local X server once at startup so the status pill reflects
  // reality (Xorg/XQuartz/VcXsrv/WSLg reachable or not) instead of a guess.
  useEffect(() => {
    void refreshXServer();
  }, [refreshXServer]);

  useEffect(() => {
    if (activeTabId) setTabHasNewOutput(activeTabId, false);
  }, [activeTabId, setTabHasNewOutput]);

  // Track which tab the AI Chat Drawer should consider "active" when the user
  // types `@terminal:last-N` or sends generated SQL back to a query tab.
  // `setActiveTerminalTab` is terminal-only (that registry pulls xterm
  // buffers), but a tab-bound chat drawer can belong to any tab kind that
  // exposes a chat toggle (terminal + rdp + database), so the drawer-sync gets the
  // active tab id for those kinds and survives tab switches.
  useEffect(() => {
    const terminalTabId = activeTab?.type === "terminal" ? activeTabId : null;
    setActiveTerminalTab(terminalTabId);
    setActiveQueryTab(activeTab?.type === "database" ? activeTabId : null);
    const chatBoundTabId = chatBindingIdForTab(activeTab);
    void syncTabChatWithActiveTab(chatBoundTabId);
  }, [activeTab, activeTabId, syncTabChatWithActiveTab]);

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
        panel.resize(`${lastSidebarSizeRef.current}%`);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [sidebarCollapsed]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        useServersStore.getState().openDialog(tr("servers.dialogTitle"));
        return;
      }
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey || event.key.toLowerCase() !== "l") return;

      if (event.shiftKey) {
        event.preventDefault();
        const aiOff = useAiStore.getState().config?.fully_disabled === true;
        const current = useAppStore.getState().tabs.find((tab) => tab.id === useAppStore.getState().activeTabId);
        const chatTabId = chatBindingIdForTab(current);
        if (!aiOff && chatTabId) {
          void toggleTabChat(chatTabId);
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleTabChat]);

  // Hydrate server configs + statuses once on mount so the servers dialog
  // opens with persisted settings and live run state.
  useEffect(() => {
    void useServersStore.getState().loadAll();
  }, []);

  const confirmExitWithOpenTabs = useCallback(async () => {
    const currentTabs = tabsRef.current;
    const terminalCount = currentTabs.filter((tab) => tab.type === "terminal" && tab.closable).length;
    const tabCount = currentTabs.filter((tab) => tab.closable).length;
    if (tabCount === 0) return true;

    const isOne = tabCount === 1;
    let message: string;
    if (terminalCount > 0) {
      message = tr(isOne ? "exit.promptOneTerminal" : "exit.promptManyTerminals", {
        count: tabCount,
        terminals: terminalCount,
      });
    } else {
      message = tr(isOne ? "exit.promptOne" : "exit.promptMany", { count: tabCount });
    }
    return confirmAppExit({
      title: tr("ribbon.exit"),
      message,
      confirmLabel: tr("ribbon.exit"),
      danger: true,
    });
  }, [confirmAppExit]);

  const requestAppExit = useCallback(() => {
    if (exitRequestInFlightRef.current) return;
    exitRequestInFlightRef.current = true;
    void (async () => {
      try {
        if (!(await confirmExitWithOpenTabs())) return;
        await Promise.allSettled(
          listQueryTabs().map((entry) => entry.flushWorkspace?.()),
        );
        for (;;) {
          try {
            await exitApp();
            return;
          } catch (error) {
            const retry = await confirmAppExit({
              title: tr("exit.cleanupFailedTitle"),
              message: tr("exit.cleanupFailedMessage", { error: String(error) }),
              confirmLabel: tr("exit.retryCleanup"),
              cancelLabel: tr("exit.cancelExit"),
              danger: true,
            });
            if (!retry) return;
          }
        }
      } finally {
        exitRequestInFlightRef.current = false;
      }
    })();
  }, [confirmAppExit, confirmExitWithOpenTabs]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow.onCloseRequested((event) => {
      event.preventDefault();
      requestAppExit();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [requestAppExit]);

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
    title?: string,
    sessionId?: string,
    terminalProfile?: TerminalProfile,
    localShell?: LocalShellSelection,
    initialCwd?: string,
  ) => {
    const id = `local-${Date.now()}`;
    const resolvedTerminalProfile = terminalProfile ?? loadTerminalDefaultProfile();
    const initialTitlePrefix = initialCwd ? terminalCwdTitlePrefix(initialCwd) : null;
    const requestedTitle = initialTitlePrefix || title || tr("tabs.localTerminal");
    const resolvedTitle = computeNewTerminalTitle(
      requestedTitle,
      useAppStore.getState().tabs
        .filter((tab) => tab.type === "terminal")
        .map((tab) => tab.title),
    );
    addTab({
      id,
      type: "terminal",
      title: resolvedTitle,
      sessionId,
      localShell,
      terminalProfile: resolvedTerminalProfile,
      terminalInitialCwd: initialCwd,
      terminalTitleMode: initialTitlePrefix ? "auto" : "pending-auto",
      terminalTitleOperation: "new",
      closable: true,
    });
    if (sessionId) void markConnected(sessionId);
  }, [addTab, markConnected]);

  const handleEditSession = useCallback((session: SessionConfig) => {
    setEditingSession(session);
    setNewSessionGroupPath(null);
    setShowSessionEditor(true);
  }, []);

  const handleEditSessionById = useCallback((sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (session) handleEditSession(session);
  }, [handleEditSession]);

  const openSftpTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const tabId = `sftp-${session.id}-${Date.now()}`;
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    const pathMappings = parsePathMappings(session.options_json);
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
        networkSettingsJson: JSON.stringify(ns),
        attachedToTerminal: false,
        pathMappings: pathMappings.length > 0 ? pathMappings : undefined,
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openVncTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `vnc-${session.id}-${Date.now()}`;
    const options = parseSessionOptions(session.options_json);
    const rawPolicy = typeof options.vncSecurityPolicy === "string" ? options.vncSecurityPolicy : "prefer-encryption";
    const securityPolicy = rawPolicy === "require-encryption" || rawPolicy === "legacy-compatible" || rawPolicy === "allow-none"
      ? rawPolicy
      : "prefer-encryption";
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    addTab({
      id,
      type: "vnc",
      title: session.name || `${session.host}:${session.port}`,
      sessionId: session.id,
      closable: true,
      vnc: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username,
        password,
        networkSettingsJson: JSON.stringify(ns),
        securityPolicy,
        viewOnly: options.vncViewOnly === true,
        clipboardPolicy:
          options.vncClipboardPolicy === "disabled" || options.vncClipboardPolicy === "client-to-server" || options.vncClipboardPolicy === "server-to-client"
            ? options.vncClipboardPolicy
            : "bidirectional",
      },
    });
  }, [addTab]);

  const openRdpTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `rdp-${session.id}-${Date.now()}`;
    const opts = parseRdpOptions(session.options_json);
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    addTab({
      id,
      type: "rdp",
      title: session.name || `${session.host}:${session.port}`,
      sessionId: session.id,
      closable: true,
      rdp: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username,
        password,
        options: opts,
        networkSettingsJson: JSON.stringify(ns),
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openFileBrowserTab = useCallback((title: string, initialPath: string, sessionId?: string) => {
    const id = `file-${sessionId ?? "ad-hoc"}-${Date.now()}`;
    addTab({
      id,
      type: "file-browser",
      title,
      sessionId,
      closable: true,
      fileBrowser: { initialPath },
    });
  }, [addTab]);

  const openDbTab = useCallback((session: SessionConfig, password?: string) => {
    const engine = session.session_type as DbConnectInfo["engine"];
    const isRedis = engine === "Redis";
    const id = `${isRedis ? "redis" : "database"}-${session.id}-${Date.now()}`;
    const info = sessionToDbConnectInfo(session, password);
    const prestoPath = info.engine === "Presto"
      ? [info.catalog, info.database].filter(Boolean).join(".")
      : info.database;
    const title = `${engine} ${session.host}:${session.port}${prestoPath ? `/${prestoPath}` : ""}`;
    addTab({
      id,
      type: isRedis ? "redis" : "database",
      title,
      sessionId: session.id,
      closable: true,
      db: info,
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openHBaseShellTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `hbase-shell-${session.id}-${Date.now()}`;
    const info = sessionToHBaseConnectInfo(session, password);
    // Native mode may have no host/port (it bootstraps via ZK quorum or
    // hbase-site.xml), so build a sensible endpoint label per mode.
    const endpointLabel =
      info.connectionMode === "native"
        ? info.zkQuorum?.split(",")[0]?.trim() ||
          (session.host ? `${session.host}:${session.port}` : "") ||
          (info.hbaseSitePath ? "hbase-site.xml" : "ZooKeeper")
        : `${session.host}:${session.port}`;
    const title = `HBase ${endpointLabel}${info.namespace ? `/${info.namespace}` : ""}`;
    addTab({
      id,
      type: "hbase-shell",
      title,
      sessionId: session.id,
      closable: true,
      hbase: info,
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openProxyTestTab = useCallback((session: SessionConfig) => {
    const id = `proxy-test-${session.id}-${Date.now()}`;
    const options = parseSessionOptions(session.options_json);
    const proxyKind = (options.proxyKind === "socks5" ? "socks5" : "http") as "http" | "socks5";
    const title = `${proxyKind === "http" ? "HTTP" : "SOCKS5"} ${session.host}:${session.port}`;
    addTab({
      id,
      type: "proxy-test",
      title,
      sessionId: session.id,
      closable: true,
      proxyTest: {
        sessionId: session.id,
        proxyKind,
        host: session.host,
        port: session.port,
        username: session.username,
        password: passwordRefFromOptions(session) || undefined,
        testUrl: typeof options.testUrl === "string" ? options.testUrl : "www.google.com:443",
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openObjectStorageTab = useCallback((session: SessionConfig) => {
    const id = `object-storage-${session.id}-${Date.now()}`;
    const config = sessionToObjectStorageConfig(session);
    const title = session.name || session.host || "Object Storage";
    addTab({
      id,
      type: "object-storage",
      title,
      sessionId: session.id,
      closable: true,
      // The browser keys its live store by the tab session id (not the saved
      // session id) so two tabs for the same saved session stay independent.
      objectStorage: { sessionId: id, config },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openMailTab = useCallback((session: SessionConfig, password?: string, smtpPassword?: string) => {
    const existing = tabsRef.current.find((tab) => tab.type === "mail" && tab.sessionId === session.id);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    const id = `mail-${session.id}-${Date.now()}`;
    const info = sessionToMailTabInfo(session, password, smtpPassword);
    const title = session.name || info.emailAddress || `Mail ${session.host}`;
    addTab({
      id,
      type: "mail",
      title,
      sessionId: session.id,
      closable: true,
      mail: info,
    });
    void markConnected(session.id);
  }, [addTab, markConnected, setActiveTab]);

  // Open a local path or URL: http(s) URLs and files always go to the system handler;
  // folders open in an embedded Taomni tab when `embedFolder` is true, otherwise
  // they fall through to the OS file manager via sftpOpenPath.
  const handleOpenLocalPath = useCallback(async (
    target: string,
    opts: { embedFolder?: boolean; title?: string; sessionId?: string } = {},
  ) => {
    const trimmed = target.trim();
    if (!trimmed) return;
    const isUrl = /^https?:\/\//i.test(trimmed);
    if (isUrl) {
      try {
        await openExternalUrl(trimmed);
      } catch (err) {
        setStatusMessage(tr("status.openFailed", {
          error: err instanceof Error ? err.message : String(err),
        }));
      }
      return;
    }
    let isDir = false;
    try {
      const info = await sftpStat("", trimmed, "local");
      isDir = effectiveFileType(info) === "dir";
    } catch (err) {
      setStatusMessage(tr("status.statFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
      return;
    }
    if (isDir && opts.embedFolder) {
      openFileBrowserTab(opts.title ?? trimmed, trimmed, opts.sessionId);
      return;
    }
    try {
      await sftpOpenPath(trimmed);
    } catch (err) {
      setStatusMessage(tr("status.openFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [openFileBrowserTab, setStatusMessage]);

  const openFileSession = useCallback((session: SessionConfig) => {
    const target = session.host?.trim();
    if (!target) {
      setStatusMessage(tr("status.fileSessionMissing"));
      return;
    }
    let embed = true;
    try {
      const opts = JSON.parse(session.options_json || "{}") as Record<string, unknown>;
      if (typeof opts.fileEmbedInTab === "boolean") embed = opts.fileEmbedInTab;
    } catch {
      /* defaults */
    }
    void handleOpenLocalPath(target, {
      embedFolder: embed,
      title: session.name || target,
      sessionId: session.id,
    });
    void markConnected(session.id);
  }, [handleOpenLocalPath, markConnected, setStatusMessage]);

  const revealRecentCodeWorkspace = useCallback((workspace: RecentWorkspace) => {
    const target = workspace.roots[0]?.path ?? workspace.looseFiles[0]?.path;
    if (!target) return;
    void handleOpenLocalPath(target, { embedFolder: false });
  }, [handleOpenLocalPath]);

  const openGitTab = useCallback((repoRoot: string) => {
    const normalized = repoRoot.trim();
    if (!normalized) return;
    const existing = tabsRef.current.find(
      (tab) => tab.type === "git" && tab.git?.repoRoot === normalized && !tab.git?.workspaceRoots?.length,
    );
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: `git-${Date.now()}`,
      type: "git",
      title: `Git · ${gitRepoName(normalized)}`,
      closable: true,
      git: { repoRoot: normalized },
    });
  }, [addTab, setActiveTab]);

  const openWorkspaceGitManager = useCallback((payload: CodeWorkspaceGitManagerPayload) => {
    const workspaceRoots = normalizeGitWorkspaceRoots(payload.roots);
    if (workspaceRoots.length === 0) return;
    const activeRepoRoot = payload.activeRepoRoot && workspaceRoots.some((root) => root.repoRoot === payload.activeRepoRoot)
      ? payload.activeRepoRoot
      : workspaceRoots[0].repoRoot;
    const name = payload.workspaceName.trim() || "Code Workspace";
    const existing = tabsRef.current.find((tab) => {
      if (tab.type !== "git" || !tab.git?.workspaceRoots?.length) return false;
      if (payload.workspaceInstanceId) {
        return tab.git.sourceWorkspaceInstanceId === payload.workspaceInstanceId;
      }
      return gitWorkspaceRootsKey(tab.git.workspaceRoots) === gitWorkspaceRootsKey(workspaceRoots);
    });
    if (existing) {
      updateGitTabInfo(existing.id, {
        ...existing.git!,
        repoRoot: activeRepoRoot,
        workspaceName: name,
        workspaceRoots,
        activeRepoRoot,
        sourceWorkspaceInstanceId: payload.workspaceInstanceId ?? existing.git?.sourceWorkspaceInstanceId,
        sourceWorkspaceId: payload.workspaceId ?? existing.git?.sourceWorkspaceId,
        sourceWorkspaceName: name,
      }, `Git · ${name}`);
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: `git-workspace-${Date.now()}`,
      type: "git",
      title: `Git · ${name}`,
      closable: true,
      git: {
        repoRoot: activeRepoRoot,
        workspaceName: name,
        workspaceRoots,
        activeRepoRoot,
        sourceWorkspaceInstanceId: payload.workspaceInstanceId,
        sourceWorkspaceId: payload.workspaceId,
        sourceWorkspaceName: name,
      },
    });
  }, [addTab, setActiveTab, updateGitTabInfo]);

  const syncWorkspaceGitManager = useCallback((payload: CodeWorkspaceGitManagerPayload) => {
    const sourceWorkspaceInstanceId = payload.workspaceInstanceId;
    if (!sourceWorkspaceInstanceId) return;
    const workspaceRoots = normalizeGitWorkspaceRoots(payload.roots);
    const existing = tabsRef.current.find((tab) => (
      tab.type === "git"
      && tab.git?.sourceWorkspaceInstanceId === sourceWorkspaceInstanceId
    ));
    const decision = decideWorkspaceGitSync({
      hasLinkedTab: !!existing?.git,
      workspaceRoots,
      existingActiveRepoRoot: existing?.git?.activeRepoRoot ?? existing?.git?.repoRoot,
      payloadActiveRepoRoot: payload.activeRepoRoot,
    });
    if (decision.kind === "noop" || !existing?.git) return;
    // Empty / removed roots: close the linked Git tab so we never keep
    // snapshotting deleted paths after the workspace drops them (issue #324 B1).
    if (decision.kind === "close") {
      removeTab(existing.id);
      return;
    }
    const name = payload.workspaceName.trim() || "Code Workspace";
    updateGitTabInfo(existing.id, {
      ...existing.git,
      repoRoot: decision.activeRepoRoot,
      workspaceName: name,
      workspaceRoots: decision.workspaceRoots,
      activeRepoRoot: decision.activeRepoRoot,
      sourceWorkspaceInstanceId,
      sourceWorkspaceId: payload.workspaceId ?? existing.git.sourceWorkspaceId,
      sourceWorkspaceName: name,
    }, `Git · ${name}`);
  }, [removeTab, updateGitTabInfo]);

  // Close workspace Git manager tabs whose source Code Workspace tab is gone so
  // they cannot keep snapshotting stale repo paths after the workspace is closed.
  useEffect(() => {
    const openWorkspaceInstanceIds = new Set(
      tabs
        .filter((tab) => tab.type === "code-workspace" && tab.codeWorkspace)
        .map((tab) => {
          const ws = tab.codeWorkspace!;
          return ws.workspaceInstanceId ?? ws.workspaceId ?? ws.repoRoot?.trim() ?? tab.id;
        }),
    );
    for (const tab of tabs) {
      if (tab.type !== "git" || !tab.git?.sourceWorkspaceInstanceId) continue;
      if (!tab.git.workspaceRoots?.length) continue;
      if (openWorkspaceInstanceIds.has(tab.git.sourceWorkspaceInstanceId)) continue;
      removeTab(tab.id);
    }
  }, [removeTab, tabs]);

  const openCodeWorkspaceInfo = useCallback((workspace: CodeWorkspaceTabInfo) => {
    const roots = workspace.roots ?? [];
    const looseFiles = workspace.looseFiles ?? [];
    const identity = recentWorkspaceIdFromParts(roots, looseFiles);
    const existing = tabsRef.current.find(
      (tab) => {
        if (tab.type !== "code-workspace" || !tab.codeWorkspace) return false;
        if (workspace.workspaceId && tab.codeWorkspace.workspaceId === workspace.workspaceId) return true;
        if (tab.codeWorkspace.workspaceId === identity) return true;
        const tabRoots = tab.codeWorkspace.roots ?? [];
        const tabLooseFiles = tab.codeWorkspace.looseFiles ?? [];
        if (tabRoots.length === 0 && tabLooseFiles.length === 0) return false;
        return recentWorkspaceIdFromParts(tabRoots, tabLooseFiles) === identity;
      },
    );
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    const title = workspace.name?.trim()
      || (roots.length === 1 && looseFiles.length === 0 ? roots[0].name : "")
      || (roots.length === 0 && looseFiles.length > 0 ? "Editor Workspace" : "Code Workspace");
    addTab({
      id: `code-workspace-${Date.now()}`,
      type: "code-workspace",
      title: `Code · ${title}`,
      closable: true,
      codeWorkspace: {
        ...workspace,
        workspaceId: workspace.workspaceId ?? identity,
        workspaceInstanceId: workspace.workspaceInstanceId ?? newWorkspaceInstanceId(),
        name: title,
      },
    });
  }, [addTab, setActiveTab]);

  const openCodeWorkspaceTab = useCallback((repoRoot: string, initialPath?: string | null) => {
    const normalized = repoRoot.trim();
    if (!normalized) return;
    const root: CodeWorkspaceRootInfo = {
      id: `root-${Date.now()}`,
      name: gitRepoName(normalized),
      path: normalized,
      kind: "git",
    };
    openCodeWorkspaceInfo({
      repoRoot: normalized,
      initialPath: initialPath ?? null,
      workspaceId: recentWorkspaceIdFromParts([root], []),
      name: root.name,
      roots: [root],
      looseFiles: [],
      initialFile: initialPath ? { kind: "root", rootId: root.id, path: initialPath } : null,
    });
  }, [openCodeWorkspaceInfo]);

  const openRecentCodeWorkspace = useCallback((workspace: RecentWorkspace) => {
    openCodeWorkspaceInfo({
      repoRoot: workspace.roots[0]?.path ?? "",
      workspaceId: workspace.id,
      name: workspace.name,
      roots: workspace.roots,
      looseFiles: workspace.looseFiles,
      initialFile: workspace.lastActiveFile ?? null,
    });
  }, [openCodeWorkspaceInfo]);

  const openEmptyCodeWorkspaceTab = useCallback(() => {
    const id = `code-workspace-${Date.now()}`;
    addTab({
      id,
      type: "code-workspace",
      title: "Code · Editor Workspace",
      closable: true,
      codeWorkspace: {
        repoRoot: "",
        workspaceId: id,
        workspaceInstanceId: newWorkspaceInstanceId(),
        name: "Editor Workspace",
        roots: [],
        looseFiles: [],
        initialFile: null,
      },
    });
  }, [addTab]);

  const openNewCodeWorkspaceFromWelcome = useCallback(async () => {
    const path = await selectFolderPath();
    if (path) openCodeWorkspaceTab(path);
  }, [openCodeWorkspaceTab]);

  const openGitRepository = useCallback(async (path?: string | null) => {
    const target = path ?? await selectFolderPath();
    if (!target) return;
    try {
      const probe = await gitProbePath(target);
      if (!probe.gitAvailable) {
        await alertAppDialog({
          title: "Git Repository",
          message: probe.error ?? "Git executable was not found.",
        });
        return;
      }
      if (probe.isRepo && probe.repoRoot) {
        openGitTab(probe.repoRoot);
        return;
      }
      const shouldInit = await confirmAppDialog({
        title: "Initialize Git repository",
        message: `"${target}" is not inside a Git repository. Initialize a new repository here?`,
        confirmLabel: "Initialize",
      });
      if (!shouldInit) return;
      const initialized = await gitInitRepo(target);
      openGitTab(initialized.repoRoot ?? target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusMessage(message);
      await alertAppDialog({ title: "Git Repository", message });
    }
  }, [openGitTab, setStatusMessage]);

  const activeTerminalGitAction = useMemo(() => {
    const tab = activeTab;
    if (
      !tab ||
      tab.type !== "terminal" ||
      tab.ssh ||
      tab.commandTerminal ||
      tab.sockscapTerminal
    ) {
      return undefined;
    }
    const cwd = terminalCwds[tab.id] ?? null;
    return {
      label: cwd ? `Git · ${cwd}` : "Git Repository",
      title: cwd ? `Open Git panel for ${cwd}` : "Open Git panel for the current terminal directory",
      onOpen: async () => {
        const latestCwd = terminalCwdsRef.current[tab.id] ?? await queryTerminalCwd(tab.id);
        if (!latestCwd) {
          await alertAppDialog({
            title: "Git Repository",
            message: "The current terminal directory is not available yet.",
          });
          return;
        }
        await openGitRepository(latestCwd);
      },
    };
  }, [activeTab, openGitRepository, queryTerminalCwd, terminalCwds]);

  const openBrowserSession = useCallback((session: SessionConfig) => {
    const url = browserUrlFromSession(session);
    if (!url) {
      setStatusMessage(tr("status.browserSessionMissing"));
      return;
    }
    void openExternalUrl(url).catch((err) => {
      setStatusMessage(tr("status.openFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    void markConnected(session.id);
  }, [markConnected, setStatusMessage]);

  const openSshTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const id = `ssh-${session.id}-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: session.name || `${session.username}@${session.host}`,
      sessionId: session.id,
      terminalTitleMode: "pending-auto",
      terminalTitleOperation: "new",
      terminalTitleSessionName: session.name || `${session.username ?? "root"}@${session.host}`,
      closable: true,
      ssh: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        optionsJson: session.options_json,
      },
      terminalProfile: getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile(),
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openCommandTerminalTab = useCallback((session: SessionConfig) => {
    const commandTerminal = commandTerminalFromSession(session);
    if (!commandTerminal) {
      setStatusMessage(
        session.session_type === "Serial"
          ? tr("status.serialSessionMissing")
          : tr("status.remoteSessionMissing"),
      );
      return;
    }
    const id = `${session.session_type.toLowerCase()}-${session.id}-${Date.now()}`;
    const title = session.name || (
      session.session_type === "Serial"
        ? commandTerminal.host
        : `${session.session_type} ${commandTerminal.username ? `${commandTerminal.username}@` : ""}${commandTerminal.host}`
    );
    addTab({
      id,
      type: "terminal",
      title,
      sessionId: session.id,
      terminalTitleMode: "pending-auto",
      terminalTitleOperation: "new",
      terminalTitleSessionName: session.name || title,
      closable: true,
      commandTerminal,
      terminalProfile: getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile(),
    });
    void markConnected(session.id);
  }, [addTab, markConnected, setStatusMessage]);

  const openUnsupportedTab = useCallback((session: SessionConfig) => {
    const id = `${session.session_type.toLowerCase()}-${session.id}-${Date.now()}`;
    const kind = ["SFTP", "VNC"].includes(session.session_type)
      ? session.session_type.toLowerCase()
      : "placeholder";
    addTab({
      id,
      type: kind as "sftp" | "vnc" | "placeholder",
      title: session.name || session.host || session.session_type,
      sessionId: session.id,
      closable: true,
      message: `${session.session_type} connection UI is present, but its backend is outside Phase 1-2. Session data is saved and can be edited from the sidebar.`,
    });
  }, [addTab]);

  const queueVaultUnlock = useCallback((session: SessionConfig): ConnectQueueOutcome => {
    connectQueueRef.current.unshift(session);
    awaitingVaultUnlockRef.current = true;
    pendingVaultActionRef.current = () => {
      awaitingVaultUnlockRef.current = false;
      continueConnectQueueRef.current();
    };
    setVaultUnlockReason((current) => current ?? tr(SAVED_PASSWORD_VAULT_REASON_KEY));
    return "awaiting-vault";
  }, []);

  const openAfterJumpPassword = useCallback((
    session: SessionConfig,
    open: (session: SessionConfig) => void,
  ): ConnectQueueOutcome => {
    const missing = missingJumpPasswordForSession(session, sessions);
    if (missing) {
      awaitingManualAuthRef.current = true;
      setPendingAuth({
        kind: "jump",
        ...missing,
        onResolved: open,
      });
      return "awaiting-auth";
    }
    open(session);
    return "opened";
  }, [sessions]);

  const openQueuedSession = useCallback((
    session: SessionConfig,
    localShellOverride?: LocalShellSelection,
  ): ConnectQueueOutcome => {
    if (session.session_type === "SSH") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          return openAfterJumpPassword(session, (effectiveSession) => openSshTab(effectiveSession, "Password", ref));
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ kind: "session", session });
          return "awaiting-auth";
        }
      } else {
        return openAfterJumpPassword(session, (effectiveSession) => openSshTab(effectiveSession, method, data));
      }
    } else if (session.session_type === "SFTP") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          return openAfterJumpPassword(session, (effectiveSession) => openSftpTab(effectiveSession, "Password", ref));
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ kind: "session", session });
          return "awaiting-auth";
        }
      } else {
        return openAfterJumpPassword(session, (effectiveSession) => openSftpTab(effectiveSession, method, data));
      }
    } else if (session.session_type === "LocalShell") {
      openLocalTab(
        session.name || tr("tabs.localTerminal"),
        session.id,
        getSessionTerminalProfile(session.options_json),
        localShellOverride ?? localShellSelectionFromSession(session),
      );
    } else if (session.session_type === "VNC") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          openVncTab(session, ref);
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ kind: "session", session });
          return "awaiting-auth";
        }
      } else {
        openVncTab(session, data ?? undefined);
      }
    } else if (session.session_type === "RDP") {
      const { method, data } = resolveSessionAuth(session);
      if (method === "Password") {
        const ref = passwordRefFromOptions(session);
        if (ref) {
          const vaultState = useVaultStore.getState().state;
          if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
          return openAfterJumpPassword(session, (effectiveSession) => openRdpTab(effectiveSession, ref));
        } else {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ kind: "session", session });
          return "awaiting-auth";
        }
      } else {
        return openAfterJumpPassword(session, (effectiveSession) => openRdpTab(effectiveSession, data ?? undefined));
      }
    } else if (session.session_type === "File") {
      openFileSession(session);
    } else if (session.session_type === "Browser") {
      openBrowserSession(session);
    } else if (COMMAND_TERMINAL_SESSION_TYPES.has(session.session_type)) {
      openCommandTerminalTab(session);
    } else if (
      session.session_type === "MySQL" ||
      session.session_type === "PostgreSQL" ||
      session.session_type === "PanWeiDB" ||
      session.session_type === "Oracle" ||
      session.session_type === "SQLServer" ||
      session.session_type === "StarRocks" ||
      session.session_type === "ClickHouse" ||
      session.session_type === "Presto" ||
      session.session_type === "Redis"
    ) {
      // DB sessions store the password as a vault: ref in options_json. Many
      // databases (notably Redis / trust-auth Postgres) connect without one,
      // so a missing ref just means "no password" — we don't force a prompt.
      const ref = passwordRefFromOptions(session);
      if (ref) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
        return openAfterJumpPassword(session, (effectiveSession) => openDbTab(effectiveSession, ref));
      } else {
        return openAfterJumpPassword(session, (effectiveSession) => openDbTab(effectiveSession, undefined));
      }
    } else if (session.session_type === "HBaseShell") {
      const ref = passwordRefFromOptions(session);
      if (ref) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
        openHBaseShellTab(session, ref);
      } else {
        openHBaseShellTab(session, undefined);
      }
    } else if (session.session_type === "Proxy") {
      openProxyTestTab(session);
    } else if (session.session_type === "S3" || session.session_type === "AzureBlob") {
      // Secrets are vault: refs in options_json; resolve happens server-side on
      // attach. If any secret is vault-backed and the vault is locked, unlock
      // first so the attach doesn't fail with a cryptic error.
      if (objectStorageHasVaultSecret(session)) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
      }
      return openAfterJumpPassword(session, openObjectStorageTab);
    } else if (session.session_type === "Mail") {
      const existing = tabsRef.current.find((tab) => tab.type === "mail" && tab.sessionId === session.id);
      if (existing) {
        setActiveTab(existing.id);
        return "opened";
      }
      const ref = passwordRefFromOptions(session);
      const smtpRef = mailSmtpPasswordRefFromOptions(session);
      if (ref || smtpRef) {
        const vaultState = useVaultStore.getState().state;
        if (vaultState !== "unlocked" && vaultState !== "empty") return queueVaultUnlock(session);
      }
      openMailTab(session, ref ?? undefined, smtpRef ?? undefined);
    } else {
      openUnsupportedTab(session);
      void markConnected(session.id);
    }
    return "opened";
  }, [
    markConnected,
    openBrowserSession,
    openCommandTerminalTab,
    openFileSession,
    openLocalTab,
    openSftpTab,
    openSshTab,
    openUnsupportedTab,
    openVncTab,
    openRdpTab,
    openDbTab,
    openHBaseShellTab,
    openProxyTestTab,
    openObjectStorageTab,
    openMailTab,
    queueVaultUnlock,
    openAfterJumpPassword,
    setActiveTab,
  ]);

  const continueConnectQueue = useCallback(() => {
    if (connectQueueRunningRef.current || awaitingManualAuthRef.current || awaitingVaultUnlockRef.current) return;
    connectQueueRunningRef.current = true;
    try {
      while (connectQueueRef.current.length > 0) {
        const session = connectQueueRef.current.shift();
        if (!session) continue;
        const outcome = openQueuedSession(session);
        if (outcome !== "opened") return;
      }
    } finally {
      connectQueueRunningRef.current = false;
    }
  }, [openQueuedSession]);

  useEffect(() => {
    continueConnectQueueRef.current = continueConnectQueue;
  }, [continueConnectQueue]);

  const handleConnectSession = useCallback((session: SessionConfig) => {
    connectQueueRef.current.push(session);
    continueConnectQueue();
  }, [continueConnectQueue]);

  const handleConnectSessions = useCallback((targets: SessionConfig[]) => {
    const seen = new Set<string>();
    const unique = targets.filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
    if (unique.length === 0) return;
    connectQueueRef.current.push(...unique);
    continueConnectQueue();
  }, [continueConnectQueue]);

  const handleRevealRecentSession = useCallback((session: SessionConfig) => {
    setActiveSideTab("sessions");
    setSidebarCollapsed(false);
    setSelectedSession(session.id);
    setSearchQuery("");
    setStatusMessage(tr("status.revealedSession", { name: session.name || session.host || session.session_type }));
  }, [setActiveSideTab, setSearchQuery, setSelectedSession, setSidebarCollapsed, setStatusMessage, tr]);

  const handleAuthSubmit = useCallback(async (password: string, saveToVault: boolean) => {
    if (!pendingAuth) return;
    const session = pendingAuth.session;
    let credential: string = password;

    if (pendingAuth.kind === "jump") {
      let persistJumpPasswordOnTarget = false;
      if (saveToVault) {
        const ready = await ensureVaultReady(tr(SAVED_PASSWORD_VAULT_REASON_KEY));
        if (ready) {
          try {
            const label = `${pendingAuth.username}@${pendingAuth.host}:${pendingAuth.port}`;
            const result = await vaultPut("ssh-password", label, password);
            credential = result.reference;

            if (pendingAuth.jumpSession) {
              const opts = parseSessionOptions(pendingAuth.jumpSession.options_json);
              await updateSession({
                ...pendingAuth.jumpSession,
                options_json: JSON.stringify({ ...opts, passwordRef: result.reference }),
              });
            } else if (pendingAuth.manual) {
              persistJumpPasswordOnTarget = true;
              await updateSession(sessionWithJumpPassword(session, result.reference, true));
            }
          } catch (err) {
            console.error("Failed to save jump host password to vault:", err);
            credential = password;
            persistJumpPasswordOnTarget = false;
          }
        }
      }

      pendingAuth.onResolved(sessionWithJumpPassword(session, credential, persistJumpPasswordOnTarget));
      setPendingAuth(null);
      awaitingManualAuthRef.current = false;
      continueConnectQueueRef.current();
      return;
    }

    if (saveToVault) {
      // Make sure the vault is ready (set master password if empty, unlock if
      // locked) via the on-demand gate before encrypting. If the user cancels
      // the gate, fall back to a one-shot connect with the typed plaintext.
      const ready = await ensureVaultReady(tr(SAVED_PASSWORD_VAULT_REASON_KEY));
      if (ready) {
        try {
          const kind =
            session.session_type === "VNC"
              ? "vnc-password"
              : session.session_type === "RDP"
                ? "rdp-password"
                : "ssh-password";
          const label = `${session.username || "user"}@${session.host || "?"}:${session.port}`;
          const result = await vaultPut(kind, label, password);
          credential = result.reference;

          // Persist the vault reference back into options_json so future
          // connects find it without re-prompting.
          const opts = parseSessionOptions(session.options_json);
          const updated = JSON.stringify({ ...opts, passwordRef: result.reference });
          await updateSession({ ...session, options_json: updated });
        } catch (err) {
          // On any vault error, fall back to one-shot connect with the typed
          // plaintext — don't block the user.
          console.error("Failed to save password to vault:", err);
          credential = password;
        }
      }
    }

    let outcome: ConnectQueueOutcome = "opened";
    if (session.session_type === "SFTP") {
      outcome = openAfterJumpPassword(session, (effectiveSession) => openSftpTab(effectiveSession, "Password", credential));
    } else if (session.session_type === "VNC") {
      openVncTab(session, credential);
    } else if (session.session_type === "RDP") {
      outcome = openAfterJumpPassword(session, (effectiveSession) => openRdpTab(effectiveSession, credential));
    } else {
      outcome = openAfterJumpPassword(session, (effectiveSession) => openSshTab(effectiveSession, "Password", credential));
    }
    if (outcome === "opened") {
      setPendingAuth(null);
      awaitingManualAuthRef.current = false;
      continueConnectQueueRef.current();
    }
  }, [pendingAuth, openAfterJumpPassword, openSftpTab, openSshTab, openVncTab, openRdpTab, updateSession]);

  const handleQuickConnect = useCallback((value: string) => {
    try {
      const parsed = parseQuickConnectInput(value);
      const session = parsed.config;
      if (session.session_type === "LocalShell") {
        openLocalTab(session.name);
      } else if (session.session_type === "Browser") {
        openBrowserSession(session);
      } else if (session.session_type === "Mail") {
        openMailTab(session);
      } else if (COMMAND_TERMINAL_SESSION_TYPES.has(session.session_type)) {
        openCommandTerminalTab(session);
      } else if (
        session.session_type === "SSH"
        || session.session_type === "SFTP"
        || session.session_type === "RDP"
        || session.session_type === "VNC"
      ) {
        if (session.auth_method === "Password") {
          awaitingManualAuthRef.current = true;
          setPendingAuth({ kind: "session", session });
        } else {
          const authMethod = typeof session.auth_method === "string" ? session.auth_method : "PrivateKey";
          if (session.session_type === "SFTP") {
            openSftpTab(session, authMethod, parsed.authData);
          } else if (session.session_type === "RDP") {
            openRdpTab(session, parsed.authData ?? undefined);
          } else if (session.session_type === "VNC") {
            openVncTab(session, parsed.authData ?? undefined);
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
  }, [openBrowserSession, openCommandTerminalTab, openLocalTab, openMailTab, openRdpTab, openSftpTab, openSshTab, openVncTab, openUnsupportedTab, setStatusMessage]);

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
      title: t("tabs.settings"),
      closable: true,
    });
  }, [addTab, setActiveTab]);

  useEffect(() => {
    const onOpenSettingsSection = () => {
      openSettingsTab();
    };
    window.addEventListener("taomni:open-settings-section", onOpenSettingsSection);
    return () => window.removeEventListener("taomni:open-settings-section", onOpenSettingsSection);
  }, [openSettingsTab]);

  const executeControlTool = useCallback(async (dispatch: ControlToolDispatch) => {
    let ok = false;
    let output = "";
    const args = dispatch.args ?? {};
    const resolveTab = (raw: unknown): Tab | undefined => {
      const id = String(raw ?? "").trim();
      if (!id) return undefined;
      return tabsRef.current.find((tab) => tab.id === id);
    };
    const resolveSession = async (): Promise<SessionConfig | null> => {
      const sessionId = String(args.session_id ?? "").trim();
      if (sessionId) {
        let found = useSessionStore.getState().sessions.find((s) => s.id === sessionId) ?? null;
        if (!found) {
          await loadSessions();
          found = useSessionStore.getState().sessions.find((s) => s.id === sessionId) ?? null;
        }
        return found;
      }
      const query = String(args.query ?? "").trim().toLowerCase();
      if (!query) return null;
      let all = useSessionStore.getState().sessions;
      if (all.length === 0) {
        await loadSessions();
        all = useSessionStore.getState().sessions;
      }
      const matches = all.filter((s) =>
        s.id.toLowerCase() === query ||
        s.name.toLowerCase().includes(query) ||
        s.host.toLowerCase().includes(query)
      );
      return matches.length === 1 ? matches[0] : null;
    };

    try {
      switch (dispatch.tool) {
        case "session_open": {
          const session = await resolveSession();
          if (!session) {
            output = "session_open could not resolve a unique session";
            break;
          }
          const localShell = controlLocalShellSelection(args);
          if (localShell.error) {
            output = localShell.error;
            break;
          }
          if (localShell.localShell && session.session_type !== "LocalShell") {
            output = "local_shell only applies to saved LocalShell sessions";
            break;
          }
          const outcome = openQueuedSession(session, localShell.localShell);
          if (outcome === "opened") {
            ok = true;
            output = `opened session ${session.id}`;
          } else {
            ok = true;
            output = `session ${session.id} queued: ${outcome}`;
          }
          break;
        }
        case "session_open_editor": {
          const sessionId = String(args.session_id ?? "").trim();
          if (sessionId) {
            const session = await resolveSession();
            if (!session) {
              output = `session not found: ${sessionId}`;
              break;
            }
            setEditingSession(session);
            setNewSessionGroupPath(null);
            setNewSessionInitialProto(undefined);
          } else {
            setEditingSession(undefined);
            setNewSessionGroupPath(typeof args.group_path === "string" ? args.group_path : null);
            setNewSessionInitialProto(typeof args.session_type === "string" ? args.session_type : undefined);
          }
          setShowSessionEditor(true);
          ok = true;
          output = "session editor opened";
          break;
        }
        case "quick_connect": {
          const input = String(args.input ?? "").trim();
          if (!input) {
            output = "quick_connect requires input";
            break;
          }
          handleQuickConnect(input);
          ok = true;
          output = "quick connect submitted";
          break;
        }
        case "tab_list": {
          const tabs = useAppStore.getState().tabs.map((tab, index) => ({
            id: tab.id,
            title: tab.title,
            type: tab.type,
            sessionId: tab.sessionId ?? null,
            active: tab.id === useAppStore.getState().activeTabId,
            index,
          }));
          ok = true;
          output = JSON.stringify(tabs, null, 2);
          break;
        }
        case "tab_switch": {
          const tab = resolveTab(args.tab_id);
          if (!tab) {
            output = `tab not found: ${String(args.tab_id ?? "")}`;
            break;
          }
          setActiveTab(tab.id);
          ok = true;
          output = `switched to tab ${tab.id}`;
          break;
        }
        case "tab_duplicate": {
          const tab = resolveTab(args.tab_id);
          if (!tab) {
            output = `tab not found: ${String(args.tab_id ?? "")}`;
            break;
          }
          await handleDuplicateTab(tab.id);
          ok = true;
          output = `duplicated tab ${tab.id}`;
          break;
        }
        case "tab_rename": {
          const tab = resolveTab(args.tab_id);
          const title = String(args.title ?? "").trim();
          if (!tab || !title) {
            output = "tab_rename requires a valid tab_id and title";
            break;
          }
          updateTabTitle(tab.id, title);
          ok = true;
          output = `renamed tab ${tab.id}`;
          break;
        }
        case "tab_close": {
          const tab = resolveTab(args.tab_id);
          if (!tab) {
            output = `tab not found: ${String(args.tab_id ?? "")}`;
            break;
          }
          if (!tab.closable) {
            output = `tab is not closable: ${tab.id}`;
            break;
          }
          removeTab(tab.id);
          ok = true;
          output = `closed tab ${tab.id}`;
          break;
        }
        case "tab_move": {
          const tab = resolveTab(args.tab_id);
          const toIndex = Number(args.to_index);
          if (!tab || !Number.isInteger(toIndex)) {
            output = "tab_move requires a valid tab_id and integer to_index";
            break;
          }
          moveTabToIndex(tab.id, toIndex);
          ok = true;
          output = `moved tab ${tab.id} to index ${toIndex}`;
          break;
        }
        case "tab_open_settings": {
          openSettingsTab();
          ok = true;
          output = "settings tab opened";
          break;
        }
        case "tab_open_local_terminal": {
          const localShell = controlLocalShellSelection(args);
          if (localShell.error) {
            output = localShell.error;
            break;
          }
          openLocalTab(
            typeof args.title === "string" ? args.title : localShell.localShell?.name,
            undefined,
            undefined,
            localShell.localShell,
          );
          ok = true;
          output = "local terminal opened";
          break;
        }
        case "tab_open_file_browser": {
          const path = String(args.path ?? "").trim();
          if (!path) {
            output = "tab_open_file_browser requires path";
            break;
          }
          openFileBrowserTab(typeof args.title === "string" ? args.title : path, path);
          ok = true;
          output = `file browser opened: ${path}`;
          break;
        }
        default:
          output = `unsupported control tool: ${dispatch.tool}`;
      }
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
    }

    try {
      await invoke("cc_resolve_tool_call", {
        callId: dispatch.callId,
        ok,
        output,
      });
    } catch (err) {
      console.error("cc_resolve_tool_call failed:", err);
    }
  }, [
    handleDuplicateTab,
    handleQuickConnect,
    loadSessions,
    moveTabToIndex,
    openFileBrowserTab,
    openLocalTab,
    openQueuedSession,
    openSettingsTab,
    removeTab,
    setActiveTab,
    updateTabTitle,
  ]);

  useEffect(() => {
    executeControlToolRef.current = executeControlTool;
  }, [executeControlTool]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<ControlToolDispatch>("agent-cc-control-tool", (event) => {
      const executor = executeControlToolRef.current;
      if (!executor) return;
      const callId = event.payload.callId;
      const seen = seenControlToolCallsRef.current;
      if (seen.has(callId)) return;
      if (seen.size > 5000) seen.clear();
      seen.add(callId);
      void executor(event.payload);
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const openLanChatTab = useCallback(() => {
    // If LanChat is currently docked as an edge drawer, undock it; the
    // edgeDock effect below restores and focuses the tab.
    if (useLanChatStore.getState().edgeDock) {
      useLanChatStore.getState().closeEdgeDock();
      return;
    }
    const existing = tabsRef.current.find((tab) => tab.type === "lan-chat");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: "lan-chat",
      type: "lan-chat",
      title: t("tabs.lanChat"),
      closable: true,
    });
  }, [addTab, setActiveTab]);

  // Initialize LanChat at app startup (not only when the tab opens) so roster,
  // unread, and desktop notifications work even while the tab is closed.
  useEffect(() => {
    void useLanChatStore.getState().init();
  }, []);

  // Keep the lan-chat tab and the in-app edge drawer mutually exclusive.
  // Docking (null → side) hides the main-window tab; undocking (side → null,
  // via the drawer close button or Esc) restores and focuses it. Chat state
  // survives because the store stays alive regardless of the tab's presence.
  const edgeDock = useLanChatStore((s) => s.edgeDock);
  const prevEdgeDock = useRef(edgeDock);
  useEffect(() => {
    const prev = prevEdgeDock.current;
    prevEdgeDock.current = edgeDock;
    if (prev === null && edgeDock !== null) {
      removeTab("lan-chat");
    } else if (prev !== null && edgeDock === null) {
      if (!tabsRef.current.some((tab) => tab.id === "lan-chat")) {
        addTab({
          id: "lan-chat",
          type: "lan-chat",
          title: tr("tabs.lanChat"),
          closable: true,
        });
      }
      setActiveTab("lan-chat");
    }
  }, [edgeDock, addTab, removeTab, setActiveTab]);

  // Mirror total LanChat unread onto the lan-chat tab's new-output indicator
  // (cleared while that tab is active).
  const lanUnread = useLanChatStore((s) => totalUnread(s.conversations));
  useEffect(() => {
    const hasUnread = lanUnread > 0 && activeTabId !== "lan-chat";
    setTabHasNewOutput("lan-chat", hasUnread);
  }, [lanUnread, activeTabId, setTabHasNewOutput]);

  const toggleQuickConnectVisible = useCallback(() => {
    const next = !quickConnectVisible;
    setQuickConnectVisible(next);
    writeQuickConnectVisible(next);
    setStatusMessage(tr(next ? "status.quickConnectShown" : "status.quickConnectHidden"));
  }, [quickConnectVisible, setStatusMessage]);

  const handleCommand = useCallback((command: AppCommand) => {
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
        setStatusMessage(tr("status.sessionsReloaded"));
        break;
      case "toggle-xserver":
        toggleXServer();
        break;
      case "view":
        toggleSidebar();
        break;
      case "toggle-quick-connect":
        toggleQuickConnectVisible();
        break;
      case "servers":
        useServersStore.getState().openDialog(tr("servers.dialogTitle"));
        break;
      case "sessions":
        setSidebarCollapsed(false);
        break;
      case "split":
        toggleTerminalSplit();
        break;
      case "multiexec":
        toggleMultiExec();
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
            title: t("tunnels.title"),
            closable: true,
          });
        }
        break;
      }
      case "sockscap": {
        const existing = tabsRef.current.find((tab) => tab.type === "sockscap");
        if (existing) {
          setActiveTab(existing.id);
        } else {
          addTab({
            id: "sockscap-main",
            type: "sockscap",
            title: t("sockscap.title"),
            closable: true,
          });
        }
        break;
      }
      case "tools":
        openPlaceholderTab(t("tabs.networkTools"), t("status.commandUnavailable"));
        break;
      case "git":
        void openGitRepository();
        break;
      case "code-workspace":
        openEmptyCodeWorkspaceTab();
        break;
      case "settings":
        openSettingsTab();
        break;
      case "lan-chat":
        openLanChatTab();
        break;
      case "help":
        setShowAbout(true);
        break;
      default:
        setStatusMessage(tr("status.commandUnavailable"));
    }
  }, [
    activeTab,
    handleNewSession,
    handleNewSftpSession,
    loadSessions,
    openLocalTab,
    openGitRepository,
    openEmptyCodeWorkspaceTab,
    openPlaceholderTab,
    openSettingsTab,
    openLanChatTab,
    removeTab,
    requestAppExit,
    setActiveTab,
    setStatusMessage,
    setSidebarCollapsed,
    toggleQuickConnectVisible,
    toggleTerminalSplit,
    toggleSidebar,
    toggleXServer,
  ]);

  // Route a native-menu activation to the right place: session import/export
  // is handled by the shared hook, everything else reuses handleCommand.
  const dispatchMenuAction = useCallback((action: MenuActionId) => {
    if (action.startsWith("workspace-command:")) {
      activeWorkspaceCommandRegistration?.execute(action.slice("workspace-command:".length));
      return;
    }
    switch (action) {
      case "import-json": importExport.importJson(); break;
      case "import-moba": importExport.importMoba(); break;
      case "import-csv": importExport.importCsv(); break;
      case "download-csv-template": importExport.downloadCsvTemplate(); break;
      case "import-openssh": importExport.importOpenSsh(); break;
      case "export-json": importExport.exportJson(); break;
      case "export-moba": importExport.exportMoba(); break;
      case "export-csv": importExport.exportCsv(); break;
      case "export-html": importExport.exportHtml(); break;
      default:
        handleCommand(action as AppCommand);
    }
  }, [activeWorkspaceCommandRegistration, handleCommand, importExport]);

  const dispatchMenuActionRef = useRef(dispatchMenuAction);
  useEffect(() => {
    dispatchMenuActionRef.current = dispatchMenuAction;
  }, [dispatchMenuAction]);

  // Build + install the macOS global menu. Rebuilt whenever a piece of state
  // shown in the menu changes (checkmarks, enabled state) — all low-frequency,
  // so a full rebuild is simpler and cheaper than mutating individual items.
  useEffect(() => {
    if (!nativeMenu) return;
    let cancelled = false;
    const spec = buildAppMenuSpec({
      activeTabClosable: !!activeTab?.closable,
      hasSessions: importExport.hasSessions,
      quickConnectVisible,
      workspaceCommands: activeWorkspaceCommandRegistration?.items ?? [],
      t,
    });
    void installAppMenu(spec, (action) => dispatchMenuActionRef.current(action)).catch((err) => {
      if (!cancelled) console.error("Failed to install application menu", err);
    });
    return () => {
      cancelled = true;
    };
  }, [
    nativeMenu,
    activeTab?.closable,
    importExport.hasSessions,
    quickConnectVisible,
    activeWorkspaceCommandRegistration?.items,
    t,
  ]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const tabIndex = macCommandDigitIndex(event);
      if (tabIndex !== null) {
        event.preventDefault();
        event.stopPropagation();

        const state = useAppStore.getState();
        const target = tabIndex === -1 ? state.tabs.at(-1) : state.tabs[tabIndex];
        if (target && target.id !== state.activeTabId) {
          setActiveTab(target.id);
        }
        return;
      }

      const primary = event.ctrlKey || event.metaKey;
      if (!primary || !event.shiftKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "n") return;

      if (key === "t") {
        event.preventDefault();
        event.stopPropagation();
        handleCommand("new-terminal");
        return;
      }

      const state = useAppStore.getState();
      const current = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (current?.type === "welcome") {
        event.preventDefault();
        event.stopPropagation();
        handleCommand("new-session");
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [handleCommand, setActiveTab]);

  const terminalTabs = tabs.filter((t) => t.type === "terminal");
  const sftpTabs = tabs.filter((t) => t.type === "sftp" && t.sftp);
  const settingsTabs = tabs.filter((t) => t.type === "settings");
  const gitTabs = tabs.filter((t) => t.type === "git" && t.git);
  const codeWorkspaceTabs = tabs.filter((t) => t.type === "code-workspace" && t.codeWorkspace);
  const vncTabs = tabs.filter((t) => t.type === "vnc" && t.vnc);
  const rdpTabs = tabs.filter((t) => t.type === "rdp" && t.rdp);
  const fileBrowserTabs = tabs.filter((t) => t.type === "file-browser" && t.fileBrowser);
  const objectStorageTabs = tabs.filter((t) => t.type === "object-storage" && t.objectStorage);
  const dbTabs = tabs.filter((t) => t.type === "database" && t.db);
  const redisTabs = tabs.filter((t) => t.type === "redis" && t.db);
  const hbaseTabs = tabs.filter((t) => t.type === "hbase-shell" && t.hbase);
  const mailTabs = tabs.filter((t) => t.type === "mail" && t.mail);
  const terminalSplitVisible =
    terminalSplitActive && terminalTabs.length > 0 && activeTab?.type === "terminal";
  const effectiveMultiExecSelectedCount = terminalSplitActive
    ? [...multiExecSelectedTabIds].filter((id) => !terminalSplitInputLockedTabIds.has(id)).length
    : multiExecSelectedTabIds.size;
  const splitGridColumns = Math.max(1, Math.ceil(Math.sqrt(terminalTabs.length)));
  const splitGridRows = Math.max(1, Math.ceil(terminalTabs.length / splitGridColumns));
  const splitPaneWeightsForTabs = useMemo(
    () => terminalTabs.map((tab) => positiveWeight(splitPaneWeights[tab.id])),
    [splitPaneWeights, terminalTabs],
  );
  const splitGridColumnWeightsForLayout = useMemo(
    () => axisWeights(splitGridColumnWeights, splitGridColumns),
    [splitGridColumnWeights, splitGridColumns],
  );
  const splitGridRowWeightsForLayout = useMemo(
    () => axisWeights(splitGridRowWeights, splitGridRows),
    [splitGridRowWeights, splitGridRows],
  );
  const splitGridColumnTemplate = weightsToGridTemplate(splitGridColumnWeightsForLayout);
  const splitGridRowTemplate = weightsToGridTemplate(splitGridRowWeightsForLayout);
  const terminalPanesClass = terminalSplitVisible
    ? terminalSplitLayout === "horizontal"
      ? "flex-1 min-h-0 flex flex-row relative"
      : terminalSplitLayout === "vertical"
        ? "flex-1 min-h-0 flex flex-col relative"
        : "flex-1 min-h-0 grid relative"
    : "contents";

  const startLinearSplitResize = useCallback((
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!terminalSplitVisible || terminalSplitLayout === "grid") return;
    const container = splitPanesRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const horizontal = terminalSplitLayout === "horizontal";
    const dimension = horizontal ? rect.width : rect.height;
    if (dimension <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const ids = terminalTabs.map((tab) => tab.id);
    const initialWeights = ids.map((id) => positiveWeight(splitPaneWeights[id]));
    const totalWeight = sumWeights(initialWeights);
    const startCoord = horizontal ? event.clientX : event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentCoord = horizontal ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = ((currentCoord - startCoord) / dimension) * totalWeight;
      const nextWeights = resizeAdjacentWeights(initialWeights, index, deltaWeight);
      setSplitPaneWeights((prev) => {
        const next = { ...prev };
        ids.forEach((id, weightIndex) => {
          next[id] = nextWeights[weightIndex];
        });
        return next;
      });
    };

    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [splitPaneWeights, terminalSplitLayout, terminalSplitVisible, terminalTabs]);

  const startGridSplitResize = useCallback((
    axis: "column" | "row",
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!terminalSplitVisible || terminalSplitLayout !== "grid") return;
    const container = splitPanesRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dimension = axis === "column" ? rect.width : rect.height;
    if (dimension <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const initialWeights = axis === "column"
      ? splitGridColumnWeightsForLayout
      : splitGridRowWeightsForLayout;
    const totalWeight = sumWeights(initialWeights);
    const startCoord = axis === "column" ? event.clientX : event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentCoord = axis === "column" ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = ((currentCoord - startCoord) / dimension) * totalWeight;
      const nextWeights = resizeAdjacentWeights(initialWeights, index, deltaWeight);
      if (axis === "column") {
        setSplitGridColumnWeights(nextWeights);
      } else {
        setSplitGridRowWeights(nextWeights);
      }
    };

    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [
    splitGridColumnWeightsForLayout,
    splitGridRowWeightsForLayout,
    terminalSplitLayout,
    terminalSplitVisible,
  ]);

  // macOS uses the native overlay title bar (traffic lights + native resize),
  // so the custom resize handles are Windows/Linux only.
  const isMac = getAppPlatform() === "macos";
  const chatDockViewport = useViewportSize();
  // After the drawer has been opened once, keep ChatDrawer mounted (hidden)
  // across tab switches so the transcript does not remount and re-animate.
  const [chatDrawerKeepAlive, setChatDrawerKeepAlive] = useState(false);
  useEffect(() => {
    if (chatDrawerOpen) setChatDrawerKeepAlive(true);
  }, [chatDrawerOpen]);
  const chatDrawerSurfaceActive = !aiFullyDisabled && (chatDrawerOpen || chatDrawerKeepAlive);
  const chatDockMode = chatDrawerSurfaceActive
    ? resolveChatDock(chatDrawerPosition, chatDrawerPinned, chatDockViewport.width, chatDockViewport.height)
    : "floating";
  const chatDrawerInline = chatDockMode === "side-inline";
  const chatDrawerTopPinned = chatDockMode === "stacked-inline" && chatDrawerPosition === "top";
  const chatDrawerBottomPinned = chatDockMode === "stacked-inline" && chatDrawerPosition === "bottom";
  const chatDrawerFloating = chatDrawerSurfaceActive && chatDockMode === "floating";

  return (
    <TabActionSlotProvider slot={tabActionSlot}>
    <div
      className="relative w-full h-full flex flex-col"
      style={{ background: "var(--taomni-chrome-bg)" }}
    >
      {!isMac && <WindowResizeHandles />}
      <ControlBar
        activeTabClosable={!!activeTab?.closable}
        nativeMenu={nativeMenu}
        xServerEnabled={xServerEnabled}
        quickConnectVisible={quickConnectVisible}
        workspaceCommands={activeWorkspaceCommandRegistration?.items ?? []}
        onCommand={handleCommand}
        onWorkspaceCommand={(commandId) => activeWorkspaceCommandRegistration?.execute(commandId)}
        onToggleSidebar={toggleSidebar}
        onStartLocalTerminal={(localShell) =>
          openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell)
        }
        onConnectSession={handleConnectSession}
        onOpenSessionEditor={() => handleNewSession()}
        onDuplicateTab={handleDuplicateTab}
        onDetachActiveTab={
          activeTab && (
            (activeTab.type === "terminal" && !terminalSplitVisible) ||
            (activeTab.type === "rdp" && !!activeTab.rdp) ||
            (activeTab.type === "vnc" && !!activeTab.vnc) ||
            (activeTab.type === "database" && !!activeTab.db) ||
            (activeTab.type === "sftp" && !!activeTab.sftp)
          )
            ? handleDetachActiveTab
            : undefined
        }
        onCloseWindow={requestAppExit}
        slotRef={setTabActionSlot}
      />
      {quickConnectVisible && (
        <QuickConnect
          onConnectInput={handleQuickConnect}
          onConnectSession={handleConnectSession}
          onHome={() => setActiveTab("welcome")}
        />
      )}

      {chatDrawerTopPinned && <ChatDrawer />}

      <div className="flex-1 flex min-h-0">
        {sidebarCollapsed && (
          <div data-testid="collapsed-sidebar-rail" className="h-full w-[30px] shrink-0 overflow-visible">
            <Sidebar
              compact
              onNewSession={handleNewSession}
              onNewSftpSession={handleNewSftpSession}
              onEditSession={handleEditSession}
              onConnectSession={handleConnectSession}
              onOpenSettings={() => handleCommand("settings")}
              onCommand={handleCommand}
              gitAction={activeTerminalGitAction}
            />
          </div>
        )}
        <PanelGroup
          orientation="horizontal"
          id="main-layout"
          defaultLayout={loadResizableLayout("main-layout", ["sidebar", "content"])}
          onLayoutChanged={saveResizableLayout("main-layout")}
          className="flex-1 min-w-0"
          // Shrink the resize hit target to match the 3px visible divider.
          // The library default ({coarse:20, fine:10}) inflates a thin Separator's
          // hit area symmetrically, so ~3.5px of it overflowed rightward onto the
          // terminal's first column — there a left-edge mousedown was captured as a
          // resize (col-resize cursor) instead of starting a text selection. Sizing
          // the hit target to the divider width keeps it from bleeding onto content.
          resizeTargetMinimumSize={{ coarse: 3, fine: 3 }}
        >
          <Panel
            panelRef={sidebarPanelRef}
            id="sidebar"
            defaultSize="22%"
            minSize="15%"
            maxSize="40%"
            collapsible
            collapsedSize={0}
            onResize={(size: PanelSize) => {
              const percentage = size.asPercentage;
              if (percentage > 2) {
                lastSidebarSizeRef.current = percentage;
              }
              setSidebarCollapsed(percentage <= 2);
            }}
          >
            <div className="h-full overflow-hidden" style={sidebarCollapsed ? { display: "none" } : undefined}>
              <Sidebar
                onNewSession={handleNewSession}
                onNewSftpSession={handleNewSftpSession}
                onEditSession={handleEditSession}
                onConnectSession={handleConnectSession}
                onOpenSettings={() => handleCommand("settings")}
                onCommand={handleCommand}
                gitAction={activeTerminalGitAction}
              />
            </div>
          </Panel>

          <PanelResizeHandle
            data-testid="main-sidebar-resize-handle"
            className={sidebarCollapsed ? "hidden" : "w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"}
          />

          <Panel id="content">
            <div className="h-full flex min-w-0">
              {chatDrawerInline && chatDrawerPosition === "left" && <ChatDrawer />}
              <div className="h-full flex flex-col min-w-0 flex-1">
              {multiExecActive && (
                <MultiExecBar
                  selectedCount={effectiveMultiExecSelectedCount}
                  totalTerminalCount={tabs.filter((t) => t.type === "terminal").length}
                  onSend={broadcastToSelectedTerminals}
                  onSelectAll={selectAllTerminalTabs}
                  onClearSelection={clearMultiExecSelection}
                  onClose={toggleMultiExec}
                />
              )}
              <div className="flex-1 min-h-0 overflow-hidden relative">
                {/* Welcome stays mounted so filters, scroll, and shell
                    selections survive switching to another tab. */}
                <div
                  data-testid="welcome-tab-panel"
                  className="absolute inset-0"
                  style={{ display: (activeTab?.type === "welcome" || !activeTab) ? "block" : "none" }}
                >
                  <WelcomePanel
                    active={activeTab?.type === "welcome" || !activeTab}
                    onStartLocalTerminal={(localShell, cwd) => openLocalTab(localShell?.name ?? tr("tabs.localTerminal"), undefined, undefined, localShell, cwd)}
                    onNewSession={handleNewSession}
                    onOpenLocalPath={(path, opts) => void handleOpenLocalPath(path, opts)}
                    onOpenLanChat={openLanChatTab}
                    recentSessions={welcomeRecentSessions}
                    recentWorkspaces={recentWorkspaces}
                    mailSessions={welcomeMailSessions}
                    onOpenMailSession={handleConnectSession}
                    onOpenRecentSession={handleConnectSession}
                    onOpenRecentSessions={handleConnectSessions}
                    onEditRecentSession={handleEditSession}
                    onRevealRecentSession={handleRevealRecentSession}
                    onOpenRecentWorkspace={openRecentCodeWorkspace}
                    onRemoveRecentWorkspace={(workspace) => removeRecentWorkspace(workspace.id)}
                    onClearRecentWorkspaces={clearRecentWorkspaces}
                    onRevealRecentWorkspace={revealRecentCodeWorkspace}
                    onOpenNewWorkspace={() => void openNewCodeWorkspaceFromWelcome()}
                    onOpenSettings={openSettingsTab}
                  />
                </div>

                {/* All terminal tabs stay mounted. Single-tab mode hides
                    inactive panes; split mode only changes the pane wrappers. */}
                <div
                  data-testid="terminal-split-stage"
                  data-active={terminalSplitVisible || undefined}
                  data-split-layout={terminalSplitVisible ? terminalSplitLayout : undefined}
                  className={terminalSplitVisible ? "absolute inset-0 z-10 flex flex-col" : "contents"}
                >
                  <div style={{ display: terminalSplitVisible ? "block" : "none" }}>
                    <TerminalSplitToolbar
                      layout={terminalSplitLayout}
                      lockedCount={terminalSplitInputLockedTabIds.size}
                      onLayoutChange={setTerminalSplitLayout}
                      onClearLocks={clearTerminalSplitInputLocks}
                      onClose={toggleTerminalSplit}
                    />
                  </div>
                  <div
                    ref={splitPanesRef}
                    data-testid="terminal-split-panes"
                    data-layout={terminalSplitVisible ? terminalSplitLayout : undefined}
                    className={terminalPanesClass}
                    style={terminalSplitVisible && terminalSplitLayout === "grid"
                      ? {
                        gridTemplateColumns: splitGridColumnTemplate,
                        gridTemplateRows: splitGridRowTemplate,
                      }
                      : undefined}
                  >
                    {terminalTabs.map((tab, index) => {
                      const isActive = activeTabId === tab.id;
                      const inputLocked = terminalSplitVisible && terminalSplitInputLockedTabIds.has(tab.id);
                      const sidebarOpen = !terminalSplitVisible && !!attachedSidebars[tab.id] && !!tab.ssh;
                      const liveTerminalProfile = terminalProfileOverrides[tab.id]
                        ?? (tab.sessionId ? terminalProfilesBySessionId.get(tab.sessionId) : undefined)
                        ?? tab.terminalProfile;
                      const tabDetails = buildTabDetailSummary(
                        tab,
                        sessions,
                        terminalRuntimeByTab[tab.id],
                        terminalCwds[tab.id],
                        t,
                      );
                      const terminalNode = (
                        <div className="h-full w-full relative">
                          <TerminalPanel
                            tabId={tab.id}
                            tabTitle={tab.title}
                            ssh={tab.ssh}
                            commandTerminal={tab.commandTerminal}
                            localShell={tab.localShell}
                            sockscapTerminal={tab.sockscapTerminal}
                            terminalProfile={liveTerminalProfile}
                            onTerminalProfileChange={(profile) => handleTerminalProfileChange(tab.id, profile)}
                            adoptedTerminal={tab.adoptedTerminal}
                            initialCwd={tab.terminalInitialCwd}
                            visible={terminalSplitVisible || isActive}
                            activeForShortcuts={isActive}
                            inputLocked={inputLocked}
                            onCwdChange={(cwd) => handleTerminalCwd(tab.id, cwd)}
                            cwdRequestToken={terminalCwdRequestTokens[tab.id] ?? 0}
                            onSessionReady={(sid) => { terminalSessionIds.current[tab.id] = sid; }}
                            onOutput={() => handleTerminalOutput(tab.id)}
                            onUploadLocalPaths={
                              tab.ssh
                                ? (request) => handleTerminalLocalPathUpload(tab.id, request)
                                : undefined
                            }
                            multiExecActive={multiExecActive}
                            isMultiExecTarget={
                              multiExecActive &&
                              multiExecSelectedTabIds.has(tab.id) &&
                              !inputLocked
                            }
                            onInputBroadcast={
                              multiExecActive && !inputLocked && (terminalSplitVisible || isActive)
                                ? (data) => broadcastToSelectedTerminals(data, tab.id)
                                : undefined
                            }
                            sftpToggle={!terminalSplitVisible && tab.ssh ? {
                              open: sidebarOpen,
                              onToggle: () => {
                                if (sftpDetachedTabs[tab.id] && tab.ssh) {
                                  openDetachedSftp(
                                    {
                                      sessionId: `attached-${tab.id}`,
                                      host: tab.ssh.host,
                                      port: tab.ssh.port,
                                      username: tab.ssh.username,
                                      authMethod: tab.ssh.authMethod,
                                      authData: tab.ssh.authData,
                                      networkSettingsJson: JSON.stringify(
                                        toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh.optionsJson)),
                                      ),
                                      initialPath: terminalCwds[tab.id],
                                      attachedToTerminal: true,
                                    },
                                    `${tab.title} — SFTP`,
                                  );
                                } else {
                                  toggleAttachedSidebar(tab.id);
                                }
                              }
                            } : undefined}
                            gitToggle={!tab.ssh && !tab.commandTerminal ? {
                              cwd: terminalCwds[tab.id] ?? null,
                              onOpen: async () => {
                                const cwd = terminalCwdsRef.current[tab.id] ?? await queryTerminalCwd(tab.id);
                                if (!cwd) {
                                  await alertAppDialog({
                                    title: "Git Repository",
                                    message: "The current terminal directory is not available yet.",
                                  });
                                  return;
                                }
                                await openGitRepository(cwd);
                              },
                            } : undefined}
                          />
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
                          networkSettingsJson={JSON.stringify(
                            toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh.optionsJson)),
                          )}
                          cwdHint={terminalCwds[tab.id] ?? null}
                          cwdHintVersion={terminalCwdVersions[tab.id] ?? 0}
                          title={`SFTP — ${tab.ssh.username}@${tab.ssh.host}`}
                          onClose={() => toggleAttachedSidebar(tab.id)}
                          onRequestTerminalCwd={() => requestTerminalCwd(tab.id)}
                          pendingUploadRequest={pendingSftpUploadRequests[`attached-${tab.id}`] ?? null}
                          onPendingUploadRequestHandled={(requestId) => {
                            const sftpSessionId = `attached-${tab.id}`;
                            setPendingSftpUploadRequests((prev) => {
                              if (prev[sftpSessionId]?.id !== requestId) return prev;
                              const next = { ...prev };
                              delete next[sftpSessionId];
                              return next;
                            });
                          }}
                          onOpenTerminalHere={(p) => {
                            const sid = terminalSessionIds.current[tab.id];
                            if (!sid) return;
                            const escaped = p.replace(/'/g, "'\\''");
                            void writeTerminal(sid, encodeBase64(`cd '${escaped}'\r`));
                          }}
                          onDetach={() => {
                            setSftpDetachedTabs((prev) => ({ ...prev, [tab.id]: true }));
                            setAttachedSidebars((prev) => ({ ...prev, [tab.id]: false }));
                            openDetachedSftp(
                              {
                                sessionId: `attached-${tab.id}`,
                                host: tab.ssh!.host,
                                port: tab.ssh!.port,
                                username: tab.ssh!.username,
                                authMethod: tab.ssh!.authMethod,
                                authData: tab.ssh!.authData,
                                networkSettingsJson: JSON.stringify(
                                  toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh!.optionsJson)),
                                ),
                                initialPath: terminalCwds[tab.id],
                                attachedToTerminal: true,
                              },
                              `${tab.title} — SFTP`,
                            );
                          }}
                        />
                      ) : null;
                      const gridColumn = index % splitGridColumns + 1;
                      const gridRow = Math.floor(index / splitGridColumns) + 1;
                      return (
                        <Fragment key={tab.id}>
                        <div
                          data-testid="terminal-split-pane"
                          data-tab-id={tab.id}
                          data-active={isActive || undefined}
                          data-input-locked={inputLocked || undefined}
                          className={
                            terminalSplitVisible
                              ? "relative min-w-0 min-h-0 flex flex-col overflow-hidden border-r border-b border-[var(--taomni-divider)]"
                              : "absolute inset-0"
                          }
                          style={terminalSplitVisible
                            ? terminalSplitLayout === "grid"
                              ? { gridColumn, gridRow }
                              : {
                                flexGrow: splitPaneWeightsForTabs[index],
                                flexShrink: 1,
                                flexBasis: 0,
                              }
                            : { display: isActive ? "block" : "none" }}
                          onMouseDownCapture={() => {
                            if (terminalSplitVisible && activeTabId !== tab.id) {
                              setActiveTab(tab.id);
                            }
                          }}
                        >
                          <div
                            className="h-7 shrink-0 items-center gap-2 px-2 text-[11px]"
                            style={{
                              display: terminalSplitVisible ? "flex" : "none",
                              background: isActive ? "var(--taomni-selected)" : "var(--taomni-chrome-bg)",
                              borderBottom: "1px solid var(--taomni-divider)",
                              color: "var(--taomni-text)",
                            }}
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 truncate text-left"
                              onClick={() => setActiveTab(tab.id)}
                              title={tab.title}
                            >
                              {tab.title}
                            </button>
                            <span
                              data-testid={`terminal-split-activity-${tab.id}`}
                              className="max-w-[150px] truncate rounded px-1.5 py-0.5 text-[10px] text-[var(--taomni-text-muted)]"
                              style={{ background: "var(--taomni-hover)" }}
                              title={tabDetails.activityLabel}
                            >
                              {tabDetails.activityLabel}
                            </span>
                            <button
                              type="button"
                              data-testid={`terminal-split-lock-${tab.id}`}
                              aria-label={inputLocked ? t("terminalSplit.unlockInput", { title: tab.title }) : t("terminalSplit.lockInput", { title: tab.title })}
                              title={inputLocked ? t("terminalSplit.unlockTitle") : t("terminalSplit.lockTitle")}
                              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
                              style={inputLocked ? { color: "var(--taomni-accent)" } : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleTerminalSplitInputLock(tab.id);
                              }}
                            >
                              {inputLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                            </button>
                          </div>
                          {/* Always render the PanelGroup so the terminal Panel
                              stays mounted across sidebar open/close. */}
                          <div className={terminalSplitVisible ? "flex-1 min-h-0" : "h-full"}>
                            <PanelGroup
                              orientation="horizontal"
                              id={`terminal-sftp-${tab.id}`}
                              defaultLayout={loadResizableLayout(
                                `terminal-sftp-${tab.id}`,
                                sftpSidebarNode ? ["terminal", "sftp"] : ["terminal"],
                              )}
                              onLayoutChanged={saveResizableLayout(`terminal-sftp-${tab.id}`)}
                            >
                              <Panel id="terminal" defaultSize="62%" minSize="25%" className="min-w-0">
                                <div className="h-full">{terminalNode}</div>
                              </Panel>
                              {sftpSidebarNode && (
                                <>
                                  <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
                                  <Panel
                                    id="sftp"
                                    defaultSize="38%"
                                    minSize="20%"
                                    maxSize="70%"
                                    className="min-w-0"
                                  >
                                    <div
                                      className="h-full"
                                      style={{
                                        borderLeft: "1px solid var(--taomni-divider)",
                                        background: "var(--taomni-bg)",
                                      }}
                                    >
                                      {sftpSidebarNode}
                                    </div>
                                  </Panel>
                                </>
                              )}
                            </PanelGroup>
                          </div>
                        </div>
                        {terminalSplitVisible && terminalSplitLayout !== "grid" && index < terminalTabs.length - 1 && (
                          <div
                            data-testid="terminal-split-resize-handle"
                            data-orientation={terminalSplitLayout}
                            className={
                              terminalSplitLayout === "horizontal"
                                ? "w-1.5 shrink-0 cursor-col-resize bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors"
                                : "h-1.5 shrink-0 cursor-row-resize bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors"
                            }
                            onPointerDown={(event) => startLinearSplitResize(index, event)}
                            role="separator"
                            aria-orientation={terminalSplitLayout === "horizontal" ? "vertical" : "horizontal"}
                            title={t("terminalSplit.resizePanes")}
                          />
                        )}
                        </Fragment>
                      );
                    })}
                    {terminalSplitVisible && terminalSplitLayout === "grid" && (
                      <>
                        {splitGridColumnWeightsForLayout.slice(0, -1).map((_, index) => (
                          <div
                            key={`grid-col-${index}`}
                            data-testid="terminal-split-grid-column-resize-handle"
                            className="absolute top-0 bottom-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/70"
                            style={{ left: `${cumulativeWeightPercent(splitGridColumnWeightsForLayout, index)}%` }}
                            onPointerDown={(event) => startGridSplitResize("column", index, event)}
                            role="separator"
                            aria-orientation="vertical"
                            title={t("terminalSplit.resizeColumn")}
                          />
                        ))}
                        {splitGridRowWeightsForLayout.slice(0, -1).map((_, index) => (
                          <div
                            key={`grid-row-${index}`}
                            data-testid="terminal-split-grid-row-resize-handle"
                            className="absolute left-0 right-0 z-30 h-1.5 -translate-y-1/2 cursor-row-resize bg-transparent hover:bg-[var(--taomni-accent)]/70"
                            style={{ top: `${cumulativeWeightPercent(splitGridRowWeightsForLayout, index)}%` }}
                            onPointerDown={(event) => startGridSplitResize("row", index, event)}
                            role="separator"
                            aria-orientation="horizontal"
                            title={t("terminalSplit.resizeRow")}
                          />
                        ))}
                      </>
                    )}
                  </div>
                </div>

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
                        networkSettingsJson={tab.sftp.networkSettingsJson ?? null}
                        initialPath={tab.sftp.initialPath}
                        pathMappings={tab.sftp.pathMappings}
                        detachable
                        onDetach={() => openDetachedSftp(tab.sftp!, tab.title)}
                      />
                    </div>
                  );
                })}

                {settingsTabs.map((tab) => {
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      data-testid="settings-tab-panel"
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <SettingsPanel />
                    </div>
                  );
                })}

                {/* Git tabs stay mounted so repository views, loaded logs, and
                    scroll position survive switching to another app tab. */}
                {gitTabs.map((tab) => {
                  if (!tab.git) return null;
                  const isActive = activeTabId === tab.id;
                  const workspaceRoots = tab.git.workspaceRoots ?? [];
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      {workspaceRoots.length > 0 ? (
                        <WorkspaceGitManager
                          workspaceName={tab.git.workspaceName}
                          roots={workspaceRoots}
                          activeRepoRoot={tab.git.activeRepoRoot ?? tab.git.repoRoot}
                          visible={isActive}
                          onOpenWorkspace={openCodeWorkspaceTab}
                        />
                      ) : (
                        <GitPanel
                          repoRoot={tab.git.repoRoot}
                          visible={isActive}
                          onOpenWorkspace={openCodeWorkspaceTab}
                        />
                      )}
                    </div>
                  );
                })}

                {codeWorkspaceTabs.map((tab) => {
                  if (!tab.codeWorkspace) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <CodeWorkspaceTab
                        tabId={tab.id}
                        workspace={tab.codeWorkspace}
                        visible={isActive}
                        onOpenGitManager={openWorkspaceGitManager}
                        onSyncGitManager={syncWorkspaceGitManager}
                        onCommandsChange={handleWorkspaceCommandsChange}
                      />
                    </div>
                  );
                })}

                {activeTab?.type === "lan-chat" && <LanChatGate />}

                {/* VNC tabs — always mounted so connection survives tab switches */}
                {vncTabs.map((tab) => {
                  if (!tab.vnc) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <Suspense fallback={<VncLoadingPanel />}>
                        <VncPanel
                          tabId={tab.id}
                          host={tab.vnc.host}
                          port={tab.vnc.port}
                          username={tab.vnc.username}
                          password={tab.vnc.password}
                          networkSettingsJson={tab.vnc.networkSettingsJson}
                          securityPolicy={tab.vnc.securityPolicy}
                          viewOnly={tab.vnc.viewOnly}
                          clipboardPolicy={tab.vnc.clipboardPolicy}
                          visible={isActive}
                        />
                      </Suspense>
                    </div>
                  );
                })}

                {/* RDP tabs — always mounted so the WS relay stays alive across tab switches */}
                {rdpTabs.map((tab) => {
                  if (!tab.rdp) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <Suspense fallback={<RdpLoadingPanel />}>
                        <RdpPanel
                          tabId={tab.id}
                          host={tab.rdp.host}
                          port={tab.rdp.port}
                          username={tab.rdp.username}
                          password={tab.rdp.password}
                          options={tab.rdp.options}
                          networkSettingsJson={tab.rdp.networkSettingsJson}
                          visible={isActive}
                        />
                      </Suspense>
                    </div>
                  );
                })}

                {/* Embedded local file-browser tabs (File session type). */}
                {fileBrowserTabs.map((tab) => {
                  if (!tab.fileBrowser) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <LocalFileBrowserPanel
                        tabId={tab.id}
                        initialPath={tab.fileBrowser.initialPath}
                      />
                    </div>
                  );
                })}

                {/* Object-storage (S3 / Azure Blob) browser tabs — always
                    mounted so in-flight transfers survive tab switches. */}
                {objectStorageTabs.map((tab) => {
                  if (!tab.objectStorage) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <ObjectStorageBrowser
                        sessionId={tab.objectStorage.sessionId}
                        config={tab.objectStorage.config}
                        title={tab.title}
                      />
                    </div>
                  );
                })}

                {mailTabs.map((tab) => {
                  if (!tab.mail) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <MailClientTab
                        tabId={tab.id}
                        info={tab.mail}
                        visible={isActive}
                        onEditSession={handleEditSessionById}
                      />
                    </div>
                  );
                })}

                {/* SQL database client tabs — always mounted so long queries
                    keep running across tab switches. */}
                {dbTabs.map((tab) => {
                  if (!tab.db) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <Suspense fallback={<DbLoadingPanel />}>
                        <DbClientTab
                          tabId={tab.id}
                          info={tab.db}
                          visible={isActive}
                        />
                      </Suspense>
                    </div>
                  );
                })}

                {/* Redis client tabs — always mounted (CLI/monitor stay alive). */}
                {redisTabs.map((tab) => {
                  if (!tab.db) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <Suspense fallback={<DbLoadingPanel />}>
                        <RedisClientTab
                          tabId={tab.id}
                          info={tab.db}
                          visible={isActive}
                        />
                      </Suspense>
                    </div>
                  );
                })}

                {/* HBase shell UI tabs - always mounted so command history and
                    active REST sessions survive tab switches. */}
                {hbaseTabs.map((tab) => {
                  if (!tab.hbase) return null;
                  const isActive = activeTabId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className="absolute inset-0"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <Suspense fallback={<DbLoadingPanel />}>
                        <HBaseShellTab tabId={tab.id} info={tab.hbase} visible={isActive} />
                      </Suspense>
                    </div>
                  );
                })}

                {activeTab?.type === "nettools" && (
                  <TunnelManager
                    onStatusMessage={setStatusMessage}
                    onClose={() => removeTab(activeTab.id)}
                  />
                )}

                {activeTab?.type === "sockscap" && (
                  <SocksCapPanel
                    onStatusMessage={setStatusMessage}
                    onClose={() => removeTab(activeTab.id)}
                  />
                )}

                {activeTab?.type === "proxy-test" && activeTab.proxyTest && (
                  <Suspense fallback={null}>
                    <ProxyTestTab info={activeTab.proxyTest} />
                  </Suspense>
                )}

                {/* Non-terminal, non-sftp, non-vnc, non-rdp, non-welcome, non-settings, non-nettools tabs */}
                {activeTab &&
                  activeTab.type !== "welcome" &&
                  activeTab.type !== "terminal" &&
                  activeTab.type !== "sftp" &&
                  activeTab.type !== "vnc" &&
                  activeTab.type !== "rdp" &&
                  activeTab.type !== "file-browser" &&
                  activeTab.type !== "database" &&
                  activeTab.type !== "redis" &&
                  activeTab.type !== "hbase-shell" &&
                  activeTab.type !== "mail" &&
                  activeTab.type !== "settings" &&
                  activeTab.type !== "git" &&
                  activeTab.type !== "nettools" &&
                  activeTab.type !== "sockscap" &&
                  activeTab.type !== "lan-chat" &&
                  activeTab.type !== "proxy-test" && (
                  <UnavailablePanel title={activeTab.title} message={activeTab.message} />
                )}
              </div>
              </div>
              {chatDrawerInline && chatDrawerPosition === "right" && <ChatDrawer />}
            </div>
          </Panel>
        </PanelGroup>
        {chatDrawerFloating && <ChatDrawer />}
        {!aiFullyDisabled && <TaoRibbon />}
        <FloatingNotesPanel />
        <TaoAlertPoller />
      </div>

      {chatDrawerBottomPinned && <ChatDrawer />}

      <StatusBar />

      <CcAgentBridge />

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
          host={pendingAuth.kind === "jump" ? pendingAuth.host : pendingAuth.session.host}
          username={pendingAuth.kind === "jump" ? pendingAuth.username : pendingAuth.session.username ?? "root"}
          onSubmit={handleAuthSubmit}
          onCancel={() => {
            setPendingAuth(null);
            awaitingManualAuthRef.current = false;
            continueConnectQueueRef.current();
          }}
        />
      )}

      {vaultUnlockReason && (
        <VaultUnlockDialog
          reason={vaultUnlockReason}
          onCancel={() => {
            pendingVaultActionRef.current = null;
            awaitingVaultUnlockRef.current = false;
            connectQueueRef.current = [];
            setVaultUnlockReason(null);
          }}
          onSubmit={async (pw) => {
            await unlockVault(pw);
            const pending = pendingVaultActionRef.current;
            pendingVaultActionRef.current = null;
            setVaultUnlockReason(null);
            awaitingVaultUnlockRef.current = false;
            if (pending) pending();
          }}
        />
      )}

      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      <UpdateDialog />

      {/* Session import preview — driven by the native macOS menu's
          import actions (no-op elsewhere, where the ControlBar app menu hosts
          its own). */}
      {nativeMenu && importExport.previewNode}

      {appExitConfirmDialog}
      <CallOverlay />
      <WhiteboardOverlay />
      <EdgeDrawer />
    </div>
    </TabActionSlotProvider>
  );
}

function positiveWeight(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

function axisWeights(weights: number[], count: number): number[] {
  return Array.from({ length: count }, (_, index) => positiveWeight(weights[index]));
}

function sumWeights(weights: number[]): number {
  return weights.reduce((sum, weight) => sum + positiveWeight(weight), 0) || 1;
}

function resizeAdjacentWeights(weights: number[], index: number, deltaWeight: number): number[] {
  const next = weights.map(positiveWeight);
  if (index < 0 || index >= next.length - 1) return next;

  const left = next[index];
  const right = next[index + 1];
  const minDelta = MIN_SPLIT_WEIGHT - left;
  const maxDelta = right - MIN_SPLIT_WEIGHT;
  const clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaWeight));
  next[index] = left + clampedDelta;
  next[index + 1] = right - clampedDelta;
  return next;
}

function weightsToGridTemplate(weights: number[]): string {
  return weights.map((weight) => `minmax(0, ${positiveWeight(weight)}fr)`).join(" ");
}

function cumulativeWeightPercent(weights: number[], index: number): number {
  const total = sumWeights(weights);
  const before = weights
    .slice(0, index + 1)
    .reduce((sum, weight) => sum + positiveWeight(weight), 0);
  return total > 0 ? (before / total) * 100 : 0;
}

function TerminalSplitToolbar({
  layout,
  lockedCount,
  onLayoutChange,
  onClearLocks,
  onClose,
}: {
  layout: TerminalSplitLayout;
  lockedCount: number;
  onLayoutChange: (layout: TerminalSplitLayout) => void;
  onClearLocks: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const options: Array<{ id: TerminalSplitLayout; label: string; icon: ReactNode }> = [
    { id: "horizontal", label: t("terminalSplit.horizontal"), icon: <Columns2 className="w-3.5 h-3.5" /> },
    { id: "vertical", label: t("terminalSplit.vertical"), icon: <Rows3 className="w-3.5 h-3.5" /> },
    { id: "grid", label: t("terminalSplit.grid"), icon: <Grid2X2 className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      data-testid="terminal-split-toolbar"
      className="h-8 shrink-0 flex items-center gap-1 px-2"
      style={{
        background: "var(--taomni-chrome-bg)",
        borderBottom: "1px solid var(--taomni-divider)",
      }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`terminal-split-layout-${option.id}`}
          aria-label={option.label}
          title={option.label}
          data-active={layout === option.id || undefined}
          className="h-6 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          style={layout === option.id ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
          onClick={() => onLayoutChange(option.id)}
        >
          {option.icon}
        </button>
      ))}
      <span className="taomni-pill ml-1" style={{ fontSize: 11 }}>
        {t("terminalSplit.locked", { count: lockedCount })}
      </span>
      <button
        type="button"
        className="text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40"
        style={{ color: "var(--taomni-text-muted)" }}
        disabled={lockedCount === 0}
        onClick={onClearLocks}
      >
        {t("terminalSplit.clearLocks")}
      </button>
      <div className="flex-1" />
      <button
        type="button"
        aria-label={t("terminalSplit.closeView")}
        title={t("terminalSplit.closeView")}
        className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
        onClick={onClose}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function VncLoadingPanel() {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      {t("vnc.loading")}
    </div>
  );
}

function RdpLoadingPanel() {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      {t("rdp.loading")}
    </div>
  );
}

function DbLoadingPanel() {
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text-muted)" }}
    >
      Loading database client…
    </div>
  );
}

function UnavailablePanel({ title, message }: { title: string; message?: string }) {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm p-6"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      <div className="max-w-md text-center">
        <div className="text-lg font-semibold mb-2">{title}</div>
        <div className="text-[12px] text-slate-300">
          {message ?? t("status.commandUnavailable")}
        </div>
      </div>
    </div>
  );
}
