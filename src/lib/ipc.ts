import { invoke } from "@tauri-apps/api/core";
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

export async function createLocalTerminal(
  cols: number,
  rows: number,
  shell?: string,
  cwd?: string,
): Promise<string> {
  return invoke<string>("create_local_terminal", { cols, rows, shell, cwd });
}

export async function createSshTerminal(
  host: string,
  port: number,
  username: string,
  authMethod: string,
  authData: string | null,
  cols: number,
  rows: number,
): Promise<string> {
  return invoke<string>("create_ssh_terminal", {
    host,
    port,
    username,
    authMethod,
    authData,
    cols,
    rows,
  });
}

export async function testSshConnection(
  host: string,
  port: number,
  username: string,
  authMethod: string,
  authData: string | null,
): Promise<string> {
  return invoke<string>("test_ssh_connection", {
    host,
    port,
    username,
    authMethod,
    authData,
  });
}

export async function writeTerminal(
  sessionId: string,
  data: string,
): Promise<void> {
  return invoke("write_terminal", { sessionId, data });
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

export async function listenTerminalOutput(
  sessionId: string,
  callback: (data: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`terminal-output-${sessionId}`, (event) => {
    callback(event.payload);
  });
}

export async function listenTerminalExit(
  sessionId: string,
  callback: () => void,
): Promise<UnlistenFn> {
  return listen(`terminal-exit-${sessionId}`, () => {
    callback();
  });
}

export function encodeBase64(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
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
