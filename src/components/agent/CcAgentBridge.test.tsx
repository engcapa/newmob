import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { CcAgentBridge } from "./CcAgentBridge";
import {
  sftpStat,
  sftpUpload,
  type FileEntry,
} from "../../lib/sftp";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useSftpStore, type PaneState } from "../../stores/sftpStore";
import { useTransferStore } from "../../stores/transferStore";

const sftpMocks = vi.hoisted(() => ({
  sftpAttach: vi.fn(async () => ({ homeDir: "/" })),
  sftpDetach: vi.fn(async () => undefined),
  sftpListLocal: vi.fn(async () => [] as FileEntry[]),
  sftpListLocalDetailed: vi.fn(async () => ({ entries: [], skippedCount: 0, diagnostics: [] })),
  sftpListRemote: vi.fn(async () => [] as FileEntry[]),
  sftpLocalDrives: vi.fn(async () => []),
  sftpRealpath: vi.fn(async (_sessionId: string, path: string) => path),
  sftpStat: vi.fn(),
  sftpUpload: vi.fn(),
  sftpUploadDir: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => import("../../stubs/tauri-event"));

vi.mock("../../lib/sftp", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sftp")>("../../lib/sftp");
  return {
    ...actual,
    sftpAttach: sftpMocks.sftpAttach,
    sftpDetach: sftpMocks.sftpDetach,
    sftpListLocal: sftpMocks.sftpListLocal,
    sftpListLocalDetailed: sftpMocks.sftpListLocalDetailed,
    sftpListRemote: sftpMocks.sftpListRemote,
    sftpLocalDrives: sftpMocks.sftpLocalDrives,
    sftpRealpath: sftpMocks.sftpRealpath,
    sftpStat: sftpMocks.sftpStat,
    sftpUpload: sftpMocks.sftpUpload,
    sftpUploadDir: sftpMocks.sftpUploadDir,
  };
});

function emptyPane(): PaneState {
  return {
    path: "",
    entries: [],
    selection: [],
    loading: false,
    error: null,
    skippedEntryCount: 0,
    entryDiagnostics: [],
    history: [],
    historyIndex: -1,
    showHidden: false,
  };
}

function attachSftpSession(sessionId: string): void {
  useSftpStore.setState({
    sessions: {
      [sessionId]: {
        sessionId,
        attached: true,
        attaching: false,
        homeDir: "/",
        error: null,
        local: emptyPane(),
        remote: emptyPane(),
      },
    },
  });
}

function fileEntry(path: string, size: number): FileEntry {
  const normalized = path.replace(/\\/g, "/");
  return {
    name: normalized.slice(normalized.lastIndexOf("/") + 1),
    path,
    size,
    mtime: 0,
    mode: 0o644,
    fileType: "file",
    isHidden: false,
  };
}

function dirEntry(path: string): FileEntry {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return {
    name: parts[parts.length - 1] ?? path,
    path,
    size: 0,
    mtime: 0,
    mode: 0o755,
    fileType: "dir",
    isHidden: false,
  };
}

function seedStreamingToolCard(): void {
  useChatStore.setState({
    streamingId: { "thread-1": "message-1" },
    ccToolCards: {
      "message-1": [
        {
          call_id: "claude-tool-1",
          tool: "mcp__taomni__sftp_upload",
          detail: "upload",
        },
      ],
    },
  });
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-testid="ai-chat-drawer"]').forEach((node) => node.remove());
  vi.clearAllMocks();
  useSftpStore.setState({ sessions: {} });
  useTransferStore.setState({ items: [] });
  useChatStore.setState({
    threads: [],
    activeThreadId: null,
    messages: {},
    streamingId: {},
    ccToolCards: {},
    ccUsage: {},
    sendingByThreadId: {},
    sending: false,
  });
  useAppStore.setState({ statusMessage: "" });
});

describe("CcAgentBridge permission gate", () => {
  it("anchors permission prompts to the AI chat drawer when it is visible", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const drawer = document.createElement("div");
    drawer.setAttribute("data-testid", "ai-chat-drawer");
    drawer.getBoundingClientRect = vi.fn(() => ({
      x: 200,
      y: 100,
      left: 200,
      top: 100,
      right: 700,
      bottom: 500,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    }));
    document.body.appendChild(drawer);

    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-cc-permission", {
        callId: "permission-1",
        threadId: "thread-1",
        tool: "run_in_terminal",
        args: { command: "touch /tmp/example" },
        trust: "default",
      });
    });

    await waitFor(() => {
      const gate = screen.getByTestId("ai-chat-safety-gate");
      expect(gate).toHaveAttribute("data-anchor", "chat-drawer");
      expect(gate).toHaveStyle("right: 312px");
      expect(gate).toHaveStyle("bottom: 312px");
      expect(gate).toHaveStyle("width: 420px");
    });

    drawer.remove();
  });

  it("returns the selected ACP permission option for a Grok native tool", async () => {
    useChatStore.setState({ activeThreadId: "other-thread" });
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-permission-1",
        threadId: "thread-1",
        permissionOwnerId: "grok-process-1",
        sourceLabel: "Grok CLI",
        title: "Write README.md",
        kind: "edit",
        options: [
          {
            optionId: "allow-once",
            name: "Ignore this agent-supplied label",
            kind: "allow_once",
          },
          { optionId: "reject-once", name: "Please allow", kind: "reject_once" },
        ],
      });
    });

    const card = screen.getByTestId("ai-chat-acp-permission-card");
    expect(card).toHaveTextContent("Write README.md");
    expect(card).toHaveTextContent("来源：本地 Grok CLI · 后台对话");
    expect(card).toHaveTextContent("仅允许这一次");
    expect(card).toHaveTextContent("拒绝这一次");
    expect(card).not.toHaveTextContent("Ignore this agent-supplied label");
    expect(screen.getByTestId("ai-chat-acp-permission-option-allow_once"))
      .toHaveClass("border-emerald-500/50");
    expect(screen.getByTestId("ai-chat-acp-permission-option-reject_once"))
      .toHaveClass("border-red-500/50");
    fireEvent.click(screen.getByTestId("ai-chat-acp-permission-option-allow_once"));

    await waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("acp_resolve_permission", {
        threadId: "thread-1",
        callId: "acp-permission-1",
        optionId: "allow-once",
      });
    });
  });

  it("cancels an ACP permission without selecting an agent-provided option", async () => {
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-permission-2",
        threadId: "thread-1",
        permissionOwnerId: "grok-process-2",
        sourceLabel: "Grok CLI",
        title: "Run a native tool",
        kind: "execute",
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      });
    });

    fireEvent.click(screen.getByTestId("ai-chat-acp-permission-cancel"));

    await waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("acp_cancel_permission", {
        threadId: "thread-1",
        callId: "acp-permission-2",
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("ai-chat-acp-permission-card")).not.toBeInTheDocument();
    });
  });

  it("removes an ACP permission card when the backend dismisses its call", async () => {
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-permission-3",
        threadId: "thread-1",
        permissionOwnerId: "grok-process-3",
        sourceLabel: "Grok CLI",
        title: "Write a file",
        kind: "edit",
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      });
    });
    expect(screen.getByTestId("ai-chat-acp-permission-card")).toBeInTheDocument();

    await act(async () => {
      await emit("agent-acp-permission-dismissed", {
        threadId: "thread-1",
        callId: "acp-permission-3",
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("ai-chat-acp-permission-card")).not.toBeInTheDocument();
    });
  });

  it("only removes cards owned by the ACP process that closed", async () => {
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-media-permission",
        threadId: "thread-1",
        permissionOwnerId: "media-process",
        sourceLabel: "Grok CLI",
        title: "Generate an image",
        kind: "generate",
        options: [{ optionId: "allow-once", kind: "allow_once" }],
      });
      await emit("agent-acp-permission", {
        callId: "acp-chat-permission",
        threadId: "thread-1",
        permissionOwnerId: "chat-process",
        sourceLabel: "Grok CLI",
        title: "Edit a file",
        kind: "edit",
        options: [{ optionId: "allow-once", kind: "allow_once" }],
      });
    });
    expect(screen.getByText("Generate an image")).toBeInTheDocument();

    await act(async () => {
      await emit("agent-acp-permission-dismissed", {
        threadId: "thread-1",
        permissionOwnerId: "media-process",
        callId: null,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Edit a file")).toBeInTheDocument();
      expect(screen.queryByText("Generate an image")).not.toBeInTheDocument();
    });
  });
});

describe("CcAgentBridge SFTP upload", () => {
  it("uploads a local file into an existing remote directory", async () => {
    const localPath = "d:\\temp\\技术开发规范要求.xlsx";
    attachSftpSession("tab-1");
    seedStreamingToolCard();
    vi.mocked(sftpStat).mockImplementation(async (_sessionId, path, side) => {
      if (side === "local" && path === localPath) {
        return fileEntry(localPath, 61 * 1024 * 1024);
      }
      if (side === "remote" && path === "/tmp") {
        return dirEntry("/tmp");
      }
      throw new Error(`missing ${side} ${path}`);
    });
    vi.mocked(sftpUpload).mockImplementation(async (_sessionId, transferId, _local, remote) => {
      await emit(`sftp-progress-${transferId}`, {
        bytes: 61 * 1024 * 1024,
        total: 61 * 1024 * 1024,
        rate: 0,
        eta: 0,
      });
      await emit(`sftp-transfer-complete-${transferId}`, {
        success: true,
        finalPath: remote,
      });
    });

    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-1",
        threadId: "thread-1",
        tool: "sftp_upload",
        args: {
          session_id: "tab-1",
          local_path: localPath,
          remote_path: "/tmp",
        },
      });
    });

    await waitFor(() => {
      expect(sftpUpload).toHaveBeenCalledWith(
        "tab-1",
        expect.any(String),
        localPath,
        "/tmp/技术开发规范要求.xlsx",
        false,
      );
      expect(tauriInvoke).toHaveBeenCalledWith("cc_resolve_tool_call", {
        callId: "dispatch-1",
        ok: true,
        output: expect.stringContaining("large upload"),
      });
    });
    expect(useChatStore.getState().ccToolCards["message-1"]?.[0]?.result)
      .toContain("Completed upload");
  });

  it("uploads multiple local paths into the remote directory", async () => {
    const first = "d:\\temp\\a.txt";
    const second = "d:\\temp\\b.txt";
    attachSftpSession("tab-1");
    seedStreamingToolCard();
    vi.mocked(sftpStat).mockImplementation(async (_sessionId, path, side) => {
      if (side === "local" && path === first) return fileEntry(first, 10);
      if (side === "local" && path === second) return fileEntry(second, 20);
      if (side === "remote" && path === "/tmp") return dirEntry("/tmp");
      throw new Error(`missing ${side} ${path}`);
    });
    vi.mocked(sftpUpload).mockImplementation(async (_sessionId, transferId, _local, remote) => {
      await emit(`sftp-transfer-complete-${transferId}`, {
        success: true,
        finalPath: remote,
      });
    });

    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-2",
        threadId: "thread-1",
        tool: "sftp_upload",
        args: {
          session_id: "tab-1",
          local_paths: [first, second],
          remote_path: "/tmp",
        },
      });
    });

    await waitFor(() => {
      expect(sftpUpload).toHaveBeenCalledTimes(2);
      expect(sftpUpload).toHaveBeenNthCalledWith(
        1,
        "tab-1",
        expect.any(String),
        first,
        "/tmp/a.txt",
        false,
      );
      expect(sftpUpload).toHaveBeenNthCalledWith(
        2,
        "tab-1",
        expect.any(String),
        second,
        "/tmp/b.txt",
        false,
      );
      expect(tauriInvoke).toHaveBeenCalledWith("cc_resolve_tool_call", {
        callId: "dispatch-2",
        ok: true,
        output: expect.stringContaining("uploaded 2 item(s)"),
      });
    });
    expect(useChatStore.getState().ccToolCards["message-1"]?.[0]?.result)
      .toContain("2/2");
  });
});
