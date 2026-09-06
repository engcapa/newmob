import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearWelcomeRunSnapshot,
  getWelcomeRunSnapshot,
  recordWelcomeRunSnapshot,
  type RunEntryInput,
  type RunSnapshot,
  type RunSnapshotIssue,
} from "../lib/ipc";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import {
  isRestorableKind,
  type BatchOutcome,
  type EntryOutcome,
  type ResumeIssue,
} from "../lib/welcomeRunRestore";

export type RestoreViewState =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "available"; snapshot: RunSnapshot }
  | { state: "restoring"; operationId: string; snapshot: RunSnapshot; done: number; total: number }
  | { state: "awaiting-auth"; operationId: string; snapshot: RunSnapshot; done: number; total: number }
  | {
      state: "succeeded" | "partial" | "failed";
      snapshot: RunSnapshot;
      operationId: string;
      results: EntryOutcome[];
    }
  | { state: "unavailable"; reason: "storage" | "schema"; message: string };

const RUN_ID_KEY = "taomni.welcome.runId.v1";
const EXCLUDED_SNAPSHOT_KINDS = new Set([
  "welcome",
  "settings",
  "placeholder",
  "code-workspace",
  "git",
  "nettools",
  "sockscap",
  "lan-chat",
  "notes",
  "servers",
  "browser",
]);

function getOrCreateRunId(): string {
  try {
    const existing = localStorage.getItem(RUN_ID_KEY);
    if (existing) return existing;
    const fresh = globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}`;
    localStorage.setItem(RUN_ID_KEY, fresh);
    return fresh;
  } catch {
    return `run-${Date.now()}`;
  }
}

export function collectSnapshotEntries(): { entries: RunEntryInput[]; activeEntryKey: string | null } {
  const { tabs, activeTabId, cwdByTab } = useAppStore.getState();
  const { sessions } = useSessionStore.getState();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const entries: RunEntryInput[] = [];
  const keyForTab = new Map<string, string>();
  tabs.forEach((tab, index) => {
    if (EXCLUDED_SNAPSHOT_KINDS.has(tab.type)) return;
    if (tab.type === "terminal") {
      if (tab.sessionId) {
        const session = byId.get(tab.sessionId);
        if (!session) return;
        const key = `saved:${tab.sessionId}`;
        if (keyForTab.has(key)) return;
        keyForTab.set(key, tab.id);
        entries.push({
          entryKey: key,
          orderIndex: index,
          kind: "terminal",
          savedSessionId: session.id,
          savedSessionType: session.session_type,
          displayName: session.name || tab.title,
          localCwd: cwdByTab[tab.id] ?? tab.terminalInitialCwd ?? null,
          tempShell: null,
          profileRef: null,
        });
      } else {
        // Temp native-local terminal whitelist: needs a resolvable shell.
        const shell = tab.localShell;
        if (!shell?.id || !shell.name) return;
        if (shell.id.startsWith("wsl:")) return;
        const key = `temp:${tab.id}`;
        keyForTab.set(key, tab.id);
        entries.push({
          entryKey: key,
          orderIndex: index,
          kind: "terminal",
          savedSessionId: null,
          savedSessionType: null,
          displayName: tab.title || "Local terminal",
          localCwd: cwdByTab[tab.id] ?? tab.terminalInitialCwd ?? null,
          tempShell: { id: shell.id, name: shell.name, args: shell.args ?? [] },
          profileRef: null,
        });
      }
      return;
    }
    // Saved-config tabs: sftp/rdp/vnc/database/redis/hbase-shell/proxy-test/
    // object-storage/mail/file-browser share Tab.sessionId.
    if (tab.sessionId) {
      if (!isRestorableKind(tab.type)) return;
      const session = byId.get(tab.sessionId);
      if (!session) return;
      const key = `saved:${tab.sessionId}`;
      if (keyForTab.has(key)) return;
      keyForTab.set(key, tab.id);
      entries.push({
        entryKey: key,
        orderIndex: index,
        kind: tab.type,
        savedSessionId: session.id,
        savedSessionType: session.session_type,
        displayName: session.name || tab.title,
        localCwd: null,
        tempShell: null,
        profileRef: null,
      });
    }
  });
  let activeEntryKey: string | null = null;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (activeTab) {
    if (activeTab.sessionId) {
      const candidate = `saved:${activeTab.sessionId}`;
      if (entries.some((e) => e.entryKey === candidate)) activeEntryKey = candidate;
    } else if (activeTab.type === "terminal" && !activeTab.sessionId) {
      const candidate = `temp:${activeTab.id}`;
      if (entries.some((e) => e.entryKey === candidate)) activeEntryKey = candidate;
    }
  }
  return { entries, activeEntryKey };
}

export function useWelcomeRunRestore(openEntry: (entryKey: string) => Promise<EntryOutcome>) {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<RunSnapshotIssue | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [results, setResults] = useState<EntryOutcome[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [awaitingAuth, setAwaitingAuth] = useState(false);
  const cancelRef = useRef(false);
  const activeOpRef = useRef<string | null>(null);
  const suppressRef = useRef(false);
  const runIdRef = useRef(getOrCreateRunId());
  const openEntryRef = useRef(openEntry);
  openEntryRef.current = openEntry;

  const refresh = useCallback(async () => {
    setLoading(true);
    setUnavailable(null);
    try {
      const response = await getWelcomeRunSnapshot();
      if (response.issue && !response.snapshot) {
        setUnavailable(response.issue);
        setSnapshot(null);
      } else {
        setSnapshot(response.snapshot);
      }
    } catch (err) {
      setUnavailable({ code: "storage", message: String(err) });
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Debounced snapshot collection on tab changes; suppressed during restore.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useAppStore.subscribe(() => {
      if (suppressRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (suppressRef.current) return;
        const { entries, activeEntryKey } = collectSnapshotEntries();
        if (entries.length === 0) return;
        const revision = useWelcomeRunRestoreRevision.getState().revision;
        void recordWelcomeRunSnapshot({
          runId: runIdRef.current,
          entries,
          activeEntryKey,
          expectedRevision: revision,
        })
          .then((response) => {
            useWelcomeRunRestoreRevision.getState().setRevision(response.snapshot.revision);
            setSnapshot(response.snapshot);
          })
          .catch(() => undefined);
      }, 1000);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const restore = useCallback(
    async (onlyKeys?: string[]) => {
      if (activeOpRef.current) return activeOpRef.current;
      const current = snapshot;
      if (!current || current.entries.length === 0) return null;
      const targets = onlyKeys
        ? current.entries.filter((e) => onlyKeys.includes(e.entryKey))
        : current.entries;
      if (targets.length === 0) return null;
      const opId = globalThis.crypto?.randomUUID?.() ?? `restore-${Date.now()}`;
      activeOpRef.current = opId;
      setOperationId(opId);
      setResults(null);
      setAwaitingAuth(false);
      cancelRef.current = false;
      suppressRef.current = true;
      const collected: EntryOutcome[] = [];
      try {
        for (let i = 0; i < targets.length; i++) {
          if (cancelRef.current) {
            for (let j = i; j < targets.length; j++) {
              collected.push({
                entryKey: targets[j].entryKey,
                tabId: null,
                status: "cancelled",
                readiness: null,
                issues: [{ code: "cancelled", message: "Cancelled by user" }],
              });
            }
            break;
          }
          setProgress({ done: i, total: targets.length });
          try {
            const outcome = await openEntryRef.current(targets[i].entryKey);
            collected.push(outcome);
          } catch (err) {
            collected.push({
              entryKey: targets[i].entryKey,
              tabId: null,
              status: "failed",
              readiness: null,
              issues: [{ code: "connect", message: String(err) }],
            });
          }
        }
      } finally {
        setProgress(null);
        suppressRef.current = false;
        activeOpRef.current = null;
      }
      setResults(collected);
      const outcome: BatchOutcome = {
        operationId: opId,
        runId: current.runId,
        batchRevision: current.revision,
        results: collected,
      };
      void outcome;
      return opId;
    },
    [snapshot],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const clear = useCallback(async () => {
    await clearWelcomeRunSnapshot(
      useWelcomeRunRestoreRevision.getState().revision || null,
    );
    setSnapshot(null);
    setResults(null);
    await refresh();
  }, [refresh]);

  const view: RestoreViewState = useMemo(() => {
    if (loading) return { state: "loading" };
    if (unavailable) {
      return {
        state: "unavailable",
        reason: unavailable.code === "schema" ? "schema" : "storage",
        message: unavailable.message,
      };
    }
    if (results && snapshot && operationId) {
      const ok = results.filter((r) => r.status === "ready" || r.status === "partial").length;
      const failed = results.filter((r) => r.status === "failed" || r.status === "cancelled").length;
      if (ok === results.length) return { state: "succeeded", snapshot, operationId, results };
      if (ok > 0) return { state: "partial", snapshot, operationId, results };
      void failed;
      return { state: "failed", snapshot, operationId, results };
    }
    if (operationId && snapshot && progress) {
      if (awaitingAuth) {
        return {
          state: "awaiting-auth",
          operationId,
          snapshot,
          done: progress.done,
          total: progress.total,
        };
      }
      return {
        state: "restoring",
        operationId,
        snapshot,
        done: progress.done,
        total: progress.total,
      };
    }
    if (snapshot && snapshot.entries.length > 0) return { state: "available", snapshot };
    return { state: "empty" };
  }, [loading, unavailable, results, snapshot, operationId, progress, awaitingAuth]);

  return {
    view,
    snapshot,
    refresh,
    restore,
    cancel,
    clear,
    setAwaitingAuth,
    isRestoring: operationId !== null && results === null,
  };
}

// Tiny revision holder to avoid re-render loops in the subscriber.
import { create } from "zustand";

const useWelcomeRunRestoreRevision = create<{
  revision: number | null;
  setRevision: (revision: number) => void;
}>((set) => ({
  revision: null,
  setRevision: (revision) => set({ revision }),
}));

export function __setRunRestoreRevisionForTest(revision: number | null): void {
  useWelcomeRunRestoreRevision.getState().setRevision(revision as number);
}

export type { ResumeIssue };
