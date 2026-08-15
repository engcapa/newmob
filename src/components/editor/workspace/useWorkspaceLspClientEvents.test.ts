import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import {
  LSP_SHOW_MESSAGE_CANCELLED_EVENT,
  LSP_SHOW_MESSAGE_EVENT,
  LSP_SHOW_MESSAGE_REQUEST_EVENT,
  LSP_WORK_DONE_PROGRESS_EVENT,
  useWorkspaceLspClientEvents,
} from "./useWorkspaceLspClientEvents";

vi.mock("@tauri-apps/api/event", () => import("../../../stubs/tauri-event"));

const lspMocks = vi.hoisted(() => ({
  lspResolveShowMessageRequest: vi.fn(),
  lspCancelWorkDoneProgress: vi.fn(),
}));

vi.mock("../../../lib/editor/lsp", () => lspMocks);

describe("useWorkspaceLspClientEvents", () => {
  beforeEach(() => {
    lspMocks.lspResolveShowMessageRequest.mockReset().mockResolvedValue(undefined);
    lspMocks.lspCancelWorkDoneProgress.mockReset().mockResolvedValue(true);
  });

  it("filters requests by workspace and resolves the selected action", async () => {
    const onStatus = vi.fn();
    const { result, unmount } = renderHook(() => useWorkspaceLspClientEvents({
      workspaceId: "workspace-a",
      visible: true,
      onStatus,
    }));

    await act(async () => {
      await emit(LSP_SHOW_MESSAGE_REQUEST_EVENT, {
        requestId: "other-request",
        workspaceId: "workspace-b",
        serverLabel: "Other",
        messageType: 3,
        message: "ignore",
        actions: [{ title: "No" }],
      });
      await emit(LSP_SHOW_MESSAGE_REQUEST_EVENT, {
        requestId: "request-1",
        workspaceId: "workspace-a",
        serverLabel: "Java",
        messageType: 3,
        message: "Reload project?",
        actions: [{ title: "Reload", command: "reload" }],
      });
    });

    await waitFor(() => expect(result.current.messageRequest?.requestId).toBe("request-1"));
    act(() => result.current.resolveMessageRequest(0));
    await waitFor(() => expect(lspMocks.lspResolveShowMessageRequest).toHaveBeenCalledWith(
      "request-1",
      "workspace-a",
      0,
    ));
    expect(result.current.messageRequest).toBeNull();
    expect(onStatus).not.toHaveBeenCalled();
    unmount();
  });

  it("dismisses a cancelled request and merges progress reports", async () => {
    const onStatus = vi.fn();
    const { result, unmount } = renderHook(() => useWorkspaceLspClientEvents({
      workspaceId: "workspace-a",
      visible: true,
      onStatus,
    }));

    await act(async () => {
      await emit(LSP_SHOW_MESSAGE_REQUEST_EVENT, {
        requestId: "request-2",
        workspaceId: "workspace-a",
        serverLabel: "Rust",
        messageType: 1,
        message: "Build failed",
        actions: [{ title: "Details" }],
      });
      await emit(LSP_SHOW_MESSAGE_CANCELLED_EVENT, {
        requestId: "request-2",
        workspaceId: "workspace-a",
        reason: "server stopped",
      });
      await emit(LSP_WORK_DONE_PROGRESS_EVENT, {
        workspaceId: "workspace-a",
        presetId: "rust",
        serverLabel: "Rust",
        rootUri: "file:///repo",
        token: "build",
        kind: "begin",
        title: "Building",
        message: null,
        percentage: 10,
        cancellable: true,
      });
      await emit(LSP_WORK_DONE_PROGRESS_EVENT, {
        workspaceId: "workspace-a",
        presetId: "rust",
        serverLabel: "Rust",
        rootUri: "file:///repo",
        token: "build",
        kind: "report",
        title: null,
        message: "Compiling",
        percentage: 55,
        cancellable: true,
      });
    });

    await waitFor(() => expect(result.current.messageRequest).toBeNull());
    await waitFor(() => expect(result.current.progresses).toHaveLength(1));
    expect(result.current.progresses[0]).toMatchObject({
      title: "Building",
      message: "Compiling",
      percentage: 55,
      cancellable: true,
    });

    act(() => result.current.cancelProgress(result.current.progresses[0]!));
    await waitFor(() => expect(lspMocks.lspCancelWorkDoneProgress).toHaveBeenCalledWith(
      "workspace-a",
      "rust",
      "file:///repo",
      "build",
    ));
    expect(result.current.progresses[0]?.cancellable).toBe(false);

    await act(async () => {
      await emit(LSP_WORK_DONE_PROGRESS_EVENT, {
        workspaceId: "workspace-a",
        presetId: "rust",
        serverLabel: "Rust",
        rootUri: "file:///repo",
        token: "build",
        kind: "end",
        title: "Building",
        message: "Done",
        percentage: 100,
        cancellable: false,
      });
    });
    await waitFor(() => expect(result.current.progresses).toHaveLength(0));
    expect(onStatus).toHaveBeenCalledWith("Building: Done");
    unmount();
  });

  it("surfaces one-way server messages only for the visible workspace", async () => {
    const onStatus = vi.fn();
    const { unmount } = renderHook(() => useWorkspaceLspClientEvents({
      workspaceId: "workspace-a",
      visible: true,
      onStatus,
    }));
    await act(async () => {
      await emit(LSP_SHOW_MESSAGE_EVENT, {
        workspaceId: "workspace-b",
        serverLabel: "Other",
        messageType: 3,
        message: "hidden",
      });
      await emit(LSP_SHOW_MESSAGE_EVENT, {
        workspaceId: "workspace-a",
        serverLabel: "Java",
        messageType: 2,
        message: "Indexing",
      });
    });
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith("Java: Warning: Indexing"));
    expect(onStatus).toHaveBeenCalledTimes(1);
    unmount();
  });
});
