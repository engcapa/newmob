import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ServerType =
  | "ssh"
  | "ftp"
  | "tftp"
  | "http"
  | "telnet"
  | "vnc"
  | "nfs"
  | "cron"
  | "iperf"
  | "rdp";

export type ServerRunState = "stopped" | "starting" | "running" | "error";

export interface ServerConfig {
  port: number;
  bindAddress: string;
  autoStop: boolean;
  autoStopSeconds: number;
  startOnLaunch: boolean;
  /** server-specific fields (e.g. rootDir, password, cronExpr) */
  [key: string]: unknown;
}

export interface ServerStatus {
  serverType: ServerType;
  status: ServerRunState;
  pid?: number;
  startedAt?: number;
  error?: string;
}

export interface RdpCaptureDisplay {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface RdpCaptureProbe {
  permission: "granted" | "denied" | "notRequired";
  displays: RdpCaptureDisplay[];
  summary: string;
}

export interface RdpConnectionRequest {
  requestId: string;
  peer: string;
  timeoutSeconds: number;
  expiresAt: number;
}

export interface RdpServerSessionEvent {
  state: "connecting" | "rejected" | "disconnected";
  peer: string;
  viewOnly: boolean;
  durationMs?: number;
  reason?: string;
}

/**
 * Static metadata for each server type. `labelKey`/`descKey` are i18n keys
 * resolved at render time via `useT()`. This array is the source of truth for
 * server ordering, default ports, and whether a type binds a listening port.
 */
export interface ServerDef {
  type: ServerType;
  /** i18n key, e.g. "servers.types.ssh.label" */
  labelKey: string;
  /** i18n key, e.g. "servers.types.ssh.desc" */
  descKey: string;
  /** Default listening port (0 when the type has no port, e.g. cron). */
  defaultPort: number;
  /** False for types that do not bind a port (cron). */
  hasPort: boolean;
}

export const SERVER_DEFS: ServerDef[] = [
  { type: "ssh", labelKey: "servers.types.ssh.label", descKey: "servers.types.ssh.desc", defaultPort: 22, hasPort: true },
  { type: "ftp", labelKey: "servers.types.ftp.label", descKey: "servers.types.ftp.desc", defaultPort: 21, hasPort: true },
  { type: "tftp", labelKey: "servers.types.tftp.label", descKey: "servers.types.tftp.desc", defaultPort: 69, hasPort: true },
  { type: "http", labelKey: "servers.types.http.label", descKey: "servers.types.http.desc", defaultPort: 8080, hasPort: true },
  { type: "telnet", labelKey: "servers.types.telnet.label", descKey: "servers.types.telnet.desc", defaultPort: 23, hasPort: true },
  { type: "vnc", labelKey: "servers.types.vnc.label", descKey: "servers.types.vnc.desc", defaultPort: 5900, hasPort: true },
  { type: "nfs", labelKey: "servers.types.nfs.label", descKey: "servers.types.nfs.desc", defaultPort: 2049, hasPort: true },
  { type: "cron", labelKey: "servers.types.cron.label", descKey: "servers.types.cron.desc", defaultPort: 0, hasPort: false },
  { type: "iperf", labelKey: "servers.types.iperf.label", descKey: "servers.types.iperf.desc", defaultPort: 5201, hasPort: true },
  { type: "rdp", labelKey: "servers.types.rdp.label", descKey: "servers.types.rdp.desc", defaultPort: 3389, hasPort: true },
];

export const SERVER_ORDER: ServerType[] = SERVER_DEFS.map((d) => d.type);

/**
 * Build a sane default config for a server type, including the server-specific
 * fields each form reads. Always returns every common field so store indexing
 * is safe regardless of type.
 */
export function defaultConfig(type: ServerType): ServerConfig {
  const def = SERVER_DEFS.find((d) => d.type === type);
  const base: ServerConfig = {
    port: def ? def.defaultPort : 0,
    bindAddress: "0.0.0.0",
    autoStop: true,
    autoStopSeconds: 3600,
    startOnLaunch: false,
  };

  switch (type) {
    case "ssh":
      return {
        ...base,
        authMethod: "password",
        allowedUsers: "",
        rootDir: "",
        loginShell: true,
        maxSessions: 8,
      };
    case "ftp":
      return { ...base, rootDir: "", allowAnonymous: false, maxConnections: 10 };
    case "tftp":
      return { ...base, rootDir: "", writable: false };
    case "http":
      return { ...base, rootDir: "", directoryListing: true, cors: false };
    case "telnet":
      return { ...base, allowedUsers: "" };
    case "vnc":
      return { ...base, password: "", viewOnly: false, sharedDesktop: true };
    case "nfs":
      return { ...base, rootDir: "", readOnly: false };
    case "cron":
      return { ...base, cronExpr: "", command: "", workingDir: "" };
    case "iperf":
      return { ...base, protocol: "tcp", bandwidthLimit: 0 };
    case "rdp":
      return {
        ...base,
        bindAddress: "127.0.0.1",
        username: "",
        password: "",
        domain: "",
        securityMode: "hybrid",
        viewOnly: false,
        displayId: "",
        requireControlApproval: true,
      };
    default:
      return base;
  }
}

// --- Window / IPC wrappers ------------------------------------------------

/** Singleton id for the local-servers OS window (`#servers=main`). */
export const SERVERS_WINDOW_ID = "main";

/**
 * Open (or focus) the Local servers manager as a native OS window with system
 * chrome. Reuses the generic detached-window path; the label is fixed so a
 * second open focuses the existing window instead of spawning a duplicate.
 */
export async function openServersWindow(title?: string): Promise<void> {
  const { openDetachedWindow } = await import("./detachWindowing");
  return openDetachedWindow({
    kind: "servers",
    sessionId: SERVERS_WINDOW_ID,
    title,
    width: 720,
    height: 520,
  });
}

export async function startLocalServer(
  serverType: ServerType,
  config: ServerConfig,
): Promise<ServerStatus> {
  return invoke<ServerStatus>("start_local_server", { serverType, config });
}

export async function stopLocalServer(serverType: ServerType): Promise<ServerStatus> {
  return invoke<ServerStatus>("stop_local_server", { serverType });
}

export async function getServerStatus(serverType: ServerType): Promise<ServerStatus> {
  return invoke<ServerStatus>("get_server_status", { serverType });
}

export async function listServerStatuses(): Promise<ServerStatus[]> {
  return invoke<ServerStatus[]>("list_server_statuses", {});
}

export async function probeRdpCapture(
  requestPermission = false,
): Promise<RdpCaptureProbe> {
  return invoke<RdpCaptureProbe>("probe_rdp_capture", { requestPermission });
}

export async function resolveRdpConnectionRequest(
  requestId: string,
  approved: boolean,
): Promise<boolean> {
  return invoke<boolean>("resolve_rdp_connection_request", { requestId, approved });
}

export async function saveServerConfig(
  serverType: ServerType,
  config: ServerConfig,
): Promise<ServerConfig> {
  return invoke<ServerConfig>("save_server_config", { serverType, config });
}

export async function loadServerConfigs(): Promise<Record<string, ServerConfig>> {
  return invoke<Record<string, ServerConfig>>("load_server_configs", {});
}

// --- Event listeners ------------------------------------------------------

/**
 * Listen for a server's stdout/stderr lines on `server://output/<type>`.
 * Returns an UnlistenFn the caller must invoke on cleanup.
 */
export async function listenServerOutput(
  serverType: ServerType,
  cb: (line: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`server://output/${serverType}`, (event) => {
    cb(event.payload);
  });
}

/**
 * Listen for a server's status transitions on `server://status/<type>`.
 * Returns an UnlistenFn the caller must invoke on cleanup.
 */
export async function listenServerStatus(
  serverType: ServerType,
  cb: (s: ServerStatus) => void,
): Promise<UnlistenFn> {
  return listen<ServerStatus>(`server://status/${serverType}`, (event) => {
    cb(event.payload);
  });
}

export async function listenRdpConnectionRequests(
  cb: (request: RdpConnectionRequest) => void,
): Promise<UnlistenFn> {
  return listen<RdpConnectionRequest>("server://rdp/connection-request", (event) => {
    cb(event.payload);
  });
}

export async function listenRdpServerSessions(
  cb: (session: RdpServerSessionEvent) => void,
): Promise<UnlistenFn> {
  return listen<RdpServerSessionEvent>("server://rdp/session", (event) => {
    cb(event.payload);
  });
}
