import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Language } from "@codemirror/language";
import { Ban, CaseSensitive, ChevronDown, ChevronRight, File, Loader2, Regex, Search, WholeWord } from "lucide-react";
import {
  newWorkspaceSearchId,
  subscribeWorkspaceSearch,
  workspaceSearchCancel,
  workspaceSearchStart,
  type WorkspaceSearchMatch,
  type WorkspaceSearchRoot,
} from "../../../../lib/editor/workspaceSearch";
import {
  highlightSearchLine,
  languageForSearchPath,
} from "../../../../lib/editor/searchLineHighlight";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import {
  pushWorkspaceSearchHistory,
  readWorkspaceSearchHistory,
} from "../workspaceLayoutPersistence";
import {
  isFileInScopePlan,
  planFindInFilesScope,
  type FindInFilesScopeKind,
  type FindInFilesScopePlan,
} from "../findInFilesScopeModel";
import {
  useProjectFactsStore,
  type WorkspaceProjectFactsEntry,
} from "../../../../stores/projectFactsStore";

interface FindInFilesPanelProps {
  roots: CodeWorkspaceRootInfo[];
  onOpenMatch: (match: WorkspaceSearchMatch, options: { preview: boolean }) => void;
  /** Apply replacements for the current result set via the shared WorkspaceEdit path. */
  onReplaceMatches?: (matches: WorkspaceSearchMatch[], replacement: string) => void | Promise<void>;
  /** Bump to move focus into the query input (Ctrl+Shift+F). */
  focusNonce?: number;
  /** Bump the nonce to overwrite the include globs ("Find in Directory..."). */
  includePreset?: { value: string; nonce: number };
  /** Bump the nonce to seed the query field (Search Everywhere Text tab). */
  queryPreset?: { value: string; nonce: number };
  /** Workspace instance id for search history persistence. */
  workspaceInstanceId?: string;
}

interface MatchGroup {
  key: string;
  title: string;
  matches: WorkspaceSearchMatch[];
}

interface SearchSummary {
  filesScanned: number;
  totalMatches: number;
  truncated: boolean;
  cancelled: boolean;
}

type SearchStatus = "idle" | "searching" | "done" | "error";

/**
 * Rendering every match as a DOM row (no virtualization yet), so keep the
 * default total well below the backend's 10k ceiling.
 */
const MAX_TOTAL_MATCHES = 2_000;
/** Default visible matches per file; extra rows need explicit expand. */
export const DEFAULT_MATCHES_PER_FILE = 10;
/** How many more rows "Show more" reveals each click. */
export const MATCHES_PER_FILE_STEP = 20;
/** Prefer keeping text from the line start when the match is near it. */
const CONTEXT_BEFORE_MATCH = 48;
/** Cap how much of the line continues past the keyword. */
const CONTEXT_AFTER_MATCH = 56;
/** Hard cap on displayed code points (hit always retained in full). */
const MAX_LINE_CHARS = 120;

function splitGlobs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface MatchSegments {
  before: string;
  hit: string;
  after: string;
  /** Display text without ellipsis markers (code points in the kept window). */
  text: string;
  /** Hit range within `text` (code-point indices). */
  hitStart: number;
  hitEnd: number;
  elidedStart: boolean;
  elidedEnd: boolean;
}

/**
 * Slice the line around the match. Offsets from the backend are Unicode
 * code-point based, so slice via code points rather than UTF-16 indices.
 *
 * Strategy (Find-in-Files readability):
 * - Drop pure leading indent so results align.
 * - Keep up to CONTEXT_BEFORE_MATCH before the hit (or from line start when closer).
 * - Keep up to CONTEXT_AFTER_MATCH after the hit.
 * - If the window still exceeds MAX_LINE_CHARS, shrink both sides while
 *   always retaining the full hit.
 */
export function matchSegments(match: WorkspaceSearchMatch): MatchSegments {
  const chars = Array.from(match.lineText);
  const trimmed = match.lineText.trimStart();
  const leading = chars.length - Array.from(trimmed).length;
  const start = Math.min(Math.max(match.matchStart, leading), chars.length);
  const end = Math.min(Math.max(match.matchEnd, start), chars.length);
  const hitLen = end - start;

  let contextStart = Math.max(leading, start - CONTEXT_BEFORE_MATCH);
  let contextEnd = Math.min(chars.length, end + CONTEXT_AFTER_MATCH);

  // Prefer keeping from the (trimmed) line start when the whole prefix fits.
  if (start - leading <= CONTEXT_BEFORE_MATCH) {
    contextStart = leading;
  }

  let windowLen = contextEnd - contextStart;
  if (windowLen > MAX_LINE_CHARS) {
    const budget = Math.max(0, MAX_LINE_CHARS - hitLen);
    const leftWant = start - contextStart;
    const rightWant = contextEnd - end;
    const leftKeep = Math.min(leftWant, Math.ceil(budget / 2));
    const rightKeep = Math.min(rightWant, budget - leftKeep);
    // If the right side was shorter, give leftover budget back to the left.
    const leftFinal = Math.min(leftWant, leftKeep + (budget - leftKeep - rightKeep));
    contextStart = start - leftFinal;
    contextEnd = end + rightKeep;
  }

  const elidedStart = contextStart > leading;
  const elidedEnd = contextEnd < chars.length;
  const text = chars.slice(contextStart, contextEnd).join("");
  const hitStart = start - contextStart;
  const hitEnd = end - contextStart;
  const prefix = elidedStart ? "…" : "";
  const suffix = elidedEnd ? "…" : "";

  return {
    before: prefix + chars.slice(contextStart, start).join(""),
    hit: chars.slice(start, end).join(""),
    after: chars.slice(end, contextEnd).join("") + suffix,
    text,
    hitStart,
    hitEnd,
    elidedStart,
    elidedEnd,
  };
}

function groupKey(match: WorkspaceSearchMatch): string {
  return `${match.rootId}:${match.path}`;
}

function groupTitle(match: WorkspaceSearchMatch): string {
  return `${match.rootName}/${match.path}`;
}

export function FindInFilesPanel({
  roots,
  onOpenMatch,
  onReplaceMatches,
  focusNonce = 0,
  includePreset,
  queryPreset,
  workspaceInstanceId,
}: FindInFilesPanelProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [includeGlobs, setIncludeGlobs] = useState("");
  const [excludeGlobs, setExcludeGlobs] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  /** ED-FIND-003: selected search scope. Module scope requires ready facts. */
  const [scopeKind, setScopeKind] = useState<FindInFilesScopeKind>("project");
  const [scopeModuleId, setScopeModuleId] = useState("");
  const [scopeDirectory, setScopeDirectory] = useState("");
  const workspaceRoot = roots[0]?.path ?? "";
  const factsEntry: WorkspaceProjectFactsEntry | null = useProjectFactsStore(
    (state) => (workspaceRoot ? (state.workspaces[workspaceRoot] ?? null) : null),
  );
  const factsModules = factsEntry?.structure?.modules ?? [];

  // ED-FIND-003 A1: the selected scope plan, rebuilt live so the panel can
  // fail closed before touching the backend. startSearch consumes the same
  // plan object the notice below renders.
  const scopePlan: FindInFilesScopePlan = useMemo(() => {
    const maskValue = splitGlobs(includeGlobs).join(",") || undefined;
    const directoryInput = scopeDirectory.trim();
    const targetDirectory = scopeKind !== "directory"
      ? undefined
      : !directoryInput
        ? workspaceRoot || undefined
        : /^(?:[a-zA-Z]:[\\/]|[/\\])/.test(directoryInput)
          ? directoryInput
          : workspaceRoot
            ? `${workspaceRoot.replace(/\/+$/, "")}/${directoryInput.replace(/^\/+/, "")}`
            : directoryInput;
    return planFindInFilesScope(
      {
        kind: scopeKind,
        workspaceRoot,
        targetDirectory,
        moduleId: scopeModuleId || factsModules[0]?.id,
        fileMask: maskValue,
        expectedGeneration: factsEntry?.generation,
      },
      factsEntry,
    );
  }, [factsEntry, factsModules, includeGlobs, scopeDirectory, scopeKind, scopeModuleId, workspaceRoot]);
  /** Per-file expand state: collapsed (default), numeric limit, or "all". */
  const [fileExpand, setFileExpand] = useState<Record<string, number | "all">>({});
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  /** path → language (null = plain text / unknown). */
  const [languagesByPath, setLanguagesByPath] = useState<Record<string, Language | null>>({});
  const [searchHistory, setSearchHistory] = useState<string[]>(() => (
    workspaceInstanceId ? readWorkspaceSearchHistory(workspaceInstanceId) : []
  ));

  const inputRef = useRef<HTMLInputElement>(null);
  const searchIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const groupsRef = useRef<Map<string, MatchGroup>>(new Map());
  const languagesRef = useRef<Record<string, Language | null>>({});

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  const appliedPresetNonceRef = useRef(0);
  useEffect(() => {
    if (!includePreset || includePreset.nonce === 0) return;
    if (includePreset.nonce === appliedPresetNonceRef.current) return;
    appliedPresetNonceRef.current = includePreset.nonce;
    setIncludeGlobs(includePreset.value);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [includePreset]);

  const appliedQueryPresetNonceRef = useRef(0);
  useEffect(() => {
    if (!queryPreset || queryPreset.nonce === 0) return;
    if (queryPreset.nonce === appliedQueryPresetNonceRef.current) return;
    appliedQueryPresetNonceRef.current = queryPreset.nonce;
    setQuery(queryPreset.value);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [queryPreset]);

  const teardownSearch = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    const active = searchIdRef.current;
    searchIdRef.current = null;
    if (active) void workspaceSearchCancel(active).catch(() => {});
  }, []);

  useEffect(() => teardownSearch, [teardownSearch]);

  useEffect(() => {
    setSearchHistory(workspaceInstanceId ? readWorkspaceSearchHistory(workspaceInstanceId) : []);
  }, [workspaceInstanceId]);

  const startSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || roots.length === 0) return;
    if (workspaceInstanceId) {
      setSearchHistory(pushWorkspaceSearchHistory(workspaceInstanceId, trimmed));
    }
    teardownSearch();
    groupsRef.current = new Map();
    setGroups([]);
    setSummary(null);
    setError(null);
    setFileExpand({});
    setCollapsedFiles({});
    languagesRef.current = {};
    setLanguagesByPath({});
    setStatus("searching");

    // ED-FIND-003 A1: the scope plan is built live (scopePlan memo) so the
    // notice below and the search consume one plan. Unresolved plans
    // (module scope without ready facts) fail closed here with a visible
    // reason and never reach the backend (A3).
    const plan = scopePlan;
    if (plan.status !== "ready") {
      setStatus("error");
      setError(plan.reason);
      return;
    }
    // Project scope spans every workspace root; module/directory scopes use
    // the exact plan roots. Client-side filtering below applies to
    // facts-derived scopes only, so other roots' matches are never dropped.
    const filterPlan = plan.kind === "project" ? null : plan;
    const planStructure = factsEntry?.structure ?? null;
    const searchRoots: WorkspaceSearchRoot[] = filterPlan === null
      ? roots.map((root) => ({ id: root.id, name: root.name, path: root.path }))
      : plan.roots.map((rootPath, index) => ({
        id: `scope-${index}`,
        name: rootPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? rootPath,
        path: rootPath,
      }));

    const searchId = newWorkspaceSearchId();
    searchIdRef.current = searchId;
    try {
      const unlisten = await subscribeWorkspaceSearch(searchId, (event) => {
        if (searchIdRef.current !== searchId) return;
        // ED-FIND-003 A4: facts-derived scopes stop publishing once the
        // snapshot moves under a running search. Filesystem scopes are
        // facts-independent and keep streaming.
        if (filterPlan !== null && filterPlan.generation !== undefined) {
          const liveGeneration = useProjectFactsStore
            .getState()
            .getWorkspaceFacts(workspaceRoot).generation;
          if (liveGeneration !== filterPlan.generation) {
            teardownSearch();
            setStatus("error");
            setError(
              `Project facts changed during search (G${filterPlan.generation} -> G${liveGeneration}); run the search again`,
            );
            return;
          }
        }
        if (event.kind === "batch") {
          for (const match of event.matches) {
            if (filterPlan !== null) {
              const absolute = `${(match.rootPath ?? "").replace(/\/+$/, "")}/${(match.path ?? "").replace(/^\/+/, "")}`;
              if (!isFileInScopePlan(absolute, filterPlan, planStructure)) continue;
            }
            const key = groupKey(match);
            const group = groupsRef.current.get(key);
            if (group) group.matches.push(match);
            else groupsRef.current.set(key, { key, title: groupTitle(match), matches: [match] });
          }
          setGroups([...groupsRef.current.values()]);
          return;
        }
        unlistenRef.current?.();
        unlistenRef.current = null;
        searchIdRef.current = null;
        if (event.kind === "error") {
          setStatus("error");
          setError(event.error ?? "Search failed");
          return;
        }
        setStatus("done");
        setSummary({
          filesScanned: event.filesScanned,
          totalMatches: event.totalMatches,
          truncated: event.truncated,
          cancelled: event.cancelled,
        });
      });
      if (searchIdRef.current !== searchId) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
      await workspaceSearchStart(
        searchId,
        searchRoots,
        trimmed,
        {
          caseSensitive,
          wholeWord,
          regexp,
          includeGlobs: splitGlobs(includeGlobs),
          excludeGlobs: splitGlobs(excludeGlobs),
          maxTotalMatches: MAX_TOTAL_MATCHES,
        },
      );
    } catch (err) {
      if (searchIdRef.current === searchId) {
        unlistenRef.current?.();
        unlistenRef.current = null;
        searchIdRef.current = null;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [caseSensitive, excludeGlobs, factsEntry, factsModules, includeGlobs, query, regexp, roots, scopeDirectory, scopeKind, scopeModuleId, teardownSearch, wholeWord, workspaceInstanceId, workspaceRoot]);

  const cancelSearch = useCallback(() => {
    const active = searchIdRef.current;
    if (!active) return;
    void workspaceSearchCancel(active).catch(() => {});
  }, []);

  const totalShown = useMemo(
    () => groups.reduce((sum, group) => sum + group.matches.length, 0),
    [groups],
  );

  const allMatches = useMemo(
    () => groups.flatMap((group) => group.matches),
    [groups],
  );

  const visibleLimitFor = useCallback((key: string, total: number): number => {
    const expand = fileExpand[key];
    if (expand === "all") return total;
    if (typeof expand === "number") return Math.min(total, expand);
    return Math.min(total, DEFAULT_MATCHES_PER_FILE);
  }, [fileExpand]);

  const toggleFileCollapsed = useCallback((key: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const showMoreForFile = useCallback((key: string, total: number) => {
    setFileExpand((prev) => {
      const current = prev[key];
      const base = current === "all"
        ? total
        : typeof current === "number"
          ? current
          : DEFAULT_MATCHES_PER_FILE;
      const next = base + MATCHES_PER_FILE_STEP;
      return { ...prev, [key]: next >= total ? "all" : next };
    });
  }, []);

  const showAllForFile = useCallback((key: string) => {
    setFileExpand((prev) => ({ ...prev, [key]: "all" }));
  }, []);

  // Lazily resolve CodeMirror languages for result paths so lines can share
  // the same grammar as the editor (and use --taomni-code-syntax-* colors).
  useEffect(() => {
    const paths = new Set<string>();
    for (const group of groups) {
      if (group.matches[0]) paths.add(group.matches[0].path);
    }
    let cancelled = false;
    for (const path of paths) {
      if (Object.prototype.hasOwnProperty.call(languagesRef.current, path)) continue;
      void languageForSearchPath(path).then((language) => {
        if (cancelled) return;
        languagesRef.current = { ...languagesRef.current, [path]: language };
        setLanguagesByPath((prev) => (
          Object.prototype.hasOwnProperty.call(prev, path) ? prev : { ...prev, [path]: language }
        ));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [groups]);

  const renderMatchLine = useCallback((match: WorkspaceSearchMatch, segments: MatchSegments): ReactNode => {
    const hasLanguage = Object.prototype.hasOwnProperty.call(languagesByPath, match.path);
    const language = hasLanguage ? languagesByPath[match.path] ?? null : null;
    const spans = hasLanguage && language
      ? highlightSearchLine(segments.text, segments.hitStart, segments.hitEnd, language)
      : null;

    // Plain fallback (language not resolved yet, or unknown extension): before/hit/after
    // already carry … elision markers from matchSegments.
    if (!spans) {
      return (
        <>
          {segments.before}
          <mark
            className="rounded-sm border border-[var(--taomni-code-find-match-border)] bg-[var(--taomni-code-find-match-bg)] px-0.5 font-semibold text-[var(--taomni-code-find-match-fg)]"
            data-testid="code-workspace-find-match-hit"
          >
            {segments.hit}
          </mark>
          {segments.after}
        </>
      );
    }

    return (
      <>
        {segments.elidedStart ? "…" : null}
        {spans.map((span, index) => {
          if (span.hit) {
            return (
              <mark
                key={`h-${index}`}
                className="rounded-sm border border-[var(--taomni-code-find-match-border)] bg-[var(--taomni-code-find-match-bg)] px-0.5 font-semibold text-[var(--taomni-code-find-match-fg)]"
                data-testid="code-workspace-find-match-hit"
              >
                {span.text}
              </mark>
            );
          }
          if (span.className) {
            return (
              <span key={`t-${index}`} className={span.className}>
                {span.text}
              </span>
            );
          }
          return <span key={`p-${index}`}>{span.text}</span>;
        })}
        {segments.elidedEnd ? "…" : null}
      </>
    );
  }, [languagesByPath]);

  const replaceAll = useCallback(async () => {
    if (!onReplaceMatches || allMatches.length === 0 || replacing) return;
    const files = new Set(allMatches.map((match) => `${match.rootId}:${match.path}`)).size;
    const ok = window.confirm(
      `Replace ${allMatches.length} occurrence${allMatches.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}?`,
    );
    if (!ok) return;
    setReplacing(true);
    try {
      await onReplaceMatches(allMatches, replacement);
    } finally {
      setReplacing(false);
    }
  }, [allMatches, onReplaceMatches, replacement, replacing]);

  const toggles = [
    { label: "Match case", icon: <CaseSensitive className="h-3.5 w-3.5" />, value: caseSensitive, set: setCaseSensitive },
    { label: "Whole word", icon: <WholeWord className="h-3.5 w-3.5" />, value: wholeWord, set: setWholeWord },
    { label: "Regular expression", icon: <Regex className="h-3.5 w-3.5" />, value: regexp, set: setRegexp },
  ];

  return (
    <div data-testid="code-workspace-find-in-files-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="shrink-0 flex flex-wrap items-center gap-1.5 border-b border-[var(--taomni-code-border)] px-2 py-1.5">
        <div className="flex min-w-44 flex-1 items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            list={workspaceInstanceId ? "code-workspace-search-history" : undefined}
            placeholder="Search in files (Enter to run)"
            aria-label="Search query"
            className="h-6 min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void startSearch();
              else if (event.key === "Escape") cancelSearch();
            }}
          />
          {workspaceInstanceId && searchHistory.length > 0 && (
            <datalist id="code-workspace-search-history">
              {searchHistory.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          )}
          {toggles.map((toggle) => (
            <button
              key={toggle.label}
              type="button"
              title={toggle.label}
              aria-label={toggle.label}
              aria-pressed={toggle.value}
              data-active={toggle.value || undefined}
              className="h-5 w-5 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
              onClick={() => toggle.set((current) => !current)}
            >
              {toggle.icon}
            </button>
          ))}
        </div>
        <label className="inline-flex h-6 items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <span className="sr-only">Search scope</span>
          <select
            aria-label="Search scope"
            data-testid="code-workspace-find-scope-select"
            value={scopeKind}
            onChange={(event) => setScopeKind(event.target.value as FindInFilesScopeKind)}
            className="h-full bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none"
          >
            <option value="project">Project</option>
            <option value="module">Module</option>
            <option value="directory">Directory</option>
          </select>
        </label>
        {scopeKind === "module" && (
          <label className="inline-flex h-6 min-w-24 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
            <span className="sr-only">Search module</span>
            <select
              aria-label="Search module"
              data-testid="code-workspace-find-module-select"
              value={scopeModuleId || factsModules[0]?.id || ""}
              onChange={(event) => setScopeModuleId(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none"
            >
              {factsModules.length === 0 && <option value="">No modules</option>}
              {factsModules.map((mod) => (
                <option key={mod.id} value={mod.id}>{mod.id}</option>
              ))}
            </select>
          </label>
        )}
        {scopeKind === "directory" && (
          <label className="inline-flex h-6 w-40 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
            <input
              type="text"
              value={scopeDirectory}
              placeholder="subdir (empty = root)"
              aria-label="Search directory"
              data-testid="code-workspace-find-directory-input"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
              onChange={(event) => setScopeDirectory(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void startSearch()}
            />
          </label>
        )}
        <label className="inline-flex h-6 w-32 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            type="search"
            value={includeGlobs}
            placeholder="include: *.ts, src/**"
            aria-label="Include globs"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setIncludeGlobs(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void startSearch()}
          />
        </label>
        <label className="inline-flex h-6 w-32 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            type="search"
            value={excludeGlobs}
            placeholder="exclude: dist/**"
            aria-label="Exclude globs"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setExcludeGlobs(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void startSearch()}
          />
        </label>
        <label className="inline-flex h-6 w-36 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace text"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setReplacement(event.target.value)}
          />
        </label>
        {status === "searching" ? (
          <button
            type="button"
            aria-label="Cancel search"
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={cancelSearch}
          >
            <Ban className="h-3.5 w-3.5" />
            <span>Cancel</span>
          </button>
        ) : (
          <button
            type="button"
            aria-label="Run search"
            disabled={!query.trim() || roots.length === 0}
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
            onClick={() => void startSearch()}
          >
            <Search className="h-3.5 w-3.5" />
            <span>Search</span>
          </button>
        )}
        {onReplaceMatches && (
          <button
            type="button"
            aria-label="Replace all matches"
            disabled={allMatches.length === 0 || replacing || status === "searching"}
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
            onClick={() => void replaceAll()}
          >
            <span>{replacing ? "Replacing…" : "Replace All"}</span>
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--taomni-code-muted)]">
          {status === "searching" && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === "searching" && `${totalShown} so far`}
          {status === "done" && summary && (
            `${summary.totalMatches} result${summary.totalMatches === 1 ? "" : "s"} · ${groups.length} file${groups.length === 1 ? "" : "s"}`
          )}
        </span>
      </div>
      {(summary?.truncated || summary?.cancelled) && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] text-amber-500">
          {summary.cancelled ? "Search cancelled — results are partial." : `Match limit reached (${MAX_TOTAL_MATCHES}) — refine the query to see everything.`}
        </div>
      )}
      {scopePlan.status !== "ready" && (
        <div
          data-testid="code-workspace-find-scope-notice"
          className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] text-amber-500"
        >
          {scopePlan.reason} — switch scope or refresh project facts.
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {error && (
          <div data-testid="code-workspace-find-error" className="mx-2 mb-1 rounded border border-red-500/30 bg-red-500/10 p-2 text-red-500">{error}</div>
        )}
        {!error && groups.length === 0 && (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            {roots.length === 0
              ? "Add a folder to the workspace to search its files"
              : status === "done"
                ? "No results"
                : status === "searching"
                  ? "Searching..."
                  : "Search file contents across all workspace roots"}
          </div>
        )}
        {groups.map((group) => {
          const total = group.matches.length;
          const collapsed = Boolean(collapsedFiles[group.key]);
          const visibleLimit = visibleLimitFor(group.key, total);
          const visibleMatches = collapsed ? [] : group.matches.slice(0, visibleLimit);
          const hiddenCount = collapsed ? total : Math.max(0, total - visibleLimit);
          const Chevron = collapsed ? ChevronRight : ChevronDown;
          return (
            <section key={group.key} data-testid="code-workspace-find-file-group" data-file={group.title}>
              <button
                type="button"
                className="h-6 w-full flex items-center gap-2 px-3 font-medium text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                title={group.title}
                aria-expanded={!collapsed}
                aria-label={collapsed ? `Expand ${group.title}` : `Collapse ${group.title}`}
                onClick={() => toggleFileCollapsed(group.key)}
              >
                <Chevron className="h-3.5 w-3.5 shrink-0" />
                <File className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{group.title}</span>
                <span className="shrink-0 text-[10px] tabular-nums" data-testid="code-workspace-find-file-count">
                  {collapsed || hiddenCount === 0
                    ? `${total}`
                    : `${visibleLimit}/${total}`}
                </span>
              </button>
              {visibleMatches.map((match, index) => {
                const segments = matchSegments(match);
                return (
                  <button
                    key={`${match.lineNumber}:${match.column}:${index}`}
                    type="button"
                    className="h-6 w-full min-w-0 flex items-center gap-2 px-4 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                    title={`${group.title}:${match.lineNumber}:${match.column}`}
                    onClick={() => onOpenMatch(match, { preview: true })}
                    onDoubleClick={() => onOpenMatch(match, { preview: false })}
                  >
                    <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                      {match.lineNumber}:{match.column}
                    </span>
                    <span className="taomni-find-line min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--taomni-code-text)]">
                      {renderMatchLine(match, segments)}
                    </span>
                  </button>
                );
              })}
              {!collapsed && hiddenCount > 0 && (
                <div className="flex items-center gap-2 px-4 py-0.5 text-[10px] text-[var(--taomni-code-muted)]">
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
                    aria-label={`Show more matches in ${group.title}`}
                    data-testid="code-workspace-find-show-more"
                    onClick={() => showMoreForFile(group.key, total)}
                  >
                    Show more ({Math.min(MATCHES_PER_FILE_STEP, hiddenCount)} of {hiddenCount})
                  </button>
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
                    aria-label={`Show all matches in ${group.title}`}
                    data-testid="code-workspace-find-show-all"
                    onClick={() => showAllForFile(group.key)}
                  >
                    Show all
                  </button>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
