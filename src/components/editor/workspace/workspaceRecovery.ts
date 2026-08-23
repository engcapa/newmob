import type { CodeWorkspaceFileRef } from "../../../types";
import type { OpenFileState } from "./codeWorkspaceModel";

/**
 * Crash/restart recovery is deliberately kept separate from Local History.
 * Local History records durable edits; recovery records the latest unsaved
 * buffer so a renderer/process crash can be repaired before the next edit.
 */
export interface WorkspaceRecoveryEntry {
  workspaceId: string;
  key: string;
  ref: CodeWorkspaceFileRef;
  path: string;
  text: string;
  savedText: string;
  eol: OpenFileState["eol"];
  encoding?: string;
  bom?: boolean;
  hash: string;
  mtime: number;
  size: number;
  capturedAt: number;
}

export const WORKSPACE_RECOVERY_STORAGE_PREFIX = "taomni.codeWorkspace.recovery.v1";
export const WORKSPACE_RECOVERY_MAX_ENTRIES = 32;
export const WORKSPACE_RECOVERY_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_RECOVERY_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function storageKey(workspaceId: string): string {
  return `${WORKSPACE_RECOVERY_STORAGE_PREFIX}:${workspaceId}`;
}

function refKey(ref: CodeWorkspaceFileRef): string {
  return ref.kind === "root"
    ? `root:${ref.rootId}:${ref.path}`
    : `loose:${ref.id}:${ref.path}`;
}

function validRef(value: unknown): CodeWorkspaceFileRef | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.kind === "root" && typeof source.rootId === "string" && typeof source.path === "string") {
    return { kind: "root", rootId: source.rootId, path: source.path };
  }
  if (source.kind === "loose" && typeof source.id === "string" && typeof source.path === "string") {
    return { kind: "loose", id: source.id, path: source.path };
  }
  return null;
}

function normalizeEntry(value: unknown, workspaceId: string): WorkspaceRecoveryEntry | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const ref = validRef(source.ref);
  if (!ref || typeof source.text !== "string" || typeof source.savedText !== "string") return null;
  if (source.text === source.savedText) return null;
  const key = typeof source.key === "string" && source.key ? source.key : refKey(ref);
  const path = typeof source.path === "string" && source.path ? source.path : ref.path;
  const eol = source.eol === "CRLF" || source.eol === "CR" ? source.eol : "LF";
  return {
    workspaceId,
    key,
    ref,
    path,
    text: source.text,
    savedText: source.savedText,
    eol,
    encoding: typeof source.encoding === "string" && source.encoding.trim()
      ? source.encoding
      : "UTF-8",
    bom: source.bom === true,
    hash: typeof source.hash === "string" ? source.hash : "",
    mtime: typeof source.mtime === "number" && Number.isFinite(source.mtime) ? source.mtime : 0,
    size: typeof source.size === "number" && Number.isFinite(source.size) ? source.size : 0,
    capturedAt: typeof source.capturedAt === "number" && Number.isFinite(source.capturedAt)
      ? source.capturedAt
      : 0,
  };
}

function entryBytes(entry: WorkspaceRecoveryEntry): number {
  // UTF-16 is what the WebView storage implementation counts most closely;
  // using a conservative estimate keeps quota failures from becoming data
  // loss during a crash path.
  return (entry.text.length + entry.savedText.length) * 2;
}

function trimEntries(entries: WorkspaceRecoveryEntry[]): WorkspaceRecoveryEntry[] {
  const seen = new Set<string>();
  const sorted = [...entries]
    .filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return entryBytes(entry) <= WORKSPACE_RECOVERY_MAX_ENTRY_BYTES;
    })
    .sort((left, right) => right.capturedAt - left.capturedAt || left.path.localeCompare(right.path));
  const next: WorkspaceRecoveryEntry[] = [];
  let total = 0;
  for (const entry of sorted) {
    const bytes = entryBytes(entry);
    if (next.length >= WORKSPACE_RECOVERY_MAX_ENTRIES || total + bytes > WORKSPACE_RECOVERY_MAX_TOTAL_BYTES) continue;
    next.push(entry);
    total += bytes;
  }
  return next;
}

function readRaw(workspaceId: string): string | null {
  if (typeof window === "undefined" || !workspaceId) return null;
  try {
    return window.localStorage.getItem(storageKey(workspaceId));
  } catch {
    return null;
  }
}

export function readWorkspaceRecoveryEntries(workspaceId: string): WorkspaceRecoveryEntry[] {
  const raw = readRaw(workspaceId);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    return trimEntries(values
      .map((value) => normalizeEntry(value, workspaceId))
      .filter((entry): entry is WorkspaceRecoveryEntry => entry !== null));
  } catch {
    return [];
  }
}

export function writeWorkspaceRecoveryEntries(
  workspaceId: string,
  entries: WorkspaceRecoveryEntry[],
): WorkspaceRecoveryEntry[] {
  const next = trimEntries(entries.map((entry) => ({ ...entry, workspaceId })));
  if (typeof window === "undefined" || !workspaceId) return next;
  try {
    if (next.length === 0) {
      window.localStorage.removeItem(storageKey(workspaceId));
    } else {
      window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(next));
    }
  } catch {
    // Recovery must never make editing fail. A later interval can retry after
    // another workspace releases storage quota.
  }
  return next;
}

export function removeWorkspaceRecoveryEntry(workspaceId: string, key: string): WorkspaceRecoveryEntry[] {
  const next = readWorkspaceRecoveryEntries(workspaceId).filter((entry) => entry.key !== key);
  return writeWorkspaceRecoveryEntries(workspaceId, next);
}

export function reconcileWorkspaceRecoveryEntries(
  workspaceId: string,
  files: Record<string, OpenFileState>,
  preserveKeys: ReadonlySet<string> = new Set(),
): WorkspaceRecoveryEntry[] {
  const byKey = new Map(readWorkspaceRecoveryEntries(workspaceId).map((entry) => [entry.key, entry]));
  const capturedAt = Date.now();
  for (const file of Object.values(files)) {
    if (file.library) continue;
    if (file.dirty && file.text !== file.savedText) {
      byKey.set(file.key, {
        workspaceId,
        key: file.key,
        ref: file.ref,
        path: file.path,
        text: file.text,
        savedText: file.savedText,
        eol: file.eol,
        encoding: file.encoding ?? "UTF-8",
        bom: file.bom ?? false,
        hash: file.hash,
        mtime: file.mtime,
        size: file.size,
        capturedAt,
      });
    } else if (!preserveKeys.has(file.key)) {
      byKey.delete(file.key);
    }
  }
  return writeWorkspaceRecoveryEntries(workspaceId, [...byKey.values()]);
}

/**
 * Disk-effect recovery ledger (§8.18.1, schema v3). Records save
 * transactions whose disk outcome is committed-but-discarded or unknown so a
 * later session can see exactly which path/hash changed. Never stores body
 * text — the unsaved buffer content stays in the buffer entries above.
 */
export interface WorkspaceDiskEffectLedgerEntry {
  workspaceId: string;
  transactionId: string;
  path: string;
  /** Stable file identity (`root:<rootId>:<path>` / `loose:<id>:<path>`). */
  fileIdentity: string;
  expectedOldHash: string | null;
  intendedNewHash: string | null;
  observedHash?: string | null;
  diskEffect: "committed-discarded" | "unknown";
  createdAt: number;
  lastVerifiedAt: number | null;
}

export const WORKSPACE_DISK_EFFECT_LEDGER_PREFIX = "taomni.codeWorkspace.recovery.diskEffects.v3";
export const WORKSPACE_DISK_EFFECT_LEDGER_MAX_ENTRIES = 64;

function diskEffectStorageKey(workspaceId: string): string {
  return `${WORKSPACE_DISK_EFFECT_LEDGER_PREFIX}:${workspaceId}`;
}

function readDiskEffectRaw(workspaceId: string): unknown[] {
  if (typeof window === "undefined" || !workspaceId) return [];
  try {
    const raw = window.localStorage.getItem(diskEffectStorageKey(workspaceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDiskEffectEntry(value: unknown, workspaceId: string): WorkspaceDiskEffectLedgerEntry | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  // Legacy v2-era rows carried no effect fact; they migrate as `unknown`.
  const legacy = source.diskEffect === undefined || source.diskEffect === null;
  const diskEffect = source.diskEffect === "committed-discarded" || source.diskEffect === "unknown"
    ? source.diskEffect
    : legacy ? "unknown" : null;
  if (!diskEffect) return null;
  if (typeof source.transactionId !== "string" || !source.transactionId) return null;
  const path = typeof source.path === "string" && source.path ? source.path : null;
  if (!path) return null;
  return {
    workspaceId,
    transactionId: source.transactionId,
    path,
    fileIdentity: typeof source.fileIdentity === "string" ? source.fileIdentity : path,
    expectedOldHash: typeof source.expectedOldHash === "string" ? source.expectedOldHash : null,
    intendedNewHash: typeof source.intendedNewHash === "string" ? source.intendedNewHash : null,
    observedHash: typeof source.observedHash === "string" ? source.observedHash : null,
    diskEffect,
    createdAt: typeof source.createdAt === "number" && Number.isFinite(source.createdAt) ? source.createdAt : 0,
    lastVerifiedAt: typeof source.lastVerifiedAt === "number" && Number.isFinite(source.lastVerifiedAt)
      ? source.lastVerifiedAt
      : null,
  };
}

function writeDiskEffectEntries(
  workspaceId: string,
  entries: WorkspaceDiskEffectLedgerEntry[],
): WorkspaceDiskEffectLedgerEntry[] {
  if (typeof window === "undefined" || !workspaceId) return entries;
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(diskEffectStorageKey(workspaceId));
    } else {
      window.localStorage.setItem(diskEffectStorageKey(workspaceId), JSON.stringify(entries.slice(0, WORKSPACE_DISK_EFFECT_LEDGER_MAX_ENTRIES)));
    }
  } catch {
    // The ledger must never make editing fail.
  }
  return entries;
}

/** Stable identity matching the recovery buffer-entry key shape. */
export function workspaceFileIdentity(ref: CodeWorkspaceFileRef): string {
  return ref.kind === "root"
    ? `root:${ref.rootId}:${ref.path}`
    : `loose:${ref.id}:${ref.path}`;
}

export function recordDiskEffectLedgerEntry(entry: WorkspaceDiskEffectLedgerEntry): void {
  const workspaceId = entry.workspaceId;
  const next = [
    { ...entry },
    ...readDiskEffectRaw(workspaceId)
      .map((value) => normalizeDiskEffectEntry(value, workspaceId))
      .filter((value): value is WorkspaceDiskEffectLedgerEntry => value !== null && value.transactionId !== entry.transactionId),
  ];
  writeDiskEffectEntries(workspaceId, next.slice(0, WORKSPACE_DISK_EFFECT_LEDGER_MAX_ENTRIES));
}

/**
 * Clear the ledger row for one settled transaction on one path only — never
 * other workspaces or other paths (§8.18.1).
 */
export function resolveDiskEffectLedgerEntry(
  workspaceId: string,
  transactionId: string,
  path: string,
): void {
  const next = listDiskEffectLedgerEntries(workspaceId).filter(
    (entry) => !(entry.transactionId === transactionId && entry.path === path),
  );
  writeDiskEffectEntries(workspaceId, next);
}

export function listDiskEffectLedgerEntries(workspaceId: string): WorkspaceDiskEffectLedgerEntry[] {
  return readDiskEffectRaw(workspaceId)
    .map((value) => normalizeDiskEffectEntry(value, workspaceId))
    .filter((value): value is WorkspaceDiskEffectLedgerEntry => value !== null);
}

/**
 * An unresolved `unknown` row blocks automatic retries against the same path
 * until a re-read verifies the real bytes (§8.18.1).
 */
export function hasUnverifiedUnknownDiskEffect(workspaceId: string, path: string): boolean {
  return listDiskEffectLedgerEntries(workspaceId).some(
    (entry) => entry.path === path && entry.diskEffect === "unknown" && entry.lastVerifiedAt === null,
  );
}
