import type { SshConnectInfo } from "../components/terminal/TerminalPanel";
import type { TerminalProfile } from "../lib/terminalProfile";
import type { NetworkSettingsPayload } from "../lib/networkSettings";
import type { RdpOptions } from "./rdp";
import type { ObjectStorageConfig } from "./objectStorage";

export type TabKind = "terminal" | "sftp" | "rdp" | "vnc" | "nettools" | "sockscap" | "welcome" | "settings" | "placeholder" | "file-browser" | "database" | "redis" | "hbase-shell" | "proxy-test" | "object-storage" | "lan-chat" | "git" | "mail" | "code-workspace";

/** Presence state of a LAN peer (mirrors the Rust `PresenceStatus`). */
export type LanPresence = "online" | "away" | "busy" | "offline";

/** A peer discovered on the LAN via mDNS (mirrors Rust `PeerRecord`). */
export interface LanPeer {
  id: string;
  name: string;
  avatarHash?: string | null;
  signature: string;
  status: LanPresence;
  lastSeen: number;
  addr?: string | null;
  port?: number | null;
}

/** This node's own profile (mirrors Rust `Profile`). */
export interface LanProfile {
  id: string;
  name: string;
  avatarBase64?: string | null;
  avatarHash?: string | null;
  signature: string;
  status: LanPresence;
  updatedAt: number;
}

/** A conversation thread — direct (`direct:<peer>`) or group (`group:<id>`). */
export interface LanConversation {
  id: string;
  kind: "direct" | "group";
  peerOrGroupId: string;
  lastMsgAt: number;
  unread: number;
}

/** Delivery state of an outgoing/incoming message. */
export type LanMessageState = "sending" | "sent" | "delivered" | "failed";

/** A chat message (mirrors Rust `LanMessage`). */
export interface LanMessage {
  id: string;
  convId: string;
  senderId: string;
  body: string;
  mentions: string[];
  createdAt: number;
  state: LanMessageState;
}

/** A named group / channel (mirrors Rust `Group`). */
export interface LanGroup {
  id: string;
  name: string;
  createdAt: number;
  members: string[];
}

/** LanChat service status (mirrors Rust `LanChatStatus`). */
export interface LanChatStatus {
  running: boolean;
  nodeId: string;
  peerCount: number;
}

/** A file transfer progress / state update (mirrors Rust `TransferProgress`). */
export interface LanTransferProgress {
  transferId: string;
  direction: "send" | "recv";
  name: string;
  size: number;
  transferred: number;
  rate: number;
  eta: number;
  state: "offering" | "active" | "paused" | "done" | "failed" | "cancelled" | "rejected";
  convId: string;
}

/** An inbound file offer awaiting accept/reject. */
export interface LanFileOffer {
  transferId: string;
  from: string;
  name: string;
  size: number;
  mime: string;
  kind: "file" | "dir";
  convId: string;
  /** Set when the offer targets a group (vs a 1:1 chat). */
  groupId?: string | null;
}

/** A WebRTC signaling frame relayed from a peer. */
export interface LanSignal {
  from: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Message-retention policy (mirrors Rust `RetentionSettings`). */
export interface LanRetention {
  retentionDays: number;
  maxPerConv: number;
  cleanupEnabled: boolean;
}

/** Service enablement state (mirrors Rust `LanChatServiceState`). */
export interface LanServiceState {
  /** Whether the background service (discovery + transport + beacon) is live. */
  running: boolean;
  /** Whether the service is configured to start on app launch. */
  startOnLaunch: boolean;
}

/** A pinned peer identity record (mirrors Rust `PinnedPeer`). */
export interface LanPinnedPeer {
  nodeId: string;
  firstSeen: number;
  lastSeen: number;
}

/** A security event: a peer's presented identity was rejected. */
export interface LanSecurityEvent {
  peerId: string;
  addr: string;
  /** "spoof" = claimed id != cert fingerprint; "keyChanged" = pinned cert changed. */
  kind: "spoof" | "keyChanged";
}

/** Call kind. */
export type LanCallKind = "audio" | "video";

export interface VncConnectInfo {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
}

/**
 * Connection parameters for a database client tab (MySQL / PostgreSQL /
 * PanWeiDB / Oracle / SQL Server / StarRocks / ClickHouse / Presto / Redis). Mirrors the Rust `DbConfig` (camelCase). The password
 * may be a `vault:<id>` reference resolved server-side.
 */
export interface DbConnectInfo {
  sessionId: string;
  /** Stable saved-session id used for restoring query workspace files. */
  workspaceSessionId?: string;
  engine: "MySQL" | "PostgreSQL" | "PanWeiDB" | "Oracle" | "SQLServer" | "StarRocks" | "ClickHouse" | "Presto" | "Redis";
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  /** Presto catalog name. */
  catalog?: string | null;
  database?: string | null;
  ssl?: boolean;
  timeoutSecs?: number | null;
  /** ClickHouse HTTP port (defaults to 8123). */
  httpPort?: number | null;
  /** ClickHouse protocol: "http" (default) or "native". */
  protocol?: string | null;
  /**
   * Presto/Trino HTTP header dialect. Controls X-Presto-* vs X-Trino-* headers.
   * Defaults to "presto" when absent (legacy sessions).
   */
  prestoDialect?: "presto" | "trino" | null;
  /** Redis logical DB index (0-15). */
  dbIndex?: number | null;
  /** Per-session network settings (proxy / SSH jump host). The backend routes
   *  the connection through a loopback forwarder when this requests a proxy or
   *  jump host. Serialized as the same camelCase payload SSH uses. */
  networkSettings?: NetworkSettingsPayload | null;
}

/**
 * Connection parameters for the JVM-free HBase shell UI. The backend talks to
 * an HBase REST/Stargate-compatible endpoint directly.
 */
export interface HBaseConnectInfo {
  sessionId: string;
  workspaceSessionId?: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  ssl?: boolean;
  timeoutSecs?: number | null;
  restPath?: string | null;
  namespace?: string | null;
  /** "native" (RPC via ZooKeeper), "rest" (Stargate), or "thrift" (Lindorm 9190). */
  connectionMode?: "native" | "rest" | "thrift" | null;
  /** ZooKeeper quorum for native mode, e.g. "zk1:2181,zk2:2181". */
  zkQuorum?: string | null;
  /** ZooKeeper root znode for native mode (default "/hbase"). */
  zkRoot?: string | null;
  /** Effective user for native simple auth (default "root"). */
  effectiveUser?: string | null;
  /** Auth method for native mode: "simple" (default) or "kerberos". */
  authMethod?: "simple" | "kerberos" | null;
  /** Service principal for Kerberos auth, e.g. "hbase/host@REALM". */
  servicePrincipal?: string | null;
  /** Client principal for keytab-based Kerberos, e.g. "user@REALM". */
  principal?: string | null;
  /** Absolute path to a keytab file for automatic kinit. */
  keytabPath?: string | null;
  /** Absolute path to a custom krb5.conf file. */
  krb5ConfPath?: string | null;
  /** Absolute path to a custom hbase-site.xml file. */
  hbaseSitePath?: string | null;
}

export interface RdpConnectInfo {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  /** JSON blob mirroring the SSH `networkSettings` shape; null = direct. */
  networkSettingsJson?: string | null;
}

export interface ProxyTestTabInfo {
  sessionId: string;
  proxyKind: "http" | "socks5";
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  testUrl?: string;
}

export interface FileBrowserTabInfo {
  initialPath: string;
}

/** Connection parameters for an object-storage browser tab (S3 / Azure Blob). */
export interface ObjectStorageTabInfo {
  sessionId: string;
  config: ObjectStorageConfig;
}

export type MailConnectionSecurity = "tls" | "starttls" | "none";
export type MailProvider = "custom" | "gmail" | "outlook";
export type MailAuthMode = "password" | "oauth2";

export interface MailCacheSettings {
  enabled: boolean;
  headerRetentionDays: number;
  headerLimitPerFolder: number;
  bodyRecentLimit: number;
  bodyMaxBytes: number;
  attachmentCache: boolean;
  saveDirectory?: string | null;
}

export interface MailAiSettings {
  enabled: boolean;
  skipBodyConfirm: boolean;
}

export interface MailTabInfo {
  sessionId: string;
  emailAddress: string;
  provider: MailProvider;
  authMode: MailAuthMode;
  displayName?: string | null;
  replyTo?: string | null;
  signature?: string | null;
  terminalProfile?: TerminalProfile;
  imap: {
    host: string;
    port: number;
    username?: string | null;
    password?: string;
    security: MailConnectionSecurity;
  };
  smtp: {
    host: string;
    port: number;
    username?: string | null;
    password?: string;
    security: MailConnectionSecurity;
    useImapAuth: boolean;
  };
  oauth: {
    clientId?: string | null;
    clientSecret?: string;
    tokenRef?: string | null;
    refreshTokenRef?: string | null;
    expiresAt?: number | null;
    scope?: string | null;
  };
  networkSettings?: NetworkSettingsPayload | null;
  sync: {
    onOpen: boolean;
    intervalMinutes: number;
    maxFetchPerSync: number;
  };
  cache: MailCacheSettings;
  ai: MailAiSettings;
}

export interface GitTabInfo {
  repoRoot: string;
  workspaceName?: string;
  workspaceRoots?: GitWorkspaceRootInfo[];
  activeRepoRoot?: string | null;
  sourceWorkspaceInstanceId?: string;
  sourceWorkspaceId?: string;
  sourceWorkspaceName?: string;
}

export interface GitWorkspaceRootInfo {
  id: string;
  name: string;
  path: string;
  repoRoot: string;
  rootIds: string[];
  isSubmodule?: boolean;
}

export type CodeWorkspaceRootKind = "git" | "folder";

export interface CodeWorkspaceRootInfo {
  id: string;
  name: string;
  path: string;
  kind: CodeWorkspaceRootKind;
}

export interface CodeWorkspaceLooseFileInfo {
  id: string;
  name: string;
  path: string;
}

export type CodeWorkspaceFileRef =
  | {
      kind: "root";
      rootId: string;
      path: string;
    }
  | {
      kind: "loose";
      id: string;
      path: string;
    };

export interface CodeWorkspaceTabInfo {
  /** Legacy primary root. Empty for loose-file-only editor workspaces. */
  repoRoot: string;
  initialPath?: string | null;
  workspaceId?: string;
  workspaceInstanceId?: string;
  name?: string;
  roots?: CodeWorkspaceRootInfo[];
  looseFiles?: CodeWorkspaceLooseFileInfo[];
  initialFile?: CodeWorkspaceFileRef | null;
}

export interface RecentWorkspace {
  id: string;
  name: string;
  roots: CodeWorkspaceRootInfo[];
  looseFiles: CodeWorkspaceLooseFileInfo[];
  lastOpenedAt: number;
  lastActiveFile?: CodeWorkspaceFileRef | null;
  isGitRepo: boolean;
}

export interface Tab {
  id: string;
  /**
   * Stable id used for AI chat thread binding when it should outlive a visual
   * tab id change, e.g. detach -> reattach. Defaults to `id`.
   */
  chatTabId?: string;
  type: TabKind;
  title: string;
  sessionId?: string;
  connectionId?: string;
  closable: boolean;
  ssh?: SshConnectInfo;
  commandTerminal?: CommandTerminalConnectInfo;
  localShell?: LocalShellSelection;
  adoptedTerminal?: AdoptedTerminalInfo;
  sockscapTerminal?: SocksCapTerminalLaunchInfo;
  terminalProfile?: TerminalProfile;
  message?: string;
  sftp?: SftpTabInfo;
  vnc?: VncConnectInfo;
  rdp?: RdpConnectInfo;
  db?: DbConnectInfo;
  hbase?: HBaseConnectInfo;
  fileBrowser?: FileBrowserTabInfo;
  proxyTest?: ProxyTestTabInfo;
  objectStorage?: ObjectStorageTabInfo;
  mail?: MailTabInfo;
  git?: GitTabInfo;
  codeWorkspace?: CodeWorkspaceTabInfo;
  hasNewOutput?: boolean;
  /**
   * Ownership of a terminal tab title. Fresh terminals keep their launch label
   * only as a placeholder until the first valid cwd arrives. Automatic titles
   * continue following later `cd`s; an explicit rename permanently opts the
   * tab out of automatic naming.
   */
  terminalTitleMode?: "pending-auto" | "auto" | "manual";
  /** The sequencing rule to use when a pending automatic title is resolved. */
  terminalTitleOperation?: "new" | "duplicate";
  /** Saved remote-session name kept at the front of cwd-derived titles. */
  terminalTitleSessionName?: string;
  /**
   * One-shot starting directory for a freshly opened local/SSH terminal tab.
   * Set when a terminal tab is duplicated so the copy lands in the same
   * working directory the source terminal was in (local terminals start the
   * shell there; SSH terminals `cd` there right after connecting). Consumed on
   * the initial connect and otherwise ignored.
   */
  terminalInitialCwd?: string;
}

/** A single local ↔ remote path mapping entry. */
export interface SftpPathMapping {
  localPath: string;
  remotePath: string;
}

export interface SftpTabInfo {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  networkSettingsJson?: string | null;
  initialPath?: string;
  attachedToTerminal?: boolean;
  /** Deployment path mappings: local ↔ remote directory pairs. */
  pathMappings?: SftpPathMapping[];
}

export interface LocalShellSelection {
  id: string;
  name: string;
  args?: string[];
}

export interface CommandTerminalConnectInfo {
  sessionId?: string;
  kind: "FTP" | "Telnet" | "Rlogin" | "Serial" | "Mosh";
  host: string;
  port: number;
  username?: string | null;
  optionsJson?: string | null;
}

export interface AdoptedTerminalInfo {
  sessionId: string;
  snapshotText?: string;
}

export interface SocksCapTerminalLaunchInfo {
  profileId: string;
  path: string;
  args: string[];
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
