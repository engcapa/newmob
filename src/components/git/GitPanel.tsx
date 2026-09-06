import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  Loader2,
  Ellipsis,
  Plus,
  RefreshCcw,
  RefreshCw,
  Save,
  Search,
  Settings,
  Tag,
  Trash2,
  Upload,
  Download,
} from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  gitCheckoutBranch,
  gitCherryPick,
  gitOperationState,
  gitOperationContinue,
  gitOperationAbort,
  gitRebaseSkip,
  gitResolveConflict,
  gitCleanUntracked,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemote,
  gitBlobPair,
  GIT_REF_WORKTREE,
  gitDiscard,
  gitFetch,
  gitMergeBranch,
  gitRenameBranch,
  gitSetUpstream,
  gitCreateTag,
  gitDeleteTag,
  gitPushTag,
  gitCheckoutTag,
  gitPull,
  gitPush,
  gitRepoName,
  gitReset,
  gitRevert,
  gitSaveRemoteAuth,
  gitSaveSettings,
  gitSetRemote,
  gitSnapshot,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashSave,
  gitStashShow,
  gitUnstage,
  selectedRemote,
  type GitBranch as GitBranchInfo,
  type GitBlobPair,
  type GitChange,
  type GitLogEntry,
  type GitOperationState,
  type GitRemote,
  type GitRepoSettings,
  type GitResetMode,
  type GitSnapshot,
  type GitStashEntry,
  type GitTag,
} from "../../lib/git";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../lib/gitRefresh";
import { alertAppDialog, confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { writeText } from "../../lib/clipboard";
import {
  formatRefDate,
  getRecentBranchNames,
  getRecentTagNames,
  loadBranchCollapse,
  loadTagCollapse,
  pickRecentItems,
  rememberRecentBranch,
  rememberRecentTag,
  saveBranchCollapse,
  saveTagCollapse,
  sortByDateThenName,
  type BranchSectionId,
  type TagSectionId,
} from "../../lib/gitRefList";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { ChangesTree } from "./ChangesTree";
import { CommitLog } from "./CommitLog";
import { CompareView } from "./CompareView";
import {
  ChangesListToolbar,
  emptyGitChangeFilters,
  gitChangeMatchesFilters,
  hasActiveGitChangeFilters,
  type GitChangeFilters,
  type GitStageFilter,
  type GitStatusFilter,
} from "./shared/ChangesListToolbar";
import { CommitBar } from "./shared/CommitBar";
import { DiffPane as ChangesDiffPane } from "./shared/DiffPane";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";

interface GitPanelProps {
  repoRoot: string;
  visible?: boolean;
  embedded?: boolean;
  onOpenWorkspace?: (repoRoot: string) => void;
  changesView?: ReactNode;
  workspaceLogView?: ReactNode;
  workspaceBranchesView?: ReactNode;
  workspaceTagsView?: ReactNode;
  workspaceSettingsView?: ReactNode;
  workspaceSettingsAggregateView?: ReactNode | ((showCurrent: () => void) => ReactNode);
  workspaceHeader?: {
    title: string;
    summary: string;
    selectedRepoName: string;
    selectedRepoRoot: string;
    repoSelector?: ReactNode;
    branchBadge?: ReactNode;
    changeSummary?: ReactNode;
    actionControls?: ReactNode;
  };
  changeCountOverride?: number | null;
  refreshToken?: number;
}

type WorkspaceSettingsAggregateView = ReactNode | ((showCurrent: () => void) => ReactNode);

type GitView = "changes" | "log" | "branches" | "tags" | "stash" | "settings";

const EMPTY_SETTINGS: GitRepoSettings = {
  userName: null,
  userEmail: null,
  httpProxy: null,
  httpsProxy: null,
  pullRebase: null,
  pushDefault: null,
  coreAutocrlf: null,
  coreFilemode: null,
  commitGpgsign: null,
};

export function GitPanel({
  repoRoot,
  visible = true,
  embedded = false,
  onOpenWorkspace,
  changesView,
  workspaceLogView,
  workspaceBranchesView,
  workspaceTagsView,
  workspaceSettingsView,
  workspaceSettingsAggregateView,
  workspaceHeader,
  changeCountOverride = null,
  refreshToken = 0,
}: GitPanelProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const [view, setView] = useState<GitView>("changes");
  const [mountedViews, setMountedViews] = useState<Set<GitView>>(() => new Set(["changes"]));
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<GitBranchInfo | null>(null);
  const [selectedStash, setSelectedStash] = useState<GitStashEntry | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<GitRepoSettings>(EMPTY_SETTINGS);
  const [remoteDrafts, setRemoteDrafts] = useState<Record<string, RemoteDraft>>({});
  const [includeUntracked, setIncludeUntracked] = useState(false);
  // Track explicitly *unchecked* paths so new changes are committed by default.
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [treeMode, setTreeMode] = useState(() => {
    try {
      return localStorage.getItem("taomni.git.changes.tree") !== "flat";
    } catch {
      return true;
    }
  });
  const [amendChecked, setAmendChecked] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; entry: GitLogEntry } | null>(null);
  const [repoRefreshRevision, setRepoRefreshRevision] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<string | null>(null);
  const [operation, setOperation] = useState<GitOperationState | null>(null);
  const [compare, setCompare] = useState<{ refA: string; refB: string; title: string } | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("taomni.git.changes.tree", treeMode ? "tree" : "flat");
    } catch {
      /* ignore */
    }
  }, [treeMode]);

  const repoName = useMemo(() => gitRepoName(repoRoot), [repoRoot]);
  const selectedChange = useMemo(
    () => snapshot?.changes.find((change) => change.path === selectedPath) ?? null,
    [selectedPath, snapshot],
  );
  const hasConflicts = !!snapshot?.changes.some((change) => change.conflict);
  const displayedChangeCount = changeCountOverride ?? snapshot?.changes.length ?? null;
  const setGitUiFontSize = useCallback(
    (size: number) => {
      const next = Math.min(18, Math.max(10, Math.round(size)));
      setUiFontSize(next);
      setStatusMessage(`UI font size ${next}px`);
    },
    [setStatusMessage, setUiFontSize],
  );

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const increase =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";
      const decrease =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";
      const reset =
        event.key === "0" ||
        event.code === "Digit0" ||
        event.code === "Numpad0";

      if (!increase && !decrease && !reset) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const current = useAppStore.getState().uiFontSize;
      if (increase) {
        setGitUiFontSize(current + 1);
      } else if (decrease) {
        setGitUiFontSize(current - 1);
      } else {
        setGitUiFontSize(12);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [setGitUiFontSize, visible]);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const current = useAppStore.getState().uiFontSize;
      if (event.deltaY < 0) {
        setGitUiFontSize(current + 1);
      } else if (event.deltaY > 0) {
        setGitUiFontSize(current - 1);
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [setGitUiFontSize, visible]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await gitSnapshot(repoRoot);
      setSnapshot(next);
      setSettingsDraft(normalizeSettings(next.settings));
      setRemoteDrafts((current) => buildRemoteDrafts(next.remotes, current));
      const paths = new Set(next.changes.map((c) => c.path));
      // Drop unchecked entries that no longer exist; everything else stays checked.
      setUnchecked((current) => new Set([...current].filter((p) => paths.has(p))));
      setSelected((current) => new Set([...current].filter((p) => paths.has(p))));
      setSelectedPath((current) =>
        current && next.changes.some((change) => change.path === current) ? current : next.changes[0]?.path ?? null,
      );
      setSelectedBranch((current) =>
        current && next.branches.some((branch) => branch.fullName === current.fullName)
          ? current
          : next.branches.find((branch) => branch.current) ?? next.branches[0] ?? null,
      );
      setSelectedStash((current) =>
        current && next.stashes.some((stash) => stash.selector === current.selector)
          ? current
          : next.stashes[0] ?? null,
      );
      const remote = selectedRemote(next);
      setRemoteName((current) => current || remote?.name || "");
      try {
        setOperation(await gitOperationState(repoRoot));
      } catch {
        setOperation(null);
      }
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      setStatusMessage(message);
    } finally {
      setLoading(false);
    }
  }, [repoRoot, setStatusMessage]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken, repoRefreshRevision]);

  useEffect(() => subscribeGitRepoRefresh((changedRepoRoot) => {
    if (changedRepoRoot === repoRoot) {
      setRepoRefreshRevision((current) => current + 1);
    }
  }), [repoRoot]);

  useEffect(() => {
    let cancelled = false;
    async function loadPair() {
      if (view !== "changes") {
        return;
      }
      if (!selectedChange) {
        setPair(null);
        return;
      }
      setPairLoading(true);
      try {
        // Local Changes diff: HEAD ↔ working tree (covers staged + unstaged combined;
        // untracked files have no HEAD side and show as fully added).
        const next = await gitBlobPair(
          repoRoot,
          selectedChange.path,
          "HEAD",
          GIT_REF_WORKTREE,
          selectedChange.oldPath,
        );
        if (!cancelled) setPair(next);
      } catch (err) {
        if (!cancelled) {
          setPair(null);
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) setPairLoading(false);
      }
    }
    void loadPair();
    return () => {
      cancelled = true;
    };
  }, [repoRoot, selectedChange, view]);

  useEffect(() => {
    let cancelled = false;
    async function loadDiff() {
      if (view !== "stash") {
        return;
      }
      setDiffLoading(true);
      try {
        if (selectedStash) {
          const text = await gitStashShow(repoRoot, selectedStash.selector);
          if (!cancelled) setDiff(text || "(stash has no patch)");
        } else {
          setDiff("");
        }
      } catch (err) {
        if (!cancelled) setDiff(errorMessage(err));
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    }
    void loadDiff();
    return () => {
      cancelled = true;
    };
  }, [repoRoot, selectedStash, view]);

  const switchView = useCallback((next: GitView) => {
    setView(next);
    setMountedViews((current) => {
      if (current.has(next)) return current;
      const updated = new Set(current);
      updated.add(next);
      return updated;
    });
  }, []);

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
        notifyGitRepoChanged(repoRoot);
        setStatusMessage(`${label} completed`);
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        setStatusMessage(message);
        await alertAppDialog({ title: label, message });
      } finally {
        setBusy(false);
      }
    },
    [refresh, repoRoot, setStatusMessage],
  );

  const changesList = useMemo(() => snapshot?.changes ?? [], [snapshot]);
  const orderedPaths = useMemo(
    () => [...changesList].map((c) => c.path).sort((a, b) => a.localeCompare(b)),
    [changesList],
  );
  const checked = useMemo(
    () => new Set(changesList.filter((c) => !unchecked.has(c.path)).map((c) => c.path)),
    [changesList, unchecked],
  );
  const checkedPaths = useMemo(() => [...checked], [checked]);
  const opPaths = selected.size > 0 ? [...selected] : selectedPath ? [selectedPath] : [];

  const toggleChecked = useCallback((paths: string[], value: boolean) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (value) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (path: string, mods: { ctrl: boolean; shift: boolean }) => {
      setSelectedPath(path);
      setSelected((prev) => {
        if (mods.ctrl) {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          anchorRef.current = path;
          return next;
        }
        if (mods.shift && anchorRef.current) {
          const from = orderedPaths.indexOf(anchorRef.current);
          const to = orderedPaths.indexOf(path);
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from <= to ? [from, to] : [to, from];
            return new Set(orderedPaths.slice(lo, hi + 1));
          }
        }
        anchorRef.current = path;
        return new Set([path]);
      });
    },
    [orderedPaths],
  );

  const stageSelected = () => opPaths.length && runAction("Stage", () => gitStage(repoRoot, opPaths));
  const unstageSelected = () => opPaths.length && runAction("Unstage", () => gitUnstage(repoRoot, opPaths));
  const discardPaths = (paths: string[]) => {
    if (paths.length === 0) return;
    const set = new Set(paths);
    const untracked = changesList.filter((c) => set.has(c.path) && c.status === "untracked").map((c) => c.path);
    const tracked = changesList.filter((c) => set.has(c.path) && c.status !== "untracked").map((c) => c.path);
    void confirmAndRun(
      "Discard changes",
      `Discard changes in ${paths.length} file(s)? This cannot be undone.`,
      true,
      () =>
        runAction("Discard", async () => {
          if (tracked.length) await gitDiscard(repoRoot, tracked);
          if (untracked.length) await gitCleanUntracked(repoRoot, untracked);
        }),
    );
  };
  const discardSelected = () => discardPaths(opPaths);
  const doCommit = (push: boolean) => {
    if (checkedPaths.length === 0 || !commitMessage.trim()) return;
    void runAction(
      push ? "Commit and Push" : "Commit",
      async () => {
        await gitCommit(repoRoot, commitMessage, amendChecked, checkedPaths);
        setCommitMessage("");
        setAmendChecked(false);
        if (push) {
          await gitPush(repoRoot, remoteName || null, snapshot?.currentBranch ?? null, !snapshot?.upstream);
        }
      },
    );
  };
  const syncCurrentBranch = () => {
    if (!remoteName) return;
    void runAction("Sync", async () => {
      await gitPull(repoRoot, remoteName, pullBranchForRemote(snapshot, remoteName));
      await gitPush(repoRoot, remoteName, snapshot?.currentBranch ?? null, !snapshot?.upstream);
    });
  };
  const checkoutBranchByName = () => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "Checkout branch",
        label: "Checkout an existing branch",
        placeholder: "branch name",
        confirmLabel: "Checkout",
      });
      const target = branch?.trim();
      if (target) await runAction("Checkout", () => gitCheckoutBranch(repoRoot, target));
    })();
  };
  const createBranchFromHead = () => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "New branch",
        label: "Create and checkout a branch",
        placeholder: "branch name",
        confirmLabel: "Create",
      });
      const target = branch?.trim();
      if (target) await runAction("New branch", () => gitCreateBranch(repoRoot, target, null, true));
    })();
  };
  const forcePushCurrentBranch = () => {
    if (!remoteName || !snapshot?.currentBranch) return;
    const branch = snapshot.currentBranch;
    const setUpstream = !snapshot.upstream;
    void confirmAndRun(
      "Force push",
      `Force push ${branch} to ${remoteName} using --force-with-lease?`,
      true,
      () => runAction("Force push", () => gitPush(repoRoot, remoteName, branch, setUpstream, true)),
    );
  };
  const resolveConflict = (side: "ours" | "theirs") => {
    const targets = changesList.filter((c) => opPaths.includes(c.path) && c.conflict).map((c) => c.path);
    if (targets.length === 0) return;
    void runAction(`Accept ${side}`, async () => {
      for (const p of targets) await gitResolveConflict(repoRoot, p, side);
    });
  };
  const markResolved = () => opPaths.length && runAction("Mark resolved", () => gitStage(repoRoot, opPaths));
  const openMenu = (path: string, event: ReactMouseEvent) => {
    event.preventDefault();
    if (!selected.has(path)) {
      setSelected(new Set([path]));
      setSelectedPath(path);
      anchorRef.current = path;
    }
    setMenu({ x: event.clientX, y: event.clientY, path });
  };

  return (
    <div
      ref={rootRef}
      data-testid="git-panel"
      className="h-full w-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <header className={`${embedded ? "h-9 px-2" : "h-10 px-3"} shrink-0 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]`}>
        {embedded ? (
          <span className="max-w-40 truncate text-[11px] text-[var(--taomni-text-muted)]" title={repoRoot}>
            {repoName}
          </span>
        ) : workspaceHeader ? (
          <>
            <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
            {workspaceHeader.repoSelector ? (
              <>
                <span className="shrink-0 font-semibold leading-4">Git</span>
                {workspaceHeader.repoSelector}
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="font-semibold leading-4 truncate">Workspace Git · {workspaceHeader.title}</div>
                  <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">{workspaceHeader.summary}</div>
                </div>
                <span className="taomni-divider-v h-5 mx-1" />
                <span
                  className="inline-flex items-center gap-1 h-6 max-w-56 rounded bg-[var(--taomni-hover)] px-2 text-[11px]"
                  title={workspaceHeader.selectedRepoRoot}
                >
                  <span className="shrink-0 text-[var(--taomni-text-muted)]">Repository detail</span>
                  <span className="min-w-0 truncate font-medium">{workspaceHeader.selectedRepoName}</span>
                </span>
              </>
            )}
          </>
        ) : (
          <>
            <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
            <div className="min-w-0">
              <div className="font-semibold leading-4 truncate">Git · {repoName}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">{repoRoot}</div>
            </div>
            <span className="taomni-divider-v h-5 mx-1" />
          </>
        )}
        {workspaceHeader?.branchBadge ?? <BranchBadge snapshot={snapshot} />}
        {workspaceHeader?.changeSummary ?? (displayedChangeCount !== null && (
          <span className="text-[11px] text-[var(--taomni-text-muted)]">
            {displayedChangeCount} changes
            {snapshot && (snapshot.ahead || snapshot.behind) ? ` · ↑${snapshot.ahead} ↓${snapshot.behind}` : ""}
          </span>
        ))}
        <div className="flex-1" />
        {workspaceHeader?.actionControls ?? (
          <>
            <select
              className="taomni-input h-7 w-32"
              value={remoteName}
              onChange={(event) => setRemoteName(event.target.value)}
              disabled={!snapshot?.remotes.length}
            >
              {snapshot?.remotes.length ? snapshot.remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>{remote.name}</option>
              )) : <option value="">No remote</option>}
            </select>
            <IconButton label="Fetch" icon={<Download className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Fetch", () => gitFetch(repoRoot, remoteName))} />
            <IconButton label="Pull" icon={<GitMerge className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Pull", () => gitPull(repoRoot, remoteName, pullBranchForRemote(snapshot, remoteName)))} />
            <IconButton label="Push" icon={<Upload className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Push", () => gitPush(repoRoot, remoteName, snapshot?.currentBranch ?? null, !snapshot?.upstream))} />
            <button
              type="button"
              className="taomni-btn h-7 w-7 inline-flex items-center justify-center"
              title="More Git actions"
              aria-label="More Git actions"
              onClick={(event) => setHeaderMenu({ x: event.clientX, y: event.clientY })}
            >
              <Ellipsis className="w-3.5 h-3.5 text-[var(--taomni-text)]" />
            </button>
            <IconButton label="Refresh" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={loading} onClick={() => void refresh()} />
          </>
        )}
      </header>

      <nav className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--taomni-divider)]">
        {(["changes", "log", "branches", "tags", "stash", "settings"] as GitView[]).map((item) => (
          <button
            key={item}
            type="button"
            data-testid={item === "log" ? "git-log-tab" : undefined}
            className={`h-7 px-3 rounded text-[12px] capitalize ${view === item ? "bg-[var(--taomni-accent)] text-white" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => switchView(item)}
          >
            {item}
          </button>
        ))}
        {(busy || loading) && <Loader2 className="w-3.5 h-3.5 animate-spin ml-1" />}
        {error && <span className="ml-2 text-[11px] text-red-500 truncate">{error}</span>}
      </nav>

      {(operation && operation.kind !== "none") || hasConflicts ? (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[12px]">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="min-w-0">
            {operationLabel(operation)}
            {operation?.conflictedPaths.length
              ? ` — ${operation.conflictedPaths.length} conflicted file(s). Resolve and stage them, then continue.`
              : " Resolve conflicts, stage them, then continue or abort."}
          </span>
          <div className="flex-1" />
          {operation && operation.kind !== "none" ? (
            <>
              <button
                className="taomni-btn h-7 px-2"
                type="button"
                disabled={busy}
                onClick={() => void runAction(`Continue ${operation.kind}`, () => gitOperationContinue(repoRoot, operation.kind))}
              >
                Continue
              </button>
              {operation.kind === "rebase" && (
                <button
                  className="taomni-btn h-7 px-2"
                  type="button"
                  disabled={busy}
                  onClick={() => void runAction("Skip", () => gitRebaseSkip(repoRoot))}
                >
                  Skip
                </button>
              )}
              <button
                className="taomni-btn h-7 px-2 text-red-500"
                type="button"
                disabled={busy}
                onClick={() => void runAction(`Abort ${operation.kind}`, () => gitOperationAbort(repoRoot, operation.kind))}
              >
                Abort
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <main className="flex-1 min-h-0">
        {compare ? (
          <CompareView
            repoRoot={repoRoot}
            refA={compare.refA}
            refB={compare.refB}
            title={compare.title}
            onClose={() => setCompare(null)}
          />
        ) : historyPath ? (
            <CommitLog
              repoRoot={repoRoot}
              headOid={snapshot?.headOid ?? null}
              branches={snapshot?.branches ?? []}
              busy={busy}
              pathFilter={historyPath}
              onClose={() => setHistoryPath(null)}
            onContextMenu={(entry, x, y) => setCommitMenu({ x, y, entry })}
          />
        ) : (
        <>
        {mountedViews.has("changes") && (
          <div className="h-full min-h-0" style={{ display: view === "changes" ? "block" : "none" }}>
          {changesView ?? (
            <ChangesView
              changes={changesList}
              treeMode={treeMode}
              setTreeMode={setTreeMode}
              checked={checked}
              checkedCount={checkedPaths.length}
              selected={selected}
              activePath={selectedPath}
              onToggleChecked={toggleChecked}
              onSelect={handleSelect}
              onContextMenu={openMenu}
              pair={pair}
              pairLoading={pairLoading}
              commitMessage={commitMessage}
              setCommitMessage={setCommitMessage}
              amendChecked={amendChecked}
              setAmendChecked={setAmendChecked}
              busy={busy}
              hasRemote={!!remoteName}
              stagePaths={(paths) => {
                if (paths.length) void runAction("Stage", () => gitStage(repoRoot, paths));
              }}
              unstagePaths={(paths) => {
                if (paths.length) void runAction("Unstage", () => gitUnstage(repoRoot, paths));
              }}
              discardPaths={discardPaths}
              commit={() => doCommit(false)}
              commitAndPush={() => doCommit(true)}
            />
          )}
          </div>
        )}
        {mountedViews.has("log") && (
          <div className="h-full min-h-0 git-log-view" style={{ display: view === "log" ? "block" : "none" }}>
            {workspaceLogView ?? (
              <CommitLog
                repoRoot={repoRoot}
                headOid={snapshot?.headOid ?? null}
                branches={snapshot?.branches ?? []}
                busy={busy}
                onContextMenu={(entry, x, y) => setCommitMenu({ x, y, entry })}
              />
            )}
          </div>
        )}
        {mountedViews.has("branches") && (
          <div className="h-full min-h-0" style={{ display: view === "branches" ? "block" : "none" }}>
          {workspaceBranchesView ?? <BranchesView
            snapshot={snapshot}
            selected={selectedBranch}
            setSelected={setSelectedBranch}
            busy={busy}
            onCreate={async () => {
              const name = await promptAppDialog({ title: "Create branch", label: "Branch name" });
              if (name) {
                await runAction("Create branch", async () => {
                  await gitCreateBranch(repoRoot, name, selectedBranch?.name ?? null, true);
                  rememberRecentBranch(repoRoot, name);
                });
              }
            }}
            onCheckout={(branch) => void checkoutBranch(repoRoot, branch, runAction)}
            onMerge={(branch) => void confirmAndRun("Merge branch", `Merge ${branch.name} into current branch?`, false, () => runAction("Merge", () => gitMergeBranch(repoRoot, branch.name)))}
            onDelete={(branch) => void confirmAndRun("Delete branch", `Delete local branch ${branch.name}?`, true, () => runAction("Delete branch", () => gitDeleteBranch(repoRoot, branch.name, false)))}
            onRename={async (branch) => {
              const next = await promptAppDialog({ title: "Rename branch", label: "New name", initialValue: branch.name });
              if (next && next !== branch.name) {
                await runAction("Rename branch", async () => {
                  await gitRenameBranch(repoRoot, branch.name, next);
                  rememberRecentBranch(repoRoot, next);
                });
              }
            }}
            onPush={(branch) => void runAction("Push branch", () => gitPush(repoRoot, remoteName || null, branch.name, !branch.upstream))}
            onSetUpstream={async (branch) => {
              const up = await promptAppDialog({
                title: "Set upstream",
                label: "Upstream (remote/branch, empty to clear)",
                initialValue: branch.upstream ?? `${remoteName || "origin"}/${branch.name}`,
                allowEmpty: true,
              });
              if (up !== null) await runAction("Set upstream", () => gitSetUpstream(repoRoot, branch.name, up || null));
            }}
            onCompare={(branch) => {
              if (!snapshot?.currentBranch) return;
              setCompare({ refA: branch.name, refB: snapshot.currentBranch, title: `${branch.name} → ${snapshot.currentBranch}` });
            }}
          />}
          </div>
        )}
        {mountedViews.has("tags") && (
          <div className="h-full min-h-0" style={{ display: view === "tags" ? "block" : "none" }}>
          {workspaceTagsView ?? <TagsView
            snapshot={snapshot}
            busy={busy}
            hasRemote={!!remoteName}
            onCreate={async () => {
              const name = await promptAppDialog({ title: "Create tag", label: "Tag name" });
              if (!name) return;
              const message = await promptAppDialog({ title: "Create tag", label: "Annotation message (empty = lightweight)", allowEmpty: true });
              await runAction("Create tag", () => gitCreateTag(repoRoot, name, null, message || null));
            }}
            onCheckout={(tag) => void confirmAndRun("Checkout tag", `Checkout ${tag.name}? This detaches HEAD.`, false, () => runAction("Checkout tag", () => gitCheckoutTag(repoRoot, tag.name)))}
            onDelete={(tag) => void confirmAndRun("Delete tag", `Delete tag ${tag.name}?`, true, () => runAction("Delete tag", () => gitDeleteTag(repoRoot, tag.name)))}
            onPush={(tag) => void runAction("Push tag", () => gitPushTag(repoRoot, remoteName || null, tag.name, false))}
          />}
          </div>
        )}
        {mountedViews.has("stash") && (
          <div className="h-full min-h-0" style={{ display: view === "stash" ? "block" : "none" }}>
          <StashView
            snapshot={snapshot}
            selected={selectedStash}
            setSelected={setSelectedStash}
            diff={diff}
            diffLoading={diffLoading}
            busy={busy}
            includeUntracked={includeUntracked}
            setIncludeUntracked={setIncludeUntracked}
            onSave={async () => {
              const message = await promptAppDialog({ title: "Stash changes", label: "Message", allowEmpty: true });
              if (message !== null) await runAction("Stash", () => gitStashSave(repoRoot, message, includeUntracked));
            }}
            onApply={() => selectedStash && void runAction("Apply stash", () => gitStashApply(repoRoot, selectedStash.selector, false))}
            onPop={() => selectedStash && void runAction("Pop stash", () => gitStashApply(repoRoot, selectedStash.selector, true))}
            onDrop={() => selectedStash && void confirmAndRun("Drop stash", `Drop ${selectedStash.selector}?`, true, () => runAction("Drop stash", () => gitStashDrop(repoRoot, selectedStash.selector)))}
          />
          </div>
        )}
        {mountedViews.has("settings") && (
          <div className="h-full min-h-0" style={{ display: view === "settings" ? "block" : "none" }}>
            <WorkspaceSettingsSwitcher
              aggregateView={workspaceSettingsAggregateView}
              currentView={workspaceSettingsView ?? <SettingsView
                snapshot={snapshot}
                settings={settingsDraft}
                setSettings={setSettingsDraft}
                remoteDrafts={remoteDrafts}
                setRemoteDrafts={setRemoteDrafts}
                busy={busy}
                onSaveSettings={() => void runAction("Save Git settings", () => gitSaveSettings(repoRoot, settingsDraft))}
                onSaveRemote={(remote, draft) => void runAction("Save remote", async () => {
                  await gitSetRemote(repoRoot, draft.name || remote.name, draft.fetchUrl, draft.pushUrl);
                  await gitSaveRemoteAuth(repoRoot, draft.name || remote.name, draft.username, draft.token, false);
                  setRemoteDrafts({ ...remoteDrafts, [remote.name]: { ...draft, token: "" } });
                })}
                onClearToken={(remote) => void runAction("Clear remote token", async () => {
                  await gitSaveRemoteAuth(repoRoot, remote.name, remoteDrafts[remote.name]?.username ?? remote.username, null, true);
                })}
                onDeleteRemote={(remote) => void confirmAndRun("Delete remote", `Delete remote ${remote.name}?`, true, () => runAction("Delete remote", () => gitDeleteRemote(repoRoot, remote.name)))}
                onAddRemote={async () => {
                  const name = await promptAppDialog({ title: "Add remote", label: "Remote name", initialValue: "origin" });
                  if (!name) return;
                  const url = await promptAppDialog({ title: "Add remote", label: "Remote URL" });
                  if (!url) return;
                  await runAction("Add remote", () => gitSetRemote(repoRoot, name, url, null));
                }}
              />}
            />
          </div>
        )}
        </>
        )}
      </main>
      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          items={[
            {
              label: "Sync",
              icon: <RefreshCcw className="w-3.5 h-3.5" />,
              disabled: busy || !remoteName,
              onClick: syncCurrentBranch,
            },
            {
              label: "Checkout branch...",
              icon: <GitFork className="w-3.5 h-3.5" />,
              disabled: busy,
              onClick: checkoutBranchByName,
            },
            {
              label: "New branch...",
              icon: <Plus className="w-3.5 h-3.5" />,
              disabled: busy,
              onClick: createBranchFromHead,
            },
            {
              label: "Open code workspace",
              icon: <Braces className="w-3.5 h-3.5" />,
              disabled: !onOpenWorkspace,
              onClick: () => onOpenWorkspace?.(repoRoot),
            },
            { label: "", separator: true },
            {
              label: "Force push with lease...",
              icon: <Upload className="w-3.5 h-3.5" />,
              disabled: busy || !remoteName || !snapshot?.currentBranch,
              danger: true,
              onClick: forcePushCurrentBranch,
            },
          ]}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={changeMenuItems({
            repoRoot,
            opPaths,
            conflicted: changesList.some((c) => opPaths.includes(c.path) && c.conflict),
            onStage: stageSelected,
            onUnstage: unstageSelected,
            onDiscard: discardSelected,
            onShowDiff: () => setSelectedPath(menu.path),
            onShowHistory: () => setHistoryPath(menu.path),
            onAcceptOurs: () => resolveConflict("ours"),
            onAcceptTheirs: () => resolveConflict("theirs"),
            onMarkResolved: markResolved,
          })}
        />
      )}
      {commitMenu && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          onClose={() => setCommitMenu(null)}
          items={commitMenuItems(commitMenu.entry, {
            onCherryPick: (e) =>
              void confirmAndRun("Cherry-pick", `Cherry-pick ${e.shortOid}: ${e.subject}?`, false, () =>
                runAction("Cherry-pick", () => gitCherryPick(repoRoot, e.oid))),
            onRevert: (e) =>
              void confirmAndRun("Revert commit", `Revert ${e.shortOid}: ${e.subject}?`, false, () =>
                runAction("Revert", () => gitRevert(repoRoot, e.oid))),
            onReset: (e, mode) =>
              void confirmAndRun(`Reset ${mode}`, `Reset current branch to ${e.shortOid} using --${mode}? `, mode === "hard", () =>
                runAction("Reset", () => gitReset(repoRoot, e.oid, mode))),
            onNewBranch: async (e) => {
              const name = await promptAppDialog({ title: "New branch from commit", label: "Branch name" });
              if (name) await runAction("Create branch", () => gitCreateBranch(repoRoot, name, e.oid, true));
            },
          })}
        />
      )}
    </div>
  );
}

function ChangesView({
  changes,
  treeMode,
  setTreeMode,
  checked,
  checkedCount,
  selected,
  activePath,
  onToggleChecked,
  onSelect,
  onContextMenu,
  pair,
  pairLoading,
  commitMessage,
  setCommitMessage,
  amendChecked,
  setAmendChecked,
  busy,
  hasRemote,
  stagePaths,
  unstagePaths,
  discardPaths,
  commit,
  commitAndPush,
}: {
  changes: GitChange[];
  treeMode: boolean;
  setTreeMode: (value: boolean) => void;
  checked: Set<string>;
  checkedCount: number;
  selected: Set<string>;
  activePath: string | null;
  onToggleChecked: (paths: string[], value: boolean) => void;
  onSelect: (path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (path: string, event: ReactMouseEvent) => void;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  amendChecked: boolean;
  setAmendChecked: (value: boolean) => void;
  busy: boolean;
  hasRemote: boolean;
  stagePaths: (paths: string[]) => void;
  unstagePaths: (paths: string[]) => void;
  discardPaths: (paths: string[]) => void;
  commit: () => void;
  commitAndPush: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const [changeFilters, setChangeFilters] = useState<GitChangeFilters>(() => emptyGitChangeFilters());
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleChanges = useMemo(() => (
    changes.filter((change) => (
      gitChangeMatchesFilters(change, changeFilters)
      && gitChangeMatchesSearch(change, normalizedFilter)
    ))
  ), [changeFilters, changes, normalizedFilter]);
  const visiblePaths = useMemo(() => visibleChanges.map((change) => change.path), [visibleChanges]);
  const visibleStagedPaths = useMemo(
    () => visibleChanges.filter((change) => change.staged).map((change) => change.path),
    [visibleChanges],
  );
  const hasActiveFilters = hasActiveGitChangeFilters(changeFilters);
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
  const active = changes.find((change) => change.path === activePath) ?? null;
  const canCommit = !busy && checkedCount > 0 && !!commitMessage.trim();
  return (
    <PanelGroup orientation="horizontal" id="git-changes-layout">
      <Panel id="changes-list" defaultSize="36%" minSize="24%" className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <ChangesListToolbar
          busy={busy}
          filter={filter}
          onFilterChange={setFilter}
          filters={changeFilters}
          onToggleStageFilter={toggleStageFilter}
          onToggleStatusFilter={toggleStatusFilter}
          onClearFilters={clearChangeFilters}
          checkedCount={checkedCount}
          totalCount={changes.length}
          visibleCount={visibleChanges.length}
          visibleStagedCount={visibleStagedPaths.length}
          treeMode={treeMode}
          onCheckVisible={() => onToggleChecked(visiblePaths, true)}
          onUncheckVisible={() => onToggleChecked(visiblePaths, false)}
          onStageVisible={() => stagePaths(visiblePaths)}
          onUnstageVisible={() => unstagePaths(visibleStagedPaths)}
          onToggleTreeMode={() => setTreeMode(!treeMode)}
        />
        <ChangesTree
          changes={visibleChanges}
          treeMode={treeMode}
          emptyLabel={normalizedFilter || hasActiveFilters
            ? t("git.workspaceChanges.noMatchingChanges")
            : t("git.workspaceChanges.noLocalChanges")}
          checked={checked}
          onToggleChecked={onToggleChecked}
          busy={busy}
          onStagePaths={stagePaths}
          onUnstagePaths={unstagePaths}
          selected={selected}
          activePath={activePath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
        <CommitBar
          message={commitMessage}
          onMessageChange={setCommitMessage}
          canCommit={canCommit}
          canCommitAndPush={canCommit && hasRemote}
          onCommit={commit}
          onCommitAndPush={commitAndPush}
          commitLabel={`Commit${checkedCount ? ` (${checkedCount})` : ""}`}
          amend={{ checked: amendChecked, onChange: setAmendChecked }}
        />
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="changes-diff" defaultSize="64%" minSize="35%" className="min-w-0 min-h-0 flex flex-col">
        <ChangesDiffPane
          title={active?.path ?? t("git.workspaceChanges.diffTitle")}
          busy={busy}
          selectedCount={active ? 1 : 0}
          pair={pair}
          pairLoading={pairLoading}
          onStage={() => {
            if (activePath) stagePaths([activePath]);
          }}
          onUnstage={() => {
            if (activePath) unstagePaths([activePath]);
          }}
          onDiscard={() => {
            if (activePath) discardPaths([activePath]);
          }}
        />
      </Panel>
    </PanelGroup>
  );
}

function gitChangeMatchesSearch(change: GitChange, normalizedFilter: string): boolean {
  if (!normalizedFilter) return true;
  return (
    change.path.toLowerCase().includes(normalizedFilter) ||
    (change.oldPath ?? "").toLowerCase().includes(normalizedFilter) ||
    change.status.toLowerCase().includes(normalizedFilter) ||
    (change.conflict ? "conflict conflicted" : "").includes(normalizedFilter) ||
    (change.staged ? "staged" : "").includes(normalizedFilter) ||
    (change.unstaged ? "unstaged" : "").includes(normalizedFilter)
  );
}

function toggleSetValue<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function BranchesView({
  snapshot,
  selected,
  setSelected,
  busy,
  onCreate,
  onCheckout,
  onMerge,
  onDelete,
  onRename,
  onPush,
  onSetUpstream,
  onCompare,
}: {
  snapshot: GitSnapshot | null;
  selected: GitBranchInfo | null;
  setSelected: (branch: GitBranchInfo) => void;
  busy: boolean;
  onCreate: () => void;
  onCheckout: (branch: GitBranchInfo) => void;
  onMerge: (branch: GitBranchInfo) => void;
  onDelete: (branch: GitBranchInfo) => void;
  onRename: (branch: GitBranchInfo) => void;
  onPush: (branch: GitBranchInfo) => void;
  onSetUpstream: (branch: GitBranchInfo) => void;
  onCompare: (branch: GitBranchInfo) => void;
}) {
  const repoRoot = snapshot?.repoRoot ?? "";
  const branches = snapshot?.branches ?? [];
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadBranchCollapse);
  const [ctx, setCtx] = useState<{ x: number; y: number; branch: GitBranchInfo } | null>(null);
  const [recentTick, setRecentTick] = useState(0);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredBranches = useMemo(() => (
    sortByDateThenName(branches.filter((branch) => branchMatchesQuery(branch, normalizedQuery)))
  ), [branches, normalizedQuery]);
  const local = useMemo(() => sortByDateThenName(filteredBranches.filter((b) => !b.remote)), [filteredBranches]);
  const remote = useMemo(() => sortByDateThenName(filteredBranches.filter((b) => b.remote)), [filteredBranches]);
  const recent = useMemo(() => {
    void recentTick;
    return pickRecentItems(
      sortByDateThenName(filteredBranches),
      getRecentBranchNames(repoRoot),
    );
  }, [filteredBranches, recentTick, repoRoot]);

  useEffect(() => {
    if (snapshot?.currentBranch) {
      rememberRecentBranch(repoRoot, snapshot.currentBranch);
      setRecentTick((n) => n + 1);
    }
  }, [repoRoot, snapshot?.currentBranch]);

  const toggleSection = (id: BranchSectionId) => {
    setCollapsed((current) => {
      const next = { ...current, [id]: !current[id] };
      saveBranchCollapse(next);
      return next;
    });
  };

  const openBranchMenu = (branch: GitBranchInfo, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected(branch);
    setCtx({ x: event.clientX, y: event.clientY, branch });
  };

  const branchMenuItems = (branch: GitBranchInfo): MenuItem[] => {
    const localSel = !branch.remote;
    return [
      {
        label: "Checkout",
        disabled: busy || branch.current,
        onClick: () => {
          setSelected(branch);
          onCheckout(branch);
        },
      },
      {
        label: "Merge into current",
        disabled: busy || branch.current || branch.remote,
        onClick: () => {
          setSelected(branch);
          onMerge(branch);
        },
      },
      {
        label: "Compare with current",
        disabled: busy || !snapshot?.currentBranch,
        onClick: () => {
          setSelected(branch);
          onCompare(branch);
        },
      },
      { label: "", separator: true },
      {
        label: "Rename…",
        disabled: busy || !localSel,
        onClick: () => {
          setSelected(branch);
          onRename(branch);
        },
      },
      {
        label: "Push",
        disabled: busy || !localSel,
        onClick: () => {
          setSelected(branch);
          onPush(branch);
        },
      },
      {
        label: "Set upstream…",
        disabled: busy || !localSel,
        onClick: () => {
          setSelected(branch);
          onSetUpstream(branch);
        },
      },
      {
        label: "Copy name",
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => void writeText(branch.name),
      },
      { label: "", separator: true },
      {
        label: "Delete…",
        danger: true,
        disabled: busy || branch.current || branch.remote,
        onClick: () => {
          setSelected(branch);
          onDelete(branch);
        },
      },
    ];
  };

  const renderBranchRow = (branch: GitBranchInfo) => {
    const dateLabel = formatRefDate(branch.date);
    return (
      <button
        key={branch.fullName}
        type="button"
        data-testid="git-branch-row"
        data-branch={branch.name}
        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected?.fullName === branch.fullName ? "bg-[var(--taomni-hover)]" : ""}`}
        onClick={() => setSelected(branch)}
        onDoubleClick={() => {
          if (!busy && !branch.current) {
            setSelected(branch);
            onCheckout(branch);
          }
        }}
        onContextMenu={(event) => openBranchMenu(branch, event)}
      >
        <GitFork className={`w-4 h-4 shrink-0 ${branch.current ? "text-[var(--taomni-accent)]" : "text-[var(--taomni-text-muted)]"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] truncate font-medium">{branch.name}</span>
            {dateLabel ? (
              <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]" title={branch.date ?? undefined}>
                {dateLabel}
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            {branch.upstream ? `tracks ${branch.upstream}` : branch.remote ? "remote" : "local"}
            {branch.subject ? ` · ${branch.subject}` : ""}
          </div>
        </div>
        {branch.current && <span className="text-[11px] text-[var(--taomni-accent)] shrink-0">current</span>}
      </button>
    );
  };

  const renderSection = (
    id: BranchSectionId,
    label: string,
    list: GitBranchInfo[],
  ) => {
    if (list.length === 0) return null;
    const isCollapsed = collapsed[id];
    return (
      <section data-testid={`git-branch-section-${id}`} className="border-b border-[var(--taomni-divider)]">
        <button
          type="button"
          className="w-full h-7 px-2 flex items-center gap-1.5 text-left bg-[var(--taomni-quick-bg)] hover:bg-[var(--taomni-hover)]"
          aria-expanded={!isCollapsed}
          onClick={() => toggleSection(id)}
        >
          {isCollapsed
            ? <ChevronRight className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
            : <ChevronDown className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
            {label}
          </span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">({list.length})</span>
        </button>
        {isCollapsed ? null : list.map(renderBranchRow)}
      </section>
    );
  };

  const localSel = !!selected && !selected.remote;
  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="git-branches-view">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)] overflow-x-auto">
        <div className="relative w-56 min-w-40 shrink-0">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="search"
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search branches"
            aria-label="Search branches"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <IconButton label="New" icon={<Plus className="w-3.5 h-3.5" />} disabled={busy} onClick={onCreate} />
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected || selected.current} onClick={() => selected && onCheckout(selected)}>Checkout</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected || selected.current || selected.remote} onClick={() => selected && onMerge(selected)}>Merge</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected} onClick={() => selected && onCompare(selected)}>Compare</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !localSel || !selected} onClick={() => selected && onRename(selected)}>Rename</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !localSel || !selected} onClick={() => selected && onPush(selected)}>Push</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !localSel || !selected} onClick={() => selected && onSetUpstream(selected)}>Upstream</button>
        <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || !selected || selected.current || selected.remote} onClick={() => selected && onDelete(selected)}>Delete</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {branches.length === 0 ? <EmptyState title="No branches" /> : filteredBranches.length === 0 ? <EmptyState title="No branches match" /> : (
          <>
            {renderSection("recent", "Recent", recent)}
            {renderSection("local", "Local", local)}
            {renderSection("remote", "Remote", remote)}
          </>
        )}
      </div>
      {ctx ? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={branchMenuItems(ctx.branch)}
        />
      ) : null}
    </div>
  );
}

function TagsView({
  snapshot,
  busy,
  hasRemote,
  onCreate,
  onCheckout,
  onDelete,
  onPush,
}: {
  snapshot: GitSnapshot | null;
  busy: boolean;
  hasRemote: boolean;
  onCreate: () => void;
  onCheckout: (tag: GitTag) => void;
  onDelete: (tag: GitTag) => void;
  onPush: (tag: GitTag) => void;
}) {
  const repoRoot = snapshot?.repoRoot ?? "";
  const tags = snapshot?.tags ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadTagCollapse);
  const [ctx, setCtx] = useState<{ x: number; y: number; tag: GitTag } | null>(null);
  const [recentTick, setRecentTick] = useState(0);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTags = useMemo(() => (
    sortByDateThenName(tags.filter((tag) => tagMatchesQuery(tag, normalizedQuery)))
  ), [tags, normalizedQuery]);
  const recent = useMemo(() => {
    void recentTick;
    return pickRecentItems(filteredTags, getRecentTagNames(repoRoot));
  }, [filteredTags, recentTick, repoRoot]);
  const current = tags.find((t) => t.name === selected) ?? null;

  const toggleSection = (id: TagSectionId) => {
    setCollapsed((state) => {
      const next = { ...state, [id]: !state[id] };
      saveTagCollapse(next);
      return next;
    });
  };

  const openTagMenu = (tag: GitTag, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected(tag.name);
    setCtx({ x: event.clientX, y: event.clientY, tag });
  };

  const tagMenuItems = (tag: GitTag): MenuItem[] => [
    {
      label: "Checkout",
      disabled: busy,
      onClick: () => {
        rememberRecentTag(repoRoot, tag.name);
        setRecentTick((n) => n + 1);
        onCheckout(tag);
      },
    },
    {
      label: "Push",
      disabled: busy || !hasRemote,
      onClick: () => onPush(tag),
    },
    {
      label: "Copy name",
      icon: <Copy className="w-3.5 h-3.5" />,
      onClick: () => void writeText(tag.name),
    },
    { label: "", separator: true },
    {
      label: "Delete…",
      danger: true,
      disabled: busy,
      onClick: () => onDelete(tag),
    },
  ];

  const renderTagRow = (tag: GitTag) => {
    const dateLabel = formatRefDate(tag.date);
    return (
      <button
        key={tag.name}
        type="button"
        data-testid="git-tag-row"
        data-tag={tag.name}
        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected === tag.name ? "bg-[var(--taomni-hover)]" : ""}`}
        onClick={() => setSelected(tag.name)}
        onDoubleClick={() => {
          if (!busy) {
            rememberRecentTag(repoRoot, tag.name);
            setRecentTick((n) => n + 1);
            onCheckout(tag);
          }
        }}
        onContextMenu={(event) => openTagMenu(tag, event)}
      >
        <Tag className="w-4 h-4 shrink-0 text-[var(--taomni-text-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] truncate font-medium">{tag.name}</span>
            {dateLabel ? (
              <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]" title={tag.date ?? undefined}>
                {dateLabel}
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            <span className="taomni-mono text-[var(--taomni-accent)]">{tag.oid}</span>
            {tag.annotated ? " · annotated" : " · lightweight"}{tag.subject ? ` · ${tag.subject}` : ""}
          </div>
        </div>
      </button>
    );
  };

  const renderSection = (id: TagSectionId, label: string, list: GitTag[]) => {
    if (list.length === 0) return null;
    const isCollapsed = collapsed[id];
    return (
      <section data-testid={`git-tag-section-${id}`} className="border-b border-[var(--taomni-divider)]">
        <button
          type="button"
          className="w-full h-7 px-2 flex items-center gap-1.5 text-left bg-[var(--taomni-quick-bg)] hover:bg-[var(--taomni-hover)]"
          aria-expanded={!isCollapsed}
          onClick={() => toggleSection(id)}
        >
          {isCollapsed
            ? <ChevronRight className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
            : <ChevronDown className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
            {label}
          </span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">({list.length})</span>
        </button>
        {isCollapsed ? null : list.map(renderTagRow)}
      </section>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="git-tags-view">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-56 min-w-40 shrink-0">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="search"
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search tags"
            aria-label="Search tags"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <IconButton label="New tag" icon={<Plus className="w-3.5 h-3.5" />} disabled={busy} onClick={onCreate} />
        <button
          className="taomni-btn h-7 px-2"
          type="button"
          disabled={busy || !current}
          onClick={() => {
            if (!current) return;
            rememberRecentTag(repoRoot, current.name);
            setRecentTick((n) => n + 1);
            onCheckout(current);
          }}
        >
          Checkout
        </button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !current || !hasRemote} onClick={() => current && onPush(current)}>Push</button>
        <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || !current} onClick={() => current && onDelete(current)}>Delete</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tags.length === 0 ? <EmptyState title="No tags" /> : filteredTags.length === 0 ? <EmptyState title="No tags match" /> : (
          <>
            {renderSection("recent", "Recent", recent)}
            {renderSection("all", "All tags", filteredTags)}
          </>
        )}
      </div>
      {ctx ? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={tagMenuItems(ctx.tag)}
        />
      ) : null}
    </div>
  );
}

function branchMatchesQuery(branch: GitBranchInfo, query: string): boolean {
  if (!query) return true;
  return (
    branch.name.toLowerCase().includes(query) ||
    branch.fullName.toLowerCase().includes(query) ||
    (branch.upstream ?? "").toLowerCase().includes(query) ||
    (branch.subject ?? "").toLowerCase().includes(query)
  );
}

function tagMatchesQuery(tag: GitTag, query: string): boolean {
  if (!query) return true;
  return (
    tag.name.toLowerCase().includes(query) ||
    tag.oid.toLowerCase().includes(query) ||
    (tag.subject ?? "").toLowerCase().includes(query)
  );
}

function StashView({
  snapshot,
  selected,
  setSelected,
  diff,
  diffLoading,
  busy,
  includeUntracked,
  setIncludeUntracked,
  onSave,
  onApply,
  onPop,
  onDrop,
}: {
  snapshot: GitSnapshot | null;
  selected: GitStashEntry | null;
  setSelected: (stash: GitStashEntry) => void;
  diff: string;
  diffLoading: boolean;
  busy: boolean;
  includeUntracked: boolean;
  setIncludeUntracked: (value: boolean) => void;
  onSave: () => void;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
}) {
  const stashes = snapshot?.stashes ?? [];
  return (
    <PanelGroup orientation="horizontal" id="git-stash-layout">
      <Panel id="stash-list" defaultSize={34} minSize={24} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy} onClick={onSave}>Stash</button>
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} />
            Include untracked
          </label>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {stashes.length === 0 ? <EmptyState title="No stashes" /> : stashes.map((stash) => (
            <button
              key={stash.selector}
              type="button"
              className={`w-full px-3 py-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected?.selector === stash.selector ? "bg-[var(--taomni-hover)]" : ""}`}
              onClick={() => setSelected(stash)}
            >
              <div className="taomni-mono text-[11px] text-[var(--taomni-accent)]">{stash.selector}</div>
              <div className="text-[12px] truncate">{stash.message}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)]">{stash.date}</div>
            </button>
          ))}
        </div>
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="stash-diff" defaultSize={66} minSize={35} className="min-w-0 min-h-0 flex flex-col">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold text-[12px] truncate">{selected?.selector ?? "Stash"}</span>
          <div className="flex-1" />
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected} onClick={onApply}>Apply</button>
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected} onClick={onPop}>Pop</button>
          <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || !selected} onClick={onDrop}>Drop</button>
        </div>
        <DiffPane diff={diff} loading={diffLoading} />
      </Panel>
    </PanelGroup>
  );
}

function WorkspaceSettingsSwitcher({
  currentView,
  aggregateView,
}: {
  currentView: ReactNode;
  aggregateView?: WorkspaceSettingsAggregateView;
}) {
  const [mode, setMode] = useState<"current" | "aggregate">("current");

  if (!aggregateView) return <>{currentView}</>;

  const showCurrent = () => setMode("current");
  const aggregate = typeof aggregateView === "function" ? aggregateView(showCurrent) : aggregateView;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <div className="inline-flex h-7 rounded border border-[var(--taomni-divider)] overflow-hidden">
          <button
            type="button"
            className={`px-2 text-[12px] ${mode === "current" ? "bg-[var(--taomni-hover)]" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => setMode("current")}
          >
            Current Repository
          </button>
          <button
            type="button"
            className={`px-2 text-[12px] border-l border-[var(--taomni-divider)] ${mode === "aggregate" ? "bg-[var(--taomni-hover)]" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => setMode("aggregate")}
          >
            Aggregate
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {mode === "current" ? currentView : aggregate}
      </div>
    </div>
  );
}

interface RemoteDraft {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  username: string;
  token: string;
}

function SettingsView({
  snapshot,
  settings,
  setSettings,
  remoteDrafts,
  setRemoteDrafts,
  busy,
  onSaveSettings,
  onSaveRemote,
  onClearToken,
  onDeleteRemote,
  onAddRemote,
}: {
  snapshot: GitSnapshot | null;
  settings: GitRepoSettings;
  setSettings: (settings: GitRepoSettings) => void;
  remoteDrafts: Record<string, RemoteDraft>;
  setRemoteDrafts: (drafts: Record<string, RemoteDraft>) => void;
  busy: boolean;
  onSaveSettings: () => void;
  onSaveRemote: (remote: GitRemote, draft: RemoteDraft) => void;
  onClearToken: (remote: GitRemote) => void;
  onDeleteRemote: (remote: GitRemote) => void;
  onAddRemote: () => void;
}) {
  const remotes = snapshot?.remotes ?? [];
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="max-w-[1100px] p-4 space-y-5">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Settings className="w-4 h-4" />
            <h2 className="font-semibold">Repository config</h2>
            <button className="taomni-btn h-7 px-2 ml-auto" type="button" disabled={busy} onClick={onSaveSettings}>
              <Save className="w-3.5 h-3.5 mr-1" /> Save config
            </button>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <SettingInput label="user.name" value={settings.userName} onChange={(value) => setSettings({ ...settings, userName: value })} />
            <SettingInput label="user.email" value={settings.userEmail} onChange={(value) => setSettings({ ...settings, userEmail: value })} />
            <SettingInput label="http.proxy" value={settings.httpProxy} onChange={(value) => setSettings({ ...settings, httpProxy: value })} />
            <SettingInput label="https.proxy" value={settings.httpsProxy} onChange={(value) => setSettings({ ...settings, httpsProxy: value })} />
            <SettingInput label="pull.rebase" value={settings.pullRebase} onChange={(value) => setSettings({ ...settings, pullRebase: value })} />
            <SettingInput label="push.default" value={settings.pushDefault} onChange={(value) => setSettings({ ...settings, pushDefault: value })} />
            <SettingInput label="core.autocrlf" value={settings.coreAutocrlf} onChange={(value) => setSettings({ ...settings, coreAutocrlf: value })} />
            <SettingInput label="core.filemode" value={settings.coreFilemode} onChange={(value) => setSettings({ ...settings, coreFilemode: value })} />
            <SettingInput label="commit.gpgsign" value={settings.commitGpgsign} onChange={(value) => setSettings({ ...settings, commitGpgsign: value })} />
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <GitBranch className="w-4 h-4" />
            <h2 className="font-semibold">Remotes and credentials</h2>
            <button className="taomni-btn h-7 px-2 ml-auto" type="button" disabled={busy} onClick={onAddRemote}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add remote
            </button>
          </div>
          <div className="space-y-3">
            {remotes.length === 0 ? <EmptyState title="No remotes configured" /> : remotes.map((remote) => {
              const draft = remoteDrafts[remote.name] ?? remoteDraft(remote);
              const updateDraft = (next: RemoteDraft) => setRemoteDrafts({ ...remoteDrafts, [remote.name]: next });
              return (
                <div key={remote.name} className="border border-[var(--taomni-divider)] rounded-md overflow-hidden">
                  <div className="h-8 flex items-center px-3 bg-[var(--taomni-quick-bg)] border-b border-[var(--taomni-divider)]">
                    <span className="font-semibold">{remote.name}</span>
                    <span className="ml-2 text-[11px] text-[var(--taomni-text-muted)]">{remote.tokenRef ? "token stored in Vault" : "no token"}</span>
                    <div className="flex-1" />
                    <button className="taomni-btn h-6 px-2" type="button" disabled={busy} onClick={() => onSaveRemote(remote, draft)}>Save</button>
                    <button className="taomni-btn h-6 px-2 ml-1" type="button" disabled={busy || !remote.tokenRef} onClick={() => onClearToken(remote)}>Clear token</button>
                    <button className="taomni-btn h-6 px-2 ml-1 text-red-500" type="button" disabled={busy} onClick={() => onDeleteRemote(remote)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-3 p-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                    <SettingInput label="name" value={draft.name} onChange={(value) => updateDraft({ ...draft, name: value ?? "" })} />
                    <SettingInput label="fetch URL" value={draft.fetchUrl} onChange={(value) => updateDraft({ ...draft, fetchUrl: value ?? "" })} />
                    <SettingInput label="push URL" value={draft.pushUrl} onChange={(value) => updateDraft({ ...draft, pushUrl: value ?? "" })} />
                    <SettingInput label="account / username" value={draft.username} onChange={(value) => updateDraft({ ...draft, username: value ?? "" })} />
                    <label className="text-[12px]">
                      <span className="block mb-1 text-[var(--taomni-text-muted)]">token</span>
                      <input
                        className="taomni-input w-full h-8"
                        type="password"
                        value={draft.token}
                        placeholder={remote.tokenRef ? "Stored in Vault; enter new token to replace" : "Personal access token"}
                        onChange={(event) => updateDraft({ ...draft, token: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function SettingInput({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string | null) => void }) {
  return (
    <label className="text-[12px]">
      <span className="block mb-1 text-[var(--taomni-text-muted)]">{label}</span>
      <input className="taomni-input w-full h-8" value={value ?? ""} onChange={(event) => onChange(emptyToNull(event.target.value))} />
    </label>
  );
}

function DiffPane({ diff, loading }: { diff: string; loading: boolean }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-[var(--taomni-term-bg,#111827)]">
      {loading ? (
        <div className="h-full flex items-center justify-center text-[var(--taomni-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading diff
        </div>
      ) : diff ? (
        <pre className="taomni-mono text-[12px] leading-5 p-3 whitespace-pre-wrap break-words text-slate-100">{diff}</pre>
      ) : (
        <EmptyState title="Select an item to preview its diff" />
      )}
    </div>
  );
}

function BranchBadge({ snapshot }: { snapshot: GitSnapshot | null }) {
  if (!snapshot) return <span className="text-[11px] text-[var(--taomni-text-muted)]">No repo state</span>;
  return (
    <span className="inline-flex items-center gap-1 h-6 px-2 rounded bg-[var(--taomni-hover)] text-[12px]">
      <GitCommitHorizontal className="w-3.5 h-3.5" />
      {snapshot.detached ? `detached ${snapshot.headOid ?? ""}` : snapshot.currentBranch ?? "(no branch)"}
    </span>
  );
}

function IconButton({ label, icon, disabled, onClick }: { label: string; icon: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="taomni-btn h-7 px-2 inline-flex items-center gap-1" type="button" disabled={disabled} onClick={onClick} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EmptyState({ title }: { title: string }) {
  return <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">{title}</div>;
}

function normalizeSettings(settings: GitRepoSettings | null | undefined): GitRepoSettings {
  return { ...EMPTY_SETTINGS, ...(settings ?? {}) };
}

function pullBranchForRemote(snapshot: GitSnapshot | null, remoteName: string): string | null {
  if (!snapshot?.currentBranch || !remoteName) return null;
  const prefix = `${remoteName}/`;
  if (snapshot.upstream?.startsWith(prefix)) {
    return snapshot.upstream.slice(prefix.length) || snapshot.currentBranch;
  }
  return snapshot.currentBranch;
}

function buildRemoteDrafts(remotes: GitRemote[], current: Record<string, RemoteDraft>): Record<string, RemoteDraft> {
  const next: Record<string, RemoteDraft> = {};
  for (const remote of remotes) {
    next[remote.name] = current[remote.name] ?? remoteDraft(remote);
  }
  return next;
}

function remoteDraft(remote: GitRemote): RemoteDraft {
  return {
    name: remote.name,
    fetchUrl: remote.fetchUrl,
    pushUrl: remote.pushUrl ?? "",
    username: remote.username ?? "",
    token: "",
  };
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

async function confirmAndRun(title: string, message: string, danger: boolean, action: () => Promise<void>) {
  const ok = await confirmAppDialog({ title, message, danger, confirmLabel: title });
  if (ok) await action();
}

function changeMenuItems(opts: {
  repoRoot: string;
  opPaths: string[];
  conflicted: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onShowDiff: () => void;
  onShowHistory: () => void;
  onAcceptOurs: () => void;
  onAcceptTheirs: () => void;
  onMarkResolved: () => void;
}): MenuItem[] {
  const { repoRoot, opPaths, conflicted, onStage, onUnstage, onDiscard, onShowDiff } = opts;
  const sep = repoRoot.includes("\\") ? "\\" : "/";
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const disabled = opPaths.length === 0;
  const items: MenuItem[] = [
    { label: "Show diff", disabled, onClick: onShowDiff },
    { label: "Show history", disabled: opPaths.length !== 1, onClick: opts.onShowHistory },
  ];
  if (conflicted) {
    items.push(
      { label: "", separator: true },
      { label: "Accept ours", onClick: opts.onAcceptOurs },
      { label: "Accept theirs", onClick: opts.onAcceptTheirs },
      { label: "Mark resolved", onClick: opts.onMarkResolved },
    );
  }
  items.push(
    { label: "", separator: true },
    { label: "Stage", disabled, onClick: onStage },
    { label: "Unstage", disabled, onClick: onUnstage },
    { label: "Discard…", disabled, danger: true, onClick: onDiscard },
    { label: "", separator: true },
    {
      label: opPaths.length > 1 ? `Copy paths (${opPaths.length})` : "Copy path",
      disabled,
      onClick: () => copy(opPaths.map((p) => `${repoRoot}${sep}${p.split("/").join(sep)}`).join("\n")),
    },
    { label: "Copy relative path", disabled, onClick: () => copy(opPaths.join("\n")) },
  );
  return items;
}

function commitMenuItems(
  entry: GitLogEntry,
  handlers: {
    onCherryPick: (e: GitLogEntry) => void;
    onRevert: (e: GitLogEntry) => void;
    onReset: (e: GitLogEntry, mode: GitResetMode) => void;
    onNewBranch: (e: GitLogEntry) => void;
  },
): MenuItem[] {
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const message = [entry.subject, entry.body.trim()].filter(Boolean).join("\n\n");
  return [
    { label: "Cherry-pick", onClick: () => handlers.onCherryPick(entry) },
    { label: "Revert", onClick: () => handlers.onRevert(entry) },
    {
      label: "Reset current branch to here",
      children: [
        { label: "Soft", onClick: () => handlers.onReset(entry, "soft") },
        { label: "Mixed", onClick: () => handlers.onReset(entry, "mixed") },
        { label: "Hard", danger: true, onClick: () => handlers.onReset(entry, "hard") },
      ],
    },
    { label: "New branch here…", onClick: () => handlers.onNewBranch(entry) },
    { label: "", separator: true },
    { label: "Copy revision hash", onClick: () => copy(entry.oid) },
    { label: "Copy subject", onClick: () => copy(entry.subject) },
    { label: "Copy message", onClick: () => copy(message) },
  ];
}

function operationLabel(operation: GitOperationState | null): string {
  switch (operation?.kind) {
    case "merge":
      return "Merge in progress.";
    case "cherryPick":
      return "Cherry-pick in progress.";
    case "revert":
      return "Revert in progress.";
    case "rebase":
      return "Rebase in progress.";
    default:
      return "Conflicts detected.";
  }
}

async function checkoutBranch(
  repoRoot: string,
  branch: GitBranchInfo,
  runAction: (label: string, action: () => Promise<void>) => Promise<void>,
) {
  if (branch.remote) {
    const suggested = branch.name.split("/").slice(1).join("/") || branch.name;
    const localName = await promptAppDialog({
      title: "Checkout remote branch",
      label: "Local branch name",
      initialValue: suggested,
    });
    if (!localName) return;
    await runAction("Checkout remote branch", async () => {
      await gitCreateBranch(repoRoot, localName, branch.name, true);
      rememberRecentBranch(repoRoot, localName);
    });
    return;
  }
  await runAction("Checkout branch", async () => {
    await gitCheckoutBranch(repoRoot, branch.name);
    rememberRecentBranch(repoRoot, branch.name);
  });
}
