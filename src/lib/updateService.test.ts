import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => undefined,
  ),
  relaunch: vi.fn(async () => undefined),
  check: vi.fn(),
  download: vi.fn(async () => undefined),
  install: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.check,
}));

vi.mock("./runtime", () => ({
  getAppPlatform: () => "linux",
  isTauriRuntime: () => true,
}));

import {
  checkForUpdate,
  downloadAndInstall,
  installDownloadedUpdate,
  isSocksCapUpgradeAuthorizationRequired,
  relaunchApp,
} from "./updateService";

const update = {
  version: "0.4.4",
  currentVersion: "0.4.3",
  body: "test update",
  close: mocks.close,
  download: mocks.download,
  install: mocks.install,
};

describe("updateService.relaunchApp", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.relaunch.mockReset();
    mocks.relaunch.mockResolvedValue(undefined);
    mocks.check.mockReset();
    mocks.check.mockResolvedValue(update);
    mocks.download.mockReset();
    mocks.download.mockResolvedValue(undefined);
    mocks.install.mockReset();
    mocks.install.mockResolvedValue(undefined);
    mocks.close.mockReset();
    mocks.close.mockResolvedValue(undefined);
  });

  it("gracefully tears down SocksCap before relaunching on Linux", async () => {
    await relaunchApp();

    expect(mocks.invoke).toHaveBeenCalledWith("sockscap_prepare_for_update", {
      sudoPassword: undefined,
    });
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.relaunch.mock.invocationCallOrder[0],
    );
  });

  it("does not relaunch when SocksCap network cleanup fails", async () => {
    mocks.invoke.mockRejectedValueOnce("Linux capture teardown failed");

    await expect(relaunchApp()).rejects.toBe("Linux capture teardown failed");
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("does not install an update when pre-install network cleanup fails", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "sockscap_prepare_for_update") {
        throw new Error("Linux capture teardown failed");
      }
      return null;
    });
    await checkForUpdate();

    await expect(downloadAndInstall(undefined, vi.fn())).rejects.toThrow(
      "Linux capture teardown failed",
    );

    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("resumes a downloaded Linux update after automatic recovery gets sudo authorization", async () => {
    await checkForUpdate();
    mocks.invoke.mockRejectedValueOnce(
      "SOCKSCAP_UPDATE_SUDO_REQUIRED: automatic SocksCap recovery failed",
    );

    const initialInstall = downloadAndInstall(undefined, vi.fn());
    await expect(initialInstall).rejects.toSatisfy(isSocksCapUpgradeAuthorizationRequired);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.install).not.toHaveBeenCalled();

    await installDownloadedUpdate(undefined, "root-secret");

    expect(mocks.invoke).toHaveBeenLastCalledWith("sockscap_prepare_for_update", {
      sudoPassword: "root-secret",
    });
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });
});
