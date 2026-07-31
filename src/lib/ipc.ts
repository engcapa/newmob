import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  open as openDialog,
  save as saveDialog,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";
import type {
  DbConnectInfo,
  HBaseConnectInfo,
  LanChatStatus,
  LanConversation,
  LanFileOffer,
  LanGroup,
  LanMessage,
  LanPeer,
  LanPinnedPeer,
  LanProfile,
  LanRetention,
  LanSecurityEvent,
  LanServiceState,
  LanSignal,
  LanTransferProgress,
} from "../types";

export interface LocalShellOption {
  id: string;
  name: string;
  path: string;
  args: string[];
  isDefault: boolean;
  canElevate: boolean;
}

export interface LocalDirectoryShortcut {
  label: string;
  path: string;
  kind: "system" | "personal";
}

export async function listLocalShells(): Promise<LocalShellOption[]> {
  return invoke<LocalShellOption[]>("list_local_shells", {});
}

export async function listCommonLocalDirectories(): Promise<LocalDirectoryShortcut[]> {
  return invoke<LocalDirectoryShortcut[]>("list_common_local_directories", {});
}

export async function openLocalShellAsAdministrator(shell?: string): Promise<void> {
  return invoke("open_local_shell_as_administrator", { shell });
}

export interface WslDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: number | null;
}

export async function listWslDistros(): Promise<WslDistro[]> {
  return invoke<WslDistro[]>("list_wsl_distros", {});
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

export interface LocalTerminalCreated {
  sessionId: string;
  /** `LocalShellOption.id` of the shell the backend actually launched. */
  shellId: string;
}

export async function createLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  shell?: string,
  shellArgs?: string[],
  cwd?: string,
  onOutput?: (data: Uint8Array) => void,
  workspaceRoot?: string,
): Promise<LocalTerminalCreated> {
  return invoke<LocalTerminalCreated>("create_local_terminal", {
    sessionId,
    cols,
    rows,
    shell,
    shellArgs,
    cwd,
    workspaceRoot,
    onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
  });
}

export async function createCommandTerminal(
  sessionId: string,
  kind: string,
  host: string,
  port: number,
  username: string | null | undefined,
  optionsJson: string | null | undefined,
  cols: number,
  rows: number,
  onOutput?: (data: Uint8Array) => void,
): Promise<string> {
  return invoke<string>("create_command_terminal", {
    sessionId,
    kind,
    host,
    port,
    username,
    optionsJson,
    cols,
    rows,
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
  x11: boolean = false,
  x11Trusted: boolean = true,
  startupCommand: string | null = null,
  keepOpenAfterStartupCommand: boolean = false,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("create_ssh_terminal", {
      sessionId,
      host,
      port,
      username,
      authMethod,
      authData,
      cols,
      rows,
      networkSettingsJson,
      x11,
      x11Trusted,
      startupCommand,
      keepOpenAfterStartupCommand,
      onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
    }),
  );
}

/** Local system X server (Xorg / XQuartz / VcXsrv / WSLg) detection result. */
export interface XServerStatus {
  available: boolean;
  display: string;
  endpoint: string;
  hasCookie: boolean;
  provider: string;
  hint: string | null;
}

/**
 * Probe the local X server so the UI can show honest X11 status and prompt to
 * install XQuartz/VcXsrv when none is reachable. Returns a safe "unavailable"
 * status if the backend command is missing (e.g. web preview stub).
 */
export async function detectXServer(): Promise<XServerStatus> {
  try {
    const raw = await invoke<{
      available: boolean;
      display: string;
      endpoint: string;
      has_cookie: boolean;
      provider: string;
      hint: string | null;
    }>("detect_x_server");
    return {
      available: raw.available,
      display: raw.display,
      endpoint: raw.endpoint,
      hasCookie: raw.has_cookie,
      provider: raw.provider,
      hint: raw.hint,
    };
  } catch {
    return {
      available: false,
      display: "",
      endpoint: "",
      hasCookie: false,
      provider: "unknown",
      hint: "no-display",
    };
  }
}

/** A single prompt within a keyboard-interactive (MFA/OTP) auth round. */
export interface SshAuthPromptEntry {
  prompt: string;
  /** When false the answer is secret (password/OTP) and should be masked. */
  echo: boolean;
}

/** Payload of the `ssh-auth-prompt-{sessionId}` event. */
export interface SshAuthPromptPayload {
  requestId: string;
  name: string;
  instructions: string;
  prompts: SshAuthPromptEntry[];
}

/**
 * Listen for keyboard-interactive auth prompts (MFA/OTP) emitted by the
 * backend mid-connect for `sessionId`. The callback receives the server's
 * prompts; answer them via {@link submitSshAuthResponse} using the same
 * `requestId`.
 */
export async function listenSshAuthPrompt(
  sessionId: string,
  callback: (payload: SshAuthPromptPayload) => void,
): Promise<UnlistenFn> {
  return listen<SshAuthPromptPayload>(`ssh-auth-prompt-${sessionId}`, (event) => {
    callback(event.payload);
  });
}

/**
 * Deliver the user's answers to a pending keyboard-interactive auth round.
 * Pass `null` for `responses` to cancel the prompt (aborts the connection).
 */
export async function submitSshAuthResponse(
  requestId: string,
  responses: string[] | null,
): Promise<void> {
  return invoke("submit_ssh_auth_response", { requestId, responses });
}

export async function attachTerminalOutput(
  sessionId: string,
  onOutput?: (data: Uint8Array) => void,
): Promise<void> {
  return invoke("attach_terminal_output", {
    sessionId,
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
  return withVaultLockedNotice(() =>
    invoke<string>("test_ssh_connection", {
      host,
      port,
      username,
      authMethod,
      authData,
      networkSettingsJson,
    }),
  );
}

export async function testProxyConnection(
  proxyKind: string,
  proxyHost: string,
  proxyPort: number,
  proxyUser: string,
  proxyPass: string,
  testHost: string,
  testPort: number,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("test_proxy_connection", {
      proxyKind,
      proxyHost,
      proxyPort,
      proxyUser,
      proxyPass,
      testHost,
      testPort,
    }),
  );
}

/**
 * Application-level outbound proxy (settings → "Application Proxy"). Distinct
 * from the per-session proxy in NetworkSettings. Field names mirror the Rust
 * `AppProxyConfig` (snake_case) so the object crosses the IPC boundary as-is.
 */
export interface AppProxyConfig {
  enabled: boolean;
  /** "session" | "manual" */
  mode: string;
  /** Saved Proxy session id (mode === "session"). */
  session_id: string;
  /** "http" | "socks5" (mode === "manual"). */
  kind: string;
  host: string;
  port: number;
  username: string;
  /** vault:<id> reference to the manual password; never plaintext. */
  password_ref: string;
}

export async function getAppProxyConfig(): Promise<AppProxyConfig> {
  return invoke<AppProxyConfig>("get_app_proxy_config");
}

export async function saveAppProxyConfig(config: AppProxyConfig): Promise<void> {
  return invoke("save_app_proxy_config", { config });
}

/** Resolved proxy URL for the updater; null for a direct connection. */
export async function getAppProxyUrl(): Promise<string | null> {
  return invoke<string | null>("get_app_proxy_url");
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

/**
 * Tell the backend that a terminal *tab* (`tabId` — the id CC's tools see, equal
 * to a chat thread's `linked_session_id`) is backed by a concrete backend
 * terminal session (`sessionId`, the `state.terminals` key). This lets
 * backend-side Claude Code tools (`run_captured` / `read_capture`) resolve the
 * live terminal that `run_in_terminal` reaches indirectly via the frontend
 * registry. Called as a terminal connects; safe to call repeatedly.
 */
export async function ccTrackTerminal(tabId: string, sessionId: string): Promise<void> {
  return invoke("cc_track_terminal", { tabId, sessionId });
}

/** Drop a tab → backend-session mapping recorded by {@link ccTrackTerminal}. */
export async function ccUntrackTerminal(tabId: string, sessionId: string): Promise<void> {
  return invoke("cc_untrack_terminal", { tabId, sessionId });
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

export function encodeBase64(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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

export interface LocalSessionFile {
  source: string;
  path: string;
  relativePath: string;
  text: string;
}

export interface DbeaverCredentialEntry {
  user?: string | null;
  password?: string | null;
  sections?: Record<string, Record<string, string>>;
}

export async function importPuttySessions(): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("import_putty_sessions", {});
}

export async function importWslSessions(): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("import_wsl_sessions", {});
}

export async function importExternalBashSessions(): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("import_external_bash_sessions", {});
}

export async function scanLocalSessionFiles(source: string): Promise<LocalSessionFile[]> {
  return invoke<LocalSessionFile[]>("scan_local_session_files", { source });
}

export async function readDbeaverCredentialsForDataSources(
  path: string,
): Promise<Record<string, DbeaverCredentialEntry>> {
  return invoke<Record<string, DbeaverCredentialEntry>>("read_dbeaver_credentials_for_data_sources", { path });
}

export async function readPlistSessionFile(path: string): Promise<LocalSessionFile> {
  return invoke<LocalSessionFile>("read_plist_session_file", { path });
}

export async function exitApp(): Promise<void> {
  return invoke("exit_app", {});
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke<string[]>("list_system_fonts", {});
}

function optionalDialogPath(path?: string | null): string | undefined {
  const trimmed = path?.trim();
  return trimmed ? trimmed : undefined;
}

function firstDialogPath(selected: string | string[] | null): string | null {
  if (typeof selected === "string") return selected;
  if (Array.isArray(selected)) {
    return selected.find((item) => typeof item === "string" && item.trim()) ?? null;
  }
  return null;
}

function saveDialogDefaultPath(defaultName?: string, currentPath?: string): string | undefined {
  const name = optionalDialogPath(defaultName);
  const current = optionalDialogPath(currentPath);
  if (!name) return current;
  if (!current) return name;
  if (/[\\/]$/.test(current)) return `${current}${name}`;

  const slash = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
  if (slash >= 0) return `${current.slice(0, slash + 1)}${name}`;
  return name;
}

async function selectOnePath(options: OpenDialogOptions): Promise<string | null> {
  return firstDialogPath(await openDialog({ multiple: false, ...options }));
}

export async function selectPrivateKeyFile(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select private key",
    directory: false,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function selectUploadFile(): Promise<string[]> {
  const selected = await openDialog({
    title: "Select files to send",
    multiple: true,
    directory: false,
  });
  return selected?.filter((item) => item.trim()) ?? [];
}

export async function selectSaveDirectory(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select save directory",
    directory: true,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function selectSaveFilePath(
  defaultName?: string,
  currentPath?: string,
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: "Save as",
    defaultPath: saveDialogDefaultPath(defaultName, currentPath),
  };
  return saveDialog(options);
}

export async function selectFilePath(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select file to open",
    directory: false,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function getHomeDir(): Promise<string | null> {
  return invoke<string | null>("get_home_dir", {});
}

export async function selectFolderPath(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select folder to open",
    directory: true,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buffer);
}

export interface ReadStreamOpenResult {
  handleId: string;
  size: number;
  mtime: number;
}

export async function readStreamOpen(path: string): Promise<ReadStreamOpenResult> {
  return invoke<ReadStreamOpenResult>("read_stream_open", { path });
}

export async function readStreamRead(handleId: string, maxBytes = 64 * 1024): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_stream_read", { handleId, maxBytes });
  return new Uint8Array(buffer);
}

export async function readStreamClose(handleId: string): Promise<void> {
  return invoke("read_stream_close", { handleId });
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

export async function checkFileExists(path: string): Promise<boolean> {
  return invoke<boolean>("check_file_exists", { path });
}

export async function temporaryFilePath(defaultName: string): Promise<string> {
  return invoke<string>("temporary_file_path", { defaultName });
}

export async function openLocalPath(path: string): Promise<void> {
  return invoke("sftp_open_path", { path });
}

// --- Command history ────────────────────────────────────────────────

export async function historyAppend(
  hostKey: string,
  command: string,
  max: number,
): Promise<void> {
  return invoke("history_append", { hostKey, command, max });
}

export async function historyMatchPrefix(
  hostKey: string,
  prefix: string,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>("history_match_prefix", { hostKey, prefix, limit });
}

export async function historyListRecent(
  hostKey: string,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>("history_list_recent", { hostKey, limit });
}

export async function historyClear(hostKey: string | null): Promise<void> {
  return invoke("history_clear", { hostKey });
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
  return withVaultLockedNotice(() =>
    invoke<VncConnectResult>("vnc_connect", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
    }),
  );
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
  return withVaultLockedNotice(() =>
    invoke("vnc_test_connection", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
    }),
  );
}

// ---------- Vault ----------

export type VaultStateKind = "empty" | "locked" | "unlocked";

export interface VaultStatus {
  state: VaultStateKind;
  entry_count: number;
}

export interface VaultPutResult {
  id: string;
  reference: string;
}

export interface VaultEntrySummary {
  id: string;
  label: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

export const VAULT_REF_PREFIX = "vault:";
export const VAULT_LOCKED_ERROR = "VAULT_LOCKED";
export const VAULT_LOCKED_EVENT = "vault-locked";

export function isVaultReference(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(VAULT_REF_PREFIX);
}

export function isVaultLockedError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : (err as Error).message ?? String(err);
  return msg.includes(VAULT_LOCKED_ERROR);
}

/**
 * Run an IPC call and, if it fails with VAULT_LOCKED, emit a global
 * `vault-locked` window event so MainLayout can surface the unlock dialog.
 * The error still propagates so callers can decide whether to retry after
 * the user unlocks (typically via a follow-up await of `whenUnlocked()`).
 */
export async function withVaultLockedNotice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isVaultLockedError(e)) {
      window.dispatchEvent(new CustomEvent(VAULT_LOCKED_EVENT));
    }
    throw e;
  }
}

export async function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>("vault_status");
}

export async function vaultInit(masterPassword: string): Promise<void> {
  return invoke("vault_init", { masterPassword });
}

export async function vaultUnlock(masterPassword: string): Promise<void> {
  return invoke("vault_unlock", { masterPassword });
}

export async function vaultLock(): Promise<void> {
  return invoke("vault_lock");
}

export async function vaultChangeMaster(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke("vault_change_master", { oldPassword, newPassword });
}

export async function vaultPut(
  kind: string,
  label: string,
  plaintext: string,
): Promise<VaultPutResult> {
  return invoke<VaultPutResult>("vault_put", { kind, label, plaintext });
}

export async function vaultUpdate(id: string, plaintext: string): Promise<void> {
  return invoke("vault_update", { id, plaintext });
}

export async function vaultDelete(id: string): Promise<void> {
  return invoke("vault_delete", { id });
}

export async function vaultList(): Promise<VaultEntrySummary[]> {
  return invoke<VaultEntrySummary[]>("vault_list");
}

/**
 * Return the raw user-supplied Claude Code settings.json (decrypted from the
 * vault) for the Settings editor, or null when none is configured. Wrapped in
 * `withVaultLockedNotice` so a locked vault prompts the unlock dialog.
 */
export async function ccGetCustomSettings(): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("cc_get_custom_settings"),
  );
}

export async function ccGetProfileSettings(vaultRef: string): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("cc_get_profile_settings", { vaultRef }),
  );
}

export async function codexGetCustomConfig(): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("codex_get_custom_config"),
  );
}

export async function codexGetProfileConfig(vaultRef: string): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("codex_get_profile_config", { vaultRef }),
  );
}

// --- Third-party importer secret recovery ---

export interface KeychainQuery {
  service: string;
  account: string;
}

export interface KeychainHit {
  service: string;
  account: string;
  found: boolean;
  value?: string;
  error?: string;
}

export async function keychainLookupBatch(
  entries: KeychainQuery[],
): Promise<KeychainHit[]> {
  return invoke<KeychainHit[]>("keychain_lookup_batch", { entries });
}

export type TabbySecret =
  | { kind: "password"; host: string; port?: number; user?: string; value: string }
  | { kind: "key-passphrase"; id: string; value: string };

export interface TabbyDecryptVaultResponse {
  secrets: TabbySecret[];
}

export const TABBY_VAULT_BAD_PASSWORD = "tabby_vault_bad_password";
export const TABBY_VAULT_MISSING = "tabby_vault_missing";

export function isTabbyBadPasswordError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : (err as Error).message ?? String(err);
  return msg.includes(TABBY_VAULT_BAD_PASSWORD);
}

export async function tabbyDecryptVault(
  yamlText: string,
  masterPassword: string,
): Promise<TabbyDecryptVaultResponse> {
  return invoke<TabbyDecryptVaultResponse>("tabby_decrypt_vault", {
    args: { yamlText, masterPassword },
  });
}

export interface SecureCrtPasswordRequest {
  sessionId: string;
  encrypted: string;
}

export interface SecureCrtPasswordHit {
  sessionId: string;
  value: string;
}

export interface SecureCrtPasswordFailure {
  sessionId: string;
  error: string;
  needsPassphrase: boolean;
}

export interface SecureCrtDecryptResponse {
  secrets: SecureCrtPasswordHit[];
  failures: SecureCrtPasswordFailure[];
}

export const SECURECRT_PASSWORD_BAD_PASSPHRASE = "securecrt_password_bad_passphrase";

export async function secureCrtDecryptPasswords(
  passwords: SecureCrtPasswordRequest[],
  passphrase: string,
): Promise<SecureCrtDecryptResponse> {
  return invoke<SecureCrtDecryptResponse>("securecrt_decrypt_passwords", {
    args: { passwords, passphrase },
  });
}

// --- Database client (MySQL / PostgreSQL / PanWeiDB / Oracle / SQL Server / StarRocks / ClickHouse / Presto / Redis) ---

/** Strip the frontend-only `sessionId` to build the Rust `DbConfig` payload. */
function toDbConfigPayload(info: DbConnectInfo): Record<string, unknown> {
  return {
    engine: info.engine,
    host: info.host,
    port: info.port,
    username: info.username ?? null,
    password: info.password ?? null,
    catalog: info.catalog ?? null,
    database: info.database ?? null,
    ssl: info.ssl ?? false,
    timeoutSecs: info.timeoutSecs ?? null,
    httpPort: info.httpPort ?? null,
    protocol: info.protocol ?? null,
    // Presto/Trino header dialect (X-Presto-* vs X-Trino-*). Must reach Rust.
    prestoDialect: info.prestoDialect ?? null,
    dbIndex: info.dbIndex ?? null,
    networkSettings: info.networkSettings ?? null,
  };
}

export interface DbConnectResult {
  ok: boolean;
}

export async function dbConnect(info: DbConnectInfo): Promise<DbConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<DbConnectResult>("db_connect", {
      sessionId: info.sessionId,
      config: toDbConfigPayload(info),
    }),
  );
}

export async function dbPing(sessionId: string): Promise<string> {
  return invoke<string>("db_ping", { sessionId });
}

/**
 * One-shot connection health check used by the "Test connection" button in the
 * session editor. Opens a throwaway connection, pings it, then disconnects so
 * no handle lingers in `AppState`.
 */
export async function dbTestConnection(info: DbConnectInfo): Promise<string> {
  const probeId = `db-test-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const probe: DbConnectInfo = { ...info, sessionId: probeId };
  await dbConnect(probe);
  try {
    return await dbPing(probeId);
  } finally {
    await dbDisconnect(probeId).catch(() => undefined);
  }
}

export async function dbDisconnect(sessionId: string): Promise<void> {
  return invoke("db_disconnect", { sessionId });
}

export interface DbSchema {
  name: string;
}

export interface DbCatalog {
  name: string;
}

export interface DbTable {
  name: string;
  kind: "table" | "view" | "materialized_view";
  rowCount?: number | null;
}

export interface DbColumnDescription {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

export interface DbForeignKey {
  name: string;
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string;
  referencedColumns: string[];
}

export interface DbIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

/** A non-table schema object (routine, trigger, event, sequence, dictionary). */
export interface DbObject {
  name: string;
  /** "procedure" | "function" | "trigger" | "event" | "sequence" | "dictionary". */
  kind: string;
  /** Owning table for triggers (used to DROP/DISABLE on PostgreSQL). */
  owner?: string;
}

export interface DbColumn {
  name: string;
  type: string;
}

export interface DbQueryResult {
  columns: DbColumn[];
  rows: (string | null)[][];
  rowsAffected: number;
  durationMs: number;
  warnings: string[];
}

export interface DbResultSqlFilter {
  columnIndex: number;
  text: string;
  mode: "fuzzy" | "exact";
  selectedValues: (string | null)[];
}

export interface DbResultSqlSort {
  columnIndex: number;
  dir: "asc" | "desc";
}

export interface DbResultSqlRewriteRequest {
  engine: string;
  sourceSql: string;
  resultColumns: string[];
  visibleColumnIndexes: number[];
  globalFilterText: string;
  filters: DbResultSqlFilter[];
  sorts: DbResultSqlSort[];
}

export interface DbResultSqlRewriteResponse {
  sql: string | null;
  mode: "inline" | "unsupported";
  reason: string | null;
  warnings: string[];
}

export type DbQueryStreamEvent =
  | { kind: "columns"; columns: DbColumn[] }
  | { kind: "rows"; rows: (string | null)[][] }
  | { kind: "done"; rowsAffected: number; durationMs: number; warnings: string[] };

export async function dbListCatalogs(sessionId: string): Promise<DbCatalog[]> {
  return invoke<DbCatalog[]>("db_list_catalogs", { sessionId });
}

export async function dbListSchemas(
  sessionId: string,
  catalog?: string | null,
): Promise<DbSchema[]> {
  return invoke<DbSchema[]>("db_list_schemas", { sessionId, catalog: catalog ?? null });
}

export async function dbListTables(
  sessionId: string,
  schema?: string | null,
  catalog?: string | null,
): Promise<DbTable[]> {
  return invoke<DbTable[]>("db_list_tables", {
    sessionId,
    schema: schema ?? null,
    catalog: catalog ?? null,
  });
}

export async function dbSearchTables(
  sessionId: string,
  schema: string | null,
  catalog: string | null,
  prefix: string,
  limit: number,
): Promise<DbTable[]> {
  return invoke<DbTable[]>("db_search_tables", {
    sessionId,
    schema,
    catalog,
    prefix,
    limit,
  });
}

export async function dbDescribeTable(
  sessionId: string,
  schema: string | null,
  table: string,
  catalog?: string | null,
): Promise<DbColumnDescription[]> {
  return invoke<DbColumnDescription[]>("db_describe_table", {
    sessionId,
    schema: schema ?? null,
    table,
    catalog: catalog ?? null,
  });
}

export async function dbListForeignKeys(
  sessionId: string,
  schema: string | null,
  table: string,
  catalog?: string | null,
): Promise<DbForeignKey[]> {
  return invoke<DbForeignKey[]>("db_list_foreign_keys", {
    sessionId,
    schema: schema ?? null,
    table,
    catalog: catalog ?? null,
  });
}

export async function dbListIndexes(
  sessionId: string,
  schema: string | null,
  table: string,
): Promise<DbIndex[]> {
  return invoke<DbIndex[]>("db_list_indexes", {
    sessionId,
    schema: schema ?? null,
    table,
  });
}

export async function dbListObjects(
  sessionId: string,
  schema: string | null,
  kind: string,
): Promise<DbObject[]> {
  return invoke<DbObject[]>("db_list_objects", {
    sessionId,
    schema: schema ?? null,
    kind,
  });
}

export async function dbObjectDdl(
  sessionId: string,
  schema: string | null,
  kind: string,
  name: string,
): Promise<string> {
  return invoke<string>("db_object_ddl", {
    sessionId,
    schema: schema ?? null,
    kind,
    name,
  });
}

export async function dbTableStats(
  sessionId: string,
  schema: string | null,
  table: string,
): Promise<DbQueryResult> {
  return invoke<DbQueryResult>("db_table_stats", {
    sessionId,
    schema: schema ?? null,
    table,
  });
}

export async function dbExecute(sessionId: string, sql: string): Promise<DbQueryResult> {
  return invoke<DbQueryResult>("db_execute", { sessionId, sql });
}

export async function dbRewriteResultSql(
  request: DbResultSqlRewriteRequest,
): Promise<DbResultSqlRewriteResponse> {
  return invoke<DbResultSqlRewriteResponse>("db_rewrite_result_sql", { request });
}

export async function dbExecuteStream(
  sessionId: string,
  sql: string,
  maxRows: number | null,
  onEvent: (event: DbQueryStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<DbQueryStreamEvent>();
  channel.onmessage = onEvent;
  return invoke("db_execute_stream", { sessionId, sql, maxRows: maxRows ?? null, onEvent: channel });
}

export async function dbCancel(sessionId: string): Promise<void> {
  return invoke("db_cancel", { sessionId });
}

// --- Database SQL History ---

export interface DbSqlHistoryEntry {
  id: string;
  savedSessionId?: string | null;
  engine: string;
  host: string;
  port: number;
  catalog?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  sqlContent: string;
  startedAt: number;
  durationMs?: number | null;
  rowsAffected?: number | null;
  rowCount?: number | null;
  hasResultSet: boolean;
  error?: string | null;
  createdAt: number;
}

export async function dbAppendHistory(entry: DbSqlHistoryEntry): Promise<void> {
  return invoke<void>("db_append_history", { entry });
}

export async function dbListHistory(options: {
  savedSessionId?: string | null;
  engine?: string | null;
  limit?: number | null;
} = {}): Promise<DbSqlHistoryEntry[]> {
  return invoke<DbSqlHistoryEntry[]>("db_list_history", {
    savedSessionId: options.savedSessionId ?? null,
    engine: options.engine ?? null,
    limit: options.limit ?? null,
  });
}

export async function dbDeleteHistory(id: string): Promise<void> {
  return invoke<void>("db_delete_history", { id });
}

export async function dbClearHistory(savedSessionId?: string | null): Promise<void> {
  return invoke<void>("db_clear_history", { savedSessionId: savedSessionId ?? null });
}

// --- Database Query Workspace ---

export interface DbQueryWorkspaceTab {
  workspaceId: string;
  panelId: string;
  tabOrder: number;
  content: string;
  filePath?: string | null;
  fileName?: string | null;
  dirty: boolean;
  isOpen: boolean;
  closedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DbQueryWorkspace {
  workspaceId: string;
  activePanelId?: string | null;
  tabs: DbQueryWorkspaceTab[];
  updatedAt: number;
}

export interface DbSaveQueryWorkspaceRequest {
  workspaceId: string;
  activePanelId?: string | null;
  tabs: DbQueryWorkspaceTab[];
  updatedAt: number;
}

export async function dbLoadQueryWorkspace(workspaceId: string): Promise<DbQueryWorkspace | null> {
  return invoke<DbQueryWorkspace | null>("db_load_query_workspace", { workspaceId });
}

export async function dbSaveQueryWorkspace(request: DbSaveQueryWorkspaceRequest): Promise<void> {
  return invoke<void>("db_save_query_workspace", { request });
}

export async function dbCloseQueryWorkspaceTabs(
  workspaceId: string,
  panelIds: string[],
  closedAt: number,
): Promise<void> {
  return invoke<void>("db_close_query_workspace_tabs", { workspaceId, panelIds, closedAt });
}

export async function dbListClosedQueryWorkspaceTabs(
  workspaceId: string,
  limit = 50,
): Promise<DbQueryWorkspaceTab[]> {
  return invoke<DbQueryWorkspaceTab[]>("db_list_closed_query_workspace_tabs", { workspaceId, limit });
}

export async function dbReopenQueryWorkspaceTab(
  workspaceId: string,
  panelId: string,
  tabOrder: number,
  updatedAt: number,
): Promise<boolean> {
  return invoke<boolean>("db_reopen_query_workspace_tab", {
    workspaceId,
    panelId,
    tabOrder,
    updatedAt,
  });
}

// --- Database Saved Queries ---

export type DbSavedQueryScope = "connection" | "engine";

export interface DbSavedQuery {
  id: string;
  scopeType: DbSavedQueryScope;
  scopeId: string;
  engine: string;
  catalogName?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  namespaceKey: string;
  name: string;
  content: string;
  remarks?: string | null;
  tags: string[];
  revision: number;
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DbListSavedQueriesRequest {
  connectionId?: string | null;
  engine?: string | null;
  catalogName?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  includeAllNamespaces: boolean;
  includeArchived: boolean;
}

export async function dbListSavedQueries(
  request: DbListSavedQueriesRequest,
): Promise<DbSavedQuery[]> {
  return invoke<DbSavedQuery[]>("db_list_saved_queries", { request });
}

export async function dbSaveSavedQuery(query: DbSavedQuery): Promise<DbSavedQuery> {
  return invoke<DbSavedQuery>("db_save_saved_query", { query });
}

export async function dbArchiveSavedQuery(
  id: string,
  revision: number,
  archivedAt: number | null,
  updatedAt: number,
): Promise<number> {
  return invoke<number>("db_archive_saved_query", { id, revision, archivedAt, updatedAt });
}

export async function dbDeleteSavedQuery(id: string): Promise<boolean> {
  return invoke<boolean>("db_delete_saved_query", { id });
}

// --- Database SQL Bookmarks ---

export interface DbBookmark {
  id: string;
  name: string;
  sqlContent: string;
  remarks?: string;
  tags: string[];
  engine: string;
  databaseName?: string;
  createdAt: number;
  updatedAt: number;
}

export async function dbListBookmarks(engine?: string): Promise<DbBookmark[]> {
  return invoke<DbBookmark[]>("db_list_bookmarks", { engine: engine ?? null });
}

export async function dbSaveBookmark(bookmark: DbBookmark): Promise<void> {
  return invoke<void>("db_save_bookmark", { bookmark });
}

export async function dbDeleteBookmark(id: string): Promise<void> {
  return invoke<void>("db_delete_bookmark", { id });
}

// --- Redis ---

export interface RedisKeyEntry {
  key: string;
  type: "string" | "hash" | "list" | "set" | "zset" | "stream" | "none";
  /** TTL seconds: -1 persistent, -2 missing, else seconds remaining. */
  ttl: number;
}

export interface RedisScanPage {
  cursor: string;
  keys: RedisKeyEntry[];
}

export interface RedisValue {
  kind: "string" | "hash" | "list" | "set" | "zset" | "stream" | "none";
  /** Shape depends on kind — see Rust `RedisValue` doc. */
  value: unknown;
  ttl: number;
  encoding: string | null;
  memoryUsage: number | null;
}

export async function redisListKeys(
  sessionId: string,
  pattern: string,
  cursor: string,
  count: number,
): Promise<RedisScanPage> {
  return invoke<RedisScanPage>("redis_list_keys", {
    sessionId,
    pattern,
    cursor,
    count,
  });
}

export async function redisGetKey(sessionId: string, key: string): Promise<RedisValue> {
  return invoke<RedisValue>("redis_get_key", { sessionId, key });
}

export async function redisSetKey(
  sessionId: string,
  key: string,
  kind: string,
  value: unknown,
  ttl?: number | null,
): Promise<void> {
  return invoke("redis_set_key", { sessionId, key, kind, value, ttl: ttl ?? null });
}

export async function redisDelKey(sessionId: string, key: string): Promise<void> {
  return invoke("redis_del_key", { sessionId, key });
}

export async function redisExec(sessionId: string, rawCommand: string): Promise<string> {
  return invoke<string>("redis_exec", { sessionId, rawCommand });
}

// --- HBase shell client (JVM-free HBase REST/Stargate) ---

function toHBaseConfigPayload(info: HBaseConnectInfo): Record<string, unknown> {
  return {
    host: info.host,
    port: info.port,
    username: info.username ?? null,
    password: info.password ?? null,
    ssl: info.ssl ?? false,
    timeoutSecs: info.timeoutSecs ?? null,
    restPath: info.restPath ?? null,
    namespace: info.namespace ?? null,
    connectionMode: info.connectionMode ?? null,
    zkQuorum: info.zkQuorum ?? null,
    zkRoot: info.zkRoot ?? null,
    effectiveUser: info.effectiveUser ?? null,
    authMethod: info.authMethod ?? null,
    servicePrincipal: info.servicePrincipal ?? null,
    principal: info.principal ?? null,
    keytabPath: info.keytabPath ?? null,
    krb5ConfPath: info.krb5ConfPath ?? null,
    hbaseSitePath: info.hbaseSitePath ?? null,
  };
}

export interface HBaseConnectResult {
  ok: boolean;
}

export interface HBaseTableInfo {
  name: string;
}

export interface HBaseColumnFamily {
  name: string;
  attributes: Record<string, string>;
}

export interface HBaseTableSchema {
  name: string;
  columnFamilies: HBaseColumnFamily[];
}

export interface HBaseShellResult {
  command: string;
  message: string;
  columns: string[];
  rows: string[][];
  warnings: string[];
  durationMs: number;
}

export async function hbaseConnect(info: HBaseConnectInfo): Promise<HBaseConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<HBaseConnectResult>("hbase_connect", {
      sessionId: info.sessionId,
      config: toHBaseConfigPayload(info),
    }),
  );
}

export async function hbasePing(sessionId: string): Promise<string> {
  return invoke<string>("hbase_ping", { sessionId });
}

export async function hbaseTestConnection(info: HBaseConnectInfo): Promise<string> {
  const probeId = `hbase-test-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const probe: HBaseConnectInfo = { ...info, sessionId: probeId };
  await hbaseConnect(probe);
  try {
    return await hbasePing(probeId);
  } finally {
    await hbaseDisconnect(probeId).catch(() => undefined);
  }
}

export async function hbaseDisconnect(sessionId: string): Promise<void> {
  return invoke("hbase_disconnect", { sessionId });
}

export async function hbaseCancel(sessionId: string): Promise<void> {
  return invoke("hbase_cancel", { sessionId });
}

export async function hbaseListTables(sessionId: string): Promise<HBaseTableInfo[]> {
  return invoke<HBaseTableInfo[]>("hbase_list_tables", { sessionId });
}

export async function hbaseDescribeTable(
  sessionId: string,
  table: string,
): Promise<HBaseTableSchema> {
  return invoke<HBaseTableSchema>("hbase_describe_table", { sessionId, table });
}

export async function hbaseExecute(
  sessionId: string,
  command: string,
): Promise<HBaseShellResult> {
  return invoke<HBaseShellResult>("hbase_execute", { sessionId, command });
}

export async function hbaseParseSiteXml(path: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("hbase_parse_site_xml", { path });
}

export async function hbaseParseKeytabPrincipal(path: string): Promise<string> {
  return invoke<string>("hbase_parse_keytab_principal", { path });
}

/* ----------------------------- LanChat (内网通讯) ----------------------------- */

export async function lanchatStatus(): Promise<LanChatStatus> {
  return invoke<LanChatStatus>("lanchat_status");
}

export async function lanchatListPeers(): Promise<LanPeer[]> {
  return invoke<LanPeer[]>("lanchat_list_peers");
}

export async function lanchatGetProfile(): Promise<LanProfile> {
  return invoke<LanProfile>("lanchat_get_profile");
}

export async function lanchatUpdateProfile(args: {
  name: string;
  avatarBase64?: string | null;
  signature: string;
  status: string;
}): Promise<LanProfile> {
  return invoke<LanProfile>("lanchat_update_profile", { args });
}

export async function lanchatSendText(args: {
  peerId: string;
  text: string;
  mentions?: string[];
}): Promise<LanMessage> {
  return invoke<LanMessage>("lanchat_send_text", { args });
}

export async function lanchatResendMessage(msgId: string): Promise<LanMessage> {
  return invoke<LanMessage>("lanchat_resend_message", { msgId });
}

export async function lanchatListConversations(): Promise<LanConversation[]> {
  return invoke<LanConversation[]>("lanchat_list_conversations");
}

export async function lanchatListMessages(
  convId: string,
  limit?: number,
): Promise<LanMessage[]> {
  return invoke<LanMessage[]>("lanchat_list_messages", { convId, limit });
}

export async function lanchatMarkRead(convId: string): Promise<void> {
  return invoke("lanchat_mark_read", { convId });
}

export async function lanchatCreateGroup(args: {
  name: string;
  members?: string[];
}): Promise<LanGroup> {
  return invoke<LanGroup>("lanchat_create_group", { args });
}

export async function lanchatSendGroupText(args: {
  groupId: string;
  text: string;
  mentions?: string[];
}): Promise<LanMessage> {
  return invoke<LanMessage>("lanchat_send_group_text", { args });
}

export async function lanchatListGroups(): Promise<LanGroup[]> {
  return invoke<LanGroup[]>("lanchat_list_groups");
}

export async function lanchatLeaveGroup(groupId: string): Promise<void> {
  return invoke("lanchat_leave_group", { groupId });
}

export async function listenLanChatRoster(
  cb: (peers: LanPeer[]) => void,
): Promise<UnlistenFn> {
  return listen<LanPeer[]>("lanchat://roster", (e) => cb(e.payload));
}

export async function listenLanChatMessage(
  cb: (msg: LanMessage) => void,
): Promise<UnlistenFn> {
  return listen<LanMessage>("lanchat://message", (e) => cb(e.payload));
}

export async function listenLanChatConversation(
  cb: (conv: LanConversation) => void,
): Promise<UnlistenFn> {
  return listen<LanConversation>("lanchat://conversation", (e) => cb(e.payload));
}

export async function listenLanChatGroup(
  cb: (group: LanGroup) => void,
): Promise<UnlistenFn> {
  return listen<LanGroup>("lanchat://group", (e) => cb(e.payload));
}

/* ----------------------------- LanChat transfers ----------------------------- */

export async function lanchatSendFile(peerId: string, path: string): Promise<string> {
  return invoke<string>("lanchat_send_file", { peerId, path });
}

export async function lanchatSendGroupFile(groupId: string, path: string): Promise<string> {
  return invoke<string>("lanchat_send_group_file", { groupId, path });
}

export async function lanchatSendDir(peerId: string, path: string): Promise<string> {
  return invoke<string>("lanchat_send_dir", { peerId, path });
}

export async function lanchatAcceptFile(transferId: string, savePath: string): Promise<string> {
  return invoke<string>("lanchat_accept_file", { transferId, savePath });
}

export async function lanchatOpenPath(path: string): Promise<void> {
  return invoke("lanchat_open_path", { path });
}

export async function lanchatRejectFile(transferId: string): Promise<void> {
  return invoke("lanchat_reject_file", { transferId });
}

export async function lanchatTransferControl(
  transferId: string,
  action: "pause" | "resume" | "cancel",
): Promise<void> {
  return invoke("lanchat_transfer_control", { transferId, action });
}

export async function lanchatSendScreenshot(peerId: string): Promise<string> {
  return invoke<string>("lanchat_send_screenshot", { peerId });
}

export async function lanchatSendClipboardImage(peerId: string): Promise<string> {
  return invoke<string>("lanchat_send_clipboard_image", { peerId });
}

export async function lanchatSendImageBytes(peerId: string, dataB64: string): Promise<string> {
  return invoke<string>("lanchat_send_image_bytes", { peerId, data: dataB64 });
}

export async function listenLanChatTransfer(
  cb: (p: LanTransferProgress) => void,
): Promise<UnlistenFn> {
  return listen<LanTransferProgress>("lanchat://transfer", (e) => cb(e.payload));
}

export async function listenLanChatFileOffer(
  cb: (offer: LanFileOffer) => void,
): Promise<UnlistenFn> {
  return listen<LanFileOffer>("lanchat://file-offer", (e) => cb(e.payload));
}

/* ----------------------------- LanChat A/V signaling ----------------------------- */

export async function lanchatSendSignal(
  peerId: string,
  frameType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return invoke("lanchat_send_signal", { peerId, frameType, payload });
}

export async function lanchatSignalGroup(
  groupId: string,
  frameType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return invoke("lanchat_signal_group", { groupId, frameType, payload });
}

export async function listenLanChatSignal(
  cb: (s: LanSignal) => void,
): Promise<UnlistenFn> {
  return listen<LanSignal>("lanchat://signal", (e) => cb(e.payload));
}

/* ---- Native A/V media (v4, Linux / no-WebRTC stack) ---- */

/** Start a native media session for a call; returns the loopback WS port the
 *  webview connects to for decoded media. */
export async function nmediaStart(callId: string): Promise<number> {
  return invoke<number>("nmedia_start", { callId });
}

export async function nmediaStop(callId: string): Promise<void> {
  return invoke("nmedia_stop", { callId });
}

export async function nmediaWsPort(callId: string): Promise<number> {
  return invoke<number>("nmedia_ws_port", { callId });
}

export async function nmediaAddPeer(callId: string, peerId: string): Promise<void> {
  return invoke("nmedia_add_peer", { callId, peerId });
}

export async function nmediaRemovePeer(callId: string, peerId: string): Promise<void> {
  return invoke("nmedia_remove_peer", { callId, peerId });
}

export async function nmediaPeerState(
  callId: string,
  peerId: string,
  mic: boolean,
  cam: boolean,
  screen: boolean,
): Promise<void> {
  return invoke("nmedia_peer_state", { callId, peerId, mic, cam, screen });
}

export async function nmediaToggleMic(callId: string, on: boolean): Promise<void> {
  return invoke("nmedia_toggle_mic", { callId, on });
}

export async function nmediaToggleScreen(callId: string, on: boolean): Promise<void> {
  return invoke("nmedia_toggle_screen", { callId, on });
}

export async function nmediaToggleCam(callId: string, on: boolean): Promise<void> {
  return invoke("nmedia_toggle_cam", { callId, on });
}

export async function listenLanChatWb(
  cb: (s: LanSignal) => void,
): Promise<UnlistenFn> {
  return listen<LanSignal>("lanchat://wb", (e) => cb(e.payload));
}

/* ----------------------------- retention & security (phase 4) ----------------------------- */

export async function lanchatGetRetention(): Promise<LanRetention> {
  return invoke<LanRetention>("lanchat_get_retention");
}

export async function lanchatSetRetention(settings: LanRetention): Promise<void> {
  return invoke("lanchat_set_retention", { settings });
}

export async function lanchatDeleteMessage(msgId: string): Promise<void> {
  return invoke("lanchat_delete_message", { msgId });
}

export async function lanchatClearConversation(convId: string): Promise<void> {
  return invoke("lanchat_clear_conversation", { convId });
}

export async function lanchatClearAllHistory(): Promise<void> {
  return invoke("lanchat_clear_all_history");
}

export async function lanchatListPinned(): Promise<LanPinnedPeer[]> {
  return invoke<LanPinnedPeer[]>("lanchat_list_pinned");
}

export async function lanchatRetrustPeer(nodeId: string): Promise<void> {
  return invoke("lanchat_retrust_peer", { nodeId });
}

export async function listenLanChatSecurity(
  cb: (e: LanSecurityEvent) => void,
): Promise<UnlistenFn> {
  return listen<LanSecurityEvent>("lanchat://security", (e) => cb(e.payload));
}

/* ----------------------------- service enable / start-on-launch ----------------------------- */

export async function lanchatGetServiceState(): Promise<LanServiceState> {
  return invoke<LanServiceState>("lanchat_get_service_state");
}

/** Manually start the background service (one-way; runs until app exit). */
export async function lanchatStartService(): Promise<void> {
  return invoke("lanchat_start_service");
}

/** Set the "start LanChat on app launch" policy (affects next launch only). */
export async function lanchatSetStartOnLaunch(enabled: boolean): Promise<void> {
  return invoke("lanchat_set_start_on_launch", { enabled });
}

/** Service lifecycle change: fires with `{ running }` when the service starts. */
export async function listenLanChatService(
  cb: (running: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ running: boolean }>("lanchat://service", (e) =>
    cb(e.payload.running),
  );
}
