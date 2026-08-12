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
  /** Backend-decoded text encoding; older browser fixtures may omit it. */
  encoding?: string;
  /** Whether the on-disk UTF-8 bytes begin with EF BB BF. */
  bom?: boolean;
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
  /** Structured executable/argv contract. Optional for older browser fixtures and persisted mocks. */
  execution?: WorkspaceTaskExecution;
  environment?: WorkspaceTaskEnvironment;
}

/**
 * Optional per-workspace build-tool executable overrides passed to the task
 * detectors. Empty/omitted entries fall back to project wrapper then PATH.
 */
export interface WorkspaceToolConfig {
  maven?: string;
  gradle?: string;
  cargo?: string;
  go?: string;
  node?: string;
  npm?: string;
  pnpm?: string;
  yarn?: string;
  python?: string;
  uv?: string;
  poetry?: string;
  cmake?: string;
  dotnet?: string;
  sbt?: string;
  swift?: string;
  lldbDap?: string;
  delve?: string;
  debugpy?: string;
  jsDebug?: string;
  netcoredbg?: string;
  /** Explicit JVM options applied to Maven `exec:java` through MAVEN_OPTS. */
  mavenJvmArgs?: string[];
  /** Auto-inherit safe runtime options from Maven test plugin `argLine`. */
  inheritMavenArgLine?: boolean;
}

export interface ExecutionCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  display: string;
  source: "wrapper" | "configured" | "path";
  error?: string;
}

export interface ExecutionToolProbe {
  id: string;
  label: string;
  state: "available" | "missing";
  executable?: string;
  source?: "wrapper" | "configured" | "path";
  installHint: string;
}

export interface ExecutionProjectModel {
  id: string;
  provider: string;
  root: string;
  manifest: string;
  module: string;
  languages: string[];
  toolchain: string;
  diagnostics: string[];
}

export interface ExecutionBuildTarget {
  id: string;
  projectId: string;
  label: string;
  kind: "configure" | "restore" | "build" | "clean" | "check" | "test";
  command: ExecutionCommand;
  dependsOn: string[];
}

export interface ExecutionRunConfiguration {
  id: string;
  projectId: string;
  label: string;
  kind: string;
  command: ExecutionCommand;
  sourceFile?: string;
  preLaunchTargets: string[];
  debugConfigurationId?: string;
  /** User-configured VM/runtime options layered over the detected target. */
  runtimeOptions?: string[];
  /** Optional dotenv file loaded immediately before launch. */
  envFile?: string;
  /** Original detected configuration for a persisted named copy. */
  baseConfigurationId?: string;
  /** Provider-specific placement for user program arguments. */
  argumentStrategy?: "append" | "maven-exec" | "gradle-javaexec";
  /** Preserve append semantics for inherited task-scoped environment values. */
  environmentModes?: Record<string, "append" | "replace">;
}

export interface ExecutionDebugConfiguration {
  id: string;
  projectId: string;
  label: string;
  adapterId: string;
  request: "launch" | "attach";
  available: boolean;
  diagnostic?: string;
  preLaunchTargets: string[];
  sourceFile?: string;
  launchConfig: Record<string, unknown>;
  /** Optional dotenv file inherited from the associated run configuration. */
  envFile?: string;
}

export interface WorkspaceExecutionModel {
  projects: ExecutionProjectModel[];
  buildTargets: ExecutionBuildTarget[];
  runConfigurations: ExecutionRunConfiguration[];
  debugConfigurations: ExecutionDebugConfiguration[];
  tools: ExecutionToolProbe[];
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

/** Discover structured projects and first-class Build/Run/Debug capabilities. */
export function workspaceExecutionModel(
  repoRoot: string,
  activeFile?: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<WorkspaceExecutionModel> {
  return invoke<WorkspaceExecutionModel>("workspace_execution_model", {
    repoRoot,
    activeFile: activeFile ?? null,
    toolConfig: toolConfig ?? null,
  });
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

/** Read a workspace file using an explicit charset selected in the editor. */
export function workspaceReadFileWithEncoding(
  repoRoot: string,
  path: string,
  encoding: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_read_file_with_encoding", {
    repoRoot,
    path,
    maxBytes: maxBytes ?? null,
    encoding,
  });
}

/** Read a loose file using an explicit charset selected in the editor. */
export function workspaceReadLooseFileWithEncoding(
  path: string,
  encoding: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_read_loose_file_with_encoding", {
    path,
    maxBytes: maxBytes ?? null,
    encoding,
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

/** Persist a workspace file using an explicit charset and BOM preference. */
export function workspaceWriteFileEncoded(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash: string | null | undefined,
  encoding: string,
  bom = false,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_write_file_encoded", {
    repoRoot,
    path,
    contents,
    expectedHash: expectedHash ?? null,
    encoding,
    bom,
  });
}

/** Persist a loose file using an explicit charset and BOM preference. */
export function workspaceWriteLooseFileEncoded(
  path: string,
  contents: string,
  expectedHash: string | null | undefined,
  encoding: string,
  bom = false,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_write_loose_file_encoded", {
    path,
    contents,
    expectedHash: expectedHash ?? null,
    encoding,
    bom,
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

export type WorkspaceResourceOperation =
  | {
    kind: "create";
    path: string;
    overwrite: boolean;
    ignoreIfExists: boolean;
  }
  | {
    kind: "rename";
    fromPath: string;
    toPath: string;
    /** Destination workspace root; omitted for a rename within repoRoot. */
    toRepoRoot?: string;
    overwrite: boolean;
    ignoreIfExists: boolean;
  }
  | {
    kind: "delete";
    path: string;
    recursive: boolean;
    ignoreIfNotExists: boolean;
  };

export interface WorkspaceResourceOperationResult {
  ignored: boolean;
}

export function workspaceApplyResourceOperation(
  repoRoot: string,
  operation: WorkspaceResourceOperation,
): Promise<WorkspaceResourceOperationResult> {
  return invoke<WorkspaceResourceOperationResult>("workspace_apply_resource_operation", {
    repoRoot,
    operation,
  });
}
