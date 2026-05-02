import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type FileType =
  | "file"
  | "dir"
  | "symlink"
  | "block"
  | "char"
  | "fifo"
  | "socket"
  | "unknown";

export type FsSide = "local" | "remote";

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
  mode: number;
  fileType: FileType;
  isHidden: boolean;
  symlinkTarget?: string | null;
  owner?: string | null;
  group?: string | null;
}

export interface DriveEntry {
  id: string;
  label: string;
  path: string;
}

export type TransferDirection = "upload" | "download";

export type TransferState =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "error"
  | "cancelled";

export type TransferKind = "file" | "dir";

export interface TransferItem {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  /**
   * Whether the source/dest is a single file or a directory tree. Stored
   * explicitly (rather than inferred from `size`) so retries route to the
   * correct backend command — empty files have `size: 0` too.
   */
  kind: TransferKind;
  localPath: string;
  remotePath: string;
  size: number;
  bytes: number;
  rate: number;
  eta: number;
  state: TransferState;
  error?: string | null;
  startedAt: number;
  finishedAt?: number | null;
  openAfter?: boolean;
}

export interface TransferProgressPayload {
  bytes: number;
  total: number;
  rate: number;
  eta: number;
}

export interface TransferCompletePayload {
  success: boolean;
  error?: string | null;
  finalPath?: string | null;
}

export interface AttachOptions {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
}

export interface AttachResult {
  homeDir: string;
}

export async function sftpAttach(opts: AttachOptions): Promise<AttachResult> {
  return invoke<AttachResult>("sftp_attach", {
    sessionId: opts.sessionId,
    host: opts.host,
    port: opts.port,
    username: opts.username,
    authMethod: opts.authMethod,
    authData: opts.authData,
  });
}

export async function sftpDetach(sessionId: string): Promise<void> {
  return invoke("sftp_detach", { sessionId });
}

export async function sftpListRemote(
  sessionId: string,
  path: string,
): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("sftp_list_remote", { sessionId, path });
}

export async function sftpListLocal(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("sftp_list_local", { path });
}

export async function sftpLocalHome(): Promise<string> {
  return invoke<string>("sftp_local_home", {});
}

export async function sftpLocalDrives(): Promise<DriveEntry[]> {
  return invoke<DriveEntry[]>("sftp_local_drives", {});
}

export async function sftpMkdir(
  sessionId: string,
  path: string,
  side: FsSide,
): Promise<void> {
  return invoke("sftp_mkdir", { sessionId, path, side });
}

export async function sftpRemove(
  sessionId: string,
  path: string,
  side: FsSide,
  recursive: boolean,
): Promise<void> {
  return invoke("sftp_remove", { sessionId, path, side, recursive });
}

export async function sftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string,
  side: FsSide,
): Promise<void> {
  return invoke("sftp_rename", { sessionId, oldPath, newPath, side });
}

export async function sftpStat(
  sessionId: string,
  path: string,
  side: FsSide,
): Promise<FileEntry> {
  return invoke<FileEntry>("sftp_stat", { sessionId, path, side });
}

export async function sftpChmod(
  sessionId: string,
  path: string,
  mode: number,
  side: FsSide,
): Promise<void> {
  return invoke("sftp_chmod", { sessionId, path, mode, side });
}

export async function sftpRealpath(
  sessionId: string,
  path: string,
): Promise<string> {
  return invoke<string>("sftp_realpath", { sessionId, path });
}

export async function sftpUpload(
  sessionId: string,
  transferId: string,
  localPath: string,
  remotePath: string,
  openAfter = false,
): Promise<void> {
  return invoke("sftp_upload", {
    sessionId,
    transferId,
    localPath,
    remotePath,
    openAfter,
  });
}

export async function sftpDownload(
  sessionId: string,
  transferId: string,
  remotePath: string,
  localPath: string,
  openAfter = false,
): Promise<void> {
  return invoke("sftp_download", {
    sessionId,
    transferId,
    remotePath,
    localPath,
    openAfter,
  });
}

export async function sftpUploadDir(
  sessionId: string,
  transferId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return invoke("sftp_upload_dir", {
    sessionId,
    transferId,
    localPath,
    remotePath,
  });
}

export async function sftpDownloadDir(
  sessionId: string,
  transferId: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return invoke("sftp_download_dir", {
    sessionId,
    transferId,
    remotePath,
    localPath,
  });
}

export async function sftpCancelTransfer(transferId: string): Promise<void> {
  return invoke("sftp_cancel_transfer", { transferId });
}

export async function sftpPauseTransfer(transferId: string): Promise<void> {
  return invoke("sftp_pause_transfer", { transferId });
}

export async function sftpResumeTransfer(transferId: string): Promise<void> {
  return invoke("sftp_resume_transfer", { transferId });
}

export async function openSftpWindow(
  sessionId: string,
  title: string,
): Promise<void> {
  return invoke("open_sftp_window", { sessionId, title });
}

export async function sftpOpenPath(path: string): Promise<void> {
  return invoke("sftp_open_path", { path });
}

export async function sftpReadFileText(
  sessionId: string,
  path: string,
  side: FsSide,
  maxBytes = 4 * 1024 * 1024,
): Promise<string> {
  return invoke<string>("sftp_read_file_text", {
    sessionId,
    path,
    side,
    maxBytes,
  });
}

export async function sftpWriteFileText(
  sessionId: string,
  path: string,
  side: FsSide,
  contents: string,
): Promise<void> {
  return invoke("sftp_write_file_text", { sessionId, path, side, contents });
}

export async function sftpUploadBytes(
  sessionId: string,
  transferId: string,
  localName: string,
  remotePath: string,
  bytesB64: string,
): Promise<void> {
  return invoke("sftp_upload_bytes", {
    sessionId,
    transferId,
    localName,
    remotePath,
    bytesB64,
  });
}

export async function sftpDownloadBytes(
  sessionId: string,
  transferId: string,
  remotePath: string,
): Promise<string> {
  return invoke<string>("sftp_download_bytes", {
    sessionId,
    transferId,
    remotePath,
  });
}

export async function listenSftpProgress(
  transferId: string,
  callback: (payload: TransferProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgressPayload>(
    `sftp-progress-${transferId}`,
    (event) => callback(event.payload),
  );
}

export async function listenSftpComplete(
  transferId: string,
  callback: (payload: TransferCompletePayload) => void,
): Promise<UnlistenFn> {
  return listen<TransferCompletePayload>(
    `sftp-transfer-complete-${transferId}`,
    (event) => callback(event.payload),
  );
}

export async function listenSftpPaused(
  transferId: string,
  callback: (payload: TransferProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgressPayload>(
    `sftp-paused-${transferId}`,
    (event) => callback(event.payload),
  );
}

export async function listenSftpAttached(
  sessionId: string,
  callback: (payload: AttachResult) => void,
): Promise<UnlistenFn> {
  return listen<AttachResult>(`sftp-attached-${sessionId}`, (event) =>
    callback(event.payload),
  );
}

export function joinPath(base: string, name: string): string {
  if (!base) return name;
  if (base === "/") return `/${name}`;
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  if (base.match(/^[A-Z]:\\?$/i)) {
    return base.endsWith("\\") ? `${base}${name}` : `${base}\\${name}`;
  }
  return `${base}/${name}`;
}

export function parentPath(path: string): string {
  if (!path || path === "/" || /^[A-Z]:\\?$/i.test(path)) return path || "/";
  const isWindows = path.includes("\\") && /^[A-Z]:/i.test(path);
  const sep = isWindows ? "\\" : "/";
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) {
    if (isWindows) return trimmed.slice(0, 3);
    return "/";
  }
  return trimmed.slice(0, idx) || "/";
}

export function basename(path: string): string {
  if (!path) return "";
  const isWindows = path.includes("\\");
  const sep = isWindows ? "\\" : "/";
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf(sep);
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  if (!bytesPerSec || !isFinite(bytesPerSec)) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatPosixMode(mode: number, fileType: FileType): string {
  const types: Record<FileType, string> = {
    file: "-",
    dir: "d",
    symlink: "l",
    block: "b",
    char: "c",
    fifo: "p",
    socket: "s",
    unknown: "?",
  };
  const triplet = (bits: number) =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return `${types[fileType] ?? "?"}${triplet((mode >> 6) & 7)}${triplet(
    (mode >> 3) & 7,
  )}${triplet(mode & 7)}`;
}
