import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { useChatStore } from "../../stores/chatStore";
import { useAiStore } from "../../stores/aiStore";
import type { ChatAttachment } from "../../lib/chat/attachments";

const invokeMock = vi.hoisted(() => vi.fn());
const dialogOpenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
}));

function attachment(path: string, index = 0): ChatAttachment {
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    id: `att-${index}`,
    kind: name.endsWith(".png") ? "image" : "file",
    path,
    name,
    size: 2048,
    mime: name.endsWith(".png") ? "image/png" : "text/plain",
  };
}

describe("Composer attachments", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    dialogOpenMock.mockReset();
    useChatStore.setState({
      pendingComposerText: "",
      composerDrafts: {},
      consumePendingComposerText: () => "",
    });
    // null config → Composer falls back to Ctrl+Enter (historical default)
    useAiStore.setState({ config: null });
    invokeMock.mockImplementation((command: string, args: { paths?: string[] }) => {
      if (command === "chat_stat_attachment_paths") {
        return Promise.resolve((args.paths ?? []).map((path, index) => attachment(path, index)));
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("attaches picker files and sends metadata without leaking the local path in content", async () => {
    dialogOpenMock.mockResolvedValue(["C:\\tmp\\diagram.png"]);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<Composer onSend={onSend} sending={false} />);

    fireEvent.click(screen.getByTestId("ai-chat-attach-button"));
    expect(await screen.findByText("diagram.png (2.0 KiB)")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Send (Ctrl+Enter)"));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toBe("Please review the attached files.");
    expect(onSend.mock.calls[0][0]).not.toContain("C:\\tmp\\diagram.png");
    expect(onSend.mock.calls[0][2]).toEqual([attachment("C:\\tmp\\diagram.png")]);
  });

  it("allows drafting and attaching while sending but blocks send", async () => {
    dialogOpenMock.mockResolvedValue(["C:\\tmp\\next.txt"]);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<Composer onSend={onSend} sending={true} />);

    const textarea = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: "next question" } });
    expect(textarea.value).toBe("next question");

    const attachButton = screen.getByTestId("ai-chat-attach-button");
    expect(attachButton).not.toBeDisabled();
    fireEvent.click(attachButton);
    expect(await screen.findByText("next.txt (2.0 KiB)")).toBeInTheDocument();

    const sendButton = screen.getByTitle("Send (Ctrl+Enter)");
    expect(sendButton).toBeDisabled();
    fireEvent.click(sendButton);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("restores an unsent draft for the same draft key", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<Composer draftKey="thread:draft-1" onSend={onSend} sending={false} />);

    const textarea = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "unfinished question" } });

    await waitFor(() => {
      expect(useChatStore.getState().composerDrafts["thread:draft-1"]?.text).toBe("unfinished question");
    });

    unmount();
    render(<Composer draftKey="thread:draft-1" onSend={onSend} sending={false} />);

    const restored = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    expect(restored.value).toBe("unfinished question");

    fireEvent.click(screen.getByTitle("Send (Ctrl+Enter)"));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("unfinished question", undefined, []));
    await waitFor(() => {
      expect(useChatStore.getState().composerDrafts["thread:draft-1"]).toBeUndefined();
    });
  });

  it("attaches OS-dropped file paths to the composer", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} sending={false} />);

    fireEvent.drop(screen.getByTestId("ai-chat-composer"), {
      dataTransfer: {
        types: ["Files", "text/uri-list"],
        files: [],
        getData: (format: string) => (format === "text/uri-list" ? "file:///C:/tmp/drop.png" : ""),
        dropEffect: "none",
      },
    });

    expect(await screen.findByText("drop.png (2.0 KiB)")).toBeInTheDocument();
  });

  it("attaches pasted clipboard images as image chips", async () => {
    const pasted = {
      ...attachment("/tmp/taomni-chat-clipboard.png"),
      name: "Pasted image",
    };
    invokeMock.mockImplementation((command: string, args: { paths?: string[] }) => {
      if (command === "chat_read_clipboard_image_attachment") {
        return Promise.resolve(pasted);
      }
      if (command === "chat_stat_attachment_paths") {
        return Promise.resolve((args.paths ?? []).map((path, index) => attachment(path, index)));
      }
      return Promise.resolve(null);
    });
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} sending={false} />);

    const textarea = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    const file = new File(["png"], "clipboard.png", { type: "image/png" });
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
        files: [file],
        getData: () => "",
      },
    });

    expect(await screen.findByText("Pasted image (2.0 KiB)")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("chat_read_clipboard_image_attachment");

    fireEvent.click(screen.getByTitle("Send (Ctrl+Enter)"));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toBe("Please review the attached files.");
    expect(onSend.mock.calls[0][2]).toEqual([pasted]);
  });

  it("rejects more than ten attachments", async () => {
    const paths = Array.from({ length: 11 }, (_, i) => `C:\\tmp\\file-${i}.txt`);
    dialogOpenMock.mockResolvedValue(paths);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<Composer onSend={onSend} sending={false} />);
    fireEvent.click(screen.getByTestId("ai-chat-attach-button"));

    expect(await screen.findByTestId("ai-chat-attachment-error")).toHaveTextContent("Attach up to 10 files.");
    expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
  });

  it("persists composer height after dragging the resize handle", () => {
    render(<Composer onSend={vi.fn()} sending={false} />);

    const handle = screen.getByTestId("ai-chat-composer-resize");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 20 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 20 });

    const textarea = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    expect(textarea.style.height).toBe("136px");
    expect(localStorage.getItem("taomni.chatComposer.height.v1")).toBe("136");
  });

  it("sends on Enter when chat_send_shortcut is enter", async () => {
    useAiStore.setState({
      config: { chat_send_shortcut: "enter" } as NonNullable<ReturnType<typeof useAiStore.getState>["config"]>,
    });
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} sending={false} />);

    expect(screen.getByTitle("Send (Enter)")).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello enter" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello enter", undefined, []));
  });

  it("does not send on bare Enter when chat_send_shortcut is ctrl_enter", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} sending={false} />);

    const textarea = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keep drafting" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("keep drafting", undefined, []));
  });
});
