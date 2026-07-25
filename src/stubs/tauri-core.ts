import type { SessionConfig, SessionGroup, LocalShellOption, LocalDirectoryShortcut } from "../lib/ipc";
import {
  isSshSession,
  sshClose,
  sshConnect,
  sshResize,
  sshSignal,
  sshTest,
  sshWrite,
  type SshConnectArgs,
} from "./sshClient";
import {
  isSftpSession,
  sftpAttach,
  sftpDetach,
  sftpListRemote,
  sftpStatRemote,
  sftpMkdirRemote,
  sftpRemoveRemote,
  sftpRenameRemote,
  sftpChmodRemote,
  sftpRealpathRemote,
  sftpReadTextRemote,
  sftpWriteTextRemote,
  sftpUploadBytesRemote,
  sftpDownloadBytesRemote,
  sftpCancel,
} from "./sftpClient";
import {
  vfsHome,
  vfsList,
  vfsStat,
  vfsMkdir,
  vfsRemove,
  vfsRename,
  vfsReadText,
  vfsWriteText,
  vfsReadBytes,
  vfsWriteBytes,
  vfsExportToBrowser,
  VFS_ROOT,
} from "./localVfs";
import { emit } from "./tauri-event";
import { promptAppDialog } from "../lib/appDialogs";

const SESSION_STORAGE_KEY = "taomni.sessions.v1";
const GROUP_STORAGE_KEY = "taomni.groups.v1";
const TUNNEL_STORAGE_KEY = "taomni.tunnels.v1";
const CHAT_THREADS_STORAGE_KEY = "taomni.stub.chatThreads.v1";
const CHAT_MESSAGES_STORAGE_KEY = "taomni.stub.chatMessages.v1";
const DB_HISTORY_STORAGE_KEY = "taomni.stub.dbSqlHistory.v1";
const NOTES_STORAGE_KEY = "taomni.stub.notes.v1";
const NOTE_TAGS_STORAGE_KEY = "taomni.stub.noteTags.v1";
const NOTE_PREFS_STORAGE_KEY = "taomni.stub.notePrefs.v1";
const NOTE_ALERT_ACK_STORAGE_KEY = "taomni.stub.noteAlertAcks.v1";
const MAIL_DRAFTS_STORAGE_KEY = "taomni.stub.mailDrafts.v1";
const SDK_REGISTRY_STORAGE_KEY = "taomni.stub.sdkRegistry.v1";

interface StubSdkRegistry {
  schemaVersion: number;
  installations: Array<Record<string, any>>;
  defaults: Array<Record<string, any>>;
  bindings: Array<Record<string, any>>;
}

function loadSdkRegistry(): StubSdkRegistry {
  try {
    const parsed = JSON.parse(localStorage.getItem(SDK_REGISTRY_STORAGE_KEY) ?? "null");
    if (parsed && parsed.schemaVersion === 1) {
      return {
        schemaVersion: 1,
        installations: Array.isArray(parsed.installations) ? parsed.installations : [],
        defaults: Array.isArray(parsed.defaults) ? parsed.defaults : [],
        bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
      };
    }
  } catch {
    // Fall through to a clean browser-preview registry.
  }
  return { schemaVersion: 1, installations: [], defaults: [], bindings: [] };
}

function saveSdkRegistry(registry: StubSdkRegistry): void {
  localStorage.setItem(SDK_REGISTRY_STORAGE_KEY, JSON.stringify(registry));
}

function stubSdkVersion(kind: string, location: string): string | null {
  const match = location.match(/(?:jdk|java|kotlin|scala|python|py)[-_ ]?([0-9]+(?:\.[0-9]+)*)/i);
  if (match?.[1]) return match[1];
  if (kind === "java") return "21";
  if (kind === "python") return "3.13";
  return null;
}

interface StubTunnelStatus {
  id: string;
  status: "stopped" | "starting" | "running" | "error";
  error?: string;
  activeConnections?: number;
}
const tunnelStatuses: Record<string, StubTunnelStatus> = {};

interface StubTunnelConfig {
  id: string;
  name: string;
  kind: "Local" | "Remote" | "Dynamic";
  listenHost: string;
  listenPort: number;
  destHost: string;
  destPort: number;
  sshSessionId?: string | null;
  ssh: {
    host: string;
    port: number;
    username: string;
    authMethod: "Password" | "PrivateKey" | "Agent";
    authData: string | null;
    saveAuth?: boolean;
  };
  description?: string;
  autostart?: boolean;
  sortOrder?: number;
}

interface StubChatThread {
  id: string;
  title: string;
  provider_id: string;
  created_at: number;
  updated_at: number;
  linked_session_id: string | null;
  source: string;
  mode?: string | null;
  output_format?: string | null;
  cc_model?: string | null;
}

interface StubChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  redacted: boolean;
  attachments?: StubChatAttachment[];
}

interface StubChatAttachment {
  id: string;
  kind: "image" | "file" | "video";
  path: string;
  name: string;
  size: number;
  mime?: string | null;
  preview_url?: string | null;
}

interface StubDbSqlHistoryEntry {
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

function loadDbSqlHistory(): StubDbSqlHistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DB_HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDbSqlHistory(entries: StubDbSqlHistoryEntry[]): void {
  localStorage.setItem(DB_HISTORY_STORAGE_KEY, JSON.stringify(entries));
}

function loadChatThreads(): StubChatThread[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_THREADS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.map((thread) => ({
          ...thread,
          mode: thread?.mode === "image" || thread?.mode === "video" ? thread.mode : "chat",
        }))
      : [];
  } catch {
    return [];
  }
}

function saveChatThreads(threads: StubChatThread[]): void {
  localStorage.setItem(CHAT_THREADS_STORAGE_KEY, JSON.stringify(threads));
}

function loadChatMessages(): Record<string, StubChatMessage[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_MESSAGES_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveChatMessages(messages: Record<string, StubChatMessage[]>): void {
  localStorage.setItem(CHAT_MESSAGES_STORAGE_KEY, JSON.stringify(messages));
}

// ---------- Tao Notes (browser-preview localStorage mirror of notes.db) ----------

interface StubNoteStep {
  id: string;
  note_id: string;
  title: string;
  completed_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}
interface StubNoteTag {
  id: string;
  name: string;
  color: string | null;
  created_at: number;
  updated_at: number;
}
interface StubNote {
  id: string;
  title: string;
  body: string;
  completed_at: number | null;
  pinned: boolean;
  archived_at: number | null;
  color: string | null;
  priority: number;
  due_at: number | null;
  reminder_at: number | null;
  repeat_rule: string | null;
  source_tab_id: string | null;
  source_session_id: string | null;
  source_title: string | null;
  source_uri: string | null;
  created_at: number;
  updated_at: number;
  steps: StubNoteStep[];
  tag_ids: string[];
}

const NOTE_DUE_SOON_SECS = 30 * 60;
const nowSecsStub = () => Math.floor(Date.now() / 1000);
const stubId = () =>
  globalThis.crypto?.randomUUID?.() ?? `stub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function loadNotes(): StubNote[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveNotes(notes: StubNote[]): void {
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
}
function loadNoteTags(): StubNoteTag[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTE_TAGS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveNoteTags(tags: StubNoteTag[]): void {
  localStorage.setItem(NOTE_TAGS_STORAGE_KEY, JSON.stringify(tags));
}
function loadNoteAcks(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTE_ALERT_ACK_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveNoteAcks(acks: Record<string, number>): void {
  localStorage.setItem(NOTE_ALERT_ACK_STORAGE_KEY, JSON.stringify(acks));
}

/** Hydrate the wire NoteItem shape (steps + resolved tags) from a stored note. */
function stubNoteToItem(note: StubNote): Record<string, unknown> {
  const allTags = loadNoteTags();
  const tags = note.tag_ids
    .map((id) => allTags.find((t) => t.id === id))
    .filter((t): t is StubNoteTag => Boolean(t));
  const { tag_ids: _drop, ...rest } = note;
  return { ...rest, tags };
}

function stubFilterNotes(notes: StubNote[], query: Record<string, unknown>): StubNote[] {
  const filter = (query.filter as string | undefined) ?? "recent_incomplete";
  const filters = Array.isArray(query.filters) && query.filters.length > 0 ? query.filters.map(String) : [filter];
  const now = Number(query.now) || nowSecsStub();
  const dueSoon = Number(query.due_soon_secs) || NOTE_DUE_SOON_SECS;
  const search = ((query.search as string | undefined) ?? "").trim().toLowerCase();
  const tagId = (query.tag_id as string | undefined) ?? null;
  const allTags = loadNoteTags();

  let list = notes.filter((n) =>
    filters.some((status) => {
      switch (status) {
        case "all":
          return n.archived_at === null;
        case "pinned":
          return n.archived_at === null && n.pinned;
        case "completed":
          return n.archived_at === null && n.completed_at !== null;
        case "archived":
          return n.archived_at !== null;
        case "today": {
          if (n.archived_at !== null || n.completed_at !== null || n.due_at === null) return false;
          const d = new Date(now * 1000);
          const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
          return n.due_at >= start && n.due_at < start + 86400;
        }
        case "due_soon":
          return (
            n.archived_at === null &&
            n.completed_at === null &&
            n.due_at !== null &&
            n.due_at > now &&
            n.due_at <= now + dueSoon
          );
        case "overdue":
          return n.archived_at === null && n.completed_at === null && n.due_at !== null && n.due_at <= now;
        default: // recent_incomplete
          return n.archived_at === null && n.completed_at === null;
      }
    }),
  );

  if (tagId) list = list.filter((n) => n.tag_ids.includes(tagId));
  if (search) {
    list = list.filter((n) => {
      if (n.title.toLowerCase().includes(search) || n.body.toLowerCase().includes(search)) return true;
      return n.tag_ids.some((id) => {
        const tag = allTags.find((t) => t.id === id);
        return tag ? tag.name.toLowerCase().includes(search) : false;
      });
    });
  }

  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aNull = a.due_at === null ? 1 : 0;
    const bNull = b.due_at === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    if (a.due_at !== null && b.due_at !== null && a.due_at !== b.due_at) return a.due_at - b.due_at;
    return b.updated_at - a.updated_at;
  });

  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = query.limit != null && Number(query.limit) >= 0 ? Number(query.limit) : undefined;
  return limit != null ? list.slice(offset, offset + limit) : list.slice(offset);
}


function normalizeStubChatMode(mode: unknown): "chat" | "image" | "video" {
  return mode === "image" || mode === "video" ? mode : "chat";
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stubGeneratedImageDataUri(prompt: string): string {
  const label = escapeSvgText((prompt || "Generated image").slice(0, 48));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="0 0 1024 768"><rect width="1024" height="768" fill="#111827"/><rect x="72" y="72" width="880" height="624" rx="32" fill="#1f2937"/><circle cx="512" cy="306" r="156" fill="#38bdf8"/><path d="M336 594h352l-112-142-82 92-54-62z" fill="#a7f3d0"/><text x="512" y="658" fill="#f8fafc" font-size="38" font-family="Arial, sans-serif" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function loadTunnels(): StubTunnelConfig[] {
  try {
    return JSON.parse(localStorage.getItem(TUNNEL_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveTunnels(list: StubTunnelConfig[]): void {
  // Strip secrets unless saveAuth is true (mirrors how the desktop vault behaves).
  const sanitized = list.map((t) => ({
    ...t,
    ssh: {
      ...t.ssh,
      authData: t.ssh.saveAuth ? t.ssh.authData : (t.ssh.authMethod === "PrivateKey" ? t.ssh.authData : null),
    },
  }));
  localStorage.setItem(TUNNEL_STORAGE_KEY, JSON.stringify(sanitized));
}

function loadSessions(): SessionConfig[] {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionConfig[]): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

function loadGroups(): SessionGroup[] {
  try {
    return JSON.parse(localStorage.getItem(GROUP_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveGroups(groups: SessionGroup[]): void {
  localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups));
}

type InvokeArgs = Record<string, unknown>;
interface InvokeOptions {
  headers?: Record<string, string>;
}

export class Channel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;
}

// Base class mirrored from `@tauri-apps/api/core`. Plugins like
// `@tauri-apps/plugin-updater` (Update extends Resource) import it, so the
// browser build needs the symbol to exist. It's never exercised here — update
// flows are guarded by isTauriRuntime() and no-op outside the desktop app.
export class Resource {
  readonly rid: number;
  constructor(rid: number) {
    this.rid = rid;
  }
  async close(): Promise<void> {
    /* no-op in browser preview */
  }
}

function joinWorkspacePath(repoRoot: string, relative = ""): string {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  const clean = relative.replace(/^\/+/, "").replace(/\\/g, "/");
  return clean ? `${root}/${clean}` : root;
}

function relativeWorkspacePath(repoRoot: string, path: string): string {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  const normalized = path.replace(/\\/g, "/");
  return normalized === root ? "" : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function assertWorkspaceWritablePath(path: string): void {
  if (path.split(/[\\/]+/).includes(".git")) {
    throw new Error("Writing inside .git is not allowed");
  }
}

async function workspaceEntryFromVfs(repoRoot: string, path: string) {
  const entry = await vfsStat(path);
  return {
    name: entry.name,
    path: relativeWorkspacePath(repoRoot, entry.path),
    fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
    size: entry.size,
    mtime: entry.mtime,
    isHidden: entry.isHidden,
  };
}

const STUB_LSP_PRESETS = [
  {
    id: "typescript-javascript",
    displayName: "TypeScript / JavaScript",
    documentLanguageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    fileExtensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    fileNames: [],
    commands: [
      {
        id: "typescript-language-server",
        label: "typescript-language-server",
        command: "typescript-language-server",
        args: ["--stdio"],
        installHint: "npm install -g typescript typescript-language-server",
        fallback: false,
      },
    ],
  },
  {
    id: "rust",
    displayName: "Rust",
    documentLanguageIds: ["rust"],
    fileExtensions: ["rs"],
    fileNames: [],
    commands: [{ id: "rust-analyzer", label: "rust-analyzer", command: "rust-analyzer", args: [], installHint: "rustup component add rust-analyzer", fallback: false }],
  },
  {
    id: "python",
    displayName: "Python",
    documentLanguageIds: ["python"],
    fileExtensions: ["py", "pyi"],
    fileNames: [],
    commands: [{ id: "pyright", label: "pyright-langserver", command: "pyright-langserver", args: ["--stdio"], installHint: "npm install -g pyright", fallback: false }],
  },
  {
    id: "go",
    displayName: "Go",
    documentLanguageIds: ["go"],
    fileExtensions: ["go"],
    fileNames: [],
    commands: [{ id: "gopls", label: "gopls", command: "gopls", args: [], installHint: "go install golang.org/x/tools/gopls@latest", fallback: false }],
  },
  {
    id: "java",
    displayName: "Java",
    documentLanguageIds: ["java"],
    fileExtensions: ["java"],
    fileNames: [],
    commands: [{
      id: "jdtls",
      label: "jdtls",
      command: "jdtls",
      args: [],
      installHint: "Requires JDK 21+ (current JDT LS). Install Eclipse JDT LS and ensure `jdtls` + java 21 are on PATH",
      fallback: false,
    }],
  },
  {
    id: "cpp",
    displayName: "C / C++",
    documentLanguageIds: ["c", "cpp"],
    fileExtensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx"],
    fileNames: [],
    commands: [{ id: "clangd", label: "clangd", command: "clangd", args: [], installHint: "Install LLVM clangd and ensure `clangd` is on PATH", fallback: false }],
  },
  {
    id: "kotlin",
    displayName: "Kotlin",
    documentLanguageIds: ["kotlin"],
    fileExtensions: ["kt", "kts"],
    fileNames: [],
    commands: [{ id: "kotlin-language-server", label: "kotlin-language-server", command: "kotlin-language-server", args: [], installHint: "Install kotlin-language-server and ensure it is on PATH", fallback: false }],
  },
  {
    id: "scala",
    displayName: "Scala",
    documentLanguageIds: ["scala"],
    fileExtensions: ["scala", "sc"],
    fileNames: [],
    commands: [{ id: "metals", label: "Metals", command: "metals", args: [], installHint: "Install Metals and ensure `metals` is on PATH", fallback: false }],
  },
  {
    id: "csharp",
    displayName: "C#",
    documentLanguageIds: ["csharp"],
    fileExtensions: ["cs", "csx"],
    fileNames: [],
    commands: [
      { id: "csharp-ls", label: "csharp-ls", command: "csharp-ls", args: [], installHint: "dotnet tool install -g csharp-ls", fallback: false },
      { id: "omnisharp", label: "OmniSharp", command: "omnisharp", args: ["--languageserver"], installHint: "Install OmniSharp and ensure `omnisharp` is on PATH", fallback: true },
    ],
  },
  {
    id: "swift",
    displayName: "Swift",
    documentLanguageIds: ["swift"],
    fileExtensions: ["swift"],
    fileNames: [],
    commands: [{ id: "sourcekit-lsp", label: "SourceKit-LSP", command: "sourcekit-lsp", args: [], installHint: "Install Swift toolchain and ensure `sourcekit-lsp` is on PATH", fallback: false }],
  },
];

function stubLspPresetForPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return STUB_LSP_PRESETS.find((preset) => preset.fileExtensions.includes(ext)) ?? null;
}

function stubLspDocumentStatus(args?: InvokeArgs) {
  const filePath = (args?.filePath as string | undefined) ?? "";
  const preset = stubLspPresetForPath(filePath);
  return {
    path: filePath,
    uri: filePath ? `file://${filePath}` : "",
    presetId: preset?.id ?? null,
    languageId: preset?.documentLanguageIds[0] ?? null,
    displayName: preset?.displayName ?? null,
    available: false,
    active: false,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: preset?.commands[0]?.installHint ?? null,
    error: preset ? `${preset.displayName} language server is not available in browser preview` : "No language server preset for this file type",
  };
}

function stubLspServerStatuses() {
  return STUB_LSP_PRESETS.map((preset) => ({
    presetId: preset.id,
    displayName: preset.displayName,
    documentLanguageIds: preset.documentLanguageIds,
    available: false,
    active: false,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: preset.commands[0]?.installHint ?? "",
    error: "Language servers are not available in browser preview",
    runtimeStatus: preset.id === "java"
      ? "Java not probed in browser preview — need JDK 21+ for jdtls"
      : null,
    commands: preset.commands.map((command) => ({ ...command, available: false })),
  }));
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** No-op plugin-listener shim so plugins that import `addPluginListener`
 *  (e.g. @tauri-apps/plugin-notification) load in browser preview. */
export class PluginListener {
  constructor(
    public plugin: string,
    public event: string,
    public channelId: number,
  ) {}
  async unregister(): Promise<void> {
    /* no-op in browser preview */
  }
}

export async function addPluginListener(
  plugin: string,
  event: string,
  _cb: (payload: unknown) => void,
): Promise<PluginListener> {
  return new PluginListener(plugin, event, 0);
}

export function convertFileSrc(path: string): string {
  return path;
}

const writeStreams = new Map<string, { path: string; chunks: Uint8Array[] }>();
const readStreams = new Map<string, { bytes: Uint8Array; offset: number }>();

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? path : path.slice(idx + 1);
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "svg":
      return "image/svg+xml";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "txt":
    case "log":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function bytesB64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToB64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(binary);
}

function rawBytesFromInvokeArgs(args?: unknown): Uint8Array {
  if (args instanceof Uint8Array) return args;
  if (args instanceof ArrayBuffer) return new Uint8Array(args);
  if (ArrayBuffer.isView(args)) {
    return new Uint8Array(args.buffer, args.byteOffset, args.byteLength);
  }
  throw new Error("Expected raw bytes payload");
}

function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/* --------------------------- LanChat preview mocks --------------------------- */
const LANCHAT_MOCK_PEERS = [
  { id: "zhao", name: "赵敏 · 设计部", avatarHash: null, signature: "设计即沟通", status: "online", lastSeen: Date.now(), addr: "192.168.1.24", port: 47100 },
  { id: "qian", name: "钱进 · 后端", avatarHash: null, signature: "勿扰，发版中", status: "busy", lastSeen: Date.now(), addr: "192.168.1.31", port: 47100 },
  { id: "sun", name: "孙莉 · 测试", avatarHash: null, signature: "测试一切", status: "away", lastSeen: Date.now(), addr: "192.168.1.46", port: 47100 },
  { id: "li", name: "李工 · 运维", avatarHash: null, signature: "稳定第一", status: "online", lastSeen: Date.now(), addr: "192.168.1.12", port: 47100 },
  { id: "zhou", name: "周哲", avatarHash: null, signature: "", status: "offline", lastSeen: Date.now(), addr: null, port: null },
];
const LANCHAT_MOCK_GROUPS = [
  { id: "g1", name: "研发大群", createdAt: Date.now() - 86400000, members: ["me-preview", "zhao", "qian", "sun", "li"] },
  { id: "g2", name: "前端小队", createdAt: Date.now() - 43200000, members: ["me-preview", "zhao"] },
];
const LANCHAT_MOCK_CONVERSATIONS = [
  { id: "direct:zhao", kind: "direct", peerOrGroupId: "zhao", lastMsgAt: Date.now() - 60000, unread: 0 },
  { id: "direct:qian", kind: "direct", peerOrGroupId: "qian", lastMsgAt: Date.now() - 600000, unread: 2 },
  { id: "group:g1", kind: "group", peerOrGroupId: "g1", lastMsgAt: Date.now() - 120000, unread: 5 },
];
const LANCHAT_MOCK_MESSAGES: Record<string, unknown[]> = {
  "direct:zhao": [
    { id: "p1", convId: "direct:zhao", senderId: "zhao", body: "早呀，新版内网通讯的配色我调好了 ✨", mentions: [], createdAt: Date.now() - 300000, state: "delivered" },
    { id: "p2", convId: "direct:zhao", senderId: "me-preview", body: "太好了！发我看看", mentions: [], createdAt: Date.now() - 240000, state: "delivered" },
    { id: "p3", convId: "direct:zhao", senderId: "me-preview", body: "收到，@赵敏 这个主色和我们 Taomni 的靛蓝很搭 👍", mentions: ["zhao"], createdAt: Date.now() - 60000, state: "delivered" },
  ],
  "group:g1": [
    { id: "g1m1", convId: "group:g1", senderId: "sun", body: "周会改到下午三点哈", mentions: [], createdAt: Date.now() - 180000, state: "delivered" },
    { id: "g1m2", convId: "group:g1", senderId: "li", body: "收到 👌", mentions: [], createdAt: Date.now() - 150000, state: "delivered" },
    { id: "g1m3", convId: "group:g1", senderId: "me-preview", body: "好的，记得带上各自的进度", mentions: [], createdAt: Date.now() - 120000, state: "sent" },
  ],
};

const MAIL_STUB_FOLDERS = [
  { name: "INBOX", displayName: "INBOX", total: 3, unread: 1 },
  { name: "Sent", displayName: "Sent", total: 1, unread: 0 },
  { name: "Archive", displayName: "Archive", total: 8, unread: 0 },
];

function stubMailAccountId(args?: InvokeArgs): string {
  const config = args?.config as { sessionId?: string } | undefined;
  return ((args?.accountId as string | undefined) ?? config?.sessionId ?? "stub-mail").trim() || "stub-mail";
}

function stubMailFolderList(accountId: string) {
  const now = Math.floor(Date.now() / 1000);
  return MAIL_STUB_FOLDERS.map((folder) => ({
    accountId,
    name: folder.name,
    displayName: folder.displayName,
    delimiter: "/",
    flags: [],
    uidValidity: 1,
    uidNext: 100,
    total: folder.total,
    unread: folder.unread,
    updatedAt: now,
  }));
}

function stubMailMessages(accountId: string, folder: string) {
  const now = Math.floor(Date.now() / 1000);
  const inbox = [
    {
      accountId,
      folder: "INBOX",
      uid: 91,
      messageId: "<stub-91@taomni.local>",
      subject: "Welcome to Taomni Mail",
      from: { name: "Taomni Mail", address: "mail-preview@taomni.local" },
      to: [{ name: "Preview User", address: "user@example.com" }],
      cc: [],
      dateTs: now - 1800,
      flags: [],
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      snippet: "This preview uses IMAP/SMTP-shaped data and the same cache-first reader flow as the desktop backend.",
      rawSize: 8432,
      bodyCached: true,
    },
    {
      accountId,
      folder: "INBOX",
      uid: 90,
      messageId: "<stub-90@taomni.local>",
      subject: "Account-level AI policy",
      from: { name: "AI Assistant", address: "assistant@taomni.local" },
      to: [{ name: "Preview User", address: "user@example.com" }],
      cc: [],
      dateTs: now - 7200,
      flags: ["\\Seen"],
      hasAttachments: true,
      attachmentCount: 1,
      attachments: [{ name: "policy.txt", contentType: "text/plain", size: 1240 }],
      snippet: "Mail AI actions can reuse the existing Taomni chat drawer and skip body confirmation per account config.",
      rawSize: 12980,
      bodyCached: true,
    },
    {
      accountId,
      folder: "INBOX",
      uid: 89,
      messageId: "<stub-89@taomni.local>",
      subject: "HTML newsletter sample",
      from: { name: "Ops Digest", address: "ops@example.com" },
      to: [{ name: "Preview User", address: "user@example.com" }],
      cc: [],
      dateTs: now - 86400,
      flags: ["\\Seen"],
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      snippet: "Remote images are blocked in the reader until explicitly loaded.",
      rawSize: 33120,
      bodyCached: true,
    },
  ];
  if (folder === "Sent") {
    return [{
      ...inbox[0],
      folder,
      uid: 12,
      subject: "Sent preview message",
      from: { name: "Preview User", address: "user@example.com" },
      to: [{ name: "Teammate", address: "team@example.com" }],
      flags: ["\\Seen"],
      snippet: "This is a browser-preview sent message.",
    }];
  }
  if (folder === "Archive") return inbox.slice(1).map((message, index) => ({ ...message, folder, uid: 70 - index }));
  return inbox;
}

function stubMailBody(accountId: string, folder: string, uid: number) {
  const header = stubMailMessages(accountId, folder).find((message) => message.uid === uid) ?? stubMailMessages(accountId, folder)[0];
  const html = uid === 89
    ? `<h2>Ops Digest</h2><p>The reader sanitizes HTML and blocks tracking images.</p><p><img src="https://example.com/tracker.png" alt="tracker"></p><table><tr><td>Queue</td><td>Healthy</td></tr></table>`
    : null;
  const text = html
    ? null
    : `Hello from Taomni Mail preview.\n\nThis body is shaped like a cached IMAP message body. Use Sync in the desktop build to fetch live mailbox data.\n\nSubject: ${header.subject}`;
  return {
    accountId,
    folder,
    uid: header.uid,
    messageId: header.messageId,
    subject: header.subject,
    text,
    html,
    snippet: header.snippet,
    attachments: header.attachments,
    rawSize: header.rawSize,
    cachedAt: Math.floor(Date.now() / 1000),
    source: "cache",
  };
}

function stubMailContacts(accountId: string, query: string, limit: number) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const byEmail = new Map<string, { name: string | null; email: string; source: "history" | "sent"; score: number; lastSeenAt: number | null }>();
  for (const folder of MAIL_STUB_FOLDERS) {
    for (const message of stubMailMessages(accountId, folder.name)) {
      const sent = folder.name === "Sent";
      const addresses = [message.from, ...message.to, ...message.cc];
      for (const address of addresses) {
        const email = address.address;
        const haystack = `${address.name ?? ""} ${email}`.toLowerCase();
        if (!email || !haystack.includes(needle)) continue;
        const score = (email.toLowerCase().startsWith(needle) ? 300 : 0)
          + ((address.name ?? "").toLowerCase().startsWith(needle) ? 180 : 0)
          + (sent ? 80 : 20);
        const existing = byEmail.get(email.toLowerCase());
        if (!existing || score > existing.score) {
          byEmail.set(email.toLowerCase(), {
            name: address.name ?? null,
            email,
            source: sent ? "sent" : "history",
            score,
            lastSeenAt: message.dateTs ?? null,
          });
        }
      }
    }
  }
  return Array.from(byEmail.values())
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, limit);
}

interface StubMailDraft {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: Array<{
    path: string;
    name?: string | null;
    contentType?: string | null;
    inline?: boolean;
    contentId?: string | null;
    size?: number | null;
    modifiedAt?: number | null;
  }>;
  replyContext?: Record<string, unknown> | null;
  remoteDraftFolder?: string | null;
  remoteDraftUid?: number | null;
  createdAt: number;
  updatedAt: number;
}

function loadMailDrafts(): StubMailDraft[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MAIL_DRAFTS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMailDrafts(drafts: StubMailDraft[]): void {
  localStorage.setItem(MAIL_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
}

function stubSaveMailDraft(accountId: string, draft: Record<string, unknown>): StubMailDraft {
  const drafts = loadMailDrafts();
  const id = typeof draft.id === "string" && draft.id.trim()
    ? draft.id.trim()
    : `stub-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const existing = drafts.find((item) => item.accountId === accountId && item.id === id);
  const now = Math.floor(Date.now() / 1000);
  const attachments = Array.isArray(draft.attachments)
    ? draft.attachments
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .filter((item) => typeof item.path === "string" && item.path.trim().length > 0)
        .map((item) => ({
          path: String(item.path),
          name: typeof item.name === "string" ? item.name : null,
          contentType: typeof item.contentType === "string" ? item.contentType : null,
          inline: item.inline === true,
          contentId: typeof item.contentId === "string" ? item.contentId : null,
          size: typeof item.size === "number" ? item.size : null,
          modifiedAt: typeof item.modifiedAt === "number" ? item.modifiedAt : null,
        }))
    : [];
  const saved: StubMailDraft = {
    id,
    accountId,
    to: Array.isArray(draft.to) ? draft.to.map(String) : [],
    cc: Array.isArray(draft.cc) ? draft.cc.map(String) : [],
    bcc: Array.isArray(draft.bcc) ? draft.bcc.map(String) : [],
    subject: typeof draft.subject === "string" ? draft.subject : "",
    textBody: typeof draft.textBody === "string" ? draft.textBody : "",
    htmlBody: typeof draft.htmlBody === "string" ? draft.htmlBody : "",
    attachments,
    replyContext: draft.replyContext && typeof draft.replyContext === "object"
      ? draft.replyContext as Record<string, unknown>
      : null,
    remoteDraftFolder: typeof draft.remoteDraftFolder === "string" ? draft.remoteDraftFolder : null,
    remoteDraftUid: typeof draft.remoteDraftUid === "number" ? draft.remoteDraftUid : null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  saveMailDrafts([
    saved,
    ...drafts.filter((item) => !(item.accountId === accountId && item.id === id)),
  ]);
  return saved;
}

export async function invoke<T>(cmd: string, args?: any, options?: InvokeOptions): Promise<T> {
  switch (cmd) {
    case "list_sessions": {
      return loadSessions() as T;
    }
    case "get_session": {
      const sessions = loadSessions();
      const session = sessions.find((s) => s.id === (args?.id as string));
      if (!session) throw new Error(`Session not found: ${args?.id}`);
      return session as T;
    }
    case "save_session": {
      const sessions = loadSessions();
      const config = args?.config as SessionConfig;
      const idx = sessions.findIndex((s) => s.id === config.id);
      if (idx >= 0) sessions[idx] = config;
      else sessions.push(config);
      saveSessions(sessions);
      return undefined as T;
    }
    case "delete_session": {
      const sessions = loadSessions();
      saveSessions(sessions.filter((s) => s.id !== (args?.id as string)));
      return undefined as T;
    }
    case "mark_session_connected": {
      const sessions = loadSessions();
      const now = Math.floor(Date.now() / 1000);
      const idx = sessions.findIndex((s) => s.id === (args?.id as string));
      if (idx >= 0) {
        sessions[idx] = { ...sessions[idx], last_connected_at: now };
        saveSessions(sessions);
        return now as T;
      }
      return 0 as T;
    }
    case "list_session_groups": {
      return loadGroups() as T;
    }
    case "save_session_group": {
      const groups = loadGroups();
      const group = args?.group as SessionGroup;
      const idx = groups.findIndex((g) => g.id === group.id);
      if (idx >= 0) groups[idx] = group;
      else groups.push(group);
      saveGroups(groups);
      return undefined as T;
    }
    case "delete_session_group": {
      const groups = loadGroups();
      saveGroups(groups.filter((g) => g.id !== (args?.id as string)));
      return undefined as T;
    }
    case "detect_x_server": {
      // Web preview has no system X server; report unavailable so the UI shows
      // honest "no display" status rather than a misleading green pill.
      return {
        available: false,
        display: "",
        endpoint: "",
        has_cookie: false,
        provider: "unknown",
        hint: "no-display",
      } as unknown as T;
    }
    case "list_local_shells": {
      const shells: LocalShellOption[] = [
        {
          id: "browser-shell",
          name: "Browser preview (SSH only)",
          path: "/dev/null",
          args: [],
          isDefault: true,
          canElevate: false,
        },
      ];
      return shells as T;
    }
    case "list_common_local_directories": {
      const home = await vfsHome();
      const dirs: LocalDirectoryShortcut[] = [
        { label: "Home", path: home, kind: "system" },
        { label: "Workspace", path: VFS_ROOT, kind: "personal" },
      ];
      return dirs as T;
    }
    case "list_system_fonts": {
      return [] as T;
    }
    case "clipboard_read_text": {
      return ((await navigator.clipboard?.readText?.()) ?? "") as T;
    }
    case "clipboard_write_text": {
      const text = ((args as InvokeArgs | undefined)?.text as string) ?? "";
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard write is not available in browser preview.");
      }
      await navigator.clipboard.writeText(text);
      return undefined as T;
    }
    case "select_private_key_file": {
      const current = (args?.currentPath as string | null) || "~/.ssh/id_ed25519";
      const selected = await promptAppDialog({
        title: "Private key path",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_upload_file": {
      const selected = await promptAppDialog({
        title: "Upload file path in browser VFS",
        initialValue: VFS_ROOT,
        allowEmpty: true,
      });
      return (selected?.trim() ? [selected.trim()] : []) as T;
    }
    case "select_save_directory": {
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || VFS_ROOT;
      const selected = await promptAppDialog({
        title: "Save directory in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_save_file_path": {
      const defaultName = ((args as InvokeArgs | undefined)?.defaultName as string | null) || "capture.png";
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || `${VFS_ROOT}/${defaultName}`;
      const selected = await promptAppDialog({
        title: "Save file path in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_file_path": {
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || VFS_ROOT;
      const selected = await promptAppDialog({
        title: "File path in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_folder_path": {
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || VFS_ROOT;
      const selected = await promptAppDialog({
        title: "Folder path in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "read_file_bytes": {
      return (await vfsReadBytes((args as InvokeArgs)?.path as string)) as T;
    }
    case "check_file_exists": {
      try {
        await vfsStat((args as InvokeArgs)?.path as string);
        return true as T;
      } catch {
        return false as T;
      }
    }
    case "read_plist_session_file": {
      const path = (args as InvokeArgs)?.path as string;
      return {
        source: "plist",
        path,
        relativePath: basename(path),
        text: await vfsReadText(path),
      } as T;
    }
    case "read_stream_open": {
      const path = (args as InvokeArgs)?.path as string;
      const stat = await vfsStat(path);
      const bytes = new Uint8Array(await vfsReadBytes(path));
      const handleId = `read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      readStreams.set(handleId, { bytes, offset: 0 });
      return { handleId, size: stat.size, mtime: stat.mtime } as T;
    }
    case "read_stream_read": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      const maxBytes = (args as InvokeArgs)?.maxBytes as number;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
        throw new Error("read_stream_read maxBytes must be between 1 and 1048576");
      }
      const stream = readStreams.get(handleId);
      if (!stream) throw new Error(`Read stream handle ${handleId} not found`);
      const end = Math.min(stream.offset + maxBytes, stream.bytes.byteLength);
      const chunk = stream.bytes.slice(stream.offset, end);
      stream.offset = end;
      return chunk.buffer as T;
    }
    case "read_stream_close": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      if (!readStreams.delete(handleId)) throw new Error(`Read stream handle ${handleId} not found`);
      return undefined as T;
    }
    case "write_stream_open": {
      const handleId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeStreams.set(handleId, { path: (args as InvokeArgs)?.path as string, chunks: [] });
      return handleId as T;
    }
    case "write_stream_append": {
      const handleId = options?.headers?.["x-handle-id"] ?? options?.headers?.["X-Handle-Id"];
      if (!handleId) throw new Error("Missing x-handle-id header");
      const stream = writeStreams.get(handleId);
      if (!stream) throw new Error(`Write stream handle ${handleId} not found`);
      const bytes = rawBytesFromInvokeArgs(args);
      stream.chunks.push(new Uint8Array(bytes));
      return undefined as T;
    }
    case "write_stream_close": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      const stream = writeStreams.get(handleId);
      if (!stream) throw new Error(`Write stream handle ${handleId} not found`);
      writeStreams.delete(handleId);
      await vfsWriteBytes(stream.path, concatChunks(stream.chunks));
      return undefined as T;
    }
    case "write_stream_abort": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      writeStreams.delete(handleId);
      return undefined as T;
    }
    case "temporary_file_path": {
      const defaultName = ((args as InvokeArgs)?.defaultName as string | undefined) || "query-results.dat";
      const dir = `${VFS_ROOT}/tmp/query-results`;
      await vfsMkdir(`${VFS_ROOT}/tmp`).catch(() => undefined);
      await vfsMkdir(dir).catch(() => undefined);
      return `${dir}/${Date.now()}-${defaultName.replace(/[\\/:*?"<>|]/g, "_")}` as T;
    }
    case "sdk_get_registry": {
      return loadSdkRegistry() as T;
    }
    case "sdk_probe_installation": {
      const kind = String(args?.kind ?? "java");
      const location = String(args?.location ?? "").trim();
      return {
        kind,
        location,
        executables: {},
        version: stubSdkVersion(kind, location),
        vendor: kind === "java" ? "Browser preview" : null,
        architecture: "browser",
        status: location ? "ready" : "missing",
        error: location ? null : "SDK location is required",
        source: "browser-preview",
      } as T;
    }
    case "sdk_discover_installations": {
      return [] as T;
    }
    case "sdk_save_installation": {
      const request = args?.request ?? {};
      const registry = loadSdkRegistry();
      const id = String(request.id || globalThis.crypto?.randomUUID?.() || `sdk-${Date.now()}`);
      const kind = String(request.kind || "java");
      const location = String(request.location || "").trim();
      const version = stubSdkVersion(kind, location);
      const installation = {
        id,
        kind,
        name: String(request.name || `${kind === "java" ? "JDK" : kind} ${version || "SDK"}`),
        location,
        executables: {},
        version,
        vendor: kind === "java" ? "Browser preview" : null,
        architecture: "browser",
        origin: request.origin || "manual",
        status: location ? "ready" : "missing",
        lastError: location ? null : "SDK location is required",
        lastProbedAt: new Date().toISOString(),
      };
      registry.installations = [
        ...registry.installations.filter((item) => item.id !== id),
        installation,
      ];
      saveSdkRegistry(registry);
      return installation as T;
    }
    case "sdk_remove_installation": {
      const registry = loadSdkRegistry();
      const id = String(args?.id ?? "");
      registry.installations = registry.installations.filter((item) => item.id !== id);
      registry.defaults = registry.defaults.filter((item) => item.sdkId !== id);
      registry.bindings = registry.bindings.filter((item) => item.sdkId !== id);
      saveSdkRegistry(registry);
      return undefined as T;
    }
    case "sdk_refresh_installations": {
      const registry = loadSdkRegistry();
      const id = args?.id == null ? null : String(args.id);
      const now = new Date().toISOString();
      registry.installations = registry.installations.map((item) => (
        id == null || item.id === id ? { ...item, lastProbedAt: now } : item
      ));
      saveSdkRegistry(registry);
      return registry.installations.filter((item) => id == null || item.id === id) as T;
    }
    case "sdk_set_default": {
      const request = args?.request ?? {};
      const registry = loadSdkRegistry();
      registry.defaults = registry.defaults.filter((item) => item.kind !== request.kind);
      if (request.sdkId) registry.defaults.push({ kind: request.kind, sdkId: request.sdkId });
      saveSdkRegistry(registry);
      return undefined as T;
    }
    case "sdk_save_workspace_binding": {
      const request = args?.request ?? {};
      const registry = loadSdkRegistry();
      registry.bindings = registry.bindings.filter((item) => !(
        item.scopePath === request.scopePath
        && item.kind === request.kind
        && item.role === request.role
      ));
      const binding = { ...request, sdkId: request.sdkId ?? null, updatedAt: new Date().toISOString() };
      registry.bindings.push(binding);
      saveSdkRegistry(registry);
      return binding as T;
    }
    case "sdk_remove_workspace_binding": {
      const registry = loadSdkRegistry();
      registry.bindings = registry.bindings.filter((item) => !(
        item.scopePath === args?.scopePath
        && item.kind === args?.kind
        && item.role === args?.role
      ));
      saveSdkRegistry(registry);
      return undefined as T;
    }
    case "sdk_analyze_workspace": {
      return {
        workspaceRoot: String(args?.workspaceRoot ?? ""),
        profiles: [],
        warnings: [],
      } as T;
    }
    case "sdk_resolve_workspace": {
      return {
        analysis: {
          workspaceRoot: String(args?.workspaceRoot ?? ""),
          profiles: [],
          warnings: [],
        },
        resolved: [],
      } as T;
    }
    case "lsp_list_presets": {
      return STUB_LSP_PRESETS as T;
    }
    case "git_blame_lines": {
      return [] as T;
    }
    case "history_snapshot": {
      return null as T;
    }
    case "history_list": {
      return [] as T;
    }
    case "history_read": {
      return "" as T;
    }
    case "history_prune": {
      return 0 as T;
    }
    case "lsp_set_java_home": {
      return undefined as T;
    }
    case "lsp_set_java_vmargs": {
      const raw = (args as { vmargs?: string | null } | undefined)?.vmargs;
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      return (trimmed || "-Xms1024m -Xmx1024m") as T;
    }
    case "lsp_detect_servers": {
      return stubLspServerStatuses() as T;
    }
    case "lsp_document_status":
    case "lsp_open_document":
    case "lsp_change_document":
    case "lsp_save_document":
    case "lsp_close_document": {
      return stubLspDocumentStatus(args as InvokeArgs) as T;
    }
    case "lsp_stop_workspace": {
      return 0 as T;
    }
    case "lsp_get_diagnostics": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        diagnostics: [],
      } as T;
    }
    case "lsp_hover": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        contents: null,
        range: null,
      } as T;
    }
    case "lsp_definition":
    case "lsp_type_definition":
    case "lsp_implementation":
    case "lsp_references": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        locations: [],
      } as T;
    }
    case "lsp_read_uri_contents": {
      const uri = String((args as InvokeArgs)?.uri ?? "");
      const title = uri.split("/").pop()?.split("?")[0] || "Library.java";
      const decompiled = uri.includes(".class");
      const banner = "// Source code is decompiled from a .class file using FernFlower decompiler (from Intellij IDEA).\n";
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        uri,
        path: null,
        title: title.endsWith(".class") ? title.replace(/\.class$/, ".java") : title,
        container: uri.split("/").slice(-3, -1).reverse().join(" · ") || null,
        languageId: "java",
        text: `${decompiled ? banner : ""}// Stub library source for ${uri}\n`,
        readOnly: true,
        decompiled,
      } as T;
    }
    case "lsp_download_sources": {
      const uri = String((args as InvokeArgs)?.uri ?? "");
      // Stub pretends the sources JAR published, returning non-decompiled text.
      return {
        attached: true,
        text: `// Stub attached source for ${uri}\n`,
        decompiled: false,
        message: null,
      } as T;
    }
    case "lsp_prepare_call_hierarchy":
    case "lsp_prepare_type_hierarchy":
    case "lsp_type_hierarchy_supertypes":
    case "lsp_type_hierarchy_subtypes": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        items: [],
      } as T;
    }
    case "lsp_call_hierarchy_incoming":
    case "lsp_call_hierarchy_outgoing": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        entries: [],
      } as T;
    }
    case "lsp_document_highlights": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        highlights: [],
      } as T;
    }
    case "lsp_inlay_hints": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        hints: [],
      } as T;
    }
    case "lsp_selection_ranges": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        ranges: [],
      } as T;
    }
    case "lsp_semantic_tokens": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        tokens: [],
      } as T;
    }
    case "workspace_list_dir": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = (args?.path as string) || "";
      const target = joinWorkspacePath(repoRoot, path);
      const entries = await vfsList(target);
      return entries.map((entry) => ({
        name: entry.name,
        path: relativeWorkspacePath(repoRoot, entry.path),
        fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
        size: entry.size,
        mtime: entry.mtime,
        isHidden: entry.isHidden,
      })) as T;
    }
    case "workspace_read_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      const target = joinWorkspacePath(repoRoot, path);
      const [entry, text] = await Promise.all([vfsStat(target), vfsReadText(target)]);
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(text),
      } as T;
    }
    case "workspace_read_loose_file": {
      const path = args?.path as string;
      const [entry, text] = await Promise.all([vfsStat(path), vfsReadText(path)]);
      return {
        path: entry.path,
        text,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(text),
      } as T;
    }
    case "workspace_write_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      if (expectedHash) {
        const current = await vfsReadText(target);
        const currentHash = await sha256Hex(current);
        if (currentHash !== expectedHash) {
          throw new Error(`File changed on disk; expected hash ${expectedHash}, found ${currentHash}`);
        }
      }
      const contents = (args?.contents as string) ?? "";
      await vfsWriteText(target, contents);
      const entry = await vfsStat(target);
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: contents,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }
    case "workspace_write_loose_file": {
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      if (expectedHash) {
        const current = await vfsReadText(path);
        const currentHash = await sha256Hex(current);
        if (currentHash !== expectedHash) {
          throw new Error(`File changed on disk; expected hash ${expectedHash}, found ${currentHash}`);
        }
      }
      const contents = (args?.contents as string) ?? "";
      await vfsWriteText(path, contents);
      const entry = await vfsStat(path);
      return {
        path: entry.path,
        text: contents,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }
    case "workspace_create_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      await vfsStat(target)
        .then(() => {
          throw new Error(`Path already exists: ${target}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      const contents = (args?.contents as string | null | undefined) ?? "";
      await vfsWriteText(target, contents);
      const entry = await vfsStat(target);
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: contents,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }
    case "workspace_create_dir": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      await vfsStat(target)
        .then(() => {
          throw new Error(`Path already exists: ${target}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      await vfsMkdir(target);
      return await workspaceEntryFromVfs(repoRoot, target) as T;
    }
    case "workspace_delete_path": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      if (relativeWorkspacePath(repoRoot, target) === "") {
        throw new Error("Cannot delete the workspace root");
      }
      await vfsRemove(target, !!args?.recursive);
      return undefined as T;
    }
    case "workspace_rename_path": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const fromPath = args?.fromPath as string;
      const toPath = args?.toPath as string;
      assertWorkspaceWritablePath(fromPath);
      assertWorkspaceWritablePath(toPath);
      const from = joinWorkspacePath(repoRoot, fromPath);
      const to = joinWorkspacePath(repoRoot, toPath);
      await vfsStat(to)
        .then(() => {
          throw new Error(`Path already exists: ${to}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      await vfsRename(from, to);
      return await workspaceEntryFromVfs(repoRoot, to) as T;
    }
    case "create_local_terminal": {
      throw new Error(
        "Local terminal is not available in browser preview. Use the Quick connect bar or 'New session' to open an SSH connection (e.g. demo@test.rebex.net).",
      );
    }
    case "workspace_detect_tasks": {
      return [] as T;
    }
    case "create_ssh_terminal": {
      const cols = (args?.cols as number) ?? 80;
      const rows = (args?.rows as number) ?? 24;
      // The browser preview can't honour proxy / port-forwarding rows; we
      // simply ignore `networkSettingsJson` here and let the WS proxy
      // handle the SSH connection directly.
      return (await sshConnect({
        sessionId: args?.sessionId as string,
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: args?.authMethod as string,
        authData: (args?.authData as string | null) ?? null,
        cols,
        rows,
        onOutput: args?.onOutput as SshConnectArgs["onOutput"],
      })) as T;
    }
    case "submit_ssh_auth_response": {
      // Keyboard-interactive (MFA) auth is driven by the real Rust backend.
      // The browser preview's WS SSH proxy doesn't surface interactive
      // prompts, so this is a no-op here.
      return undefined as T;
    }
    case "test_ssh_connection": {
      // The browser preview can't honour proxy / port-forwarding rows
      // either; we ignore `networkSettingsJson` here for symmetry with
      // `create_ssh_terminal` so testing a session in web preview
      // exercises the same path the spawned terminal will take.
      return (await sshTest({
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: args?.authMethod as string,
        authData: (args?.authData as string | null) ?? null,
      })) as T;
    }
    case "write_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshWrite(sid, args?.data as string);
      return undefined as T;
    }
    case "resize_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshResize(sid, args?.cols as number, args?.rows as number);
      return undefined as T;
    }
    case "send_terminal_signal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshSignal(sid, args?.signal as string);
      return undefined as T;
    }
    case "close_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshClose(sid);
      return undefined as T;
    }
    case "open_local_shell_as_administrator": {
      throw new Error("Administrator local terminals are not available in browser preview.");
    }
    case "exit_app": {
      window.close();
      return undefined as T;
    }

    // ---------- SFTP commands ----------
    case "sftp_attach": {
      const sid = args?.sessionId as string;
      const result = await sftpAttach({
        sessionId: sid,
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: (args?.authMethod as string) || "Password",
        authData: (args?.authData as string | null) ?? null,
        networkSettingsJson: (args?.networkSettingsJson as string | null) ?? null,
      });
      return result as T;
    }
    case "sftp_detach": {
      await sftpDetach(args?.sessionId as string);
      return undefined as T;
    }
    case "sftp_list_remote": {
      const sid = args?.sessionId as string;
      const path = (args?.path as string) || ".";
      const entries = await sftpListRemote(sid, path);
      return entries as T;
    }
    case "sftp_list_local": {
      const path = (args?.path as string) || "";
      const entries = await vfsList(path);
      return entries as T;
    }
    case "sftp_local_home": {
      const home = await vfsHome();
      return home as T;
    }
    case "sftp_local_drives": {
      return [{ id: "vfs", label: VFS_ROOT, path: VFS_ROOT }] as T;
    }
    case "sftp_mkdir": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsMkdir(args?.path as string);
      } else {
        await sftpMkdirRemote(args?.sessionId as string, args?.path as string);
      }
      return undefined as T;
    }
    case "sftp_remove": {
      const side = (args?.side as string) ?? "remote";
      const recursive = !!args?.recursive;
      if (side === "local") {
        await vfsRemove(args?.path as string, recursive);
      } else {
        await sftpRemoveRemote(args?.sessionId as string, args?.path as string, recursive);
      }
      return undefined as T;
    }
    case "sftp_rename": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsRename(args?.oldPath as string, args?.newPath as string);
      } else {
        await sftpRenameRemote(
          args?.sessionId as string,
          args?.oldPath as string,
          args?.newPath as string,
        );
      }
      return undefined as T;
    }
    case "sftp_stat": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        return (await vfsStat(args?.path as string)) as T;
      }
      const entry = await sftpStatRemote(args?.sessionId as string, args?.path as string);
      return entry as T;
    }
    case "sftp_chmod": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        // The browser preview's local "FS" is the in-memory VFS, which does
        // not track POSIX permission bits. Treat chmod as a successful no-op
        // so the UI flow matches the desktop build.
        return undefined as T;
      }
      await sftpChmodRemote(
        args?.sessionId as string,
        args?.path as string,
        args?.mode as number,
      );
      return undefined as T;
    }
    case "sftp_upload_dir":
    case "sftp_download_dir": {
      // Folder transfers require a recursive walk over the SFTP bridge that
      // the browser-preview proxy does not expose. Surface a friendly error
      // and emit a completion frame so the queue row finalises.
      const transferId = args?.transferId as string;
      const message = "Folder transfers are not available in browser preview. Try the desktop build.";
      void emit(`sftp-transfer-complete-${transferId}`, {
        success: false,
        error: message,
      });
      throw new Error(message);
    }
    case "sftp_realpath": {
      const path = await sftpRealpathRemote(args?.sessionId as string, args?.path as string);
      return path as T;
    }
    case "sftp_read_file_text": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        return (await vfsReadText(args?.path as string)) as T;
      }
      const max = (args?.maxBytes as number) ?? 4 * 1024 * 1024;
      return (await sftpReadTextRemote(
        args?.sessionId as string,
        args?.path as string,
        max,
      )) as T;
    }
    case "sftp_write_file_text": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsWriteText(args?.path as string, args?.contents as string);
      } else {
        await sftpWriteTextRemote(
          args?.sessionId as string,
          args?.path as string,
          args?.contents as string,
        );
      }
      return undefined as T;
    }
    case "sftp_upload": {
      // In the web stub, "local" path is a virtual VFS path.
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const localPath = args?.localPath as string;
      const remotePath = args?.remotePath as string;
      const data = await vfsReadBytes(localPath);
      const total = data.byteLength;
      const b64 = arrayBufferToB64(data);
      void emit(`sftp-progress-${transferId}`, { bytes: 0, total, rate: 0, eta: 0 });
      try {
        await sftpUploadBytesRemote(sid, transferId, remotePath, b64);
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, { success: true, finalPath: remotePath });
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_download": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const localPath = args?.localPath as string;
      const openAfter = !!args?.openAfter;
      try {
        const b64 = await sftpDownloadBytesRemote(sid, transferId, remotePath);
        const buf = bytesB64ToArrayBuffer(b64);
        await vfsWriteBytes(localPath, buf);
        const total = buf.byteLength;
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: true,
          finalPath: localPath,
        });
        if (openAfter) {
          vfsExportToBrowser(basename(localPath), buf);
        }
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_upload_bytes": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const bytesB64 = args?.bytesB64 as string;
      const total = atob(bytesB64).length;
      void emit(`sftp-progress-${transferId}`, { bytes: 0, total, rate: 0, eta: 0 });
      try {
        await sftpUploadBytesRemote(sid, transferId, remotePath, bytesB64);
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, { success: true, finalPath: remotePath });
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_download_bytes": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const b64 = await sftpDownloadBytesRemote(sid, transferId, remotePath);
      void emit(`sftp-transfer-complete-${transferId}`, { success: true });
      return b64 as T;
    }
    case "sftp_cancel_transfer": {
      // Best-effort: cancel on every attached SFTP session.
      // (browser stub doesn't track per-transfer mapping)
      const transferId = args?.transferId as string;
      // Iterate is not exposed; provide a no-op fallback.
      // We emit "cancelled" so the UI can finish even if the underlying
      // request keeps running on the proxy.
      void emit(`sftp-transfer-complete-${transferId}`, {
        success: false,
        error: "cancelled",
      });
      // attempt to cancel on any session it might belong to:
      const sid = (args?.sessionId as string) || "";
      if (sid && isSftpSession(sid)) sftpCancel(sid, transferId);
      return undefined as T;
    }
    case "sftp_pause_transfer": {
      // Browser stub doesn't have a real per-transfer worker to suspend,
      // but we still emit the paused event so the UI flips to "paused".
      const transferId = args?.transferId as string;
      void emit(`sftp-paused-${transferId}`, {
        bytes: 0,
        total: 0,
        rate: 0,
        eta: 0,
      });
      return undefined as T;
    }
    case "sftp_resume_transfer": {
      // No-op in browser preview; the real backend will start re-emitting
      // progress events when the worker resumes.
      return undefined as T;
    }
    case "open_sftp_window": {
      const sessionId = args?.sessionId as string;
      const url = new URL(window.location.href);
      url.searchParams.set("sftp", sessionId);
      url.hash = "";
      const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
      const handle = window.open(
        url.toString(),
        `taomni_sftp_${sessionId}`,
        features,
      );
      if (!handle) {
        throw new Error(
          "Browser blocked the SFTP window. Allow pop-ups for this site.",
        );
      }
      return undefined as T;
    }
    case "close_current_detached_window": {
      window.close();
      return undefined as T;
    }
    case "open_detached_window": {
      const kind = args?.kind as string;
      const sessionId = args?.sessionId as string;
      const width = (args?.width as number | undefined) ?? 1200;
      const height = (args?.height as number | undefined) ?? 760;
      const url = new URL(window.location.href);
      url.searchParams.set(kind, sessionId);
      url.hash = "";
      const features = `width=${width},height=${height},resizable=yes,scrollbars=yes`;
      const handle = window.open(
        url.toString(),
        `taomni_${kind}_${sessionId}`,
        features,
      );
      if (!handle) {
        throw new Error(
          `Browser blocked the ${kind} window. Allow pop-ups for this site.`,
        );
      }
      return undefined as T;
    }
    // ---------- RDP commands (desktop-only) ----------
    case "rdp_connect":
    case "rdp_disconnect":
    case "rdp_test_connection": {
      throw new Error(
        "RDP is only available in the desktop build of Taomni, not in browser preview.",
      );
    }
    case "sftp_open_path": {
      // No real OS shell in browser preview.
      throw new Error(
        "Opening files with the OS shell is not available in browser preview. Use 'Download to local' to save the file.",
      );
    }
    // ---------- SocksCap (browser preview: config/rules dry-run only) ----------
    case "sockscap_capabilities": {
      return {
        platform: "browser",
        globalTcp: false,
        appFilter: false,
        captureBackend: "none",
        notes: ["Browser preview — rules engine stub only; no OS capture."],
        privilegedRequired: false,
      } as T;
    }
    case "sockscap_get_config": {
      let cfg: Record<string, unknown> | null = null;
      try {
        const raw = localStorage.getItem("taomni.sockscap.config.v1");
        if (raw) cfg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* fallthrough */
      }
      if (!cfg) {
        cfg = {
          enabled: false,
          activeProfileIds: ["default"],
          selectedProfileId: "default",
          profiles: [
            {
              id: "default",
              name: "默认方案",
              icon: "🎮",
              enabled: true,
              priority: 0,
              mode: "global",
              apps: [],
              upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080, username: "", passwordRef: "" },
              ruleMode: "gfwList",
              userRules: [],
              defaultAction: "direct",
            },
          ],
          mode: "global",
          apps: [],
          upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080, username: "", passwordRef: "" },
          ruleMode: "gfwList",
          gfwlist: {
            enabled: true,
            url: "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist/gfwlist.txt",
            autoRefreshHours: 24,
          },
          userRules: [],
          bypassCidrs: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
          defaultAction: "direct",
          restoreOnLogin: false,
        };
      }
      if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
        cfg.profiles = [
          {
            id: "default",
            name: "默认方案",
            icon: "🎮",
            enabled: true,
            priority: 0,
            mode: cfg.mode ?? "global",
            apps: cfg.apps ?? [],
            upstream: cfg.upstream ?? { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
            ruleMode: cfg.ruleMode ?? "gfwList",
            userRules: cfg.userRules ?? [],
            defaultAction: cfg.defaultAction ?? "direct",
          },
        ];
      }
      if (!Array.isArray(cfg.activeProfileIds) || cfg.activeProfileIds.length === 0) {
        const profList = cfg.profiles as Array<Record<string, unknown>>;
        cfg.activeProfileIds = [String(profList[0]?.id ?? "default")];
      }
      if (!cfg.selectedProfileId) {
        const profList = cfg.profiles as Array<Record<string, unknown>>;
        cfg.selectedProfileId = String(profList[0]?.id ?? "default");
      }
      return cfg as T;
    }
    case "sockscap_set_config": {
      localStorage.setItem("taomni.sockscap.config.v1", JSON.stringify(args?.config ?? {}));
      return undefined as T;
    }
    case "sockscap_gfwlist_status": {
      return {
        loaded: false,
        ruleCount: 0,
        skipped: 0,
        lastRefresh: null,
        source: "",
        error: null,
      } as T;
    }
    case "sockscap_refresh_gfwlist":
    case "sockscap_import_rules": {
      return {
        loaded: true,
        ruleCount: 0,
        skipped: 0,
        lastRefresh: new Date().toISOString(),
        source: "browser-stub",
        error: "GFWList fetch/import requires the desktop build.",
      } as T;
    }
    case "sockscap_test_target": {
      const host = String(args?.host ?? "");
      const hit = /google|github|twitter|facebook|youtube/i.test(host);
      return {
        host,
        port: Number(args?.port ?? 443),
        decision: hit ? "proxy" : "direct",
        reason: hit ? "browser stub heuristic" : "browser stub default",
        matchedRule: hit ? "||stub" : null,
      } as T;
    }
    case "sockscap_status": {
      return {
        phase: "idle",
        message: "browser preview",
        ruleCount: 0,
        captureBackend: "none",
      } as T;
    }
    case "sockscap_start": {
      return {
        phase: "degraded",
        message: "Browser preview — capture unavailable; use desktop build for SocksCap.",
        ruleCount: 0,
        captureBackend: "none",
      } as T;
    }
    case "sockscap_stop": {
      return {
        phase: "idle",
        message: "stopped",
        ruleCount: 0,
        captureBackend: "none",
      } as T;
    }
    case "sockscap_recover":
      return undefined as T;
    case "sockscap_stats_snapshot": {
      return {
        flowsTotal: 0,
        flowsProxy: 0,
        flowsDirect: 0,
        flowsBlock: 0,
        bytesUp: 0,
        bytesDown: 0,
      } as T;
    }
    case "sockscap_get_domain_records":
      return [] as T;
    case "sockscap_clear_domain_records":
      return undefined as T;
    case "sockscap_list_processes":
      return [] as T;
    case "sockscap_test_upstream":
      throw new Error("Upstream test is only available in the desktop build.");
    case "sockscap_helper_status":
      return {
        running: false,
        elevated: false,
        endpoint: null,
        message: "Helper not available in browser preview.",
        windivert: null,
      } as T;
    case "sockscap_helper_start":
      throw new Error("Elevated helper requires the desktop Windows build.");
    case "sockscap_helper_stop":
      return undefined as T;
    case "sockscap_helper_probe_windivert":
      throw new Error("WinDivert probe requires the desktop Windows build.");
    case "list_tunnels": {
      return loadTunnels() as T;
    }
    case "upsert_tunnel": {
      const config = args?.config as StubTunnelConfig;
      const list = loadTunnels();
      const idx = list.findIndex((t) => t.id === config.id);
      if (idx >= 0) list[idx] = config;
      else list.push(config);
      saveTunnels(list);
      return config as T;
    }
    case "delete_tunnel": {
      const id = args?.id as string;
      saveTunnels(loadTunnels().filter((t) => t.id !== id));
      delete tunnelStatuses[id];
      return undefined as T;
    }
    case "start_tunnel": {
      const id = args?.id as string;
      const tunnel = loadTunnels().find((t) => t.id === id);
      if (!tunnel) throw new Error(`Tunnel ${id} not found`);
      tunnelStatuses[id] = {
        id,
        status: "error",
        error: "Tunnels can only be opened in the desktop build of Taomni.",
      };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }
    case "stop_tunnel": {
      const id = args?.id as string;
      tunnelStatuses[id] = { id, status: "stopped" };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }
    case "start_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = {
          id: t.id,
          status: "error",
          error: "Desktop-only feature in preview mode.",
        };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }
    case "stop_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = { id: t.id, status: "stopped" };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }
    case "get_tunnel_status": {
      const id = args?.id as string;
      return (tunnelStatuses[id] ?? { id, status: "stopped" }) as T;
    }
    case "list_tunnel_statuses": {
      return Object.values(tunnelStatuses) as T;
    }
    case "test_tunnel": {
      throw new Error("Testing tunnels is only available in the desktop build.");
    }
    case "reorder_tunnels": {
      const ids = (args?.ids as string[]) ?? [];
      const list = loadTunnels();
      const byId = new Map(list.map((t) => [t.id, t]));
      const next: StubTunnelConfig[] = [];
      ids.forEach((id, idx) => {
        const t = byId.get(id);
        if (!t) return;
        next.push({ ...t, sortOrder: idx });
        byId.delete(id);
      });
      for (const t of byId.values()) next.push(t);
      saveTunnels(next);
      return undefined as T;
    }
    // ---------- AI chat drawer commands (browser preview stubs) ----------
    case "chat_list_threads": {
      const limit = Number((args as InvokeArgs | undefined)?.limit ?? 50);
      return loadChatThreads()
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, Number.isFinite(limit) ? limit : 50) as T;
    }
    case "chat_new_thread": {
      const now = Math.floor(Date.now() / 1000);
      const mode = normalizeStubChatMode((args as InvokeArgs | undefined)?.mode);
      const thread: StubChatThread = {
        id: `stub-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: "New chat",
        provider_id: ((args as InvokeArgs | undefined)?.providerId as string | null | undefined) ?? "deepseek",
        created_at: now,
        updated_at: now,
        linked_session_id: ((args as InvokeArgs | undefined)?.linkedSessionId as string | null | undefined) ?? null,
        source: "drawer",
        mode,
        output_format: null,
        cc_model: null,
      };
      saveChatThreads([thread, ...loadChatThreads()]);
      return thread as T;
    }
    case "chat_list_messages": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const messages = loadChatMessages();
      return (threadId ? messages[threadId] ?? [] : []) as T;
    }
    case "chat_set_thread_provider": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const providerId = (args as InvokeArgs | undefined)?.providerId as string | undefined;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId && providerId ? { ...thread, provider_id: providerId } : thread,
      ));
      return undefined as T;
    }
    case "chat_set_thread_cc_model": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const model = ((args as InvokeArgs | undefined)?.model as string | null | undefined) ?? null;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, cc_model: model } : thread,
      ));
      return undefined as T;
    }
    case "chat_set_thread_output_format": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const outputFormat = ((args as InvokeArgs | undefined)?.outputFormat as string | null | undefined) ?? null;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, output_format: outputFormat } : thread,
      ));
      return undefined as T;
    }
    case "chat_delete_thread": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      saveChatThreads(loadChatThreads().filter((thread) => thread.id !== threadId));
      const messages = loadChatMessages();
      if (threadId) delete messages[threadId];
      saveChatMessages(messages);
      return undefined as T;
    }
    case "chat_purge_old": {
      return 0 as T;
    }
    case "chat_stop_stream": {
      return undefined as T;
    }
    case "acp_probe_profile": {
      const profileId = (args as InvokeArgs | undefined)?.profileId as string | undefined;
      return {
        profileId: profileId ?? "unknown",
        ok: false,
        message: "ACP handshake probing is only available in the desktop build.",
        agent: null,
      } as T;
    }
    case "chat_stat_attachment_paths": {
      const paths = ((args as InvokeArgs | undefined)?.paths as string[] | undefined) ?? [];
      return paths.map((path, index) => {
        const name = basename(path);
        const mime = mimeFromName(name);
        const kind = mime.startsWith("image/")
          ? "image"
          : mime.startsWith("video/")
            ? "video"
            : "file";
        return {
          id: `stub-att-${Date.now()}-${index}`,
          kind,
          path,
          name,
          size: 0,
          mime,
        } satisfies StubChatAttachment;
      }) as T;
    }
    case "chat_read_clipboard_image_attachment": {
      return ({
        id: `stub-clipboard-image-${Date.now()}`,
        kind: "image",
        path: `clipboard://pasted-image-${Date.now()}.png`,
        name: "Pasted image",
        size: 0,
        mime: "image/png",
        preview_url: stubGeneratedImageDataUri("pasted clipboard image"),
      } satisfies StubChatAttachment) as T;
    }
    case "chat_send": {
      const req = (args as InvokeArgs | undefined)?.req as { thread_id?: string; content?: string; attachments?: StubChatAttachment[] } | undefined;
      const threadId = req?.thread_id ?? "";
      const now = Math.floor(Date.now() / 1000);
      const userMessage: StubChatMessage = {
        id: `stub-user-${Date.now()}`,
        thread_id: threadId,
        role: "user",
        content: req?.content ?? "",
        created_at: now,
        redacted: false,
        attachments: req?.attachments ?? [],
      };
      const assistantMessage: StubChatMessage = {
        id: `stub-assistant-${Date.now()}`,
        thread_id: threadId,
        role: "assistant",
        content: "Browser preview stub: connect a desktop AI provider to get a real response.",
        created_at: now,
        redacted: false,
      };
      const messages = loadChatMessages();
      messages[threadId] = [...(messages[threadId] ?? []), userMessage, assistantMessage];
      saveChatMessages(messages);
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, updated_at: now } : thread,
      ));
      return { user_message: userMessage, assistant_message: assistantMessage } as T;
    }
    case "chat_generate_media": {
      const req = (args as InvokeArgs | undefined)?.req as { thread_id?: string; prompt?: string; kind?: string } | undefined;
      const threadId = req?.thread_id ?? "";
      const kind = req?.kind === "video" ? "video" : "image";
      const now = Math.floor(Date.now() / 1000);
      const prompt = req?.prompt ?? "";
      const ext = kind === "video" ? "mp4" : "png";
      const mime = kind === "video" ? "video/mp4" : "image/svg+xml";
      const model = kind === "video" ? "agnes-video-v2.0" : "agnes-image-2.1-flash";
      const savedPath = `/browser-preview/ai-generations/${kind}-${Date.now()}.${ext}`;
      const attachmentPath = kind === "image" ? stubGeneratedImageDataUri(prompt) : savedPath;
      const userMessage: StubChatMessage = {
        id: `stub-user-${Date.now()}`,
        thread_id: threadId,
        role: "user",
        content: prompt,
        created_at: now,
        redacted: false,
        attachments: [],
      };
      const assistantMessage: StubChatMessage = {
        id: `stub-assistant-${Date.now()}`,
        thread_id: threadId,
        role: "assistant",
        content: `${kind === "video" ? "Generated video" : "Generated image"} saved to:\n${savedPath}`,
        created_at: now + 1,
        redacted: false,
        attachments: [{
          id: `stub-media-${Date.now()}`,
          kind,
          path: attachmentPath,
          name: `generated-${kind}.${ext}`,
          size: kind === "video" ? 0 : attachmentPath.length,
          mime,
          preview_url: kind === "image" ? attachmentPath : null,
        }],
      };
      const messages = loadChatMessages();
      const hadMessages = (messages[threadId] ?? []).length > 0;
      messages[threadId] = [...(messages[threadId] ?? []), userMessage, assistantMessage];
      saveChatMessages(messages);
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              updated_at: now,
              title: hadMessages ? thread.title : prompt.slice(0, 40) || thread.title,
              mode: kind,
            }
          : thread,
      ));
      return {
        user_message: userMessage,
        assistant_message: assistantMessage,
        redacted_count: 0,
        saved_path: savedPath,
        remote_url: null,
        video_id: kind === "video" ? `stub-video-${Date.now()}` : null,
        model,
      } as T;
    }
    // ---------- Mail client commands (browser preview stubs) ----------
    case "mail_list_cached_folders": {
      return stubMailFolderList(stubMailAccountId(args as InvokeArgs | undefined)) as T;
    }
    case "mail_list_cached_messages": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const limit = Math.max(0, Number((invokeArgs?.limit as number | undefined) ?? 200));
      const offset = Math.max(0, Number((invokeArgs?.offset as number | undefined) ?? 0));
      return stubMailMessages(accountId, folder).slice(offset, offset + limit) as T;
    }
    case "mail_sync_headers": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folder = ((invokeArgs?.folder as string | null | undefined) ?? "INBOX") || "INBOX";
      const messages = stubMailMessages(accountId, folder);
      const limit = Math.max(1, Number((invokeArgs?.limit as number | undefined) ?? messages.length));
      const offset = Math.max(0, Number((invokeArgs?.offset as number | undefined) ?? 0));
      const page = messages.slice(offset, offset + limit);
      return {
        accountId,
        folder,
        folders: stubMailFolderList(accountId),
        messages: page,
        fetchedMessages: page.length,
        cachedBodies: page.filter((message) => message.bodyCached).length,
        syncedAt: Math.floor(Date.now() / 1000),
        offset,
        limit,
        hasMore: offset + page.length < messages.length,
      } as T;
    }
    case "mail_sync_all_folders": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folders = stubMailFolderList(accountId);
      const messages = folders.flatMap((folder) => stubMailMessages(accountId, folder.name));
      return {
        accountId,
        folders,
        fetchedMessages: messages.length,
        cachedBodies: messages.filter((message) => message.bodyCached).length,
        syncedAt: Math.floor(Date.now() / 1000),
      } as T;
    }
    case "mail_get_message_body": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uid = Number((invokeArgs?.uid as number | undefined) ?? 91);
      return stubMailBody(accountId, folder, uid) as T;
    }
    case "mail_download_attachment": {
      const invokeArgs = args as InvokeArgs | undefined;
      const targetPath = (invokeArgs?.targetPath as string | undefined) ?? "attachment";
      return { path: targetPath, name: "policy.txt", contentType: "text/plain", size: 1240 } as T;
    }
    case "mail_mark_read": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uids = Array.isArray(invokeArgs?.uids) ? invokeArgs?.uids as unknown[] : [];
      const all = Boolean(invokeArgs?.all);
      return { folder, marked: all ? 1 : uids.length } as T;
    }
    case "mail_send_message": {
      return { accepted: true, response: "browser-preview accepted" } as T;
    }
    case "mail_list_drafts": {
      const accountId = stubMailAccountId(args as InvokeArgs | undefined);
      return loadMailDrafts()
        .filter((draft) => draft.accountId === accountId)
        .sort((a, b) => b.updatedAt - a.updatedAt) as T;
    }
    case "mail_save_draft": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const draft = (invokeArgs?.draft as Record<string, unknown> | undefined) ?? {};
      return stubSaveMailDraft(accountId, draft) as T;
    }
    case "mail_delete_draft": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const draftId = (invokeArgs?.draftId as string | undefined) ?? "";
      saveMailDrafts(loadMailDrafts().filter((draft) => !(draft.accountId === accountId && draft.id === draftId)));
      return undefined as T;
    }
    case "mail_index_cached_contacts": {
      return stubMailContacts(stubMailAccountId(args as InvokeArgs | undefined), "", 100).length as T;
    }
    case "mail_search_contacts": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const query = (invokeArgs?.query as string | undefined) ?? "";
      const limit = Math.max(1, Math.min(20, Number((invokeArgs?.limit as number | undefined) ?? 8)));
      return stubMailContacts(accountId, query, limit) as T;
    }
    case "mail_test_connection": {
      return { imapOk: true, smtpOk: true, folderCount: MAIL_STUB_FOLDERS.length } as T;
    }
    case "mail_oauth_authorize": {
      return {
        tokenRef: "vault:stub-mail-oauth-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "stub-mail-scope",
        tokenType: "Bearer",
      } as T;
    }
    case "mail_oauth_device_start": {
      const invokeArgs = args as InvokeArgs | undefined;
      const provider = (invokeArgs?.request as { provider?: string } | undefined)?.provider;
      return {
        deviceCode: "stub-device-code",
        userCode: "ABCD-EFGH",
        verificationUri: provider === "gmail" ? "https://www.google.com/device" : "https://microsoft.com/devicelogin",
        message: "Open the verification URL and enter code ABCD-EFGH.",
        expiresIn: 900,
        interval: 1,
      } as T;
    }
    case "mail_oauth_device_complete": {
      return {
        tokenRef: "vault:stub-mail-oauth-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "stub-mail-scope",
        tokenType: "Bearer",
      } as T;
    }
    case "mail_clear_cache": {
      return undefined as T;
    }
    case "db_append_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const entry = invokeArgs?.entry as StubDbSqlHistoryEntry | undefined;
      if (!entry?.id) return undefined as T;
      const entries = loadDbSqlHistory().filter((candidate) => candidate.id !== entry.id);
      saveDbSqlHistory([entry, ...entries].slice(0, 1000));
      return undefined as T;
    }
    case "db_list_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const savedSessionId = (invokeArgs?.savedSessionId as string | null | undefined) ?? null;
      const engine = (invokeArgs?.engine as string | null | undefined) ?? null;
      const limit = Math.max(1, Math.min(1000, Number((invokeArgs?.limit as number | undefined) ?? 200)));
      const entries = loadDbSqlHistory()
        .filter((entry) => !savedSessionId || entry.savedSessionId === savedSessionId)
        .filter((entry) => !engine || entry.engine === engine)
        .sort((a, b) => (b.startedAt - a.startedAt) || (b.createdAt - a.createdAt))
        .slice(0, limit);
      return entries as T;
    }
    case "db_delete_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const id = (invokeArgs?.id as string | undefined) ?? "";
      saveDbSqlHistory(loadDbSqlHistory().filter((entry) => entry.id !== id));
      return undefined as T;
    }
    case "db_clear_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const savedSessionId = (invokeArgs?.savedSessionId as string | null | undefined) ?? null;
      saveDbSqlHistory(
        savedSessionId
          ? loadDbSqlHistory().filter((entry) => entry.savedSessionId !== savedSessionId)
          : [],
      );
      return undefined as T;
    }
    // ---------- Database client commands (desktop-only) ----------
    case "db_connect":
    case "db_ping":
    case "db_disconnect":
    case "db_list_catalogs":
    case "db_list_schemas":
    case "db_list_tables":
    case "db_describe_table":
    case "db_list_foreign_keys":
    case "db_list_indexes":
    case "db_execute":
    case "db_execute_stream":
    case "db_cancel":
    case "redis_list_keys":
    case "redis_get_key":
    case "redis_set_key":
    case "redis_del_key":
    case "redis_exec":
    case "hbase_connect":
    case "hbase_ping":
    case "hbase_disconnect":
    case "hbase_list_tables":
    case "hbase_describe_table":
    case "hbase_execute": {
      throw new Error(
        "Database and HBase connections are not available in browser preview. Use the desktop build of Taomni.",
      );
    }
    /* ----------------------------- LanChat (内网通讯) ----------------------------- */
    case "lanchat_status": {
      return { running: false, nodeId: "preview", peerCount: LANCHAT_MOCK_PEERS.length } as T;
    }
    case "lanchat_list_peers": {
      return LANCHAT_MOCK_PEERS as T;
    }
    case "lanchat_get_profile": {
      return {
        id: "me-preview",
        name: "林开发",
        avatarBase64: null,
        avatarHash: null,
        signature: "摸鱼中，勿扰 ✨",
        status: "online",
        updatedAt: Date.now(),
      } as T;
    }
    case "lanchat_list_conversations": {
      return LANCHAT_MOCK_CONVERSATIONS as T;
    }
    case "lanchat_list_groups": {
      return LANCHAT_MOCK_GROUPS as T;
    }
    case "lanchat_list_messages": {
      const convId = (args as InvokeArgs | undefined)?.convId as string | undefined;
      return ((convId && LANCHAT_MOCK_MESSAGES[convId]) ?? []) as T;
    }
    case "lanchat_mark_read": {
      return undefined as T;
    }
    case "lanchat_open_path": {
      return undefined as T;
    }
    case "lanchat_send_text":
    case "lanchat_send_group_text":
    case "lanchat_resend_message":
    case "lanchat_update_profile":
    case "lanchat_create_group":
    case "lanchat_leave_group":
    case "lanchat_send_file":
    case "lanchat_send_group_file":
    case "lanchat_send_dir":
    case "lanchat_accept_file":
    case "lanchat_reject_file":
    case "lanchat_transfer_control":
    case "lanchat_send_screenshot":
    case "lanchat_send_clipboard_image":
    case "lanchat_send_signal":
    case "lanchat_signal_group": {
      throw new Error("内网通讯仅桌面版可用：浏览器预览不支持真实发现与直连。");
    }
    // ---------- Tao Notes (browser preview) ----------
    case "notes_list": {
      const query = ((args as InvokeArgs | undefined)?.query as Record<string, unknown> | undefined) ?? {};
      return stubFilterNotes(loadNotes(), query).map(stubNoteToItem) as T;
    }
    case "notes_get": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const note = loadNotes().find((n) => n.id === id);
      return (note ? stubNoteToItem(note) : null) as T;
    }
    case "notes_create": {
      const input = ((args as InvokeArgs | undefined)?.input as Record<string, unknown> | undefined) ?? {};
      const ts = nowSecsStub();
      const note: StubNote = {
        id: stubId(),
        title: (input.title as string | undefined) ?? "",
        body: (input.body as string | undefined) ?? "",
        completed_at: null,
        pinned: (input.pinned as boolean | undefined) ?? false,
        archived_at: null,
        color: (input.color as string | null | undefined) ?? null,
        priority: Number(input.priority) || 0,
        due_at: (input.due_at as number | null | undefined) ?? null,
        reminder_at: (input.reminder_at as number | null | undefined) ?? null,
        repeat_rule: (input.repeat_rule as string | null | undefined) ?? null,
        source_tab_id: (input.source_tab_id as string | null | undefined) ?? null,
        source_session_id: (input.source_session_id as string | null | undefined) ?? null,
        source_title: (input.source_title as string | null | undefined) ?? null,
        source_uri: (input.source_uri as string | null | undefined) ?? null,
        created_at: ts,
        updated_at: ts,
        steps: [],
        tag_ids: ((input.tag_ids as string[] | undefined) ?? []).slice(),
      };
      saveNotes([note, ...loadNotes()]);
      return stubNoteToItem(note) as T;
    }
    case "notes_update": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const patch = ((args as InvokeArgs | undefined)?.patch as Record<string, unknown> | undefined) ?? {};
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === id);
      if (idx < 0) return null as T;
      const ts = nowSecsStub();
      notes[idx] = {
        ...notes[idx],
        title: (patch.title as string | undefined) ?? notes[idx].title,
        body: (patch.body as string | undefined) ?? "",
        pinned: (patch.pinned as boolean | undefined) ?? false,
        color: (patch.color as string | null | undefined) ?? null,
        priority: Number(patch.priority) || 0,
        due_at: (patch.due_at as number | null | undefined) ?? null,
        reminder_at: (patch.reminder_at as number | null | undefined) ?? null,
        repeat_rule: (patch.repeat_rule as string | null | undefined) ?? null,
        source_tab_id: (patch.source_tab_id as string | null | undefined) ?? null,
        source_session_id: (patch.source_session_id as string | null | undefined) ?? null,
        source_title: (patch.source_title as string | null | undefined) ?? null,
        source_uri: (patch.source_uri as string | null | undefined) ?? null,
        updated_at: ts,
        tag_ids: (patch.tag_ids as string[] | undefined) ?? notes[idx].tag_ids,
      };
      saveNotes(notes);
      return stubNoteToItem(notes[idx]) as T;
    }
    case "notes_delete": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      saveNotes(loadNotes().filter((n) => n.id !== id));
      return undefined as T;
    }
    case "notes_toggle_complete": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const completed = Boolean((args as InvokeArgs | undefined)?.completed);
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === id);
      if (idx < 0) return null as T;
      const ts = nowSecsStub();
      notes[idx] = { ...notes[idx], completed_at: completed ? ts : null, updated_at: ts };
      saveNotes(notes);
      return stubNoteToItem(notes[idx]) as T;
    }
    case "notes_archive": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      const archived = Boolean((args as InvokeArgs | undefined)?.archived);
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === id);
      if (idx < 0) return null as T;
      const ts = nowSecsStub();
      notes[idx] = { ...notes[idx], archived_at: archived ? ts : null, updated_at: ts };
      saveNotes(notes);
      return stubNoteToItem(notes[idx]) as T;
    }
    case "notes_list_tags": {
      return loadNoteTags().slice().sort((a, b) => a.name.localeCompare(b.name)) as T;
    }
    case "notes_upsert_tags": {
      const inputTags = ((args as InvokeArgs | undefined)?.tags as Array<Record<string, unknown>> | undefined) ?? [];
      const tags = loadNoteTags();
      const out: StubNoteTag[] = [];
      const ts = nowSecsStub();
      for (const t of inputTags) {
        const name = String(t.name ?? "").trim();
        if (!name) continue;
        const tagId = t.id as string | undefined;
        let existing =
          (tagId ? tags.find((x) => x.id === tagId) : undefined) ??
          tags.find((x) => x.name === name);
        if (existing) {
          existing.name = name;
          existing.color = (t.color as string | null | undefined) ?? null;
          existing.updated_at = ts;
        } else {
          existing = { id: stubId(), name, color: (t.color as string | null | undefined) ?? null, created_at: ts, updated_at: ts };
          tags.push(existing);
        }
        out.push(existing);
      }
      saveNoteTags(tags);
      return out as T;
    }
    case "notes_set_steps": {
      const noteId = (args as InvokeArgs | undefined)?.noteId as string | undefined;
      const stepInputs = ((args as InvokeArgs | undefined)?.steps as Array<Record<string, unknown>> | undefined) ?? [];
      const notes = loadNotes();
      const idx = notes.findIndex((n) => n.id === noteId);
      if (idx < 0) return [] as T;
      const ts = nowSecsStub();
      const steps: StubNoteStep[] = stepInputs.map((s, i) => ({
        id: (s.id as string | undefined) ?? stubId(),
        note_id: noteId as string,
        title: String(s.title ?? ""),
        completed_at: (s.completed_at as number | null | undefined) ?? null,
        sort_order: s.sort_order != null ? Number(s.sort_order) : i,
        created_at: ts,
        updated_at: ts,
      }));
      steps.sort((a, b) => a.sort_order - b.sort_order);
      notes[idx] = { ...notes[idx], steps, updated_at: ts };
      saveNotes(notes);
      return steps as T;
    }
    case "notes_get_prefs": {
      try {
        const parsed = JSON.parse(localStorage.getItem(NOTE_PREFS_STORAGE_KEY) ?? "{}");
        return (parsed && typeof parsed === "object" ? parsed : {}) as T;
      } catch {
        return {} as T;
      }
    }
    case "notes_set_prefs": {
      const prefs = ((args as InvokeArgs | undefined)?.prefs as Record<string, string> | undefined) ?? {};
      let current: Record<string, string> = {};
      try {
        current = JSON.parse(localStorage.getItem(NOTE_PREFS_STORAGE_KEY) ?? "{}") || {};
      } catch {
        current = {};
      }
      localStorage.setItem(NOTE_PREFS_STORAGE_KEY, JSON.stringify({ ...current, ...prefs }));
      return undefined as T;
    }
    case "notes_list_alerts": {
      const now = Number((args as InvokeArgs | undefined)?.now) || nowSecsStub();
      const dueSoon = Number((args as InvokeArgs | undefined)?.dueSoonSecs) || NOTE_DUE_SOON_SECS;
      const acks = loadNoteAcks();
      const alerts: Array<Record<string, unknown>> = [];
      for (const n of loadNotes()) {
        if (n.completed_at !== null || n.archived_at !== null) continue;
        const emit = (kind: string, fireAt: number) => {
          const id = `${n.id}:${kind}`;
          alerts.push({
            id,
            note_id: n.id,
            kind,
            state: acks[id] ? "acknowledged" : "pending",
            fire_at: fireAt,
            acknowledged_at: acks[id] ?? null,
            note_title: n.title,
            due_at: n.due_at,
            reminder_at: n.reminder_at,
          });
        };
        if (n.due_at !== null && n.due_at <= now) emit("overdue", n.due_at);
        else if (n.due_at !== null && n.due_at > now && n.due_at <= now + dueSoon) emit("due_soon", n.due_at);
        if (n.reminder_at !== null && n.reminder_at <= now) emit("reminder", n.reminder_at);
      }
      const rank: Record<string, number> = { overdue: 0, reminder: 1, due_soon: 2 };
      alerts.sort((a, b) => (rank[a.kind as string] - rank[b.kind as string]) || (Number(a.fire_at) - Number(b.fire_at)));
      return alerts as T;
    }
    case "notes_ack_alert": {
      const id = (args as InvokeArgs | undefined)?.id as string | undefined;
      if (id) {
        const acks = loadNoteAcks();
        acks[id] = nowSecsStub();
        saveNoteAcks(acks);
      }
      return undefined as T;
    }
    default:
      console.warn(`[tauri-stub] Unknown invoke command: ${cmd}`, args);
      if (cmd === "history_match_prefix" || cmd === "history_list_recent") {
        return ([] as unknown) as T;
      }
      if (
        cmd === "history_append" ||
        cmd === "history_clear"
      ) {
        return undefined as T;
      }
      return undefined as T;
  }
}
