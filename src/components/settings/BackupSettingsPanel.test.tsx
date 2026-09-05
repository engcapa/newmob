import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupSettingsPanel } from "./BackupSettingsPanel";
import { useBackupStore } from "../../stores/backupStore";
import { useVaultStore } from "../../stores/vaultStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../lib/ipc", () => ({
  openLocalPath: vi.fn(),
  selectFilePath: vi.fn(),
  selectSaveDirectory: vi.fn(),
  selectSaveFilePath: vi.fn(),
}));

vi.mock("../../lib/updateService", () => ({
  relaunchApp: vi.fn(),
}));

describe("BackupSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const policy = {
      autoBackupEnabled: false,
      frequency: "weekly" as const,
      customBackupDir: null,
      maxRetainedCopies: 7,
      defaultScope: "core",
      lastBackupAt: null,
    };
    const defaultBackupDir = "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups";
    const history = [
      {
        fileName: "taomni_backup_20260904_120000.taobak",
        filePath: "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups\\taomni_backup_20260904_120000.taobak",
        sizeBytes: 2097152,
        modifiedAt: 1788500000000,
        isEncrypted: false,
      },
    ];

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(useBackupStore.getState().policy ?? policy);
      if (cmd === "backup_get_default_dir") return Promise.resolve(defaultBackupDir);
      if (cmd === "backup_list_history") return Promise.resolve(useBackupStore.getState().history.length > 0 ? useBackupStore.getState().history : history);
      return Promise.resolve(null);
    });

    useBackupStore.setState({
      policy,
      defaultBackupDir,
      history,
      loading: false,
      creating: false,
      restoring: false,
      lastResult: null,
      error: null,
    });

    useVaultStore.setState({
      state: "unlocked",
      entryCount: 1,
      loading: false,
      entries: [],
      refresh: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders backup storage directory and default path badge", () => {
    render(<BackupSettingsPanel />);

    expect(screen.getByText("Backup Storage Directory")).toBeDefined();
    expect(screen.getByText("Default Path")).toBeDefined();
    expect(
      screen.getByDisplayValue("C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups"),
    ).toBeDefined();
  });

  it("shows custom directory badge and reset button when customBackupDir is set", () => {
    useBackupStore.setState({
      policy: {
        autoBackupEnabled: false,
        frequency: "weekly",
        customBackupDir: "D:\\OneDrive\\TaomniBackups",
        maxRetainedCopies: 7,
        defaultScope: "core",
        lastBackupAt: null,
      },
    });

    render(<BackupSettingsPanel />);

    expect(screen.getByText("Custom Directory")).toBeDefined();
    expect(screen.getByDisplayValue("D:\\OneDrive\\TaomniBackups")).toBeDefined();
    expect(screen.getByText("Reset to Default")).toBeDefined();
  });

  it("renders backup history and actions", () => {
    render(<BackupSettingsPanel />);

    expect(screen.getByText(/Historical Snapshots/)).toBeDefined();
    expect(screen.getByText("taomni_backup_20260904_120000.taobak")).toBeDefined();
    expect(screen.getByText("2.00 MB")).toBeDefined();
    expect(screen.getByText("Restore")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
  });

  it("renders the restore dialog on an opaque theme surface", () => {
    render(<BackupSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    const dialog = screen.getByTestId("backup-restore-dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveProperty("style.background", "var(--taomni-bg)");
    expect(dialog).toHaveProperty("style.borderColor", "var(--taomni-card-border)");
  });

  it("renders manual backup controls with Backup Now and Export to... buttons without requiring vault password during creation", () => {
    useVaultStore.setState({ state: "unlocked" });
    render(<BackupSettingsPanel />);

    expect(screen.getByText("Manual Instant Backup")).toBeDefined();
    expect(screen.getByText("Backup Now")).toBeDefined();
    expect(screen.getByText("Export to...")).toBeDefined();
    // Manual backup should not have vault master password requirement
    expect(screen.queryByText("Vault Master Password Verification")).toBeNull();
  });

  it("renders auto-backup toggle card and weekly retention hint", () => {
    useBackupStore.setState({
      policy: {
        autoBackupEnabled: true,
        frequency: "weekly",
        customBackupDir: null,
        maxRetainedCopies: 7,
        defaultScope: "core",
        lastBackupAt: null,
      },
    });

    render(<BackupSettingsPanel />);
    expect(screen.getByText("Enable scheduled rolling backup in background")).toBeDefined();
    expect(
      screen.getByText("Weekly backup, defaults to keeping 7 weeks of historical snapshots"),
    ).toBeDefined();
  });
});
