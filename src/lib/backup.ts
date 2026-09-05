import { invoke } from "@tauri-apps/api/core";

export type BackupScope = "core" | "full" | "custom";

export interface BackupCustomOptions {
  includeSessions?: boolean;
  includeNotes?: boolean;
  includeVault?: boolean;
  includeLanchat?: boolean;
  includeConfigs?: boolean;
  includeMail?: boolean;
  includeLocalHistory?: boolean;
}

export interface BackupResult {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
  scope: string;
  encrypted: boolean;
  filesCount: number;
}

export interface BackupEntryInfo {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: number;
  isEncrypted: boolean;
}

export interface BackupFileEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface BackupManifest {
  formatVersion: number;
  appName: string;
  appVersion: string;
  createdAt: number;
  backupScope: string;
  encrypted: boolean;
  files: BackupFileEntry[];
}

export interface StageRestoreResult {
  manifest: BackupManifest;
  restartRequired: boolean;
  message: string;
}

export interface BackupPolicy {
  autoBackupEnabled: boolean;
  frequency: "daily" | "weekly" | "on_exit";
  customBackupDir?: string | null;
  maxRetainedCopies: number;
  defaultScope: string;
  lastBackupAt?: number | null;
}

export async function createBackup(params: {
  scope?: BackupScope;
  customOptions?: BackupCustomOptions;
  targetPath?: string;
  password?: string;
}): Promise<BackupResult> {
  return invoke<BackupResult>("backup_create", {
    scope: params.scope ?? "core",
    customOptions: params.customOptions ?? null,
    targetPath: params.targetPath ?? null,
    password: params.password ?? null,
  });
}

export async function inspectBackup(path: string, password?: string): Promise<BackupManifest> {
  return invoke<BackupManifest>("backup_inspect", {
    path,
    password: password ?? null,
  });
}

export async function stageRestore(
  path: string,
  password?: string,
  vaultPassword?: string,
): Promise<StageRestoreResult> {
  return invoke<StageRestoreResult>("backup_stage_restore", {
    path,
    password: password ?? null,
    vaultPassword: vaultPassword ?? null,
  });
}

export async function getBackupPolicy(): Promise<BackupPolicy> {
  return invoke<BackupPolicy>("backup_get_policy");
}

export async function setBackupPolicy(policy: BackupPolicy): Promise<void> {
  await invoke("backup_set_policy", { policy });
}

export async function listBackupHistory(): Promise<BackupEntryInfo[]> {
  return invoke<BackupEntryInfo[]>("backup_list_history");
}

export async function deleteBackupItem(fileName: string): Promise<void> {
  await invoke("backup_delete_item", { fileName });
}

export async function getDefaultBackupDir(): Promise<string> {
  return invoke<string>("backup_get_default_dir");
}
