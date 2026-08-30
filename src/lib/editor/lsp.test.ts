import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLspDetectCache,
  lspCancelReferenceRequest,
  lspDefinition,
  lspDetectServers,
  nextLspRequestSequence,
  type LspDocumentDescriptor,
  type LspLocationsResult,
  type LspServerStatus,
} from "./lsp";

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

describe("ED-QUERY-001: LSP cancellation identity", () => {
  const descriptor: LspDocumentDescriptor = {
    workspaceId: "ws-query",
    rootPath: "/repo",
    filePath: "/repo/App.java",
    languageId: "java",
  };

  const result: LspLocationsResult = {
    status: {
      path: descriptor.filePath,
      uri: "file:///repo/App.java",
      presetId: "jdtls",
      languageId: "java",
      displayName: "Eclipse JDT Language Server",
      available: true,
      active: true,
      selectedCommandId: "jdtls",
      selectedCommand: "jdtls",
      installHint: null,
      error: null,
    },
    locations: [],
  };

  beforeEach(() => {
    coreMocks.invoke.mockReset();
  });

  it("allocates request sequences monotonically across remount-capable consumers", () => {
    const first = nextLspRequestSequence();
    const second = nextLspRequestSequence();

    expect(second).toBe(first + 1);
  });

  it("passes the native cancel identity and forwards AbortSignal cancellation", async () => {
    let resolveRequest!: (value: LspLocationsResult) => void;
    coreMocks.invoke.mockImplementation((command: string) => {
      if (command === "lsp_definition") {
        return new Promise<LspLocationsResult>((resolve) => {
          resolveRequest = resolve;
        });
      }
      if (command === "lsp_cancel_reference_request") return Promise.resolve(true);
      return Promise.resolve(result);
    });

    const controller = new AbortController();
    const request = lspDefinition(descriptor, { line: 4, character: 8 }, {
      signal: controller.signal,
      cancelKey: "ws-query|root:App.java",
      requestSeq: 17,
    });

    expect(coreMocks.invoke).toHaveBeenCalledWith("lsp_definition", expect.objectContaining({
      cancelKey: "ws-query|root:App.java",
      requestSeq: 17,
    }));

    controller.abort();
    expect(coreMocks.invoke).toHaveBeenCalledWith("lsp_cancel_reference_request", {
      cancelKey: "ws-query|root:App.java",
      requestSeq: 17,
    });

    resolveRequest(result);
    await request;
  });

  it("passes a sequence-aware explicit cancel to native", async () => {
    coreMocks.invoke.mockResolvedValue(true);

    await expect(lspCancelReferenceRequest("ws-query|root:App.java", 18)).resolves.toBe(true);
    expect(coreMocks.invoke).toHaveBeenCalledWith("lsp_cancel_reference_request", {
      cancelKey: "ws-query|root:App.java",
      requestSeq: 18,
    });
  });
});
