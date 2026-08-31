import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "./ipc";
import { invokeWithPerformanceObservation } from "./performanceInstrumentation";

export interface GitProbeResult {
  path: string;
  gitAvailable: boolean;
  isRepo: boolean;
  repoRoot: string | null;
  error: string | null;
}

export interface GitSnapshot {
  repoRoot: string;
  currentBranch: string | null;
  headOid: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  remotes: GitRemote[];
  branches: GitBranch[];
  stashes: GitStashEntry[];
  tags: GitTag[];
  settings: GitRepoSettings;
}

export interface GitChange {
  path: string;
  oldPath: string | null;
  status: string;
  staged: boolean;
  unstaged: boolean;
  conflict: boolean;
}

export interface GitBlobPair {
  path: string;
  oldPath: string | null;
  oldText: string | null;
  newText: string | null;
  oldExists: boolean;
  newExists: boolean;
  binary: boolean;
  image: boolean;
  oldImageB64: string | null;
  newImageB64: string | null;
  oversize: boolean;
  oldSize: number;
  newSize: number;
}

export interface GitBlameLine {
  line: number;
  commit: string;
  author: string;
  authorMail: string | null;
  authorTime: number;
  summary: string;
}

export interface GitIgnoreResult {
  rule: string;
  gitignorePath: string;
  added: boolean;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string | null;
  username: string | null;
  tokenRef: string | null;
}

export interface GitRepoSettings {
  userName: string | null;
  userEmail: string | null;
  httpProxy: string | null;
  httpsProxy: string | null;
  pullRebase: string | null;
  pushDefault: string | null;
  coreAutocrlf: string | null;
  coreFilemode: string | null;
  commitGpgsign: string | null;
}

export interface GitBranch {
  name: string;
  fullName: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  oid: string | null;
  subject: string | null;
  /** Tip committer date (iso-strict), used for sort / recent UI. */
  date?: string | null;
}

export interface GitLogEntry {
  oid: string;
  shortOid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  refs: string[];
}

export interface GitLogFilter {
  limit?: number | null;
  skip?: number | null;
  author?: string | null;
  grep?: string | null;
  path?: string | null;
  all?: boolean | null;
  after?: string | null;
  before?: string | null;
  branch?: string | null;
}

export interface GitStashEntry {
  selector: string;
  oid: string;
  date: string;
  message: string;
}

export interface GitTag {
  name: string;
  oid: string;
  subject: string | null;
  annotated: boolean;
  /** Creator/tagger date (iso-strict), used for sort / recent UI. */
  date?: string | null;
}

export type GitOperationKind = "merge" | "cherryPick" | "revert" | "rebase" | "none";

export interface GitOperationState {
  kind: GitOperationKind;
  conflictedPaths: string[];
}

export type GitResetMode = "soft" | "mixed" | "hard";

export interface GitRemoteAuthResult {
  username: string | null;
  tokenRef: string | null;
}

export function gitProbePath(path: string): Promise<GitProbeResult> {
  return invoke<GitProbeResult>("git_probe_path", { path });
}

export function gitInitRepo(path: string): Promise<GitProbeResult> {
  return invoke<GitProbeResult>("git_init_repo", { path });
}

export function gitSnapshot(repoRoot: string): Promise<GitSnapshot> {
  return invoke<GitSnapshot>("git_snapshot", { repoRoot });
}

export function gitDiff(
  repoRoot: string,
  path?: string | null,
  staged = false,
  commit?: string | null,
): Promise<string> {
  return invoke<string>("git_diff", { repoRoot, path: path ?? null, staged, commit: commit ?? null });
}

// Ref tokens for gitBlobPair: ":WORKTREE" (file on disk), ":INDEX" (staged blob),
// "" (side does not exist), or any revision (HEAD, a branch, a commit hash).
export const GIT_REF_WORKTREE = ":WORKTREE";
export const GIT_REF_INDEX = ":INDEX";

export function gitBlobPair(
  repoRoot: string,
  path: string,
  oldRef: string,
  newRef: string,
  oldPath?: string | null,
): Promise<GitBlobPair> {
  const args = {
    repoRoot,
    path,
    oldPath: oldPath ?? null,
    oldRef,
    newRef,
  };
  return invokeWithPerformanceObservation(
    "git_blob_pair",
    args,
    () => invoke<GitBlobPair>("git_blob_pair", args),
  );
}

export function gitBlameLines(
  repoRoot: string,
  path: string,
  startLine: number,
  endLine: number,
): Promise<GitBlameLine[]> {
  return invoke<GitBlameLine[]>("git_blame_lines", { repoRoot, path, startLine, endLine });
}

export function gitStage(repoRoot: string, paths: string[]): Promise<void> {
  return invoke("git_stage", { repoRoot, paths });
}

export function gitUnstage(repoRoot: string, paths: string[]): Promise<void> {
  return invoke("git_unstage", { repoRoot, paths });
}

export function gitDiscard(repoRoot: string, paths: string[]): Promise<void> {
  return invoke("git_discard", { repoRoot, paths });
}

export function gitCleanUntracked(repoRoot: string, paths: string[]): Promise<void> {
  return invoke("git_clean_untracked", { repoRoot, paths });
}

export function gitIgnorePath(
  repoRoot: string,
  path: string,
  directory = false,
): Promise<GitIgnoreResult> {
  return invoke<GitIgnoreResult>("git_ignore_path", { repoRoot, path, directory });
}

export function gitCommit(
  repoRoot: string,
  message: string,
  amend = false,
  paths?: string[] | null,
): Promise<void> {
  return invoke("git_commit", { repoRoot, message, amend, paths: paths ?? null });
}

export function gitFetch(repoRoot: string, remote?: string | null): Promise<void> {
  return withVaultLockedNotice(() => invoke("git_fetch", { repoRoot, remote: remote ?? null }));
}

export function gitPull(
  repoRoot: string,
  remote?: string | null,
  branch?: string | null,
  rebase = false,
): Promise<void> {
  return withVaultLockedNotice(() =>
    invoke("git_pull", { repoRoot, remote: remote ?? null, branch: branch ?? null, rebase }),
  );
}

export function gitPush(
  repoRoot: string,
  remote?: string | null,
  branch?: string | null,
  setUpstream = false,
  forceWithLease = false,
): Promise<void> {
  return withVaultLockedNotice(() =>
    invoke("git_push", {
      repoRoot,
      remote: remote ?? null,
      branch: branch ?? null,
      setUpstream,
      forceWithLease,
    }),
  );
}

export function gitCheckoutBranch(repoRoot: string, branch: string): Promise<void> {
  return invoke("git_checkout_branch", { repoRoot, branch });
}

export function gitCreateBranch(
  repoRoot: string,
  branch: string,
  startPoint?: string | null,
  checkout = true,
): Promise<void> {
  return invoke("git_create_branch", { repoRoot, branch, startPoint: startPoint ?? null, checkout });
}

export function gitDeleteBranch(repoRoot: string, branch: string, force = false): Promise<void> {
  return invoke("git_delete_branch", { repoRoot, branch, force });
}

export function gitMergeBranch(repoRoot: string, branch: string): Promise<void> {
  return invoke("git_merge_branch", { repoRoot, branch });
}

export function gitRenameBranch(repoRoot: string, branch: string, newName: string): Promise<void> {
  return invoke("git_rename_branch", { repoRoot, branch, newName });
}

export function gitSetUpstream(
  repoRoot: string,
  branch: string,
  upstream?: string | null,
): Promise<void> {
  return invoke("git_set_upstream", { repoRoot, branch, upstream: upstream ?? null });
}

export function gitCreateTag(
  repoRoot: string,
  name: string,
  target?: string | null,
  message?: string | null,
): Promise<void> {
  return invoke("git_create_tag", { repoRoot, name, target: target ?? null, message: message ?? null });
}

export function gitDeleteTag(repoRoot: string, name: string): Promise<void> {
  return invoke("git_delete_tag", { repoRoot, name });
}

export function gitPushTag(
  repoRoot: string,
  remote: string | null,
  name: string,
  del = false,
): Promise<void> {
  return withVaultLockedNotice(() =>
    invoke("git_push_tag", { repoRoot, remote: remote ?? null, name, delete: del }),
  );
}

export function gitCheckoutTag(repoRoot: string, name: string): Promise<void> {
  return invoke("git_checkout_tag", { repoRoot, name });
}

export function gitLog(repoRoot: string, limit = 120, filter?: GitLogFilter): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>("git_log", { repoRoot, limit, filter: filter ?? null });
}

export function gitCommitFiles(repoRoot: string, oid: string): Promise<GitChange[]> {
  return invoke<GitChange[]>("git_commit_files", { repoRoot, oid });
}

export function gitCompare(repoRoot: string, refA: string, refB: string): Promise<GitChange[]> {
  return invoke<GitChange[]>("git_compare", { repoRoot, refA, refB });
}

export function gitReset(repoRoot: string, target: string, mode: GitResetMode): Promise<void> {
  return invoke("git_reset", { repoRoot, target, mode });
}

export function gitRevert(repoRoot: string, commit: string): Promise<void> {
  return invoke("git_revert", { repoRoot, commit });
}

export function gitCherryPick(repoRoot: string, commit: string): Promise<void> {
  return invoke("git_cherry_pick", { repoRoot, commit });
}

export function gitCherryPickContinue(repoRoot: string): Promise<void> {
  return invoke("git_cherry_pick_continue", { repoRoot });
}

export function gitCherryPickAbort(repoRoot: string): Promise<void> {
  return invoke("git_cherry_pick_abort", { repoRoot });
}

export function gitOperationState(repoRoot: string): Promise<GitOperationState> {
  return invoke<GitOperationState>("git_operation_state", { repoRoot });
}

export function gitOperationContinue(repoRoot: string, kind: GitOperationKind): Promise<void> {
  return invoke("git_operation_continue", { repoRoot, kind });
}

export function gitOperationAbort(repoRoot: string, kind: GitOperationKind): Promise<void> {
  return invoke("git_operation_abort", { repoRoot, kind });
}

export function gitRebase(repoRoot: string, onto: string): Promise<void> {
  return invoke("git_rebase", { repoRoot, onto });
}

export function gitRebaseSkip(repoRoot: string): Promise<void> {
  return invoke("git_rebase_skip", { repoRoot });
}

export function gitResolveConflict(
  repoRoot: string,
  path: string,
  side: "ours" | "theirs",
): Promise<void> {
  return invoke("git_resolve_conflict", { repoRoot, path, side });
}

export function gitStashSave(
  repoRoot: string,
  message?: string | null,
  includeUntracked = false,
): Promise<void> {
  return invoke("git_stash_save", { repoRoot, message: message ?? null, includeUntracked });
}

export function gitStashList(repoRoot: string): Promise<GitStashEntry[]> {
  return invoke<GitStashEntry[]>("git_stash_list", { repoRoot });
}

export function gitStashShow(repoRoot: string, selector: string): Promise<string> {
  return invoke<string>("git_stash_show", { repoRoot, selector });
}

export function gitStashApply(repoRoot: string, selector: string, pop = false): Promise<void> {
  return invoke("git_stash_apply", { repoRoot, selector, pop });
}

export function gitStashDrop(repoRoot: string, selector: string): Promise<void> {
  return invoke("git_stash_drop", { repoRoot, selector });
}

export function gitSetRemote(
  repoRoot: string,
  name: string,
  fetchUrl: string,
  pushUrl?: string | null,
): Promise<void> {
  return invoke("git_set_remote", { repoRoot, name, fetchUrl, pushUrl: pushUrl ?? null });
}

export function gitDeleteRemote(repoRoot: string, name: string): Promise<void> {
  return invoke("git_delete_remote", { repoRoot, name });
}

export function gitSaveSettings(repoRoot: string, settings: GitRepoSettings): Promise<void> {
  return invoke("git_save_settings", { repoRoot, settings });
}

export function gitSaveRemoteAuth(
  repoRoot: string,
  remote: string,
  username?: string | null,
  token?: string | null,
  clearToken = false,
): Promise<GitRemoteAuthResult> {
  return withVaultLockedNotice(() =>
    invoke<GitRemoteAuthResult>("git_save_remote_auth", {
      repoRoot,
      remote,
      username: username ?? null,
      token: token ?? null,
      clearToken,
    }),
  );
}

export function gitRepoName(repoRoot: string): string {
  const trimmed = repoRoot.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed || "repository";
}

export function gitChangeLabel(change: GitChange): string {
  if (change.conflict) return "Conflicted";
  return change.status[0]?.toUpperCase() + change.status.slice(1);
}

export function selectedRemote(snapshot: GitSnapshot | null): GitRemote | null {
  if (!snapshot || snapshot.remotes.length === 0) return null;
  const upstreamRemote = snapshot.upstream?.split("/")[0];
  return snapshot.remotes.find((remote) => remote.name === upstreamRemote) ?? snapshot.remotes[0];
}
