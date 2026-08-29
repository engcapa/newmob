import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLspDetectCache, lspDetectServers, type LspServerStatus } from "./lsp";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

const mockStatus: LspServerStatus = {
  presetId: "jdtls",
  displayName: "Eclipse JDT Language Server",
  documentLanguageIds: ["java"],
  available: true,
  active: true,
  selectedCommandId: "jdtls",
  selectedCommand: "jdtls",
  installHint: "brew install jdtls",
  error: null,
  commands: [],
};

describe("ED-PERF-002: lspDetectServers caching & deduplication", () => {
  beforeEach(() => {
    clearLspDetectCache();
    coreMocks.invoke.mockReset().mockResolvedValue([mockStatus]);
  });

  it("caches server detection result for repeated calls with same javaHome", async () => {
    const res1 = await lspDetectServers({ javaHome: "/jdk17" });
    const res2 = await lspDetectServers({ javaHome: "/jdk17" });

    expect(res1).toEqual([mockStatus]);
    expect(res2).toEqual([mockStatus]);
    expect(coreMocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("deduplicates in-flight detection requests", async () => {
    let resolveFn!: (val: LspServerStatus[]) => void;
    coreMocks.invoke.mockReturnValue(new Promise<LspServerStatus[]>((resolve) => {
      resolveFn = resolve;
    }));

    const p1 = lspDetectServers();
    const p2 = lspDetectServers();

    expect(coreMocks.invoke).toHaveBeenCalledTimes(1);

    resolveFn([mockStatus]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual([mockStatus]);
    expect(r2).toEqual([mockStatus]);
  });

  it("bypasses cache when forceRefresh is true", async () => {
    await lspDetectServers();
    expect(coreMocks.invoke).toHaveBeenCalledTimes(1);

    await lspDetectServers({ forceRefresh: true });
    expect(coreMocks.invoke).toHaveBeenCalledTimes(2);
  });
});
