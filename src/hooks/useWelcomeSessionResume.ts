import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionConfig } from "../lib/ipc";
import {
  clearWelcomeRunSnapshot,
  commitWelcomeRunSnapshot,
  getWelcomeRunSnapshot,
  entryDisplayName,
} from "../lib/welcomeSessionResume";
import type {
  ResumeIssue,
  RunSnapshotRecord,
  SnapshotEntry,
} from "../types";

/**
 * Welcome restore orchestrator (design §4.2.3–4.2.5, D-01 = scheme B).
 *
 * The hook owns the single restore operation, the per-entry outcome state
 * machine and the revision/CAS bookkeeping. MainLayout injects the actual
 * open/locate capability and the run-snapshot collector; WelcomePanel only
 * renders state.
 */

export type EntryStatus = "ready" | "partial" | "failed" | "cancelled";
export type EntryReadiness = "connected" | "client-started" | "view-opened" | null;

export interface EntryOutcome {
  identity: string;
  kind: SnapshotEntry["kind"];
  displayName: string;
  status: EntryStatus;
  readiness: EntryReadiness;
  tabId: string | null;
  issue: ResumeIssue | null;
}

export type RestoreViewState =
  | { state: "loading" }
  | { state: "empty" }
  | {
      state: "available";
      record: RunSnapshotRecord;
      /** legacy-open candidate: shown as "最近会话配置". */
      legacy: boolean;
    }
  | {
      state: "restoring" | "awaiting-auth";
      operationId: string;
      record: RunSnapshotRecord;
      completed: number;
      total: number;
      awaitingEntry: string | null;
    }
  | {
      state: "succeeded" | "partial" | "failed";
      record: RunSnapshotRecord;
      operationId: string;
      outcomes: EntryOutcome[];
    }
  | { state: "unavailable"; reason: "storage" | "schema"; message: string };

export interface OpenEntryResult {
  tabId: string | null;
  status: EntryStatus;
  readiness: EntryReadiness;
  issue: ResumeIssue | null;
}

export interface RestoreCallbacks {
  /** Re-read the current saved config; reject with `ResumeIssue`. */
  loadSessionConfig: (savedSessionId: string) => Promise<SessionConfig>;
  /** Find an existing live tab for the entry (locate, not reopen). */
  findExistingTab: (entry: SnapshotEntry) => string | null;
  /** Focus/activate a tab by id. */
  activateTab: (tabId: string) => void;
  /** Open a saved session through the connect queue (awaits auth). */
  openSavedSession: (
    session: SessionConfig,
    context: { operationId: string; entryIdentity: string },
  ) => Promise<OpenEntryResult>;
  /** Open a whitelist local terminal (fresh PTY). */
  openLocalTerminal: (
    entry: Extract<SnapshotEntry, { kind: "local-terminal" }>,
    context: { operationId: string },
  ) => Promise<OpenEntryResult>;
  /** Cancel any in-flight auth wait owned by `operationId`. */
  cancelPendingAuth: (operationId: string) => void;
  /** Whether the snapshot collector currently suppresses an identity. */
  isIdentitySuppressed?: (identity: string) => boolean;
}

export interface UseWelcomeSessionResumeResult {
  view: RestoreViewState;
  refresh: () => void;
  startRestore: () => void;
  retryFailed: () => void;
  cancelRestore: () => void;
  clearRecord: () => Promise<void>;
  outcomes: EntryOutcome[];
  /** True when the collector must not treat this identity as normal use. */
  isIdentitySuppressed: (identity: string) => boolean;
}

function aggregateStatus(outcomes: EntryOutcome[]): "succeeded" | "partial" | "failed" {
  const failed = outcomes.filter((o) => o.status === "failed" || o.status === "cancelled");
  if (failed.length === 0) return "succeeded";
  if (failed.length === outcomes.length) return "failed";
  return "partial";
}

function makeIssue(code: ResumeIssue["code"], message: string): ResumeIssue {
  return { code, message };
}

export function useWelcomeSessionResume(
  active: boolean,
  callbacks: RestoreCallbacks,
): UseWelcomeSessionResumeResult {
  const [view, setView] = useState<RestoreViewState>({ state: "loading" });
  const [outcomes, setOutcomes] = useState<EntryOutcome[]>([]);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const operationRef = useRef<{ id: string; cancelled: boolean } | null>(null);
  /** Identities owned by failed/cancelled entries: never collect them. */
  const suppressedIdentitiesRef = useRef<Set<string>>(new Set());
  const recordRef = useRef<RunSnapshotRecord | null>(null);
  const revisionRef = useRef<number>(0);

  const isIdentitySuppressed = useCallback((identity: string): boolean => {
    return (
      suppressedIdentitiesRef.current.has(identity) ||
      (operationRef.current !== null &&
        recordRef.current?.entries.some((entry) => entry.identity === identity) === true)
    );
  }, []);

  const load = useCallback(async (force = false) => {
    try {
      const response = await getWelcomeRunSnapshot();
      if (response.issue) {
        // Storage/schema problems are always surfaced, but never clobber a
        // running operation mid-flight.
        if (operationRef.current && !force) return;
        setView({
          state: "unavailable",
          reason: response.issue.code === "unsupported" ? "schema" : "storage",
          message: response.issue.message,
        });
        return;
      }
      const incoming = response.record && response.record.entries.length > 0 ? response.record : null;
      const currentView = viewRef.current;
      const operationActive = operationRef.current !== null;
      const showingOutcome =
        currentView.state === "succeeded" ||
        currentView.state === "partial" ||
        currentView.state === "failed";
      // Re-entering Welcome must not drop an in-flight operation or a
      // finished outcome for the same snapshot (design §4.2.4, AC-13). A
      // genuinely newer snapshot (revision moved) still refreshes the entry.
      const sameSnapshot =
        incoming &&
        recordRef.current &&
        incoming.revision === recordRef.current.revision &&
        incoming.batchId === recordRef.current.batchId;
      if (!force && (operationActive || (showingOutcome && sameSnapshot))) {
        if (incoming) {
          revisionRef.current = incoming.revision;
        }
        return;
      }
      if (incoming) {
        recordRef.current = incoming;
        revisionRef.current = incoming.revision;
        setView({
          state: "available",
          record: incoming,
          legacy: false,
        });
        return;
      }
      if (response.legacyCandidate) {
        // legacy-open: single-entry pseudo record, never claimed as a
        // confirmed snapshot (design §4.2.1).
        const pseudoRecord: RunSnapshotRecord = {
          schemaVersion: 1,
          revision: revisionRef.current,
          runSequence: 0,
          batchId: "",
          committedAtMs: 0,
          entries: [response.legacyCandidate],
          activeIdentity: null,
        };
        recordRef.current = pseudoRecord;
        setView({ state: "available", record: pseudoRecord, legacy: true });
        return;
      }
      recordRef.current = null;
      setView({ state: "empty" });
    } catch (error) {
      setView({ state: "unavailable", reason: "storage", message: String(error) });
    }
  }, []);

  useEffect(() => {
    if (active) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const runEntries = useCallback(
    async (operationId: string, targets: SnapshotEntry[]) => {
      const collected: EntryOutcome[] = [];
      for (const entry of targets) {
        const operation = operationRef.current;
        if (!operation || operation.id !== operationId || operation.cancelled) {
          collected.push({
            identity: entry.identity,
            kind: entry.kind,
            displayName: entryDisplayName(entry),
            status: "cancelled",
            readiness: null,
            tabId: null,
            issue: makeIssue("cancelled", "Restore cancelled"),
          });
          continue;
        }
        let outcome: EntryOutcome;
        try {
          if (entry.kind === "saved-session") {
            // Live tab wins: locate instead of reopening (design §4.2.5).
            const existingTab = callbacksRef.current.findExistingTab(entry);
            if (existingTab) {
              callbacksRef.current.activateTab(existingTab);
              outcome = {
                identity: entry.identity,
                kind: entry.kind,
                displayName: entryDisplayName(entry),
                status: "ready",
                readiness: "view-opened",
                tabId: existingTab,
                issue: null,
              };
            } else {
              const session = await callbacksRef.current.loadSessionConfig(
                entry.savedSessionId,
              );
              if (session.session_type !== entry.savedSessionType) {
                throw makeIssue(
                  "changed-type",
                  `Saved session type changed from ${entry.savedSessionType} to ${session.session_type}`,
                );
              }
              const result = await callbacksRef.current.openSavedSession(session, {
                operationId,
                entryIdentity: entry.identity,
              });
              outcome = {
                identity: entry.identity,
                kind: entry.kind,
                displayName: entryDisplayName(entry),
                status: result.status,
                readiness: result.readiness,
                tabId: result.tabId,
                issue: result.issue,
              };
            }
          } else {
            const result = await callbacksRef.current.openLocalTerminal(entry, {
              operationId,
            });
            outcome = {
              identity: entry.identity,
              kind: entry.kind,
              displayName: entryDisplayName(entry),
              status: result.status,
              readiness: result.readiness,
              tabId: result.tabId,
              issue: result.issue,
            };
          }
        } catch (error) {
          const issue: ResumeIssue =
            (error as { code?: string })?.code
              ? (error as ResumeIssue)
              : makeIssue("connect", String(error));
          outcome = {
            identity: entry.identity,
            kind: entry.kind,
            displayName: entryDisplayName(entry),
            status: "failed",
            readiness: null,
            tabId: null,
            issue,
          };
        }
        collected.push(outcome);
        // Merge with any previously completed outcomes from an earlier pass.
        const previous = outcomesRef.current.filter(
          (o) => o.identity !== outcome.identity,
        );
        setOutcomes([...previous, ...collected]);
        if (
          outcome.status === "ready" ||
          outcome.status === "partial"
        ) {
          suppressedIdentitiesRef.current.delete(outcome.identity);
        } else {
          suppressedIdentitiesRef.current.add(outcome.identity);
        }
        if (viewRef.current.state === "restoring") {
          setView((prev) =>
            prev.state === "restoring"
              ? { ...prev, completed: collected.length, total: targets.length }
              : prev,
          );
        }
      }
      return collected;
    },
    [],
  );

  const outcomesRef = useRef<EntryOutcome[]>([]);
  outcomesRef.current = outcomes;
  const viewRef = useRef<RestoreViewState>(view);
  viewRef.current = view;

  const finishOperation = useCallback((finalOutcomes: EntryOutcome[]) => {
    const operation = operationRef.current;
    operationRef.current = null;
    const record = recordRef.current;
    if (!record) return;
    void record; // locked record stays for retry/display
    const status = aggregateStatus(finalOutcomes);
    setOutcomes(finalOutcomes);
    setView({
      state: status,
      record,
      operationId: operation?.id ?? "",
      outcomes: finalOutcomes,
    });
    if (status === "succeeded" && !record.batchId) {
      // legacy candidate fully used: promote it as the first confirmed batch.
      void commitWelcomeRunSnapshot({
        batchId: "",
        entries: record.entries,
        activeIdentity: record.activeIdentity,
        expectedRevision: undefined,
        restored: true,
      })
        .then((response) => {
          if (response.record) revisionRef.current = response.record.revision;
        })
        .catch(() => undefined);
    }
  }, []);

  const startRestore = useCallback(() => {
    if (operationRef.current) return; // single operation guarantee
    const record = recordRef.current;
    if (!record || record.entries.length === 0) return;
    const operationId = `restore-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    operationRef.current = { id: operationId, cancelled: false };
    setOutcomes([]);
    outcomesRef.current = [];
    setView({
      state: "restoring",
      operationId,
      record,
      completed: 0,
      total: record.entries.length,
      awaitingEntry: null,
    });
    void runEntries(operationId, record.entries).then((finalOutcomes) => {
      // Only finish if this operation is still the active one.
      if (operationRef.current?.id === operationId) {
        finishOperation(finalOutcomes);
      }
    });
  }, [runEntries, finishOperation]);

  const retryFailed = useCallback(() => {
    if (operationRef.current) return;
    const record = recordRef.current;
    if (!record) return;
    const targets = outcomesRef.current
      .filter((o) => o.status === "failed" || o.status === "cancelled")
      .map((o) => record.entries.find((entry) => entry.identity === o.identity))
      .filter((entry): entry is SnapshotEntry => Boolean(entry));
    if (targets.length === 0) return;
    const operationId = `restore-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    operationRef.current = { id: operationId, cancelled: false };
    setView({
      state: "restoring",
      operationId,
      record,
      completed: 0,
      total: targets.length,
      awaitingEntry: null,
    });
    void runEntries(operationId, targets).then((finalOutcomes) => {
      if (operationRef.current?.id === operationId) {
        finishOperation(finalOutcomes);
      }
    });
  }, [runEntries, finishOperation]);

  const cancelRestore = useCallback(() => {
    const operation = operationRef.current;
    if (!operation) return;
    operation.cancelled = true;
    callbacksRef.current.cancelPendingAuth(operation.id);
  }, []);

  const clearRecord = useCallback(async () => {
    try {
      await clearWelcomeRunSnapshot({ expectedRevision: revisionRef.current || undefined });
      recordRef.current = null;
      setOutcomes([]);
      setView({ state: "empty" });
      void load();
    } catch (error) {
      setView({ state: "unavailable", reason: "storage", message: String(error) });
    }
  }, [load]);

  return {
    view,
    refresh: () => void load(),
    startRestore,
    retryFailed,
    cancelRestore,
    clearRecord,
    outcomes,
    isIdentitySuppressed,
  };
}
