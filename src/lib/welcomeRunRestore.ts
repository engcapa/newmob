import type { RunEntry, RunSnapshot, SessionConfig } from "./ipc";

/** Tab kinds excluded from the last-run set (AC-23). Mirrors Rust denylist. */
export const RUN_RESTORE_EXCLUDED_KINDS = new Set([
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

export type EntryOutcomeStatus = "ready" | "partial" | "failed" | "cancelled" | "skipped";
export type EntryReadiness = "connected" | "client-started" | "view-opened" | null;

export interface ResumeIssue {
  code:
    | "missing-session"
    | "changed-type"
    | "missing-directory"
    | "permission-denied"
    | "unavailable-directory"
    | "authentication"
    | "connect"
    | "optional-state"
    | "storage"
    | "cancelled"
    | "existing-config-conflict"
    | "unsupported";
  message: string;
}

export interface EntryOutcome {
  entryKey: string;
  tabId: string | null;
  status: EntryOutcomeStatus;
  readiness: EntryReadiness;
  issues: ResumeIssue[];
}

export interface BatchOutcome {
  operationId: string;
  runId: string;
  batchRevision: number;
  results: EntryOutcome[];
}

export function isRestorableKind(kind: string): boolean {
  return !RUN_RESTORE_EXCLUDED_KINDS.has(kind);
}

/** Non-sensitive identity for conflict detection (no secrets). */
export function sessionFingerprint(session: SessionConfig): string {
  const options = safeParseOptions(session.options_json) as {
    terminalProfile?: { theme?: unknown };
    distro?: unknown;
    wslDistro?: unknown;
    engine?: unknown;
    database?: unknown;
  } | null;
  const relevant = {
    session_type: session.session_type,
    host: session.host,
    port: session.port,
    username: session.username,
    group_path: session.group_path,
    theme: options?.terminalProfile?.theme ?? null,
    distro: options?.distro ?? options?.wslDistro ?? null,
    engine: options?.engine ?? null,
    database: options?.database ?? null,
  };
  return JSON.stringify(relevant);
}

function safeParseOptions(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export function summarizeBatch(outcome: BatchOutcome): { ok: number; total: number } {
  const ok = outcome.results.filter((r) => r.status === "ready" || r.status === "partial").length;
  return { ok, total: outcome.results.length };
}

export function failedEntries(outcome: BatchOutcome): EntryOutcome[] {
  return outcome.results.filter((r) => r.status === "failed" || r.status === "cancelled");
}

export function entryByKey(snapshot: RunSnapshot, key: string): RunEntry | null {
  return snapshot.entries.find((e) => e.entryKey === key) ?? null;
}
