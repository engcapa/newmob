import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface LocalShellOption {
  id: string;
  name: string;
  path: string;
  args: string[];
  isDefault: boolean;
  canElevate: boolean;
}

export async function listLocalShells(): Promise<LocalShellOption[]> {
  return invoke<LocalShellOption[]>("list_local_shells", {});
}

export async function openLocalShellAsAdministrator(shell?: string): Promise<void> {
  return invoke("open_local_shell_as_administrator", { shell });
}

export function createTerminalSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createBinaryOutputChannel(callback: (data: Uint8Array) => void): Channel<ArrayBuffer> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) => {
    callback(new Uint8Array(message));
  };
  return channel;
}

export async function createLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  shell?: string,
  cwd?: string,
  onOutput?: (data: Uint8Array) => void,
): Promise<string> {
  return invoke<string>("create_local_terminal", {
    sessionId,
    cols,
    rows,
    shell,
    cwd,
    onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
  });
}

export async function createSshTerminal(
  sessionId: string,
  host: string,
  port: number,
  username: string,
  authMethod: string,
  authData: string | null,
  cols: number,
  rows: number,
  networkSettingsJson: string | null = null,
  onOutput?: (data: Uint8Array) => void,
): Promise<string> {
  return invoke<string>("create_ssh_terminal", {
    sessionId,
    host,
    port,
    username,
    authMethod,
    authData,
    cols,
    rows,
    networkSettingsJson,
    onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
  });
}

export async function testSshConnection(
  host: string,
  port: number,
  username: string,
  authMethod: string,
  authData: string | null,
  networkSettingsJson: string | null = null,
): Promise<string> {
  return invoke<string>("test_ssh_connection", {
    host,
    port,
    username,
    authMethod,
    authData,
    networkSettingsJson,
  });
}

export async function writeTerminal(
  sessionId: string,
  data: string | Uint8Array,
): Promise<void> {
  if (typeof data === "string") {
    return invoke("write_terminal_text", { sessionId, data });
  }
  return invoke("write_terminal", data, {
    headers: { "x-session-id": sessionId },
  });
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_terminal", { sessionId, cols, rows });
}

export async function sendTerminalSignal(
  sessionId: string,
  signal: string,
): Promise<void> {
  return invoke("send_terminal_signal", { sessionId, signal });
}

export async function closeTerminal(sessionId: string): Promise<void> {
  return invoke("close_terminal", { sessionId });
}

export async function listenTerminalExit(
  sessionId: string,
  callback: () => void,
): Promise<UnlistenFn> {
  return listen(`terminal-exit-${sessionId}`, () => {
    callback();
  });
}

export interface ForwardErrorPayload {
  local: string;
  remote: string;
  message: string;
}

export async function listenTerminalForwardError(
  sessionId: string,
  callback: (err: ForwardErrorPayload) => void,
): Promise<UnlistenFn> {
  return listen<ForwardErrorPayload>(
    `terminal-forward-error-${sessionId}`,
    (event) => {
      callback(event.payload);
    },
  );
}

export function encodeBinaryString(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// --- Session CRUD ---

export interface SessionConfig {
  id: string;
  name: string;
  session_type: string;
  group_path: string | null;
  host: string;
  port: number;
  username: string | null;
  auth_method: AuthMethod;
  options_json: string;
  created_at: number;
  updated_at: number;
  last_connected_at: number | null;
  sort_order: number;
}

export type AuthMethod =
  | "Password"
  | { PrivateKey: { key_path: string } }
  | "Agent"
  | "None";

export interface SessionGroup {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  icon: string | null;
}

export async function listSessions(
  group?: string,
): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("list_sessions", { group: group ?? null });
}

export async function getSession(id: string): Promise<SessionConfig> {
  return invoke<SessionConfig>("get_session", { id });
}

export async function saveSession(config: SessionConfig): Promise<void> {
  return invoke("save_session", { config });
}

export async function deleteSession(id: string): Promise<void> {
  return invoke("delete_session", { id });
}

export async function markSessionConnected(id: string): Promise<number> {
  return invoke<number>("mark_session_connected", { id });
}

export async function listSessionGroups(): Promise<SessionGroup[]> {
  return invoke<SessionGroup[]>("list_session_groups", {});
}

export async function saveSessionGroup(group: SessionGroup): Promise<void> {
  return invoke("save_session_group", { group });
}

export async function deleteSessionGroup(id: string): Promise<void> {
  return invoke("delete_session_group", { id });
}

export async function exitApp(): Promise<void> {
  return invoke("exit_app", {});
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke<string[]>("list_system_fonts", {});
}

export async function selectPrivateKeyFile(currentPath?: string): Promise<string | null> {
  return invoke<string | null>("select_private_key_file", { currentPath: currentPath ?? null });
}

export async function selectUploadFile(): Promise<string[]> {
  return invoke<string[]>("select_upload_file", {});
}

export async function selectSaveDirectory(currentPath?: string): Promise<string | null> {
  return invoke<string | null>("select_save_directory", { currentPath: currentPath ?? null });
}

interface FileReadUrl {
  token: string;
  url: string;
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  const { token, url } = await invoke<FileReadUrl>("create_file_read_url", { path });
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to read file: HTTP ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
    return new Uint8Array(buffer);
  } finally {
    await invoke("release_file_read_url", { token }).catch(() => undefined);
  }
}

export async function writeStreamOpen(path: string): Promise<string> {
  return invoke<string>("write_stream_open", { path });
}

export async function writeStreamAppend(handleId: string, data: Uint8Array): Promise<void> {
  return invoke("write_stream_append", data, {
    headers: { "x-handle-id": handleId },
  });
}

export async function writeStreamClose(handleId: string): Promise<void> {
  return invoke("write_stream_close", { handleId });
}

export async function writeStreamAbort(handleId: string): Promise<void> {
  return invoke("write_stream_abort", { handleId });
}

// --- VNC ────────────────────────────────────────────────────────────

export interface VncConnectResult {
  session_id: string;
  ws_port: number;
  width: number;
  height: number;
  name: string;
}

export async function vncConnect(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>("vnc_connect", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
  });
}

export async function vncDisconnect(sessionId: string): Promise<void> {
  return invoke("vnc_disconnect", { sessionId });
}

export async function vncTestConnection(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
): Promise<string> {
  return invoke("vnc_test_connection", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
  });
}
