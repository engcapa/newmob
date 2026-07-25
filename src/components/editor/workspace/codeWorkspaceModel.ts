/**
 * Pure types and helpers for Code Workspace (no React).
 * Extracted from CodeWorkspaceTab to shrink the shell and share with store/UI units.
 */
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo, CodeWorkspaceTabInfo } from "../../../types";
import type { WorkspaceEntry, WorkspaceGitRoot } from "../../../lib/editor/workspace";
import type { LspCustomServerCommand, LspDocumentStatus, LspDiagnostic } from "../../../lib/editor/lsp";
import type { GitChange } from "../../../lib/git";
import { DEFAULT_CODE_VIEW_PROFILE } from "../../../lib/codeViewProfile";
import type { OpenFileEol, OpenFileViewModel } from "./editorGroupTypes";
import type { FileTreeViewMode } from "./FileTreePane";

export type MermaidApi = typeof import("mermaid").default;

export type OpenFileState = OpenFileViewModel;
export type TreeViewMode = FileTreeViewMode;
export type MarkdownViewMode = "edit" | "preview" | "split";

/** Custom LSP command shape shared by workspace sessions and Settings. */
export interface LspCustomCommandConfig {
  command: string;
  args: string;
}

export interface DirectoryState {
  entries: WorkspaceEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface CompactChainState {
  path: string;
  entries: WorkspaceEntry[];
  loading: boolean;
  error: string | null;
}

export interface LspFileState {
  status: LspDocumentStatus | null;
  diagnostics: LspDiagnostic[];
  syncing: boolean;
  syncedText: string | null;
  error: string | null;
}

export type TreeSelection =
  | { kind: "root"; rootId: string }
  | { kind: "dir"; rootId: string; path: string }
  | { kind: "file"; ref: CodeWorkspaceFileRef };
export interface WorkspaceTreeCommandPayload {
  selection?: TreeSelection;
  directory?: { rootId: string; path: string };
  rootId?: string;
  path?: string;
}


export const LSP_COMMAND_PREFS_KEY = "taomni.codeWorkspace.lspCommandPrefs.v1";
export const LSP_CUSTOM_COMMANDS_KEY = "taomni.codeWorkspace.lspCustomCommands.v1";
/** Absolute JDK home or `java`/`java.exe` path used to launch Eclipse JDT LS (needs 21+). */
export const LSP_JAVA_HOME_KEY = "taomni.codeWorkspace.lspJavaHome.v1";
/**
 * Free-form jdtls JVM args (space-separated), e.g. `-Xmx2G -XX:+UseG1GC`.
 * Empty → [`DEFAULT_LSP_JAVA_VMARGS`].
 */
export const LSP_JAVA_VMARGS_KEY = "taomni.codeWorkspace.lspJavaVmargs.v1";
/** Legacy heap-only key; migrated into vmargs on first read. */
export const LSP_JAVA_HEAP_MB_KEY = "taomni.codeWorkspace.lspJavaHeapMb.v1";
export const DEFAULT_LSP_JAVA_VMARGS = "-Xms1024m -Xmx1024m";
export const CUSTOM_LSP_COMMAND_ID = "__custom__";
export const TREE_FONT_SIZE_KEY = "taomni.codeWorkspace.treeFontSize.v1";
export const TREE_VIEW_MODE_KEY = "taomni.codeWorkspace.treeViewMode.v1";
export const FLAT_VIEW_MAX_FILES = 2_000;
export const FLAT_VIEW_MAX_DEPTH = 25;
export const NAV_HISTORY_LIMIT = 100;
export const RECENT_FILES_LIMIT = 50;
export const CODE_WORKSPACE_MIN_FONT_SIZE = 8;
export const CODE_WORKSPACE_MAX_FONT_SIZE = 32;
export const CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE = 12;
export const CODE_WORKSPACE_MIN_TREE_FONT_SIZE = 10;
export const CODE_WORKSPACE_MAX_TREE_FONT_SIZE = 20;

export let mermaidReady = false;
export let mermaidPromise: Promise<MermaidApi> | null = null;

export const DEFAULT_DIR_STATE: DirectoryState = {
  entries: [],
  loaded: false,
  loading: false,
  error: null,
};

export interface FlatFilesState {
  entries: WorkspaceEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  truncated: boolean;
}

export const DEFAULT_FLAT_FILES_STATE: FlatFilesState = {
  entries: [],
  loading: false,
  loaded: false,
  error: null,
  truncated: false,
};

export interface WorkspaceGitSnapshotState {
  changes: GitChange[];
  headOid: string | null;
  currentBranch: string | null;
  ahead: number;
  behind: number;
  loading: boolean;
  error: string | null;
}


export function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid")
    .then((mod) => mod.default)
    .catch((err) => {
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

export async function ensureMermaidReady(): Promise<MermaidApi> {
  const mermaid = await loadMermaid();
  if (mermaidReady) return mermaid;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
  });
  mermaidReady = true;
  return mermaid;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMermaidSvg(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg);
  downloadBlob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), fileName);
}

export function exportMermaidPng(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const image = new Image();
  image.onload = () => {
    const box = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(box?.width || rect.width || image.width || 960));
    const height = Math.max(1, Math.ceil(box?.height || rect.height || image.height || 540));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => {
      URL.revokeObjectURL(url);
      if (blob) downloadBlob(blob, fileName);
    }, "image/png");
  };
  image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
}

export function pathName(path: string, fallback = "Workspace"): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized || fallback;
}

export function rootIdForPath(path: string): string {
  return `root-${hashString(path)}`;
}

export function looseIdForPath(path: string): string {
  return `loose-${hashString(path)}`;
}

/**
 * A JDK / dependency source delivered by the language server instead of the file
 * system (jdtls answers `java/classFileContents` for `jdt://` class URIs).
 */
export interface LibraryBufferInfo {
  uri: string;
  /** Display name, e.g. `String.java`. */
  title: string;
  /** `package · jar/module` label for the tab subtitle. */
  container: string | null;
  languageId: string;
  /** Project file the jump started from; selects the language-server session. */
  originFilePath: string;
  originRootPath: string | null;
}

const LIBRARY_LANGUAGE_EXTENSIONS: Record<string, string> = {
  java: "java",
  kotlin: "kt",
  scala: "scala",
  groovy: "groovy",
};

/**
 * True when a location "path" is really a document URI (`jdt://`, `jar:file:`,
 * `file://`, …) rather than a filesystem path. Language servers and our own
 * symbol mapping both fall back to the URI when there is no path, and reading
 * such a string from disk always fails.
 */
export function looksLikeDocumentUri(candidate: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(candidate.trim());
  if (!match) return false;
  // A single letter before the colon is a Windows drive (C:\src\Main.java).
  return match[1]!.length > 1;
}

/** Library buffers are keyed by URI so same-named classes never collide. */
export function libraryFileRef(uri: string): CodeWorkspaceFileRef {
  return { kind: "loose", id: looseIdForPath(uri), path: uri };
}

/** File name used only for syntax highlighting of a library buffer. */
export function libraryLanguagePath(info: LibraryBufferInfo): string {
  const title = info.title.trim();
  if (title.includes(".")) return title;
  const extension = LIBRARY_LANGUAGE_EXTENSIONS[info.languageId] ?? "txt";
  return `${title || "Library"}.${extension}`;
}

/** Read-only open-buffer view model for a library source (never touches disk). */
export function makeLibraryFile(info: LibraryBufferInfo, text: string): OpenFileState {
  const ref = libraryFileRef(info.uri);
  const normalized = normalizeEditorText(text);
  const title = info.title.trim() || pathName(info.uri, "Library");
  return {
    ref,
    key: fileKey(ref),
    path: info.uri,
    title,
    subtitle: info.container ? `${info.container} · ${title}` : title,
    languagePath: libraryLanguagePath(info),
    text: normalized.text,
    savedText: normalized.text,
    eol: normalized.eol,
    hash: `library:${hashString(info.uri)}`,
    mtime: 0,
    size: normalized.text.length,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
    library: {
      uri: info.uri,
      container: info.container,
      originFilePath: info.originFilePath,
      originRootPath: info.originRootPath,
    },
  };
}

export function makeRoot(path: string, kind: CodeWorkspaceRootInfo["kind"] = "folder"): CodeWorkspaceRootInfo {
  const normalized = path.trim();
  return {
    id: rootIdForPath(normalized),
    name: pathName(normalized),
    path: normalized,
    kind,
  };
}

export function makeLooseFile(path: string): CodeWorkspaceLooseFileInfo {
  const normalized = path.trim();
  return {
    id: looseIdForPath(normalized),
    name: pathName(normalized, "File"),
    path: normalized,
  };
}

export function initialRoots(workspace: CodeWorkspaceTabInfo): CodeWorkspaceRootInfo[] {
  if (workspace.roots?.length) return workspace.roots;
  const legacy = workspace.repoRoot.trim();
  return legacy ? [makeRoot(legacy, "git")] : [];
}

export function initialLooseFiles(workspace: CodeWorkspaceTabInfo): CodeWorkspaceLooseFileInfo[] {
  return workspace.looseFiles ?? [];
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function joinRelativePath(parent: string, name: string): string {
  const cleanName = name.trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return parent ? `${parent}/${cleanName}` : cleanName;
}

export function remapRelativePath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath;
  return path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : path;
}

export function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function relativePathWithinRoot(rootPath: string, filePath: string): string | null {
  const root = normalizeFsPath(rootPath);
  const file = normalizeFsPath(filePath);
  if (file === root) return "";
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
}

export function absoluteWorkspacePath(root: CodeWorkspaceRootInfo, workspacePath: string): string {
  const rootPath = normalizeFsPath(root.path);
  const cleanPath = normalizeFsPath(workspacePath).replace(/^\/+/, "");
  return cleanPath ? `${rootPath}/${cleanPath}` : rootPath;
}

export function gitPathForWorkspacePath(
  root: CodeWorkspaceRootInfo,
  repo: WorkspaceGitRoot,
  workspacePath: string,
): string | null {
  const repoRoot = normalizeFsPath(repo.repoRoot);
  const filePath = absoluteWorkspacePath(root, workspacePath);
  if (filePath === repoRoot) return "";
  return filePath.startsWith(`${repoRoot}/`) ? filePath.slice(repoRoot.length + 1) : null;
}

export function workspacePathForGitPath(
  root: CodeWorkspaceRootInfo,
  repo: WorkspaceGitRoot,
  gitPath: string,
): string | null {
  const rootPath = normalizeFsPath(root.path);
  const repoRoot = normalizeFsPath(repo.repoRoot);
  const cleanPath = normalizeFsPath(gitPath).replace(/^\/+/, "");
  const filePath = cleanPath ? `${repoRoot}/${cleanPath}` : repoRoot;
  if (filePath === rootPath) return "";
  return filePath.startsWith(`${rootPath}/`) ? filePath.slice(rootPath.length + 1) : null;
}

export function gitRootsForWorkspaceRoot(root: CodeWorkspaceRootInfo, gitRoots: WorkspaceGitRoot[]): WorkspaceGitRoot[] {
  return gitRoots
    .filter((repo) => repo.rootIds.includes(root.id))
    .sort((a, b) => normalizeFsPath(b.repoRoot).length - normalizeFsPath(a.repoRoot).length);
}

export function gitRootForWorkspacePath(
  root: CodeWorkspaceRootInfo,
  workspacePath: string,
  gitRoots: WorkspaceGitRoot[],
): WorkspaceGitRoot | null {
  for (const repo of gitRootsForWorkspaceRoot(root, gitRoots)) {
    if (gitPathForWorkspacePath(root, repo, workspacePath) !== null) return repo;
  }
  return null;
}

export function rootDirKey(rootId: string, path = ""): string {
  return `${rootId}:${path}`;
}

export function fileKey(ref: CodeWorkspaceFileRef): string {
  return ref.kind === "root" ? `root:${ref.rootId}:${ref.path}` : `loose:${ref.id}`;
}

export function fileRefEquals(a: CodeWorkspaceFileRef, b: CodeWorkspaceFileRef): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "root"
    ? b.kind === "root" && a.rootId === b.rootId && a.path === b.path
    : b.kind === "loose" && a.id === b.id && a.path === b.path;
}

export function fileRefUnder(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && (ref.path === path || ref.path.startsWith(`${path}/`));
}

export function remapFileRef(ref: CodeWorkspaceFileRef, rootId: string, fromPath: string, toPath: string): CodeWorkspaceFileRef {
  if (ref.kind !== "root" || ref.rootId !== rootId) return ref;
  return { ...ref, path: remapRelativePath(ref.path, fromPath, toPath) };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMtime(mtime: number): string {
  if (!mtime) return "";
  try {
    return new Date(mtime * 1000).toLocaleString();
  } catch {
    return "";
  }
}

/** Directory names skipped in recursive indexes / heavy walks (and hidden in tree). */
export const HEAVY_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

export function shouldHideEntry(entry: WorkspaceEntry): boolean {
  if (!entry.path) return false;
  const segments = entry.path.replace(/\\/g, "/").split("/");
  return segments.some((segment) => HEAVY_DIR_NAMES.has(segment));
}

/** Compact-tree display name: `src` → `src/main` when a single-child chain is folded. */
export function compactEntryName(
  entry: WorkspaceEntry,
  chain: { path: string } | undefined,
): string {
  if (!chain || chain.path === entry.path) return entry.name;
  const suffix = chain.path.startsWith(`${entry.path}/`)
    ? chain.path.slice(entry.path.length + 1)
    : "";
  return suffix ? `${entry.name}/${suffix}` : entry.name;
}

/** Flat-view group key by file extension (lowercase, including the dot). */
export function flatExtensionGroup(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "No extension";
  return name.slice(dot).toLowerCase();
}

/**
 * Directories that must never appear as flat-view language source groups
 * (build output, docs, caches, vendored trees, etc.).
 */
export const FLAT_EXCLUDED_DIR_NAMES = new Set([
  ...HEAVY_DIR_NAMES,
  "output",
  "outputs",
  "out",
  "docs",
  "doc",
  "documentation",
  "examples",
  "example",
  "vendor",
  "third_party",
  "third-party",
  "coverage",
  "tmp",
  "temp",
  "logs",
  "log",
  "bin",
  "obj",
  "assets",
  "static",
  "public",
  "images",
  "img",
  "fonts",
  "testdata",
  "fixtures",
  "snapshots",
  "generated",
  "gen",
]);

/** Directory basenames treated as language source roots for the flat view. */
export const LANGUAGE_SOURCE_DIR_NAMES = new Set([
  "src",
  "lib",
  "app",
  "source",
  "sources",
]);

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Nearest language source root containing `path` (prefer the deepest `src` /
 * `lib` / `app` segment). Returns null when the file is not under such a root
 * (e.g. README, docs/, target/, root-level configs).
 *
 * Examples:
 * - `src/App.tsx` → `src`
 * - `src-tauri/src/lib.rs` → `src-tauri/src`
 * - `packages/web/src/main.ts` → `packages/web/src`
 */
export function languageSourceRootFor(path: string): string | null {
  const normalized = normalizeWorkspacePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // Walk directory segments only (exclude the file name).
  let rootIndex = -1;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (LANGUAGE_SOURCE_DIR_NAMES.has(parts[i])) rootIndex = i;
  }
  if (rootIndex < 0) return null;
  return parts.slice(0, rootIndex + 1).join("/");
}

function pathHasExcludedSegment(path: string): boolean {
  return normalizeWorkspacePath(path)
    .split("/")
    .some((segment) => segment.length > 0 && FLAT_EXCLUDED_DIR_NAMES.has(segment));
}

/** True when the path looks like a documentation / non-source artifact. */
export function isDocumentationPath(path: string): boolean {
  if (isMarkdownPath(path)) return true;
  const name = basename(path).toLowerCase();
  if (
    name === "readme"
    || name === "changelog"
    || name === "license"
    || name === "licence"
    || name === "authors"
    || name === "contributing"
    || name.startsWith("readme.")
  ) {
    return true;
  }
  const lower = normalizeWorkspacePath(path).toLowerCase();
  return (
    lower.startsWith("docs/")
    || lower.startsWith("doc/")
    || lower.includes("/docs/")
    || lower.includes("/doc/")
  );
}

/**
 * Flat-view eligibility: language source file under a recognized `src`/`lib`/
 * `app` root, excluding build output and documentation trees.
 */
export function isFlatViewSourceFile(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized || pathHasExcludedSegment(normalized)) return false;
  if (isDocumentationPath(normalized)) return false;
  if (!lspPresetIdForPath(normalized)) return false;
  return languageSourceRootFor(normalized) != null;
}

/**
 * Flat-view group key: language source root (`src`, `src-tauri/src`, …).
 * Falls back to the top-level directory only when a source root is missing
 * (callers should normally filter with {@link isFlatViewSourceFile} first).
 */
export function flatSourceGroup(path: string): string {
  const root = languageSourceRootFor(path);
  if (root) return root;
  const normalized = normalizeWorkspacePath(path);
  const slash = normalized.indexOf("/");
  if (slash <= 0) return "(root)";
  return normalized.slice(0, slash);
}

/** Path relative to {@link flatSourceGroup} for display under that group. */
export function flatSourceRelativePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const root = languageSourceRootFor(normalized) ?? flatSourceGroup(normalized);
  if (root === "(root)") return normalized || path;
  if (normalized === root) return basename(normalized);
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** Case-insensitive name/path substring match for the project-tree filter. */
export function matchesTreeFilter(name: string, path: string, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q) || path.replace(/\\/g, "/").toLowerCase().includes(q);
}

/**
 * CodeMirror always stores LF line endings. Normalize disk text to LF for the
 * buffer and remember the original style so save can restore it.
 */
export function normalizeEditorText(text: string): { text: string; eol: OpenFileEol } {
  let eol: OpenFileEol = "LF";
  if (text.includes("\r\n")) eol = "CRLF";
  else if (text.includes("\r")) eol = "CR";
  return {
    text: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    eol,
  };
}

/** Convert LF buffer text back to the file's original line endings on save. */
export function applyEditorEol(text: string, eol: OpenFileEol): string {
  if (eol === "CRLF") return text.replace(/\n/g, "\r\n");
  if (eol === "CR") return text.replace(/\n/g, "\r");
  return text;
}

/** Lookup a git change in the precomputed `rootId:workspacePath` map. */
export function gitChangeForPath(
  gitChangeByRootPath: Map<string, GitChange> | ReadonlyMap<string, GitChange>,
  rootId: string,
  path: string,
): GitChange | undefined {
  return gitChangeByRootPath.get(`${rootId}:${path}`);
}

/** Count git changes under a directory (or whole root when path is empty). */
export function gitDirectoryChangeCount(
  gitChangeByRootPath: Map<string, GitChange> | ReadonlyMap<string, GitChange>,
  rootId: string,
  path: string,
): number {
  const prefix = path ? `${rootId}:${path}/` : `${rootId}:`;
  let count = 0;
  for (const key of gitChangeByRootPath.keys()) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
}

export function isRootRef(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && ref.path === path;
}

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function lspPresetIdForPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lower)) return "typescript-javascript";
  if (lower.endsWith(".rs")) return "rust";
  if (/\.(py|pyi)$/.test(lower)) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (/\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/.test(lower)) return "cpp";
  if (/\.(kt|kts)$/.test(lower)) return "kotlin";
  if (/\.(scala|sc)$/.test(lower)) return "scala";
  if (/\.(cs|csx)$/.test(lower)) return "csharp";
  if (lower.endsWith(".swift")) return "swift";
  return null;
}

/**
 * Whether *typing* should schedule didOpen/didChange IPC.
 * - Active session → didChange (incremental).
 * - Open already in flight (syncing) → coalesce the latest buffer into the queue
 *   so the server is not left on a stale snapshot when startup finishes mid-type.
 * - No preset / unavailable / idle inactive → never (file-focus probe owns start).
 */
export function shouldLiveSyncLsp(
  languagePath: string,
  state: LspFileState | null | undefined,
): boolean {
  if (!lspPresetIdForPath(languagePath)) return false;
  if (state?.status?.active) return true;
  // Mid-open: keep feeding the sync queue with the latest buffer.
  if (state?.syncing) return true;
  return false;
}

/**
 * Whether the editor may probe didOpen / start a session for this buffer
 * (file focus, first open). Blocks permanently-unavailable presets.
 */
export function shouldProbeLsp(
  languagePath: string,
  state: LspFileState | null | undefined,
): boolean {
  if (!lspPresetIdForPath(languagePath)) return false;
  const status = state?.status;
  if (!status) return true;
  if (status.active) return true;
  if (!status.available) return false;
  // available && !active (exited / still starting): allow a focus-driven probe
  // but sticky start errors wait for Settings / prefs refresh.
  if (state?.error && !state.syncing) return false;
  return true;
}

/** True when completion/signature/hover should hit the language server. */
export function isLspFeatureReady(state: LspFileState | null | undefined): boolean {
  return !!state?.status?.active;
}

const LSP_PREFS_CHANGED_EVENT = "taomni:lsp-server-prefs-changed";

function emitLspPrefsChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(LSP_PREFS_CHANGED_EVENT));
  } catch {
    // CustomEvent may be unavailable in exotic environments.
  }
}

/** Subscribe to LSP command / custom-command preference changes (Settings ↔ Workspace). */
export function subscribeLspServerPrefs(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== null
      && event.key !== LSP_COMMAND_PREFS_KEY
      && event.key !== LSP_CUSTOM_COMMANDS_KEY
      && event.key !== LSP_JAVA_HOME_KEY
      && event.key !== LSP_JAVA_VMARGS_KEY
      && event.key !== LSP_JAVA_HEAP_MB_KEY
    ) {
      return;
    }
    listener();
  };
  window.addEventListener(LSP_PREFS_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LSP_PREFS_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export function readLspCommandPrefs(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LSP_COMMAND_PREFS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLspCommandPrefs(prefs: Record<string, string>): void {
  try {
    window.localStorage.setItem(LSP_COMMAND_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
}

export function readLspCustomCommands(): Record<string, LspCustomCommandConfig> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LSP_CUSTOM_COMMANDS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, LspCustomCommandConfig> = {};
    for (const [presetId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const command = typeof (value as { command?: unknown }).command === "string"
        ? (value as { command: string }).command
        : "";
      const args = typeof (value as { args?: unknown }).args === "string"
        ? (value as { args: string }).args
        : "";
      if (command.trim() || args.trim()) out[presetId] = { command, args };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLspCustomCommands(commands: Record<string, LspCustomCommandConfig>): void {
  try {
    window.localStorage.setItem(LSP_CUSTOM_COMMANDS_KEY, JSON.stringify(commands));
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
}

/** Configured JDK home / java binary for jdtls (empty string means auto-detect). */
export function readLspJavaHome(): string {
  try {
    return window.localStorage.getItem(LSP_JAVA_HOME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeLspJavaHome(javaHome: string): void {
  try {
    const trimmed = javaHome.trim();
    if (trimmed) window.localStorage.setItem(LSP_JAVA_HOME_KEY, trimmed);
    else window.localStorage.removeItem(LSP_JAVA_HOME_KEY);
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
}

/** Normalize free-form jdtls JVM args; empty → null (use default). */
export function normalizeLspJavaVmargs(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

/**
 * Effective jdtls JVM args string.
 * Migrates the legacy heap-MB setting once into vmargs if present.
 */
export function readLspJavaVmargs(): string {
  try {
    const stored = normalizeLspJavaVmargs(window.localStorage.getItem(LSP_JAVA_VMARGS_KEY));
    if (stored) return stored;

    // One-shot migration from the short-lived heap-only preference.
    const legacyHeap = window.localStorage.getItem(LSP_JAVA_HEAP_MB_KEY);
    if (legacyHeap) {
      const mb = Number(legacyHeap.trim());
      if (Number.isFinite(mb) && mb > 0) {
        const clamped = Math.min(32768, Math.max(256, Math.round(mb)));
        const migrated = `-Xms${clamped}m -Xmx${clamped}m`;
        try {
          window.localStorage.setItem(LSP_JAVA_VMARGS_KEY, migrated);
          window.localStorage.removeItem(LSP_JAVA_HEAP_MB_KEY);
        } catch {
          // Ignore storage failures; still return migrated value for this session.
        }
        return migrated;
      }
    }
    return DEFAULT_LSP_JAVA_VMARGS;
  } catch {
    return DEFAULT_LSP_JAVA_VMARGS;
  }
}

/**
 * Persist jdtls JVM args. Empty/null clears to the default 1G heap pair.
 * Returns the effective string after normalize.
 */
export function writeLspJavaVmargs(vmargs: string | null | undefined): string {
  const normalized = normalizeLspJavaVmargs(vmargs);
  try {
    if (normalized === null) {
      window.localStorage.removeItem(LSP_JAVA_VMARGS_KEY);
    } else {
      window.localStorage.setItem(LSP_JAVA_VMARGS_KEY, normalized);
    }
    // Drop legacy key once the user manages vmargs explicitly.
    window.localStorage.removeItem(LSP_JAVA_HEAP_MB_KEY);
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
  return normalized ?? DEFAULT_LSP_JAVA_VMARGS;
}

export function splitCommandArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

export function customServerCommandFromConfig(config?: LspCustomCommandConfig): LspCustomServerCommand | null {
  const command = config?.command.trim() ?? "";
  if (!command) return null;
  return {
    label: "Custom",
    command,
    args: splitCommandArgs(config?.args ?? ""),
  };
}

export function clampCodeWorkspaceFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_CODE_VIEW_PROFILE.fontSize;
  return Math.min(CODE_WORKSPACE_MAX_FONT_SIZE, Math.max(CODE_WORKSPACE_MIN_FONT_SIZE, Math.round(size)));
}

export function clampCodeWorkspaceTreeFontSize(size: number): number {
  if (!Number.isFinite(size)) return CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  return Math.min(CODE_WORKSPACE_MAX_TREE_FONT_SIZE, Math.max(CODE_WORKSPACE_MIN_TREE_FONT_SIZE, Math.round(size)));
}

export function readCodeWorkspaceTreeFontSize(): number {
  try {
    const raw = window.localStorage.getItem(TREE_FONT_SIZE_KEY);
    return raw ? clampCodeWorkspaceTreeFontSize(Number(raw)) : CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  } catch {
    return CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  }
}

export function writeCodeWorkspaceTreeFontSize(size: number): void {
  try {
    window.localStorage.setItem(TREE_FONT_SIZE_KEY, String(clampCodeWorkspaceTreeFontSize(size)));
  } catch {
    // Ignore storage failures.
  }
}

export function readCodeWorkspaceTreeViewMode(): TreeViewMode {
  try {
    const raw = window.localStorage.getItem(TREE_VIEW_MODE_KEY);
    return raw === "compact" || raw === "flat" || raw === "tree" ? raw : "tree";
  } catch {
    return "tree";
  }
}

export function writeCodeWorkspaceTreeViewMode(mode: TreeViewMode): void {
  try {
    window.localStorage.setItem(TREE_VIEW_MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}

export function emptyLspFileState(): LspFileState {
  return {
    status: null,
    diagnostics: [],
    syncing: false,
    syncedText: null,
    error: null,
  };
}

export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#");
}

export function normalizeRelativeLink(path: string): string {
  const clean = path.split("#", 1)[0].split("?", 1)[0].replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function resolveRootMarkdownLink(currentPath: string, href: string): string {
  return normalizeRelativeLink(joinRelativePath(parentPath(currentPath), href));
}

export function resolveLooseMarkdownLink(currentPath: string, href: string): string {
  const normalized = currentPath.replace(/\\/g, "/");
  return joinRelativePath(parentPath(normalized), href);
}

export function makeLoadingFile(ref: CodeWorkspaceFileRef, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): OpenFileState {
  const meta = fileMeta(ref, roots, looseFiles);
  return {
    ref,
    key: fileKey(ref),
    path: meta.path,
    title: meta.title,
    subtitle: meta.subtitle,
    languagePath: meta.languagePath,
    text: "",
    savedText: "",
    eol: "LF",
    hash: "",
    mtime: 0,
    size: 0,
    loading: true,
    saving: false,
    dirty: false,
    error: null,
  };
}

export function fileMeta(ref: CodeWorkspaceFileRef, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]) {
  if (ref.kind === "root") {
    const root = roots.find((item) => item.id === ref.rootId);
    const title = basename(ref.path);
    return {
      title,
      path: ref.path,
      subtitle: root ? `${root.name} / ${ref.path}` : ref.path,
      languagePath: ref.path,
    };
  }
  const loose = looseFiles.find((item) => item.id === ref.id);
  const title = loose?.name || pathName(ref.path, "File");
  return {
    title,
    path: ref.path,
    subtitle: ref.path,
    languagePath: ref.path,
  };
}

export function workspaceTitle(workspace: CodeWorkspaceTabInfo, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): string {
  if (workspace.name?.trim()) return workspace.name.trim();
  if (roots.length === 1 && looseFiles.length === 0) return roots[0].name;
  if (roots.length === 0 && looseFiles.length > 0) return "Editor Workspace";
  return "Code Workspace";
}

export function initialFileRef(workspace: CodeWorkspaceTabInfo, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): CodeWorkspaceFileRef | null {
  if (workspace.initialFile) return workspace.initialFile;
  const initialPath = workspace.initialPath?.trim();
  if (initialPath && roots[0]) {
    return { kind: "root", rootId: roots[0].id, path: initialPath };
  }
  return looseFiles[0] ? { kind: "loose", id: looseFiles[0].id, path: looseFiles[0].path } : null;
}
