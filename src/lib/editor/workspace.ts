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

export type StructuredTestResultStatus = "passed" | "failed" | "skipped" | "error" | "unknown";

export interface StructuredTestResult {
  id: string;
  /** Provider-native class/method selector used for a rerun. */
  selector: string;
  name: string;
  className: string;
  status: StructuredTestResultStatus;
  durationMs: number | null;
  message: string | null;
  details: string | null;
  /** Optional source path supplied by the test provider (not the report path). */
  filePath: string | null;
  line: number | null;
}

export interface StructuredTestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface StructuredTestResults {
  schema: string;
  version: number;
  source: string;
  generatedAt: number;
  results: StructuredTestResult[];
  summary: StructuredTestSummary;
  diagnostics: string[];
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
  /** Stable module identity. Optional only for persisted/browser fixtures from before v4.23. */
  moduleId?: string;
  languages: string[];
  languageLevel?: string;
  toolchain: string;
  diagnostics: string[];
}

export interface ExecutionModuleModel {
  id: string;
  projectId: string;
  name: string;
  root: string;
  manifest: string;
  languageLevel?: string;
  sourceSetIds: string[];
  parentModuleId?: string;
  childModuleIds?: string[];
  moduleDependencies?: string[];
  diagnostics: string[];
}

export interface ExecutionSourceSetModel {
  id: string;
  projectId: string;
  moduleId: string;
  name: string;
  kind: "production" | "test" | "generated" | string;
  roots: string[];
  generated: boolean;
  languageLevel?: string;
}

export interface ExecutionCompileArtifact {
  id: string;
  projectId: string;
  moduleId: string;
  targetId: string;
  kind: string;
  path?: string;
  resolution: "blocked" | "pending-provider-output" | "resolved" | string;
  source: string;
  diagnostic?: string;
}

export interface ExecutionBuildTarget {
  id: string;
  projectId: string;
  /** Stable module identity. Optional only for persisted/browser fixtures from before v4.23. */
  moduleId?: string;
  label: string;
  kind: "configure" | "restore" | "build" | "clean" | "check" | "test";
  command: ExecutionCommand;
  dependsOn: string[];
  /** Declared compile artifacts produced by this target. */
  artifactIds?: string[];
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
  /** Provider-discovered, repository-shared, or local configuration origin. */
  configurationSource?: "provider" | "shared" | "local";
  /** Child configuration ids for an IntelliJ-style compound launch. */
  compoundConfigurationIds?: string[];
  /** Run child configurations concurrently when true. */
  compoundParallel?: boolean;
  /** Stop launching subsequent children after the first failure. */
  compoundStopOnFailure?: boolean;
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
  /** Provider-discovered, repository-shared, or local configuration origin. */
  configurationSource?: "provider" | "shared" | "local";
  /** Child debug configuration ids for a compound debug chooser entry. */
  compoundConfigurationIds?: string[];
  compoundParallel?: boolean;
  compoundStopOnFailure?: boolean;
}

export interface WorkspaceExecutionModel {
  projects: ExecutionProjectModel[];
  /** Native execution-model topology; optional for older browser stubs. */
  modules?: ExecutionModuleModel[];
  sourceSets?: ExecutionSourceSetModel[];
  buildTargets: ExecutionBuildTarget[];
  compileArtifacts?: ExecutionCompileArtifact[];
  runConfigurations: ExecutionRunConfiguration[];
  debugConfigurations: ExecutionDebugConfiguration[];
  tools: ExecutionToolProbe[];
  /** Non-fatal provider or repository-shared configuration validation errors. */
  diagnostics?: string[];
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

/** Read bounded JUnit-style results produced below a workspace root. */
export function workspaceTestResults(repoRoot: string, notBeforeMs?: number): Promise<StructuredTestResults> {
  return invoke<StructuredTestResults>("workspace_test_results", {
    repoRoot,
    notBeforeMs: notBeforeMs ?? null,
  });
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

export type WorkspaceWriteErrorKind = "hash-mismatch" | "encoding" | "permission" | "io";

export interface WorkspaceWriteErrorData {
  kind: WorkspaceWriteErrorKind;
  message: string;
  expectedHash?: string;
  actualHash?: string;
}

export class WorkspaceWriteError extends Error implements WorkspaceWriteErrorData {
  readonly kind: WorkspaceWriteErrorKind;
  readonly expectedHash?: string;
  readonly actualHash?: string;

  constructor(
    kind: WorkspaceWriteErrorKind,
    message: string,
    expectedHash?: string,
    actualHash?: string,
  ) {
    super(message);
    this.name = "WorkspaceWriteError";
    this.kind = kind;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
    Object.setPrototypeOf(this, WorkspaceWriteError.prototype);
  }
}

export class WorkspaceHashMismatchError extends WorkspaceWriteError {
  readonly expected: string;
  readonly actual: string;

  constructor(message: string, expected = "", actual = "") {
    super("hash-mismatch", message, expected, actual);
    this.name = "WorkspaceHashMismatchError";
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, WorkspaceHashMismatchError.prototype);
  }
}

export function isWorkspaceHashMismatchError(err: unknown): boolean {
  if (err instanceof WorkspaceHashMismatchError) return true;
  if (err instanceof WorkspaceWriteError && err.kind === "hash-mismatch") return true;
  if (typeof err === "object" && err !== null && (err as { kind?: string }).kind === "hash-mismatch") return true;
  if (err instanceof Error && err.message.startsWith("hash-mismatch:")) return true;
  return false;
}

export function parseWorkspaceWriteError(err: unknown): WorkspaceWriteError {
  if (err instanceof WorkspaceWriteError) return err;
  const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err));
  const match = msg.match(/expected hash\s+([^\s,;]+)[,\s]+found\s+([^\s,;]+)/i);
  
  if (isWorkspaceHashMismatchError(err)) {
    if (err instanceof WorkspaceHashMismatchError) return err;
    const exp = (err as { expectedHash?: string; expected?: string })?.expectedHash ?? (err as { expected?: string })?.expected ?? match?.[1];
    const act = (err as { actualHash?: string; actual?: string })?.actualHash ?? (err as { actual?: string })?.actual ?? match?.[2];
    return new WorkspaceHashMismatchError(msg, exp ?? "", act ?? "");
  }
  if (typeof err === "object" && err !== null) {
    const raw = err as Record<string, unknown>;
    const kind = typeof raw.kind === "string" ? raw.kind : undefined;
    const message = typeof raw.message === "string" ? raw.message : msg;
    if (kind === "hash-mismatch" || kind === "encoding" || kind === "permission" || kind === "io") {
      if (kind === "hash-mismatch") {
        return new WorkspaceHashMismatchError(message, String(raw.expectedHash ?? match?.[1] ?? ""), String(raw.actualHash ?? match?.[2] ?? ""));
      }
      return new WorkspaceWriteError(kind, message);
    }
  }
  if (msg.startsWith("hash-mismatch:")) {
    return new WorkspaceHashMismatchError(msg, match?.[1] ?? "", match?.[2] ?? "");
  }
  if (msg.includes("not representable") || msg.includes("encoding")) {
    return new WorkspaceWriteError("encoding", msg);
  }
  if (msg.includes("permission denied") || msg.includes("PermissionDenied")) {
    return new WorkspaceWriteError("permission", msg);
  }
  return new WorkspaceWriteError("io", msg);
}

export async function workspaceWriteFile(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  try {
    return await invoke<WorkspaceFile>("workspace_write_file", {
      repoRoot,
      path,
      contents,
      expectedHash: expectedHash ?? null,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}

export async function workspaceWriteLooseFile(
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  try {
    return await invoke<WorkspaceFile>("workspace_write_loose_file", {
      path,
      contents,
      expectedHash: expectedHash ?? null,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}

/** Persist a workspace file using an explicit charset and BOM preference. */
export async function workspaceWriteFileEncoded(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash: string | null | undefined,
  encoding: string,
  bom = false,
): Promise<WorkspaceFile> {
  try {
    return await invoke<WorkspaceFile>("workspace_write_file_encoded", {
      repoRoot,
      path,
      contents,
      expectedHash: expectedHash ?? null,
      encoding,
      bom,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}

/** Persist a loose file using an explicit charset and BOM preference. */
export async function workspaceWriteLooseFileEncoded(
  path: string,
  contents: string,
  expectedHash: string | null | undefined,
  encoding: string,
  bom = false,
): Promise<WorkspaceFile> {
  try {
    return await invoke<WorkspaceFile>("workspace_write_loose_file_encoded", {
      path,
      contents,
      expectedHash: expectedHash ?? null,
      encoding,
      bom,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
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
