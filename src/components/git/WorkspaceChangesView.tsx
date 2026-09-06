import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
} from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { type GitBlobPair, type GitChange, type GitSnapshot } from "../../lib/git";
import { useT, type TranslateFn } from "../../lib/i18n";
import type { GitWorkspaceRootInfo } from "../../types";
import { ChangesTree } from "./ChangesTree";
import { CommitBar } from "./shared/CommitBar";
import {
  ChangesListToolbar,
  emptyGitChangeFilters,
  gitChangeMatchesFilters,
  hasActiveGitChangeFilters,
  type GitChangeFilters,
  type GitStageFilter,
  type GitStatusFilter,
} from "./shared/ChangesListToolbar";
import { DiffPane } from "./shared/DiffPane";
import { parseWorkspaceChangeKey, workspaceChangeKey } from "./workspaceGitKeys";
import {
  buildWorkspaceFlatGroups,
  changeFileName,
  changePathDirectory,
} from "../../lib/workspaceGitFlatList";

type TriState = "all" | "none" | "some";

export interface WorkspaceChangesViewProps {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, {
    snapshot: GitSnapshot | null;
    loading: boolean;
    error: string | null;
  }>;
  busy: boolean;
  treeMode: boolean;
  setTreeMode: (value: boolean) => void;
  checkedKeys: Set<string>;
  checkedCount: number;
  checkedRepoCount: number;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  canCommitAndPush: boolean;
  scopeSummary: string;
  targetBranch?: string;
  setTargetBranch?: (branch: string) => void;
  branchOptions?: string[];
  branchPlaceholder?: string;
  stageVisible: (pathsByRepo: Record<string, string[]>) => void;
  unstageVisible: (pathsByRepo: Record<string, string[]>) => void;
  stagePaths: (repoRoot: string, paths: string[]) => void;
  unstagePaths: (repoRoot: string, paths: string[]) => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  commit: () => void;
  commitAndPush: () => void;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
  onNormalizeLineEndings?: () => void;
  normalizeLineEndingsBusy?: boolean;
  onOpenInEditor?: () => void;
  onSaveWorktree?: (text: string) => Promise<void> | void;
  worktreeEditable?: boolean;
}

export function WorkspaceChangesView({
  roots,
  snapshots,
  busy,
  treeMode,
  setTreeMode,
  checkedKeys,
  checkedCount,
  checkedRepoCount,
  selectedKeys,
  focusedKey,
  pair,
  pairLoading,
  commitMessage,
  setCommitMessage,
  canCommitAndPush,
  scopeSummary,
  targetBranch,
  setTargetBranch,
  branchOptions,
  branchPlaceholder,
  stageVisible,
  unstageVisible,
  stagePaths,
  unstagePaths,
  stageSelected,
  unstageSelected,
  discardSelected,
  commit,
  commitAndPush,
  onToggleChecked,
  onSelect,
  onContextMenu,
  onNormalizeLineEndings,
  normalizeLineEndingsBusy,
  onOpenInEditor,
  onSaveWorktree,
  worktreeEditable,
}: WorkspaceChangesViewProps) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const [changeFilters, setChangeFilters] = useState<GitChangeFilters>(() => emptyGitChangeFilters());
  const normalizedFilter = filter.trim().toLowerCase();
  const groups = roots.map((root) => {
    const state = snapshots[root.repoRoot];
    const snapshot = state?.snapshot ?? null;
    return {
      root,
      state,
      snapshot,
      visibleChanges: (snapshot?.changes ?? []).filter((change) => {
        return gitChangeMatchesFilters(change, changeFilters)
          && workspaceChangeMatchesSearch(root, change, normalizedFilter);
      }),
    };
  });
  const totalChanges = groups.reduce((total, group) => total + (group.snapshot?.changes.length ?? 0), 0);
  const visibleChangeCount = groups.reduce((total, group) => total + group.visibleChanges.length, 0);
  const visibleStagedChangeCount = groups.reduce(
    (total, group) => total + group.visibleChanges.filter((change) => change.staged).length,
    0,
  );
  const visiblePathsByRepo = useMemo(() => pathsByRepoFromGroups(groups), [groups]);
  const visibleStagedPathsByRepo = useMemo(() => pathsByRepoFromGroups(groups, (change) => change.staged), [groups]);
  const hasVisibleGroups = groups.some((group) => (
    group.visibleChanges.length > 0 || group.state?.loading || group.state?.error
  ));
  const hasActiveFilters = hasActiveGitChangeFilters(changeFilters);
  const active = useMemo(() => {
    const parsed = focusedKey ? parseWorkspaceChangeKey(focusedKey) : null;
    if (!parsed) return null;
    const root = roots.find((entry) => entry.repoRoot === parsed.repoRoot) ?? null;
    const change = snapshots[parsed.repoRoot]?.snapshot?.changes.find((entry) => entry.path === parsed.path) ?? null;
    if (!root || !change) return null;
    return { root, change };
  }, [focusedKey, roots, snapshots]);
  const canCommit = !busy && checkedCount > 0 && commitMessage.trim().length > 0;
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const toggleStageFilter = (filterKey: GitStageFilter) => {
    setChangeFilters((current) => ({
      ...current,
      stage: toggleSetValue(current.stage, filterKey),
    }));
  };
  const toggleStatusFilter = (filterKey: GitStatusFilter) => {
    setChangeFilters((current) => ({
      ...current,
      status: toggleSetValue(current.status, filterKey),
    }));
  };
  const clearChangeFilters = () => {
    setChangeFilters(emptyGitChangeFilters());
  };
  const selectVisible = (value: boolean) => {
    for (const group of groups) {
      const paths = group.visibleChanges.map((change) => change.path);
      if (paths.length > 0) onToggleChecked(group.root.repoRoot, paths, value);
    }
  };
  const toggleRepoCollapsed = (repoRoot: string) => {
    setCollapsedRepos((current) => {
      const next = new Set(current);
      if (next.has(repoRoot)) next.delete(repoRoot);
      else next.add(repoRoot);
      return next;
    });
  };

  return (
    <PanelGroup orientation="horizontal" id="workspace-git-changes-layout">
      <Panel id="workspace-changes-list" defaultSize="38%" minSize="26%" className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
          <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
          <span className="font-semibold text-[12px]">{t("git.workspaceChanges.title")}</span>
          <span className="min-w-0 truncate text-[11px] text-[var(--taomni-text-muted)]">{scopeSummary}</span>
        </div>
        <ChangesListToolbar
          busy={busy}
          filter={filter}
          onFilterChange={setFilter}
          filters={changeFilters}
          onToggleStageFilter={toggleStageFilter}
          onToggleStatusFilter={toggleStatusFilter}
          onClearFilters={clearChangeFilters}
          checkedCount={checkedCount}
          totalCount={totalChanges}
          visibleCount={visibleChangeCount}
          visibleStagedCount={visibleStagedChangeCount}
          treeMode={treeMode}
          onCheckVisible={() => selectVisible(true)}
          onUncheckVisible={() => selectVisible(false)}
          onStageVisible={() => stageVisible(visiblePathsByRepo)}
          onUnstageVisible={() => unstageVisible(visibleStagedPathsByRepo)}
          onToggleTreeMode={() => setTreeMode(!treeMode)}
        />

        <div className="flex-1 min-h-0 overflow-auto">
          {!hasVisibleGroups ? (
            <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {normalizedFilter || hasActiveFilters
                ? t("git.workspaceChanges.noMatchingChanges")
                : t("git.workspaceChanges.noLocalChanges")}
            </div>
          ) : treeMode ? (
            groups.map(({ root, state, snapshot, visibleChanges }) => (
              <RepoChangeGroup
                key={root.repoRoot}
                root={root}
                snapshot={snapshot}
                changes={visibleChanges}
                loading={!!state?.loading}
                error={state?.error ?? null}
                treeMode={treeMode}
                checkedKeys={checkedKeys}
                selectedKeys={selectedKeys}
                focusedKey={focusedKey}
                collapsed={collapsedRepos.has(root.repoRoot)}
                onToggleCollapsed={() => toggleRepoCollapsed(root.repoRoot)}
                busy={busy}
                onToggleChecked={onToggleChecked}
                onStagePaths={stagePaths}
                onUnstagePaths={unstagePaths}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
              />
            ))
          ) : (
            <WorkspaceFlatChangesList
              groups={groups}
              checkedKeys={checkedKeys}
              selectedKeys={selectedKeys}
              focusedKey={focusedKey}
              collapsedRepos={collapsedRepos}
              onToggleCollapsed={toggleRepoCollapsed}
              onToggleChecked={onToggleChecked}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          )}
        </div>

        <CommitBar
          message={commitMessage}
          onMessageChange={setCommitMessage}
          canCommit={canCommit}
          canCommitAndPush={canCommit && canCommitAndPush}
          onCommit={commit}
          onCommitAndPush={commitAndPush}
          summary={`${checkedCount} files in ${checkedRepoCount} repos`}
          targetBranch={targetBranch}
          onTargetBranchChange={setTargetBranch}
          branchOptions={branchOptions}
          branchPlaceholder={branchPlaceholder}
        />
      </Panel>

      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />

      <Panel id="workspace-changes-diff" defaultSize="62%" minSize="35%" className="min-w-0 min-h-0 flex flex-col">
        <DiffPane
          title={active ? `${active.root.name} / ${active.change.path}` : t("git.workspaceChanges.diffTitle")}
          busy={busy}
          selectedCount={active ? 1 : 0}
          pair={pair}
          pairLoading={pairLoading}
          onStage={stageSelected}
          onUnstage={unstageSelected}
          onDiscard={discardSelected}
          onNormalizeLineEndings={onNormalizeLineEndings}
          normalizeLineEndingsBusy={normalizeLineEndingsBusy}
          onOpenInEditor={onOpenInEditor}
          onSaveWorktree={onSaveWorktree}
          worktreeEditable={worktreeEditable}
        />
      </Panel>
    </PanelGroup>
  );
}

function WorkspaceFlatChangesList({
  groups,
  checkedKeys,
  selectedKeys,
  focusedKey,
  collapsedRepos,
  onToggleCollapsed,
  onToggleChecked,
  onSelect,
  onContextMenu,
}: {
  groups: Array<{
    root: GitWorkspaceRootInfo;
    state: WorkspaceChangesViewProps["snapshots"][string] | undefined;
    snapshot: GitSnapshot | null;
    visibleChanges: GitSnapshot["changes"];
  }>;
  checkedKeys: Set<string>;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  collapsedRepos: Set<string>;
  onToggleCollapsed: (repoRoot: string) => void;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}) {
  const t = useT();
  const changesByRepo = new Map(
    groups.map((group) => [group.root.repoRoot, group.visibleChanges] as const),
  );
  const flatGroups = buildWorkspaceFlatGroups(
    groups.map((group) => group.root),
    changesByRepo,
  );
  const statusRows = groups.filter((group) => group.state?.loading || group.state?.error);

  return (
    <div className="min-h-full" data-testid="workspace-flat-changes-list">
      {flatGroups.map((group) => {
        const collapsed = collapsedRepos.has(group.root.repoRoot);
        const branch = groupSnapshotBranch(groups, group.root.repoRoot);
        const checkedCount = group.changes.filter((change) => (
          checkedKeys.has(workspaceChangeKey(group.root.repoRoot, change.path))
        )).length;
        return (
          <section
            key={group.root.repoRoot}
            data-testid="workspace-flat-repo-group"
            data-repo-root={group.root.repoRoot}
            className="border-b border-[var(--taomni-divider)]"
          >
            <div
              data-testid="workspace-flat-repo-header"
              className="h-7 flex items-center gap-1.5 pl-2 pr-2 bg-[var(--taomni-quick-bg)] border-b border-[var(--taomni-divider)]"
            >
              <button
                type="button"
                className="shrink-0 flex items-center justify-center text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                aria-label={collapsed
                  ? t("git.workspaceChanges.expandRepository", { repo: group.root.name })
                  : t("git.workspaceChanges.collapseRepository", { repo: group.root.name })}
                onClick={() => onToggleCollapsed(group.root.repoRoot)}
              >
                {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              <TriCheckbox
                state={checkState(checkedCount, group.changes.length)}
                disabled={group.changes.length === 0}
                ariaLabel={t("git.workspaceChanges.selectRepoChanges", { repo: group.root.name })}
                onChange={(value) => onToggleChecked(
                  group.root.repoRoot,
                  group.changes.map((change) => change.path),
                  value,
                )}
              />
              <GitBranch className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />
              <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text)]">
                {group.root.name}
              </span>
              {branch ? (
                <span className="min-w-0 truncate text-[10px] text-[var(--taomni-text-muted)]">{branch}</span>
              ) : null}
              <div className="flex-1" />
              <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
                {checkedCount}/{group.changes.length}
              </span>
            </div>
            {collapsed ? null : group.changes.map((change) => {
              const key = workspaceChangeKey(group.root.repoRoot, change.path);
              return (
                <WorkspaceFlatChangeRow
                  key={key}
                  root={group.root}
                  change={change}
                  checked={checkedKeys.has(key)}
                  selected={selectedKeys.has(key)}
                  active={focusedKey === key}
                  onToggleChecked={(value) => onToggleChecked(group.root.repoRoot, [change.path], value)}
                  onSelect={(mods) => onSelect(group.root.repoRoot, change.path, mods)}
                  onContextMenu={(event) => onContextMenu(group.root.repoRoot, change.path, event)}
                />
              );
            })}
          </section>
        );
      })}
      {statusRows.map((group) => (
        <RepoFlatStatusRow
          key={group.root.repoRoot}
          root={group.root}
          loading={!!group.state?.loading}
          error={group.state?.error ?? null}
        />
      ))}
    </div>
  );
}

function groupSnapshotBranch(
  groups: Array<{ root: GitWorkspaceRootInfo; snapshot: GitSnapshot | null }>,
  repoRoot: string,
): string | null {
  const snapshot = groups.find((group) => group.root.repoRoot === repoRoot)?.snapshot ?? null;
  if (!snapshot) return null;
  if (snapshot.detached) return `detached ${snapshot.headOid ?? ""}`.trim();
  return snapshot.currentBranch;
}

function WorkspaceFlatChangeRow({
  root,
  change,
  checked,
  selected,
  active,
  onToggleChecked,
  onSelect,
  onContextMenu,
}: {
  root: GitWorkspaceRootInfo;
  change: GitChange;
  checked: boolean;
  selected: boolean;
  active: boolean;
  onToggleChecked: (value: boolean) => void;
  onSelect: (mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const t = useT();
  const pathDir = changePathDirectory(change.path);
  const name = changeFileName(change.path);
  const status = workspaceStatusMeta(change, t);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="workspace-change-row"
      data-compact="true"
      aria-label={`${root.name} ${change.path} ${status.statusLabel}`}
      title={`${root.repoRoot}\n${change.path}`}
      className={`group relative w-full min-h-[28px] h-7 pl-6 pr-2 py-0.5 flex items-center gap-1.5 text-left cursor-pointer border-b border-[var(--taomni-divider)]/60 ${
        active ? "bg-[var(--taomni-hover)]" : selected ? "bg-[var(--taomni-accent)]/10" : "hover:bg-[var(--taomni-hover)]"
      }`}
      onClick={(event) => onSelect({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
        }
      }}
    >
      <input
        type="checkbox"
        className="shrink-0 accent-[var(--taomni-accent)]"
        checked={checked}
        aria-label={t("git.workspaceChanges.selectFile", { repo: root.name, path: change.path })}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggleChecked(event.target.checked)}
      />
      <span
        className={`shrink-0 w-5 rounded px-0.5 py-0 text-center text-[10px] font-semibold ${status.kindClass}`}
        title={status.statusLabel}
        aria-label={status.statusLabel}
      >
        {status.kindLabel}
      </span>
      <div className="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0 max-w-[55%] truncate text-[12px] font-medium">{name}</span>
        {pathDir ? (
          <span className="min-w-0 truncate text-[10px] text-[var(--taomni-text-muted)]" data-testid="workspace-change-path">
            {pathDir}
          </span>
        ) : null}
        {change.oldPath ? (
          <span className="min-w-0 truncate text-[10px] text-[var(--taomni-text-muted)]">
            · {t("git.workspaceChanges.fromPath", { path: change.oldPath })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RepoFlatStatusRow({
  root,
  loading,
  error,
}: {
  root: GitWorkspaceRootInfo;
  loading: boolean;
  error: string | null;
}) {
  const t = useT();
  const color = repoColorFor(root.repoRoot);
  return (
    <div
      className="min-h-[36px] px-2 py-2 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[12px]"
      style={{ borderLeft: `3px solid ${color.border}` }}
    >
      <span
        className="shrink-0 w-12 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase"
        style={{ background: color.bg, border: `1px solid ${color.border}`, color: color.text }}
      >
        {repoAbbr(root.name || root.repoRoot)}
      </span>
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-accent)]" /> : null}
      {error ? <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> : null}
      <span className={error ? "truncate text-red-500" : "truncate text-[var(--taomni-text-muted)]"}>
        {error ?? t("git.workspaceChanges.loadingChanges")}
      </span>
    </div>
  );
}

function RepoChangeGroup({
  root,
  snapshot,
  changes,
  loading,
  error,
  treeMode,
  checkedKeys,
  selectedKeys,
  focusedKey,
  collapsed,
  onToggleCollapsed,
  busy,
  onToggleChecked,
  onStagePaths,
  onUnstagePaths,
  onSelect,
  onContextMenu,
}: {
  root: GitWorkspaceRootInfo;
  snapshot: GitSnapshot | null;
  changes: GitSnapshot["changes"];
  loading: boolean;
  error: string | null;
  treeMode: boolean;
  checkedKeys: Set<string>;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  busy: boolean;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onStagePaths: (repoRoot: string, paths: string[]) => void;
  onUnstagePaths: (repoRoot: string, paths: string[]) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
}) {
  const t = useT();
  if (changes.length === 0 && !loading && !error) return null;

  const branch = snapshot?.detached ? `detached ${snapshot.headOid ?? ""}` : snapshot?.currentBranch ?? "No branch";
  const checkedCount = changes.filter((change) => checkedKeys.has(workspaceChangeKey(root.repoRoot, change.path))).length;
  const checkedPaths = new Set(
    changes
      .filter((change) => checkedKeys.has(workspaceChangeKey(root.repoRoot, change.path)))
      .map((change) => change.path),
  );
  const selectedPaths = new Set(
    changes
      .filter((change) => selectedKeys.has(workspaceChangeKey(root.repoRoot, change.path)))
      .map((change) => change.path),
  );
  const parsedFocus = focusedKey ? parseWorkspaceChangeKey(focusedKey) : null;
  const activePath = parsedFocus?.repoRoot === root.repoRoot ? parsedFocus.path : null;

  return (
    <section className="border-b border-[var(--taomni-divider)]">
      <div className="h-8 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <button
          type="button"
          className="shrink-0 flex items-center justify-center text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
          aria-label={collapsed
            ? t("git.workspaceChanges.expandRepository", { repo: root.name })
            : t("git.workspaceChanges.collapseRepository", { repo: root.name })}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        <TriCheckbox
          state={checkState(checkedCount, changes.length)}
          disabled={changes.length === 0}
          ariaLabel={t("git.workspaceChanges.selectRepoChanges", { repo: root.name })}
          onChange={(value) => onToggleChecked(root.repoRoot, changes.map((change) => change.path), value)}
        />
        <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
        <span className="min-w-0 truncate text-[12px] font-medium">{root.name}</span>
        <span className="min-w-0 truncate text-[11px] text-[var(--taomni-text-muted)]">{branch}</span>
        <div className="flex-1" />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-accent)]" />}
        {error && <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
        <span className="shrink-0 rounded bg-[var(--taomni-hover)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)]">
          {checkedCount}/{changes.length}
        </span>
      </div>
      {collapsed ? null : error ? (
        <div className="px-8 py-2 text-[11px] text-red-500" title={error}>
          {error}
        </div>
      ) : changes.length > 0 ? (
        <>
          <ChangesTree
            changes={changes}
            treeMode={treeMode}
            showSectionActions={false}
            checked={checkedPaths}
            onToggleChecked={(paths, value) => onToggleChecked(root.repoRoot, paths, value)}
            busy={busy}
            onStagePaths={(paths) => onStagePaths(root.repoRoot, paths)}
            onUnstagePaths={(paths) => onUnstagePaths(root.repoRoot, paths)}
            selected={selectedPaths}
            activePath={activePath}
            onSelect={(path, mods) => onSelect(root.repoRoot, path, mods)}
            onContextMenu={(path, event) => onContextMenu(root.repoRoot, path, event)}
          />
        </>
      ) : loading ? (
        <div className="px-8 py-2 text-[11px] text-[var(--taomni-text-muted)]">
          {t("git.workspaceChanges.loadingChanges")}
        </div>
      ) : null}
    </section>
  );
}

function TriCheckbox({
  state,
  disabled,
  ariaLabel,
  onChange,
}: {
  state: TriState;
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (value: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <input
      ref={(el) => {
        ref.current = el;
        if (el) el.indeterminate = state === "some";
      }}
      type="checkbox"
      className="shrink-0 accent-[var(--taomni-accent)]"
      checked={state === "all"}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function checkState(checkedCount: number, totalCount: number): TriState {
  if (totalCount === 0 || checkedCount === 0) return "none";
  if (checkedCount === totalCount) return "all";
  return "some";
}

function repoAbbr(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  const compact = (words[0] ?? name).replace(/[^a-zA-Z0-9]/g, "");
  return (compact.slice(0, 3) || "repo").toUpperCase();
}

function workspaceStatusMeta(change: GitChange, t: TranslateFn): {
  kindLabel: string;
  kindClass: string;
  statusLabel: string;
} {
  if (change.conflict) {
    return {
      kindLabel: "!",
      kindClass: "bg-red-500/15 text-red-500",
      statusLabel: t("git.workspaceChanges.statusConflict"),
    };
  }
  if (change.staged) {
    return {
      kindLabel: shortChangeKind(change),
      kindClass: "bg-emerald-500/15 text-emerald-600",
      statusLabel: t("git.workspaceChanges.statusStaged"),
    };
  }
  if (change.status === "untracked") {
    return {
      kindLabel: "?",
      kindClass: "bg-amber-500/15 text-amber-600",
      statusLabel: t("git.workspaceChanges.statusUntracked"),
    };
  }
  return {
    kindLabel: shortChangeKind(change),
    kindClass: "bg-blue-500/15 text-blue-500",
    statusLabel: statusLabelForChange(change, t),
  };
}

function statusLabelForChange(change: GitChange, t: TranslateFn): string {
  if (change.status === "renamed") return t("git.workspaceChanges.statusRenamed");
  if (change.status === "deleted") return t("git.workspaceChanges.statusDeleted");
  if (change.status === "added") return t("git.workspaceChanges.statusAdded");
  return t("git.workspaceChanges.statusModified");
}

function shortChangeKind(change: GitChange): string {
  if (change.status === "renamed") return "R";
  if (change.status === "deleted") return "D";
  if (change.status === "added") return "A";
  if (change.status === "untracked") return "?";
  return "M";
}

function repoColorFor(repoRoot: string): { bg: string; border: string; text: string } {
  const palette = [
    { bg: "#DBEAFE", border: "#2563EB", text: "#1D4ED8" },
    { bg: "#DCFCE7", border: "#16A34A", text: "#15803D" },
    { bg: "#FEF3C7", border: "#D97706", text: "#B45309" },
    { bg: "#FCE7F3", border: "#DB2777", text: "#BE185D" },
    { bg: "#E0F2FE", border: "#0284C7", text: "#0369A1" },
    { bg: "#EDE9FE", border: "#7C3AED", text: "#6D28D9" },
    { bg: "#CCFBF1", border: "#0D9488", text: "#0F766E" },
    { bg: "#FFE4E6", border: "#E11D48", text: "#BE123C" },
  ];
  let hash = 0;
  for (let i = 0; i < repoRoot.length; i += 1) {
    hash = (hash * 31 + repoRoot.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function toggleSetValue<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function pathsByRepoFromGroups(
  groups: Array<{
    root: GitWorkspaceRootInfo;
    visibleChanges: GitSnapshot["changes"];
  }>,
  predicate: (change: GitChange) => boolean = () => true,
): Record<string, string[]> {
  const byRepo: Record<string, string[]> = {};
  for (const group of groups) {
    const paths = group.visibleChanges.filter(predicate).map((change) => change.path);
    if (paths.length > 0) byRepo[group.root.repoRoot] = paths;
  }
  return byRepo;
}

function workspaceChangeMatchesSearch(
  root: GitWorkspaceRootInfo,
  change: GitChange,
  normalizedFilter: string,
): boolean {
  if (!normalizedFilter) return true;
  return (
    root.name.toLowerCase().includes(normalizedFilter) ||
    root.repoRoot.toLowerCase().includes(normalizedFilter) ||
    change.path.toLowerCase().includes(normalizedFilter) ||
    (change.oldPath ?? "").toLowerCase().includes(normalizedFilter) ||
    change.status.toLowerCase().includes(normalizedFilter) ||
    (change.conflict ? "conflict conflicted" : "").includes(normalizedFilter) ||
    (change.staged ? "staged" : "").includes(normalizedFilter) ||
    (change.unstaged ? "unstaged" : "").includes(normalizedFilter)
  );
}
