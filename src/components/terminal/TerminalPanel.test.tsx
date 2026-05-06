import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel";

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
  createLocalTerminal: vi.fn(async () => "terminal-session"),
  createSshTerminal: vi.fn(async () => "terminal-session"),
  decodeBase64: vi.fn(() => new Uint8Array()),
  encodeBase64: vi.fn((value: string) => btoa(value)),
  listenTerminalExit: vi.fn(async () => vi.fn()),
  listenTerminalForwardError: vi.fn(async () => vi.fn()),
  listenTerminalOutput: vi.fn(async () => vi.fn()),
  listSystemFonts: vi.fn(async () => ["Source Code Pro"]),
  resizeTerminal: vi.fn(async () => undefined),
  sendTerminalSignal: vi.fn(async () => undefined),
  writeTerminal: vi.fn(async () => undefined),
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
});
