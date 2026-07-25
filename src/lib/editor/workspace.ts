import { invoke } from "@tauri-apps/api/core";

export type WorkspaceEntryType = "file" | "dir" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  fileType: WorkspaceEntryType;
  size: number;
  mtime: number;
  isHidden: boolean;
}

export interface WorkspaceFile {
  path: string;
  text: string;
  size: number;
  mtime: number;
  hash: string;
}

export interface WorkspaceCompactChain {
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceGitRootCandidate {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceGitRoot {
  id: string;
  name: string;
  path: string;
  repoRoot: string;
  rootIds: string[];
  isSubmodule?: boolean;
}

export interface WorkspaceTask {
  id: string;
  label: string;
  command: string;
  cwd: string;
  source: string;
}

export function workspaceListDir(
  repoRoot: string,
  path = "",
): Promise<WorkspaceEntry[]> {
  return invoke<WorkspaceEntry[]>("workspace_list_dir", { repoRoot, path });
}

export function workspaceCompactChain(
  repoRoot: string,
  path: string,
  maxDepth?: number,
): Promise<WorkspaceCompactChain> {
  return invoke<WorkspaceCompactChain>("workspace_compact_chain", {
    repoRoot,
    path,
    maxDepth: maxDepth ?? null,
  });
}

export function workspaceListFilesRecursive(
  repoRoot: string,
  path = "",
  maxDepth?: number,
  maxFiles?: number,
): Promise<WorkspaceEntry[]> {
  return invoke<WorkspaceEntry[]>("workspace_list_files_recursive", {
    repoRoot,
    path,
    maxDepth: maxDepth ?? null,
    maxFiles: maxFiles ?? null,
  });
}

export function workspaceDetectGitRoots(
  roots: WorkspaceGitRootCandidate[],
): Promise<WorkspaceGitRoot[]> {
  return invoke<WorkspaceGitRoot[]>("workspace_detect_git_roots", { roots });
}

export function workspaceDetectTasks(repoRoot: string): Promise<WorkspaceTask[]> {
  return invoke<WorkspaceTask[]>("workspace_detect_tasks", { repoRoot });
}

/** A source-grouped bucket of tasks for the Build panel task tree (M7 F-2). */
export interface WorkspaceTaskGroup {
  source: string;
  tasks: WorkspaceTask[];
}

/**
 * Grouped task tree: Maven/Gradle carry their full lifecycle / common tasks;
 * other ecosystems group their detected tasks by source. Pure/offline (no build
 * tool is spawned).
 */
export function workspaceTaskTree(repoRoot: string): Promise<WorkspaceTaskGroup[]> {
  return invoke<WorkspaceTaskGroup[]>("workspace_task_tree", { repoRoot });
}

export function workspaceReadFile(
  repoRoot: string,
  path: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_read_file", {
    repoRoot,
    path,
    maxBytes: maxBytes ?? null,
  });
}

export function workspaceReadLooseFile(
  path: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_read_loose_file", {
    path,
    maxBytes: maxBytes ?? null,
  });
}

export function workspaceWriteFile(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_write_file", {
    repoRoot,
    path,
    contents,
    expectedHash: expectedHash ?? null,
  });
}

export function workspaceWriteLooseFile(
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_write_loose_file", {
    path,
    contents,
    expectedHash: expectedHash ?? null,
  });
}

export function workspaceCreateFile(
  repoRoot: string,
  path: string,
  contents = "",
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_create_file", {
    repoRoot,
    path,
    contents,
  });
}

export function workspaceCreateDir(
  repoRoot: string,
  path: string,
): Promise<WorkspaceEntry> {
  return invoke<WorkspaceEntry>("workspace_create_dir", { repoRoot, path });
}

export function workspaceDeletePath(
  repoRoot: string,
  path: string,
  recursive = false,
): Promise<void> {
  return invoke<void>("workspace_delete_path", { repoRoot, path, recursive });
}

export function workspaceRenamePath(
  repoRoot: string,
  fromPath: string,
  toPath: string,
): Promise<WorkspaceEntry> {
  return invoke<WorkspaceEntry>("workspace_rename_path", {
    repoRoot,
    fromPath,
    toPath,
  });
}
