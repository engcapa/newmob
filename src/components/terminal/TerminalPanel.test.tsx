import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel";
import { DEFAULT_TERMINAL_PROFILE } from "../../lib/terminalProfile";

const terminalMocks = vi.hoisted(() => {
  const focus = vi.fn();
  const terminalCtor = vi.fn().mockImplementation(() => ({
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        length: 0,
        viewportY: 0,
        getLine: vi.fn(),
      },
    },
    parser: {
      registerOscHandler: vi.fn(),
    },
    loadAddon: vi.fn(),
    open: vi.fn((el: HTMLElement) => {
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      el.appendChild(screen);
    }),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onBinary: vi.fn(() => ({ dispose: vi.fn() })),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onRender: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    refresh: vi.fn(),
    write: vi.fn(),
    focus,
    dispose: vi.fn(),
    getSelection: vi.fn(() => ""),
    hasSelection: vi.fn(() => false),
    clearSelection: vi.fn(),
    scrollToLine: vi.fn(),
    select: vi.fn(),
  }));

  return { focus, terminalCtor };
});

const fitMocks = vi.hoisted(() => ({
  fit: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  closeTerminal: vi.fn(async () => undefined),
  createLocalTerminal: vi.fn(async (sessionId: string) => sessionId),
  createSshTerminal: vi.fn(async (sessionId: string) => sessionId),
  createTerminalSessionId: vi.fn(() => "terminal-session"),
  encodeBase64: vi.fn((value: string) => btoa(value)),
  listenTerminalExit: vi.fn(async () => vi.fn()),
  listenTerminalForwardError: vi.fn(async () => vi.fn()),
  listSystemFonts: vi.fn(async () => ["Source Code Pro"]),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  readStreamClose: vi.fn(async () => undefined),
  readStreamOpen: vi.fn(async () => ({ handleId: "read-handle", size: 0, mtime: 0 })),
  readStreamRead: vi.fn(async () => new Uint8Array()),
  resizeTerminal: vi.fn(async () => undefined),
  selectSaveDirectory: vi.fn(async () => null),
  selectUploadFile: vi.fn(async (): Promise<string[]> => []),
  sendTerminalSignal: vi.fn(async () => undefined),
  writeTerminal: vi.fn(async () => undefined),
  writeStreamAbort: vi.fn(async () => undefined),
  writeStreamAppend: vi.fn(async () => undefined),
  writeStreamClose: vi.fn(async () => undefined),
  writeStreamOpen: vi.fn(async () => "stream-handle"),
  checkFileExists: vi.fn(async () => false),
  historyAppend: vi.fn(async () => undefined),
  historyMatchPrefix: vi.fn(async () => [] as string[]),
  historyListRecent: vi.fn(async () => [] as string[]),
  historyClear: vi.fn(async () => undefined),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMocks.terminalCtor,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: fitMocks.fit })),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({
    clearDecorations: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../../lib/ipc", () => ipcMocks);

vi.mock("../../lib/terminalImeGuard", () => ({
  attachTerminalImeGuard: vi.fn(() => vi.fn()),
  shouldUseLinuxImeGuard: vi.fn(() => false),
  TerminalImeInputGuard: vi.fn(),
}));

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe("TerminalPanel focus behavior", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("focuses the terminal after mounting an active tab", async () => {
    render(<TerminalPanel visible />);

    await waitFor(() => {
      expect(terminalMocks.focus).toHaveBeenCalledTimes(1);
    });
  });

  it("focuses the terminal when a hidden tab becomes active", async () => {
    const { rerender } = render(<TerminalPanel visible={false} />);

    expect(terminalMocks.focus).not.toHaveBeenCalled();

    rerender(<TerminalPanel visible />);

    await waitFor(() => {
      expect(terminalMocks.focus).toHaveBeenCalledTimes(1);
    });
  });

  it("pastes clipboard text with Shift+Insert", async () => {
    const readText = vi.fn(async () => "pasted text");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("pasted text"),
      );
    });
  });

  it("honors the right-click paste terminal setting", async () => {
    const readText = vi.fn(async () => "right click paste");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          rightClickBehavior: "paste",
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("right click paste"),
      );
    });
    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });

  it("omits the no-op ZMODEM receive action from the context menu", async () => {
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));

    await waitFor(() => {
      expect(screen.queryAllByTestId("context-menu").length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("context-menu-item-receive-file-using-z-modem")).not.toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-send-file-using-z-modem")).toBeInTheDocument();
  });

  it("queues a ZMODEM send from the context menu without reading the selected file into memory", async () => {
    ipcMocks.selectUploadFile.mockResolvedValueOnce(["/preview/uploads/big.bin"]);
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    await waitFor(() => {
      expect(screen.getByTestId("context-menu-item-send-file-using-z-modem")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("context-menu-item-send-file-using-z-modem"));

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith("terminal-session", btoa("rz\r"));
    });
    expect(ipcMocks.selectUploadFile).toHaveBeenCalledTimes(1);
    expect(ipcMocks.readFileBytes).not.toHaveBeenCalled();
    expect(ipcMocks.readStreamOpen).not.toHaveBeenCalled();
  });
});
