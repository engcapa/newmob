import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBackupStore } from "./backupStore";
import type { BackupPolicy, BackupEntryInfo, BackupResult } from "../lib/backup";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("useBackupStore", () => {
  const fakePolicy: BackupPolicy = {
    autoBackupEnabled: false,
    frequency: "weekly",
    customBackupDir: null,
    maxRetainedCopies: 7,
    defaultScope: "core",
    lastBackupAt: null,
  };

  const fakeDefaultDir = "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups";

  const fakeHistory: BackupEntryInfo[] = [
    {
      fileName: "taomni_backup_20260904_120000.taobak",
      filePath: "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups\\taomni_backup_20260904_120000.taobak",
      sizeBytes: 1048576,
      modifiedAt: 1788500000000,
      isEncrypted: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useBackupStore.setState({
      policy: null,
      defaultBackupDir: "",
      history: [],
      loading: false,
      creating: false,
      restoring: false,
      lastResult: null,
      error: null,
    });
  });

  it("loads policy, default directory and history on loadAll", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(fakePolicy);
      if (cmd === "backup_get_default_dir") return Promise.resolve(fakeDefaultDir);
      if (cmd === "backup_list_history") return Promise.resolve(fakeHistory);
      return Promise.reject(new Error(`unhandled cmd: ${cmd}`));
    });

    await useBackupStore.getState().loadAll();

    const state = useBackupStore.getState();
    expect(state.policy).toEqual(fakePolicy);
    expect(state.defaultBackupDir).toBe(fakeDefaultDir);
    expect(state.history).toEqual(fakeHistory);
    expect(state.error).toBeNull();
  });

  it("updates policy via updatePolicy", async () => {
    useBackupStore.setState({ policy: fakePolicy });

    invokeMock.mockResolvedValue(undefined);

    await useBackupStore.getState().updatePolicy({
      customBackupDir: "D:\\MyBackups",
      autoBackupEnabled: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("backup_set_policy", {
      policy: {
        ...fakePolicy,
        customBackupDir: "D:\\MyBackups",
        autoBackupEnabled: true,
      },
    });

    expect(useBackupStore.getState().policy?.customBackupDir).toBe("D:\\MyBackups");
    expect(useBackupStore.getState().policy?.autoBackupEnabled).toBe(true);
  });

  it("triggers backup creation via triggerBackup", async () => {
    useBackupStore.setState({ policy: fakePolicy });

    const fakeResult: BackupResult = {
      filePath: "C:\\test\\taomni_backup.taobak",
      fileName: "taomni_backup.taobak",
      sizeBytes: 2048,
      createdAt: 1788501000000,
      scope: "core",
      encrypted: false,
      filesCount: 3,
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_create") return Promise.resolve(fakeResult);
      if (cmd === "backup_get_policy") return Promise.resolve(fakePolicy);
      if (cmd === "backup_get_default_dir") return Promise.resolve(fakeDefaultDir);
      if (cmd === "backup_list_history") return Promise.resolve(fakeHistory);
      return Promise.resolve(null);
    });

    const result = await useBackupStore.getState().triggerBackup({
      scope: "core",
      targetPath: "C:\\test\\taomni_backup.taobak",
    });

    expect(result).toEqual(fakeResult);
    expect(useBackupStore.getState().lastResult).toEqual(fakeResult);
    expect(useBackupStore.getState().creating).toBe(false);
  });

  it("deletes a backup file via deleteBackup", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_delete_item") return Promise.resolve();
      if (cmd === "backup_list_history") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    await useBackupStore.getState().deleteBackup("test.taobak");

    expect(invokeMock).toHaveBeenCalledWith("backup_delete_item", {
      fileName: "test.taobak",
    });
    expect(useBackupStore.getState().history).toEqual([]);
  });

  it("performs stage restore with vaultPassword", async () => {
    const fakeStageResult = {
      manifest: {
        formatVersion: 1,
        appName: "Taomni",
        appVersion: "0.3.0",
        createdAt: 1788500000000,
        backupScope: "core",
        encrypted: false,
        files: [],
      },
      restartRequired: true,
      message: "Stage complete",
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_stage_restore") return Promise.resolve(fakeStageResult);
      return Promise.resolve(null);
    });

    const res = await useBackupStore
      .getState()
      .performStageRestore("test.taobak", "encPassword", "vaultPassword123");

    expect(invokeMock).toHaveBeenCalledWith("backup_stage_restore", {
      path: "test.taobak",
      password: "encPassword",
      vaultPassword: "vaultPassword123",
    });
    expect(res).toEqual(fakeStageResult);
    expect(useBackupStore.getState().restoring).toBe(false);
  });
});
