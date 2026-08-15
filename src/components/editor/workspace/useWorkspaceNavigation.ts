import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../types";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../stores/codeWorkspaceStore";
import type { GoToFileItem, SearchEverywhereMode } from "./SearchEverywhere";
import type { RecentFileEntry } from "./RecentFilesPopup";
import { createDoubleShiftDetector } from "./doubleShift";
import {
  fileKey,
  fileMeta,
  NAV_HISTORY_LIMIT,
  RECENT_FILES_LIMIT,
  shouldHideEntry,
  type FlatFilesState,
  type OpenFileState,
} from "./codeWorkspaceModel";

/** One IDE navigation-history entry: file + caret (IDEA Navigate Back/Forward). */
export interface WorkspaceNavLocation {
  ref: CodeWorkspaceFileRef;
  line: number;
  character: number;
}

export interface WorkspaceNavPosition {
  line: number;
  character: number;
}

interface UseWorkspaceNavigationOptions {
  workspaceInstanceId: string;
  activeKey: string | null;
  roots: CodeWorkspaceRootInfo[];
  flatFiles: Record<string, FlatFilesState>;
  visible: boolean;
  rootsRef: RefObject<CodeWorkspaceRootInfo[]>;
  looseFilesRef: RefObject<CodeWorkspaceLooseFileInfo[]>;
  openFilesRef: RefObject<Record<string, OpenFileState>>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  openFile: (
    ref: CodeWorkspaceFileRef,
    options?: { preview?: boolean; groupId?: EditorGroupId },
  ) => Promise<void>;
  /** Reveal caret after back/forward (same path as go-to-definition). */
  revealLocation: (key: string, position: WorkspaceNavPosition) => void;
  setSearchEverywhereMode: (mode: SearchEverywhereMode) => void;
  setSearchEverywhereOpen: (open: boolean) => void;
  setRecentEntries: (entries: RecentFileEntry[]) => void;
  setRecentFilesOpen: (open: boolean) => void;
}

export interface WorkspaceNavigationController {
  navCan: { back: boolean; forward: boolean };
  goToFileItems: GoToFileItem[];
  goToFileLoading: boolean;
  goToFileTruncated: boolean;
  openSearchEverywhere: (mode?: SearchEverywhereMode) => void;
  openGoToFileItem: (item: GoToFileItem, options?: { split: boolean }) => void;
  navigateHistory: (delta: -1 | 1) => void;
  /**
   * Push an explicit (file, caret) entry — call before go-to-definition and after
   * landing so Ctrl+Alt+Left restores the previous code focus like IDEA.
   *
   * - `replaceSameFile` (default true): refine the current stack entry when still
   *   on the same file (origin caret before a jump).
   * - `replaceSameFile: false`: always push a new entry (destination after a jump,
   *   including same-file definition targets).
   */
  recordNavigationLocation: (
    ref: CodeWorkspaceFileRef,
    position: WorkspaceNavPosition,
    options?: { replaceSameFile?: boolean },
  ) => void;
  /**
   * Suppress the next activeKey-driven history push (pair with openFile +
   * recordNavigationLocation when landing on a go-to-definition target).
   */
  suppressNextHistoryRecord: () => void;
  /** Remember the live caret so tab switches keep accurate history positions. */
  noteCaretPosition: (key: string, position: WorkspaceNavPosition) => void;
  /** Remap or remove history/recent references after LSP resource operations. */
  reconcileFileReferences: (
    transform: (ref: CodeWorkspaceFileRef) => CodeWorkspaceFileRef | null,
  ) => void;
  openRecentFiles: (options?: { changedOnly?: boolean }) => void;
  recentChangedOnly: boolean;
  recordEditLocation: (ref: CodeWorkspaceFileRef, position: WorkspaceNavPosition) => void;
  navigateLastEditLocation: () => void;
  pickRecentFile: (entry: RecentFileEntry) => void;
}

function sameNavLocation(a: WorkspaceNavLocation | undefined, b: WorkspaceNavLocation): boolean {
  if (!a) return false;
  return fileKey(a.ref) === fileKey(b.ref)
    && a.line === b.line
    && a.character === b.character;
}

export function useWorkspaceNavigation({
  workspaceInstanceId,
  activeKey,
  roots,
  flatFiles,
  visible,
  rootsRef,
  looseFilesRef,
  openFilesRef,
  loadFlatFiles,
  openFile,
  revealLocation,
  setSearchEverywhereMode,
  setSearchEverywhereOpen,
  setRecentEntries,
  setRecentFilesOpen,
}: UseWorkspaceNavigationOptions): WorkspaceNavigationController {
  const setSplitOrientation = useCodeWorkspaceStore((state) => state.setSplitOrientation);
  const [navCan, setNavCan] = useState({ back: false, forward: false });
  const [recentChangedOnly, setRecentChangedOnly] = useState(false);
  const navHistoryRef = useRef<{
    stack: WorkspaceNavLocation[];
    index: number;
    /** Skip the next activeKey-driven push (history walk or explicit open+record). */
    suppress: boolean;
  }>({ stack: [], index: -1, suppress: false });
  const recentFilesRef = useRef<CodeWorkspaceFileRef[]>([]);
  const lastEditLocationRef = useRef<WorkspaceNavLocation | null>(null);
  const changedFileKeysRef = useRef<Set<string>>(new Set());
  const caretByKeyRef = useRef<Record<string, WorkspaceNavPosition>>({});
  const previousActiveKeyRef = useRef<string | null>(null);

  const openSearchEverywhere = useCallback((mode: SearchEverywhereMode = "files") => {
    rootsRef.current?.forEach((root) => void loadFlatFiles(root.id));
    setSearchEverywhereMode(mode);
    setSearchEverywhereOpen(true);
  }, [loadFlatFiles, rootsRef, setSearchEverywhereMode, setSearchEverywhereOpen]);

  const goToFileItems = useMemo<GoToFileItem[]>(() => {
    const items: GoToFileItem[] = [];
    for (const root of roots) {
      const state = flatFiles[root.id];
      if (!state) continue;
      for (const entry of state.entries) {
        if (entry.fileType !== "file" || shouldHideEntry(entry)) continue;
        items.push({ rootId: root.id, rootName: root.name, path: entry.path });
      }
    }
    return items;
  }, [flatFiles, roots]);

  const goToFileLoading = useMemo(
    () => roots.some((root) => flatFiles[root.id]?.loading ?? false),
    [flatFiles, roots],
  );
  const goToFileTruncated = useMemo(
    () => roots.some((root) => flatFiles[root.id]?.truncated ?? false),
    [flatFiles, roots],
  );

  const openGoToFileItem = useCallback((item: GoToFileItem, options?: { split: boolean }) => {
    setSearchEverywhereOpen(false);
    const ref: CodeWorkspaceFileRef = { kind: "root", rootId: item.rootId, path: item.path };
    if (options?.split) {
      const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      const targetGroupId: EditorGroupId = current.activeEditorGroupId === "primary"
        ? "secondary"
        : "primary";
      setSplitOrientation(workspaceInstanceId, "vertical");
      void openFile(ref, { groupId: targetGroupId });
      return;
    }
    void openFile(ref, { preview: true });
  }, [openFile, setSearchEverywhereOpen, setSplitOrientation, workspaceInstanceId]);

  const noteCaretPosition = useCallback((key: string, position: WorkspaceNavPosition) => {
    caretByKeyRef.current[key] = {
      line: Math.max(0, position.line),
      character: Math.max(0, position.character),
    };
  }, []);

  const recordEditLocation = useCallback(
    (ref: CodeWorkspaceFileRef, position: WorkspaceNavPosition) => {
      const key = fileKey(ref);
      changedFileKeysRef.current.add(key);
      lastEditLocationRef.current = {
        ref,
        line: Math.max(0, position.line),
        character: Math.max(0, position.character),
      };
    },
    [],
  );

  const navigateLastEditLocation = useCallback(() => {
    const edit = lastEditLocationRef.current;
    if (!edit) return;
    const key = fileKey(edit.ref);
    revealLocation(key, { line: edit.line, character: edit.character });
    void openFile(edit.ref);
  }, [openFile, revealLocation]);

  const recordNavigationLocation = useCallback((
    ref: CodeWorkspaceFileRef,
    position: WorkspaceNavPosition,
    options?: { replaceSameFile?: boolean },
  ) => {
    const replaceSameFile = options?.replaceSameFile !== false;
    const entry: WorkspaceNavLocation = {
      ref,
      line: Math.max(0, position.line),
      character: Math.max(0, position.character),
    };
    caretByKeyRef.current[fileKey(ref)] = {
      line: entry.line,
      character: entry.character,
    };
    const nav = navHistoryRef.current;
    // Explicit destination records win over a pending suppress from openFile.
    nav.suppress = false;
    if (sameNavLocation(nav.stack[nav.index], entry)) {
      setNavCan({ back: nav.index > 0, forward: nav.index < nav.stack.length - 1 });
      return;
    }
    const current = nav.stack[nav.index];
    // Origin recording: keep a single refined caret for the active file.
    if (replaceSameFile && current && fileKey(current.ref) === fileKey(ref)) {
      nav.stack[nav.index] = entry;
      setNavCan({ back: nav.index > 0, forward: nav.index < nav.stack.length - 1 });
      return;
    }
    nav.stack = [...nav.stack.slice(0, nav.index + 1), entry].slice(-NAV_HISTORY_LIMIT);
    nav.index = nav.stack.length - 1;
    setNavCan({ back: nav.index > 0, forward: false });
  }, []);

  const suppressNextHistoryRecord = useCallback(() => {
    navHistoryRef.current.suppress = true;
  }, []);

  const reconcileFileReferences = useCallback((
    transform: (ref: CodeWorkspaceFileRef) => CodeWorkspaceFileRef | null,
  ) => {
    const nav = navHistoryRef.current;
    const knownRefs = new Map<string, CodeWorkspaceFileRef>();
    for (const entry of nav.stack) knownRefs.set(fileKey(entry.ref), entry.ref);
    for (const ref of recentFilesRef.current) knownRefs.set(fileKey(ref), ref);
    for (const file of Object.values(openFilesRef.current ?? {})) {
      knownRefs.set(file.key, file.ref);
    }

    const nextStack: WorkspaceNavLocation[] = [];
    let nextIndex = -1;
    nav.stack.forEach((entry, index) => {
      const ref = transform(entry.ref);
      if (!ref) return;
      nextStack.push({ ...entry, ref });
      if (index <= nav.index) nextIndex = nextStack.length - 1;
    });
    nav.stack = nextStack;
    nav.index = nextStack.length === 0 ? -1 : Math.max(0, Math.min(nextIndex, nextStack.length - 1));

    const seenRecent = new Set<string>();
    recentFilesRef.current = recentFilesRef.current.flatMap((ref) => {
      const next = transform(ref);
      if (!next) return [];
      const key = fileKey(next);
      if (seenRecent.has(key)) return [];
      seenRecent.add(key);
      return [next];
    });

    const nextCaret: Record<string, WorkspaceNavPosition> = {};
    for (const [key, position] of Object.entries(caretByKeyRef.current)) {
      const ref = knownRefs.get(key);
      if (!ref) {
        nextCaret[key] = position;
        continue;
      }
      const next = transform(ref);
      if (next) nextCaret[fileKey(next)] = position;
    }
    caretByKeyRef.current = nextCaret;
    const previousRef = previousActiveKeyRef.current
      ? knownRefs.get(previousActiveKeyRef.current)
      : null;
    if (previousRef) {
      const next = transform(previousRef);
      previousActiveKeyRef.current = next ? fileKey(next) : null;
    }
    setNavCan({
      back: nav.index > 0,
      forward: nav.index >= 0 && nav.index < nav.stack.length - 1,
    });

    if (lastEditLocationRef.current) {
      const rewrittenEdit = transform(lastEditLocationRef.current.ref);
      lastEditLocationRef.current = rewrittenEdit
        ? { ...lastEditLocationRef.current, ref: rewrittenEdit }
        : null;
    }
  }, [openFilesRef]);

  useEffect(() => {
    if (!activeKey) {
      previousActiveKeyRef.current = null;
      return;
    }
    const ref = openFilesRef.current?.[activeKey]?.ref;
    if (!ref) return;

    recentFilesRef.current = [
      ref,
      ...recentFilesRef.current.filter((item) => fileKey(item) !== activeKey),
    ].slice(0, RECENT_FILES_LIMIT);

    const nav = navHistoryRef.current;
    const prevKey = previousActiveKeyRef.current;
    previousActiveKeyRef.current = activeKey;

    // Before switching away, persist the previous file's live caret onto the
    // current stack entry so Navigate Back restores the real code focus.
    if (prevKey && prevKey !== activeKey) {
      const prevPos = caretByKeyRef.current[prevKey];
      const current = nav.stack[nav.index];
      if (prevPos && current && fileKey(current.ref) === prevKey) {
        nav.stack[nav.index] = {
          ...current,
          line: prevPos.line,
          character: prevPos.character,
        };
      }
    }

    if (nav.suppress) {
      nav.suppress = false;
      setNavCan({ back: nav.index > 0, forward: nav.index < nav.stack.length - 1 });
      return;
    }

    const pos = caretByKeyRef.current[activeKey] ?? { line: 0, character: 0 };
    const entry: WorkspaceNavLocation = {
      ref,
      line: pos.line,
      character: pos.character,
    };
    if (sameNavLocation(nav.stack[nav.index], entry)) {
      setNavCan({ back: nav.index > 0, forward: nav.index < nav.stack.length - 1 });
      return;
    }
    // Same file as current entry (e.g. only caret moved via explicit record) —
    // do not double-push on re-render when keys match.
    if (nav.index >= 0 && nav.stack[nav.index] && fileKey(nav.stack[nav.index].ref) === activeKey) {
      setNavCan({ back: nav.index > 0, forward: nav.index < nav.stack.length - 1 });
      return;
    }
    nav.stack = [...nav.stack.slice(0, nav.index + 1), entry].slice(-NAV_HISTORY_LIMIT);
    nav.index = nav.stack.length - 1;
    setNavCan({ back: nav.index > 0, forward: false });
  }, [activeKey, openFilesRef]);

  const navigateHistory = useCallback((delta: -1 | 1) => {
    const nav = navHistoryRef.current;
    const nextIndex = nav.index + delta;
    if (nextIndex < 0 || nextIndex >= nav.stack.length) return;
    const entry = nav.stack[nextIndex];
    if (!entry) return;
    nav.index = nextIndex;
    nav.suppress = true;
    setNavCan({ back: nextIndex > 0, forward: nextIndex < nav.stack.length - 1 });
    const key = fileKey(entry.ref);
    caretByKeyRef.current[key] = { line: entry.line, character: entry.character };
    revealLocation(key, { line: entry.line, character: entry.character });
    void openFile(entry.ref);
  }, [openFile, revealLocation]);

  const openRecentFiles = useCallback((options?: { changedOnly?: boolean }) => {
    const changedOnly = !!options?.changedOnly;
    setRecentChangedOnly(changedOnly);
    let refs = recentFilesRef.current;
    if (changedOnly) {
      refs = refs.filter((ref) => {
        const key = fileKey(ref);
        const open = openFilesRef.current?.[key];
        return (open && open.dirty) || changedFileKeysRef.current.has(key);
      });
    }
    const entries: RecentFileEntry[] = refs.map((ref) => {
      const key = fileKey(ref);
      const open = openFilesRef.current?.[key];
      const meta = fileMeta(ref, rootsRef.current ?? [], looseFilesRef.current ?? []);
      return {
        key,
        ref,
        title: open?.title || meta.title,
        subtitle: open?.subtitle || meta.subtitle,
        open: !!open,
      };
    });
    setRecentEntries(entries);
    setRecentFilesOpen(true);
  }, [looseFilesRef, openFilesRef, rootsRef, setRecentEntries, setRecentFilesOpen]);

  const pickRecentFile = useCallback((entry: RecentFileEntry) => {
    setRecentFilesOpen(false);
    void openFile(entry.ref);
  }, [openFile, setRecentFilesOpen]);

  useEffect(() => {
    if (!visible) return;
    const detector = createDoubleShiftDetector(() => openSearchEverywhere("all"));
    const handleKeyDown = (event: KeyboardEvent) => detector.handleKeyDown(event);
    const handleKeyUp = (event: KeyboardEvent) => detector.handleKeyUp(event);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [openSearchEverywhere, visible]);

  return {
    navCan,
    goToFileItems,
    goToFileLoading,
    goToFileTruncated,
    openSearchEverywhere,
    openGoToFileItem,
    navigateHistory,
    recordNavigationLocation,
    suppressNextHistoryRecord,
    noteCaretPosition,
    reconcileFileReferences,
    openRecentFiles,
    recentChangedOnly,
    recordEditLocation,
    navigateLastEditLocation,
    pickRecentFile,
  };
}
