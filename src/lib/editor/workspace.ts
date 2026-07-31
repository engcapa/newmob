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

/**
 * Structured execution for a Maven/Gradle task: the resolved absolute executable,
 * its arguments, how it was resolved (wrapper/configured/path), and a diagnostic
 * when the tool could not be resolved. Present only for build-tool tasks.
 */
export interface WorkspaceTaskExecution {
  executable: string;
  args: string[];
  source: "wrapper" | "configured" | "path";
  error?: string;
}

/** A temporary environment variable applied only while a workspace task runs. */
export interface WorkspaceTaskEnvironmentVariable {
  value: string;
  mode: "append" | "replace";
}

export type WorkspaceTaskEnvironment = Record<string, WorkspaceTaskEnvironmentVariable>;

export interface WorkspaceTask {
  id: string;
  label: string;
  command: string;
  cwd: string;
  source: string;
  /** Workspace-relative Maven/Gradle module directory when applicable. */
  modulePath?: string;
  execution?: WorkspaceTaskExecution;
  environment?: WorkspaceTaskEnvironment;
}

/** A Java `static void main` entry point with a ready-to-run terminal command. */
export interface JavaRunTarget {
  id: string;
  label: string;
  mainClass: string;
  filePath: string;
  command: string;
  cwd: string;
  buildSystem: "maven" | "gradle" | "source-file";
  modulePath: string;
  execution: WorkspaceTaskExecution;
  environment?: WorkspaceTaskEnvironment;
}

/**
 * Optional per-workspace build-tool executable overrides passed to the task
 * detectors. Empty/omitted entries fall back to project wrapper then PATH.
 */
export interface WorkspaceToolConfig {
  maven?: string;
  gradle?: string;
  /** Explicit JVM options applied to Maven `exec:java` through MAVEN_OPTS. */
  mavenJvmArgs?: string[];
  /** Auto-inherit safe runtime options from Maven test plugin `argLine`. */
  inheritMavenArgLine?: boolean;
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

export function workspaceDetectTasks(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<WorkspaceTask[]> {
  return invoke<WorkspaceTask[]>("workspace_detect_tasks", { repoRoot, toolConfig: toolConfig ?? null });
}

/** Discover runnable Java main classes without requiring the java-debug bundle. */
export function workspaceJavaRunTargets(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<JavaRunTarget[]> {
  return invoke<JavaRunTarget[]>("workspace_java_run_targets", { repoRoot, toolConfig: toolConfig ?? null });
}

/** Resolve the Java main class declared in one workspace-relative source file. */
export function workspaceJavaRunTarget(
  repoRoot: string,
  filePath: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<JavaRunTarget> {
  return invoke<JavaRunTarget>("workspace_java_run_target", {
    repoRoot,
    filePath,
    toolConfig: toolConfig ?? null,
  });
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
export function workspaceTaskTree(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<WorkspaceTaskGroup[]> {
  return invoke<WorkspaceTaskGroup[]>("workspace_task_tree", { repoRoot, toolConfig: toolConfig ?? null });
}

/** A resolved dependency-tree node (Maven / Gradle) for the Build panel (M7 F-1). */
export interface DependencyNode {
  group: string;
  artifact: string;
  version: string;
  scope: string;
  /** Version-arbitration note (Gradle `-> x`, Maven verbose conflict), when any. */
  conflict: string | null;
  children: DependencyNode[];
}

/**
 * Resolve the project dependency tree by spawning the build tool
 * (`mvn dependency:tree` / `gradle dependencies`). Slow on a cold cache; requires
 * the tool (or wrapper) present. Rejects for non-Maven/Gradle projects.
 */
export function workspaceDependencyTree(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<DependencyNode[]> {
  return invoke<DependencyNode[]>("workspace_dependency_tree", { repoRoot, toolConfig: toolConfig ?? null });
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
