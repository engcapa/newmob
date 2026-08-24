import type { CodeWorkspaceFileRef } from "../../../types";
import type { OpenFileState } from "./codeWorkspaceModel";
import type {
  DiskEffect,
  DiskResolution,
  MemoryEffect,
  ProviderEffect,
} from "./saveCommit";

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
 * Disk-effect recovery ledger (§8.19.1, schema v4). Records save/apply
 * transactions whose disk outcome is committed-but-discarded or unresolved so
 * a later session can see exactly which path/hash changed and whether the
 * path is still blocked for automatic retries. Never stores body text — the
 * unsaved buffer content stays in the buffer entries above.
 *
 * Blocking is decided by `resolution` only (`pending-readback` /
 * `foreign-blocked`); a non-null `verifiedAt` never re-enables retries by
 * itself, which removes the v3 bug where a foreign observed hash written into
 * `lastVerifiedAt` silently unblocked an unsafe path.
 */
export interface WorkspaceDiskEffectLedgerEntryV4 {
  schemaVersion: 4;
  workspaceId: string;
  transactionId: string;
  /** Operation identity within the transaction ("save", "op-<n>", …). */
  operationId: string;
  path: string;
  /** Stable file identity (`root:<rootId>:<path>` / `loose:<id>:<path>`). */
  fileIdentity: string;
  expectedOldHash: string | null;
  /**
   * Encoded-bytes hash the writer intended to put on disk. Null is legal
   * only together with `resolution: "pending-readback"` (v3 migration of rows
   * whose intent was never captured); live recording always supplies it.
   */
  intendedNewHash: string | null;
  observedHash: string | null;
  diskEffect: DiskEffect;
  memoryEffect: MemoryEffect;
  providerEffect: ProviderEffect;
  resolution: DiskResolution;
  createdAt: number;
  verifiedAt: number | null;
  resolvedAt: number | null;
}

export const WORKSPACE_DISK_EFFECT_LEDGER_PREFIX = "taomni.codeWorkspace.recovery.diskEffects.v4";
/** Legacy storage keys read exactly once during migration to v4. */
export const WORKSPACE_DISK_EFFECT_LEDGER_V3_PREFIX = "taomni.codeWorkspace.recovery.diskEffects.v3";
export const WORKSPACE_DISK_EFFECT_LEDGER_MAX_ENTRIES = 64;

const DISK_RESOLUTIONS: readonly DiskResolution[] = [
  "pending-readback",
  "confirmed-committed",
  "confirmed-none",
  "foreign-blocked",
  "user-resolved",
];

function diskEffectStorageKey(workspaceId: string): string {
  return `${WORKSPACE_DISK_EFFECT_LEDGER_PREFIX}:${workspaceId}`;
}

function legacyStorageKey(workspaceId: string): string {
  return `${WORKSPACE_DISK_EFFECT_LEDGER_V3_PREFIX}:${workspaceId}`;
}

function readRawArray(key: string): unknown[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function optionalTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validAxes(value: Record<string, unknown>): Pick<WorkspaceDiskEffectLedgerEntryV4,
  "diskEffect" | "memoryEffect" | "providerEffect"> | null {
  const diskEffect = value.diskEffect;
  const memoryEffect = value.memoryEffect;
  const providerEffect = value.providerEffect;
  const okDisk = diskEffect === "none" || diskEffect === "committed" || diskEffect === "unknown";
  const okMemory = memoryEffect === "saved-current" || memoryEffect === "kept-dirty"
    || memoryEffect === "writeback-discarded" || memoryEffect === "unchanged";
  const okProvider = providerEffect === "did-save" || providerEffect === "did-change-current"
    || providerEffect === "failed" || providerEffect === "discarded"
    || providerEffect === "not-sent" || providerEffect === "unknown";
  if (!okDisk || !okMemory || !okProvider) return null;
  return { diskEffect, memoryEffect, providerEffect } as Pick<WorkspaceDiskEffectLedgerEntryV4,
    "diskEffect" | "memoryEffect" | "providerEffect">;
}

/**
 * Migrate one legacy (v2/v3) row into the v4 shape (§8.19.1 migration rules):
 * - unknown rows without an intended hash become `pending-readback`;
 * - foreign observed hashes become `foreign-blocked`, even when the legacy
 *   row carried a non-null `lastVerifiedAt` (that field must not unblock);
 * - rows whose stored hashes already prove committed/none keep that fact with
 *   their verification timestamp preserved;
 * - nothing is silently deleted.
 */
export function migrateDiskEffectLedgerRow(
  source: Record<string, unknown>,
  workspaceId: string,
): WorkspaceDiskEffectLedgerEntryV4 | null {
  // Legacy v2-era rows carried no effect fact; they migrate as `unknown`.
  const legacy = source.diskEffect === undefined || source.diskEffect === null;
  const rawEffect = source.diskEffect === "committed-discarded" || source.diskEffect === "unknown"
    ? source.diskEffect
    : legacy ? "unknown" : null;
  if (!rawEffect) return null;
  if (typeof source.transactionId !== "string" || !source.transactionId) return null;
  const path = optionalString(source.path);
  if (!path) return null;

  const expectedOldHash = optionalString(source.expectedOldHash);
  const intendedNewHash = optionalString(source.intendedNewHash);
  const observedHash = optionalString(source.observedHash);
  const createdAt = typeof source.createdAt === "number" && Number.isFinite(source.createdAt)
    ? source.createdAt
    : 0;

  if (rawEffect === "committed-discarded") {
    return {
      schemaVersion: 4,
      workspaceId,
      transactionId: source.transactionId,
      operationId: optionalString(source.operationId) ?? "save",
      path,
      fileIdentity: optionalString(source.fileIdentity) ?? path,
      expectedOldHash,
      intendedNewHash,
      observedHash,
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      createdAt,
      verifiedAt: optionalTimestamp(source.lastVerifiedAt) ?? createdAt,
      resolvedAt: null,
    };
  }

  let resolution: DiskResolution;
  let verifiedAt: number | null = null;
  if (!intendedNewHash) {
    resolution = "pending-readback";
  } else {
    const observed = observedHash?.toLowerCase() ?? null;
    const intended = intendedNewHash.toLowerCase();
    const old = expectedOldHash?.toLowerCase() ?? null;
    if (observed && observed === intended) {
      resolution = "confirmed-committed";
      verifiedAt = optionalTimestamp(source.lastVerifiedAt) ?? createdAt;
    } else if (observed && old && observed === old) {
      resolution = "confirmed-none";
      verifiedAt = optionalTimestamp(source.lastVerifiedAt) ?? createdAt;
    } else {
      // Foreign hash (or unreadable) stays blocked regardless of any legacy
      // `lastVerifiedAt`; that timestamp must never act as "unblocked".
      resolution = observed ? "foreign-blocked" : "pending-readback";
    }
  }

  return {
    schemaVersion: 4,
    workspaceId,
    transactionId: source.transactionId,
    operationId: optionalString(source.operationId) ?? "save",
    path,
    fileIdentity: optionalString(source.fileIdentity) ?? path,
    expectedOldHash,
    intendedNewHash,
    observedHash,
    diskEffect: "unknown",
    memoryEffect: "unchanged",
    providerEffect: "unknown",
    resolution,
    createdAt,
    verifiedAt,
    resolvedAt: null,
  };
}

function normalizeDiskEffectEntry(
  value: unknown,
  workspaceId: string,
): WorkspaceDiskEffectLedgerEntryV4 | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 4) return migrateDiskEffectLedgerRow(source, workspaceId);
  if (typeof source.transactionId !== "string" || !source.transactionId) return null;
  const path = optionalString(source.path);
  if (!path) return null;
  const resolution = DISK_RESOLUTIONS.find((candidate) => candidate === source.resolution);
  if (!resolution) return null;
  const axes = validAxes(source);
  if (!axes) return null;
  const intendedNewHash = optionalString(source.intendedNewHash);
  if (intendedNewHash === null && resolution !== "pending-readback") return null;
  return {
    schemaVersion: 4,
    workspaceId,
    transactionId: source.transactionId,
    operationId: optionalString(source.operationId) ?? "save",
    path,
    fileIdentity: optionalString(source.fileIdentity) ?? path,
    expectedOldHash: optionalString(source.expectedOldHash),
    intendedNewHash,
    observedHash: optionalString(source.observedHash),
    ...axes,
    resolution,
    createdAt: typeof source.createdAt === "number" && Number.isFinite(source.createdAt) ? source.createdAt : 0,
    verifiedAt: optionalTimestamp(source.verifiedAt),
    resolvedAt: optionalTimestamp(source.resolvedAt),
  };
}

function writeDiskEffectEntries(
  workspaceId: string,
  entries: WorkspaceDiskEffectLedgerEntryV4[],
): WorkspaceDiskEffectLedgerEntryV4[] {
  if (typeof window === "undefined" || !workspaceId) return entries;
  try {
    // Always materialize the v4 key so the one-shot v3 migration does not
    // replay after every empty write.
    window.localStorage.setItem(
      diskEffectStorageKey(workspaceId),
      JSON.stringify(entries.slice(0, WORKSPACE_DISK_EFFECT_LEDGER_MAX_ENTRIES)),
    );
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

function loadDiskEffectEntries(workspaceId: string): WorkspaceDiskEffectLedgerEntryV4[] {
  if (typeof window === "undefined" || !workspaceId) return [];
  const own = readRawArray(diskEffectStorageKey(workspaceId));
  if (own.length > 0 || window.localStorage.getItem(diskEffectStorageKey(workspaceId)) !== null) {
    return own
      .map((value) => normalizeDiskEffectEntry(value, workspaceId))
      .filter((value): value is WorkspaceDiskEffectLedgerEntryV4 => value !== null);
  }
  // One-shot migration: v4 key absent but v3 data exists.
  const legacyRows = readRawArray(legacyStorageKey(workspaceId));
  if (legacyRows.length === 0 && window.localStorage.getItem(legacyStorageKey(workspaceId)) === null) {
    return [];
  }
  const migrated = legacyRows
    .map((value) => (
      value && typeof value === "object"
        ? migrateDiskEffectLedgerRow(value as Record<string, unknown>, workspaceId)
        : null
    ))
    .filter((value): value is WorkspaceDiskEffectLedgerEntryV4 => value !== null);
  writeDiskEffectEntries(workspaceId, migrated);
  return migrated;
}

export function recordDiskEffectLedgerEntry(entry: WorkspaceDiskEffectLedgerEntryV4): void {
  const workspaceId = entry.workspaceId;
  const dedupeKey = `${entry.transactionId} ${entry.operationId} ${entry.path}`;
  const next = [
    { ...entry },
    ...loadDiskEffectEntries(workspaceId).filter((existing) => (
      `${existing.transactionId} ${existing.operationId} ${existing.path}` !== dedupeKey
    )),
  ];
  writeDiskEffectEntries(workspaceId, next.slice(0, WORKSPACE_DISK_EFFECT_LEDGER_MAX_ENTRIES));
}

/**
 * Clear the ledger row for one settled transaction on one path only — never
 * other workspaces or other paths (§8.19.1). Acknowledge actions must call
 * this per explicitly selected row.
 */
export function resolveDiskEffectLedgerEntry(
  workspaceId: string,
  transactionId: string,
  path: string,
): void {
  const next = loadDiskEffectEntries(workspaceId).filter(
    (entry) => !(entry.transactionId === transactionId && entry.path === path),
  );
  writeDiskEffectEntries(workspaceId, next);
}

export function listDiskEffectLedgerEntries(workspaceId: string): WorkspaceDiskEffectLedgerEntryV4[] {
  return loadDiskEffectEntries(workspaceId);
}

/**
 * A `pending-readback` or `foreign-blocked` row blocks automatic retries
 * against the same path until a re-read confirms the real bytes or the user
 * resolves the row (§8.19.1). Decided by `resolution` alone.
 */
export function hasBlockingDiskEffectResolution(workspaceId: string, path: string): boolean {
  return listDiskEffectLedgerEntries(workspaceId).some(
    (entry) => entry.path === path
      && entry.resolvedAt === null
      && (entry.resolution === "pending-readback" || entry.resolution === "foreign-blocked"),
  );
}
