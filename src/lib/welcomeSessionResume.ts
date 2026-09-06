import {
  clearWelcomeRunSnapshot as invokeClearWelcomeRunSnapshot,
  commitWelcomeRunSnapshot as invokeCommitWelcomeRunSnapshot,
  getWelcomeRunSnapshot as invokeGetWelcomeRunSnapshot,
  type SessionConfig,
} from "./ipc";
import type {
  ResumeIssue,
  RunSnapshotRecord,
  SnapshotEntry,
} from "../types";

/**
 * Welcome run-snapshot restore contract (design §4.2, D-01 = scheme B).
 * Pure types + helpers; the orchestrator lives in useWelcomeSessionResume.
 */

export type { ResumeIssue, RunSnapshotRecord, SnapshotEntry };

/** Saved-session types this entry can actually reopen (design §4.2.2). */
export const ELIGIBLE_SAVED_SESSION_TYPES: ReadonlySet<string> = new Set([
  "LocalShell",
  "SSH",
  "SFTP",
  "RDP",
  "VNC",
  "MySQL",
  "PostgreSQL",
  "PanWeiDB",
  "Oracle",
  "SQLServer",
  "StarRocks",
  "ClickHouse",
  "Presto",
  "Redis",
  "HBaseShell",
  "Proxy",
  "S3",
  "AzureBlob",
  "File",
  "Mail",
  "FTP",
  "Telnet",
  "Rlogin",
  "Mosh",
  "Serial",
]);

export function isResumeEligibleSavedSession(
  session: Pick<SessionConfig, "id" | "session_type">,
): boolean {
  return Boolean(session.id) && ELIGIBLE_SAVED_SESSION_TYPES.has(session.session_type);
}

export interface GetRunSnapshotResponse {
  record: RunSnapshotRecord | null;
  legacyCandidate: SnapshotEntry | null;
  issue: { code: string; message: string } | null;
}

export interface CommitRunSnapshotResponse {
  record: RunSnapshotRecord | null;
  applied: boolean;
}

export async function getWelcomeRunSnapshot(): Promise<GetRunSnapshotResponse> {
  return invokeGetWelcomeRunSnapshot();
}

export async function commitWelcomeRunSnapshot(input: {
  batchId: string;
  entries: SnapshotEntry[];
  activeIdentity: string | null;
  expectedRevision?: number;
  restored?: boolean;
}): Promise<CommitRunSnapshotResponse> {
  return invokeCommitWelcomeRunSnapshot({
    batchId: input.batchId,
    entries: input.entries,
    activeIdentity: input.activeIdentity,
    expectedRevision: input.expectedRevision ?? null,
    restored: input.restored ?? false,
  });
}

export async function clearWelcomeRunSnapshot(input: {
  expectedRevision?: number;
}): Promise<void> {
  await invokeClearWelcomeRunSnapshot({
    expectedRevision: input.expectedRevision ?? null,
  });
}

/** Non-sensitive fingerprint used to detect "same identity, different config". */
export function sessionConfigFingerprint(session: SessionConfig): string {
  return [
    session.id,
    session.session_type,
    session.host,
    session.port,
    session.username ?? "",
  ].join("|");
}

/** Deep comparison for collector change detection (order-sensitive). */
export function snapshotEntriesFingerprint(
  entries: SnapshotEntry[],
  activeIdentity: string | null,
): string {
  return JSON.stringify({ e: entries, a: activeIdentity });
}

export function entryKindSummary(entry: SnapshotEntry): string {
  switch (entry.kind) {
    case "saved-session":
      return entry.savedSessionType;
    case "local-terminal":
      return "LocalTerminal";
  }
}

export function entryDisplayName(entry: SnapshotEntry): string {
  return entry.displayName || entry.identity;
}

/** True when an existing tab matches a snapshot entry (locate, not reopen). */
export function tabMatchesSnapshotEntry(
  entry: SnapshotEntry,
  tab: { id: string; type: string; sessionId?: string },
): boolean {
  if (entry.kind === "saved-session") {
    return tab.sessionId === entry.savedSessionId && tab.type === primaryViewTypeForEntry(entry);
  }
  return false;
}

/**
 * The primary view type a saved session restores into; used for live-tab
 * matching. Mirrors MainLayout opener tab kinds (design §4.2.2).
 */
export function primaryViewTypeForEntry(entry: SnapshotEntry): string {
  if (entry.kind !== "saved-session") return "terminal";
  switch (entry.savedSessionType) {
    case "SFTP":
      return "sftp";
    case "VNC":
      return "vnc";
    case "RDP":
      return "rdp";
    case "Mail":
      return "mail";
    case "Redis":
      return "redis";
    case "MySQL":
    case "PostgreSQL":
    case "PanWeiDB":
    case "Oracle":
    case "SQLServer":
    case "StarRocks":
    case "ClickHouse":
    case "Presto":
    case "HBaseShell":
      return "database";
    case "S3":
    case "AzureBlob":
      return "object-storage";
    case "Proxy":
      return "proxy-test";
    case "File":
      return "file-browser";
    default:
      return "terminal";
  }
}

export function issueLabel(code: ResumeIssue["code"]): string {
  return code;
}

/** Builds a whitelist local-terminal entry from a tab's confirmed cwd. */
export function localTerminalEntry(input: {
  tabId: string;
  displayName: string;
  shellId: string;
  shellArgs: string[] | undefined;
  confirmedCwd: string;
}): SnapshotEntry {
  return {
    kind: "local-terminal",
    identity: `local:${input.tabId}`,
    displayName: input.displayName,
    shellId: input.shellId,
    shellArgs: input.shellArgs ?? [],
    confirmedCwd: input.confirmedCwd,
  };
}

/** Builds a saved-session entry from a session config. */
export function savedSessionEntry(session: SessionConfig): SnapshotEntry {
  return {
    kind: "saved-session",
    identity: `saved:${session.id}`,
    savedSessionId: session.id,
    savedSessionType: session.session_type,
    displayName: session.name || session.host || session.session_type,
  };
}
