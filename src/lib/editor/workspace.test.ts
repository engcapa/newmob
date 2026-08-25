import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  workspaceCompactChain,
  workspaceListDir,
  workspaceListFilesRecursive,
} from "./workspace";

const ENTRY = {
  name: "Main.java",
  path: "src/Main.java",
  fileType: "file",
  size: 12,
  mtime: 1_756_100_000,
  isHidden: false,
};

describe("workspace tree IPC boundary (W0 §8.20.1)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("passes a well-formed array through as ready", async () => {
    invokeMock.mockResolvedValue([ENTRY]);
    await expect(workspaceListDir("/repo", "")).resolves.toEqual({
      state: "ready",
      entries: [ENTRY],
      truncated: false,
    });
  });

  it("sets truncated when the listing reaches maxFiles", async () => {
    invokeMock.mockResolvedValue([ENTRY]);
    await expect(workspaceListFilesRecursive("/repo", "", 25, 1)).resolves.toEqual({
      state: "ready",
      entries: [ENTRY],
      truncated: true,
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("decodes %s payload to failed", async (_label, payload) => {
    invokeMock.mockResolvedValue(payload);
    const result = await workspaceListDir("/repo", "");
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.message).toContain("no payload");
    }
  });

  it("decodes a non-array payload to failed", async () => {
    invokeMock.mockResolvedValue({ entries: [] });
    const result = await workspaceListDir("/repo", "");
    expect(result.state).toBe("failed");
  });

  it("decodes a malformed entry to failed (whole batch)", async () => {
    invokeMock.mockResolvedValue([ENTRY, { name: 42, path: "x", fileType: "file", size: 1, mtime: 1, isHidden: false }]);
    const result = await workspaceListFilesRecursive("/repo", "");
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.message).toContain("malformed entry");
    }
  });

  it("decodes a malformed compact chain to failed", async () => {
    invokeMock.mockResolvedValue({ path: "src", entries: "not-an-array" });
    const result = await workspaceCompactChain("/repo", "src", 16);
    expect(result.state).toBe("failed");
  });

  it("decodes a well-formed compact chain to ready", async () => {
    invokeMock.mockResolvedValue({ path: "src/main", entries: [ENTRY] });
    await expect(workspaceCompactChain("/repo", "src", 16)).resolves.toEqual({
      state: "ready",
      entries: [ENTRY],
      truncated: false,
    });
  });

  it("converts a rejected invoke to failed instead of throwing", async () => {
    invokeMock.mockRejectedValue(new Error("backend gone"));
    const result = await workspaceListDir("/repo", "");
    expect(result).toEqual({ state: "failed", message: "backend gone" });
  });
});
