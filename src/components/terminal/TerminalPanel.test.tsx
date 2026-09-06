import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel, collectTerminalBlockSelectionText } from "./TerminalPanel";
import { DEFAULT_TERMINAL_PROFILE, SYSTEM_TERMINAL_THEME } from "../../lib/terminalProfile";
import { NATIVE_FILE_DROP_EVENT } from "../../lib/osFileDrop";
import { useAppStore } from "../../stores/appStore";

const terminalMocks = vi.hoisted(() => {
  const focus = vi.fn();
  const modes = { bracketedPasteMode: false };
  const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  const state = {
    onDataHandler: null as ((data: string) => void) | null,
    onResizeHandler: null as ((size: { cols: number; rows: number }) => void) | null,
    customKeyEventHandler: null as ((event: KeyboardEvent) => boolean) | null,
  };
  const terminalCtor = vi.fn().mockImplementation(function () {
    return {
      cols: 80,
      rows: 24,
      buffer: {
        active: {
          length: 0,
          viewportY: 0,
          getLine: vi.fn(),
        },
      },
      modes,
      parser: {
        registerOscHandler: vi.fn((ident: number, handler: (data: string) => boolean | Promise<boolean>) => {
          oscHandlers.set(ident, handler);
          return { dispose: vi.fn() };
        }),
      },
      loadAddon: vi.fn(),
      open: vi.fn((el: HTMLElement) => {
        const screen = document.createElement("div");
        screen.className = "xterm-screen";
        el.appendChild(screen);
      }),
      onData: vi.fn((handler: (data: string) => void) => {
        state.onDataHandler = handler;
        return { dispose: vi.fn() };
      }),
      onBinary: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn((handler: (size: { cols: number; rows: number }) => void) => {
        state.onResizeHandler = handler;
        return { dispose: vi.fn() };
      }),
      onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
        state.customKeyEventHandler = handler;
      }),
      refresh: vi.fn(),
      write: vi.fn(),
      focus,
      dispose: vi.fn(),
      getSelection: vi.fn(() => ""),
      hasSelection: vi.fn(() => false),
      clearSelection: vi.fn(),
      scrollToLine: vi.fn(),
      select: vi.fn(),
    };
  });

  return { focus, modes, terminalCtor, oscHandlers, state };
});

const fitMocks = vi.hoisted(() => ({
  fit: vi.fn(),
}));

const webglMocks = vi.hoisted(() => {
  const instances: Array<{
    contextLossDispose: ReturnType<typeof vi.fn>;
    contextLossHandler: (() => void) | null;
    dispose: ReturnType<typeof vi.fn>;
    onContextLoss: ReturnType<typeof vi.fn>;
  }> = [];

  const ctor = vi.fn().mockImplementation(function () {
    const instance = {
      contextLossDispose: vi.fn(),
      contextLossHandler: null as (() => void) | null,
      dispose: vi.fn(),
      onContextLoss: vi.fn((handler: () => void) => {
        instance.contextLossHandler = handler;
        return { dispose: instance.contextLossDispose };
      }),
    };
    instances.push(instance);
    return instance;
  });

  return { ctor, instances };
});

const ipcMocks = vi.hoisted(() => {
  const terminalExitHandlers = new Map<string, () => void>();

  return {
    terminalExitHandlers,
    closeTerminal: vi.fn(async () => undefined),
    createLocalTerminal: vi.fn(async (
      sessionId: string,
      _cols?: number,
      _rows?: number,
      _shell?: string,
      _shellArgs?: string[],
      _cwd?: string,
      _onOutput?: (data: Uint8Array) => void,
      _workspaceRoot?: string,
    ) => ({ sessionId, shellId: "default" })),
    createSshTerminal: vi.fn(async (sessionId: string) => sessionId),
    listenSshAuthPrompt: vi.fn(async () => vi.fn()),
    submitSshAuthResponse: vi.fn(async () => undefined),
    createTerminalSessionId: vi.fn(() => "terminal-session"),
    encodeBase64: vi.fn((value: string) => btoa(value)),
    listenTerminalExit: vi.fn(async (sessionId: string, callback: () => void) => {
      terminalExitHandlers.set(sessionId, callback);
      return vi.fn(() => terminalExitHandlers.delete(sessionId));
    }),
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
    ccTrackTerminal: vi.fn(async () => undefined),
    ccUntrackTerminal: vi.fn(async () => undefined),
    recordLocalDirectoryUse: vi.fn(async () => ({ changed: true })),
    historyAppend: vi.fn(async () => undefined),
    historyMatchPrefix: vi.fn(async () => [] as string[]),
    historyListRecent: vi.fn(async () => [] as string[]),
    historyClear: vi.fn(async () => undefined),
  };
});

const clipboardMocks = vi.hoisted(() => ({
  readFiles: vi.fn(async () => [] as string[]),
  parseFilePaths: vi.fn(async (_text: string) => [] as string[]),
}));

const sockscapMocks = vi.hoisted(() => ({
  sockscapLaunchTerminalApp: vi.fn(async (
    terminalSessionId: string,
    profileId: string,
    path: string,
    args: string[],
  ) => ({
    pid: 4242,
    profileId,
    path,
    args,
    running: true,
    terminalSessionId,
  })),
  sockscapStopLaunchedApp: vi.fn(async () => undefined),
}));

const gitMocks = vi.hoisted(() => ({
  gitProbePath: vi.fn(async (path: string) => ({
    path,
    gitAvailable: true,
    isRepo: true,
    repoRoot: path,
    error: null,
  })),
  gitSnapshot: vi.fn(async (repoRoot: string) => ({
    repoRoot,
    currentBranch: "main",
    headOid: "abc123",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    remotes: [],
    branches: [],
    stashes: [],
    settings: {
      userName: null,
      userEmail: null,
      httpProxy: null,
      httpsProxy: null,
      pullRebase: null,
      pushDefault: null,
      coreAutocrlf: null,
      coreFilemode: null,
      commitGpgsign: null,
    },
  })),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMocks.terminalCtor,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return { fit: fitMocks.fit };
  }),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(function () {
    return {
      clearDecorations: vi.fn(),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: webglMocks.ctor,
}));

vi.mock("../../lib/ipc", () => ipcMocks);

vi.mock("../../lib/clipboard", async () => {
  const actual = await vi.importActual<typeof import("../../lib/clipboard")>("../../lib/clipboard");
  return {
    ...actual,
    readFiles: clipboardMocks.readFiles,
    parseFilePaths: clipboardMocks.parseFilePaths,
  };
});

vi.mock("../../lib/git", () => gitMocks);

vi.mock("../../lib/sockscap", () => sockscapMocks);

vi.mock("../../lib/terminalImeGuard", () => ({
  attachTerminalImeGuard: vi.fn(() => vi.fn()),
  shouldUseLinuxImeGuard: vi.fn(() => false),
  TerminalImeInputGuard: vi.fn(),
}));

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

function encodeOsc52Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `c;${btoa(binary)}`;
}

describe("terminal block selection helpers", () => {
  it("extracts fixed-column text across terminal buffer rows", () => {
    const rows = ["alpha bravo", "xy", "123456789"];
    const term = {
      cols: 12,
      buffer: {
        active: {
          getLine: (row: number) => ({
            translateToString: () => rows[row] ?? "",
          }),
        },
      },
    };

    expect(
      collectTerminalBlockSelectionText(term as never, {
        anchor: { row: 2, col: 5 },
        focus: { row: 0, col: 2 },
      }),
    ).toBe("pha\n\n3456");
  });
});

const sshInfo = {
  host: "example.test",
  port: 22,
  username: "user",
  authMethod: "Password",
  authData: "secret",
};

describe("TerminalPanel focus behavior", () => {
  beforeEach(() => {
    window.localStorage.clear();
    terminalMocks.oscHandlers.clear();
    terminalMocks.state.onDataHandler = null;
    terminalMocks.state.onResizeHandler = null;
    terminalMocks.state.customKeyEventHandler = null;
    ipcMocks.terminalExitHandlers.clear();
    useAppStore.setState({ terminalRuntimeByTab: {}, cwdByTab: {} });
    ipcMocks.createTerminalSessionId.mockImplementation(() => "terminal-session");
    ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
      sessionId,
      shellId: "default",
    }));
    ipcMocks.recordLocalDirectoryUse.mockClear();
    ipcMocks.createSshTerminal.mockImplementation(async (sessionId: string) => sessionId);
    ipcMocks.listenTerminalExit.mockImplementation(async (sessionId: string, callback: () => void) => {
      ipcMocks.terminalExitHandlers.set(sessionId, callback);
      return vi.fn(() => ipcMocks.terminalExitHandlers.delete(sessionId));
    });
    sockscapMocks.sockscapLaunchTerminalApp.mockClear();
    sockscapMocks.sockscapStopLaunchedApp.mockClear();
    clipboardMocks.readFiles.mockReset();
    clipboardMocks.readFiles.mockResolvedValue([]);
    clipboardMocks.parseFilePaths.mockReset();
    clipboardMocks.parseFilePaths.mockResolvedValue([]);
    webglMocks.instances.length = 0;
    webglMocks.ctor.mockClear();
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

  it("launches a SocksCap TUI only once when StrictMode replays mount effects", async () => {
    render(
      <StrictMode>
        <TerminalPanel
          tabId="sockscap-tab"
          visible
          sockscapTerminal={{
            profileId: "default",
            path: "agy",
            args: [],
            launchPreparation: {
              workingDirectory: "/workspace/agy",
              preCommand: "export AGL_RUN_MODE=prepared",
            },
            terminalSessionId: "sockscap-terminal-session",
          }}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(sockscapMocks.sockscapLaunchTerminalApp).toHaveBeenCalledTimes(1);
    });
    expect(sockscapMocks.sockscapLaunchTerminalApp).toHaveBeenCalledWith(
      "sockscap-terminal-session",
      "default",
      "agy",
      [],
      {
        workingDirectory: "/workspace/agy",
        preCommand: "export AGL_RUN_MODE=prepared",
      },
      80,
      24,
      expect.any(Function),
    );
  });

  it("passes the workspace root when launching an SDK-aware local terminal", async () => {
    render(<TerminalPanel visible initialCwd="/repo/app" workspaceRoot="/repo" />);

    await waitFor(() => expect(ipcMocks.createLocalTerminal).toHaveBeenCalled());
    expect(ipcMocks.createLocalTerminal.mock.calls[0]?.[7]).toBe("/repo");
  });

  it("tracks a submitted program and returns to idle on the next shell prompt", async () => {
    render(<TerminalPanel tabId="term-activity" visible />);

    await waitFor(() => {
      expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]?.backendSessionId).toBe(
        "terminal-session",
      );
    });

    terminalMocks.state.onDataHandler?.("sudo -u deploy vite --host");
    terminalMocks.state.onDataHandler?.("\r");

    expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]).toMatchObject({
      state: "running",
      program: "vite",
      activitySource: "input-heuristic",
    });

    terminalMocks.oscHandlers.get(7)?.("file://localhost/work/taomni");
    expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]).toMatchObject({
      state: "idle",
      activitySource: "shell-integration",
    });
    expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]?.program).toBeUndefined();
  });

  it("installs SSH cwd reporting when a delayed startup later reaches an idle prompt", async () => {
    let onOutput: ((data: Uint8Array) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return "terminal-session";
    });
    const onSessionReady = vi.fn();
    render(<TerminalPanel tabId="slow-ssh" visible ssh={sshInfo} onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      expect(onOutput).toBeTypeOf("function");
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    const prompt = "(base) user@example.test:/srv/project$ ";
    term.buffer.active = {
      type: "normal",
      length: 1,
      baseY: 0,
      cursorY: 0,
      cursorX: prompt.length,
      getLine: vi.fn(() => ({
        isWrapped: false,
        translateToString: () => prompt,
      })),
    };
    term.write.mockImplementation((_data: Uint8Array, callback?: () => void) => callback?.());
    ipcMocks.writeTerminal.mockClear();

    await act(async () => {
      onOutput?.(new TextEncoder().encode(prompt));
    });

    await waitFor(() => {
      const integrationWrite = (ipcMocks.writeTerminal.mock.calls as unknown[][]).find(
        ([sessionId, encoded]) =>
          sessionId === "terminal-session" &&
          typeof encoded === "string" &&
          atob(encoded).includes("__taomni_osc7"),
      );
      expect(integrationWrite).toBeTruthy();
    });
  });

  it("does not load the WebGL renderer inside the macOS Tauri webview", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    try {
      render(<TerminalPanel visible />);

      await waitFor(() => {
        expect(terminalMocks.terminalCtor).toHaveBeenCalled();
      });
      expect(webglMocks.ctor).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("does not load the WebGL renderer when disabled in the terminal profile", async () => {
    render(
      <TerminalPanel
        visible
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          webglRenderer: false,
        }}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });
    expect(webglMocks.ctor).not.toHaveBeenCalled();
  });

  it("falls back to the default renderer when the WebGL context is lost", async () => {
    render(<TerminalPanel visible terminalProfile={DEFAULT_TERMINAL_PROFILE} />);

    await waitFor(() => {
      expect(webglMocks.ctor).toHaveBeenCalledTimes(1);
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    const webgl = webglMocks.instances[0];
    webgl.contextLossHandler?.();

    expect(webgl.contextLossDispose).toHaveBeenCalledTimes(1);
    expect(webgl.dispose).toHaveBeenCalledTimes(1);
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
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

  it("handles macOS Cmd+V through the active clipboard path without double-pasting", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "permission paste");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      fireEvent.keyDown(window, { key: "v", metaKey: true });
      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("permission paste"),
        );
      });
      expect(readText).toHaveBeenCalledTimes(1);

      const screenEl = screen.getByTestId("terminal-pane").querySelector(".xterm-screen");
      expect(screenEl).toBeTruthy();
      const getData = vi.fn((type: string) => (type === "text/plain" ? "native paste" : ""));
      fireEvent.paste(screenEl as Element, {
        clipboardData: { getData },
      });

      await Promise.resolve();
      expect(ipcMocks.writeTerminal).toHaveBeenCalledTimes(1);
      expect(getData).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("confirms macOS native multi-line paste before writing to the terminal", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "permission paste");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const screenEl = screen.getByTestId("terminal-pane").querySelector(".xterm-screen");
      expect(screenEl).toBeTruthy();
      const getData = vi.fn((type: string) => (type === "text/plain" ? "line1\nline2" : ""));
      fireEvent.paste(screenEl as Element, {
        clipboardData: { getData },
      });

      await waitFor(() => {
        expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      });
      expect(readText).not.toHaveBeenCalled();
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalledWith(
        "terminal-session",
        btoa("line1\rline2"),
      );

      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("line1\rline2"),
        );
      });
      expect(readText).not.toHaveBeenCalled();
      expect(getData).toHaveBeenCalledWith("text/plain");
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("converts LF to CR for multi-line paste when bracketed paste is off", async () => {
    terminalMocks.modes.bracketedPasteMode = false;
    const readText = vi.fn(async () => "line1\nline2\nline3");
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
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    expect(ipcMocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-session",
      btoa("line1\rline2\rline3"),
    );

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("line1\rline2\rline3"),
      );
    });
  });

  it("wraps multi-line paste in CSI 200~/201~ when bracketed paste is on", async () => {
    terminalMocks.modes.bracketedPasteMode = true;
    const readText = vi.fn(async () => "line1\nline2\nline3");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("\x1b[200~line1\nline2\nline3\x1b[201~"),
        );
      });
    } finally {
      terminalMocks.modes.bracketedPasteMode = false;
    }
  });

  it("inserts shell-quoted dropped file paths into the terminal", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.dragOver(screen.getByTestId("terminal-pane"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("'/home/me/a b.png' "),
      );
    });
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("inserts native Tauri dropped file paths into the terminal", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const pane = screen.getByTestId("terminal-pane");
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => pane),
    });

    try {
      window.dispatchEvent(
        new CustomEvent(NATIVE_FILE_DROP_EVENT, {
          detail: {
            paths: ["/home/me/a b.png"],
            clientX: 10,
            clientY: 10,
          },
        }),
      );

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("'/home/me/a b.png' "),
        );
      });
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });

  it("prompts to upload copied file paths in an SSH shell and defaults to upload", async () => {
    clipboardMocks.readFiles.mockResolvedValue(["/home/me/a b.png"]);
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

    // The dialog enters the document one commit before its autofocus effect moves
    // focus to the confirm button, so presence does not imply focus. Both facts are
    // asserted under the same gate rather than gating on the earlier one.
    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("confirm-dialog-confirm")).toHaveFocus();
    });
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("/home/user/project");

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(onUploadLocalPaths).toHaveBeenCalledWith({
        paths: ["/home/me/a b.png"],
        cwd: "/home/user/project",
      });
    });
  });

  it("pastes copied file paths when the SSH upload prompt is declined", async () => {
    clipboardMocks.readFiles.mockResolvedValue(["/home/me/a b.png"]);
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("'/home/me/a b.png' "),
      );
    });
    expect(onUploadLocalPaths).not.toHaveBeenCalled();
  });

  it("prompts to upload when clipboard text contains a quoted local file path", async () => {
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "'/home/zhyhang/图片/2026-08-27_23-08.png'");
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    clipboardMocks.readFiles.mockResolvedValue([]);
    clipboardMocks.parseFilePaths.mockResolvedValue(["/home/zhyhang/图片/2026-08-27_23-08.png"]);

    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    try {
      render(
        <TerminalPanel
          visible
          ssh={sshInfo}
          onSessionReady={onSessionReady}
          onUploadLocalPaths={onUploadLocalPaths}
        />,
      );

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });
      terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

      fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      });
      expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("/home/user/project");

      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

      await waitFor(() => {
        expect(onUploadLocalPaths).toHaveBeenCalledWith({
          paths: ["/home/zhyhang/图片/2026-08-27_23-08.png"],
          cwd: "/home/user/project",
        });
      });
    } finally {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("prompts to upload dragged file paths in an SSH shell", async () => {
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(onUploadLocalPaths).toHaveBeenCalledWith({
        paths: ["/home/me/a b.png"],
        cwd: "/home/user/project",
      });
    });
  });

  it("prompts to upload dragged file paths even when the shell prompt is custom", async () => {
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

    const term = terminalMocks.terminalCtor.mock.results[terminalMocks.terminalCtor.mock.results.length - 1].value;
    const prompt = "[user@example.test project] λ ";
    term.buffer.active = {
      type: "normal",
      length: 1,
      baseY: 0,
      cursorY: 0,
      cursorX: prompt.length,
      getLine: vi.fn(() => ({
        isWrapped: false,
        translateToString: () => prompt,
      })),
    };

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(onUploadLocalPaths).toHaveBeenCalledWith({
        paths: ["/home/me/a b.png"],
        cwd: "/home/user/project",
      });
    });
  });

  it("pastes dragged file paths in an SSH alternate-screen app", async () => {
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    const term = terminalMocks.terminalCtor.mock.results[terminalMocks.terminalCtor.mock.results.length - 1].value;
    term.buffer.active.type = "alternate";

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("'/home/me/a b.png' "),
      );
    });
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(onUploadLocalPaths).not.toHaveBeenCalled();
  });

  it("blocks typed input when split input is locked", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible inputLocked onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      expect(terminalMocks.state.onDataHandler).toBeTruthy();
    });

    terminalMocks.state.onDataHandler?.("blocked");

    expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-input-locked")).toHaveTextContent("Input locked");
  });

  it("blocks clipboard paste when split input is locked", async () => {
    const readText = vi.fn(async () => "locked paste");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible inputLocked onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });
    await Promise.resolve();

    expect(readText).not.toHaveBeenCalled();
    expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
  });

  it("blocks dropped file paths when split input is locked", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible inputLocked onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
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

  it("keeps a block selection alive when pressing the floating selection toolbar", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    term.buffer.active.length = 4;
    term.buffer.active.viewportY = 0;
    term.buffer.active.getLine.mockImplementation((row: number) => ({
      translateToString: () => ["alpha bravo", "charlie delta", "echo foxtrot", ""][row] ?? "",
    }));

    const screenEl = screen.getByTestId("terminal-pane").querySelector(".xterm-screen") as HTMLElement;
    vi.spyOn(screenEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 240,
      width: 800,
      height: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(screenEl, { button: 0, ctrlKey: true, shiftKey: true, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 70, clientY: 20 });

    const copyButton = await screen.findByTitle("Copy (Ctrl+C)");
    fireEvent.mouseDown(copyButton, { button: 0 });

    expect(screen.getByTitle("Copy (Ctrl+C)")).toBeInTheDocument();
  });

  it("pastes the captured terminal selection on macOS middle mouse up", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "clipboard fallback");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      term.getSelection.mockReturnValue("selected text");
      const pane = screen.getByTestId("terminal-pane");

      fireEvent.mouseDown(pane, { button: 1 });
      term.getSelection.mockReturnValue("");
      fireEvent.mouseUp(pane, { button: 1 });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("selected text"),
        );
      });
      expect(readText).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("falls back to the clipboard on macOS middle mouse up when there is no terminal selection", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "mac clipboard");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const pane = screen.getByTestId("terminal-pane");
      fireEvent.mouseDown(pane, { button: 1 });
      fireEvent.mouseUp(pane, { button: 1 });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("mac clipboard"),
        );
      });
      expect(readText).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("does not paste twice when macOS emits both mouseup and auxclick for the middle button", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      term.getSelection.mockReturnValue("selected once");
      const pane = screen.getByTestId("terminal-pane");

      fireEvent.mouseDown(pane, { button: 1 });
      fireEvent.mouseUp(pane, { button: 1 });
      fireEvent(pane, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledTimes(1);
      });
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("selected once"),
      );
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("keeps non-macOS middle-click paste on the existing auxclick path", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "windows clipboard");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "Win32",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const pane = screen.getByTestId("terminal-pane");
      fireEvent.mouseDown(pane, { button: 1 });
      fireEvent.mouseUp(pane, { button: 1 });
      await Promise.resolve();

      expect(readText).not.toHaveBeenCalled();
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

      fireEvent(pane, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("windows clipboard"),
        );
      });
      expect(readText).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("accepts OSC 52 clipboard writes from local terminals", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    render(<TerminalPanel visible terminalProfile={DEFAULT_TERMINAL_PROFILE} />);

    await waitFor(() => {
      expect(terminalMocks.oscHandlers.get(52)).toBeTruthy();
    });

    terminalMocks.oscHandlers.get(52)?.(encodeOsc52Text("local copy"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("local copy");
    });
  });

  it("blocks OSC 52 clipboard writes from SSH terminals by default", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    render(<TerminalPanel visible ssh={sshInfo} terminalProfile={DEFAULT_TERMINAL_PROFILE} />);

    await waitFor(() => {
      expect(terminalMocks.oscHandlers.get(52)).toBeTruthy();
    });

    terminalMocks.oscHandlers.get(52)?.(encodeOsc52Text("remote copy"));
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });

  it("reconnects an SSH terminal with Enter after exit while keeping the same xterm instance", async () => {
    ipcMocks.createTerminalSessionId
      .mockReturnValueOnce("terminal-session")
      .mockReturnValueOnce("terminal-session-reconnect");
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    ipcMocks.terminalExitHandlers.get("terminal-session")?.();

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(expect.stringContaining("Press Enter to reconnect"));
    });
    expect(ipcMocks.writeTerminal).not.toHaveBeenCalledWith("terminal-session", btoa("\r"));

    terminalMocks.state.onDataHandler?.("\r");

    await waitFor(() => {
      expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(2);
    });
    expect(ipcMocks.createSshTerminal).toHaveBeenLastCalledWith(
      "terminal-session-reconnect",
      sshInfo.host,
      sshInfo.port,
      sshInfo.username,
      sshInfo.authMethod,
      sshInfo.authData,
      80,
      24,
      expect.any(String),
      expect.any(Function),
      true,
      true,
      null,
      false,
    );
    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session-reconnect");
    });
    expect(terminalMocks.terminalCtor).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith(expect.stringContaining("[Reconnecting"));
    expect(term.write).toHaveBeenCalledWith(expect.stringContaining("[Reconnected"));

    ipcMocks.writeTerminal.mockClear();
    terminalMocks.state.onDataHandler?.("whoami\r");

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session-reconnect",
        btoa("whoami\r"),
      );
    });
  });

  it("passes saved SSH startup command options to the backend", async () => {
    render(
      <TerminalPanel
        visible
        ssh={{
          ...sshInfo,
          optionsJson: JSON.stringify({
            startupCmd: "  tmux new -A -s main  ",
          }),
        }}
      />,
    );

    await waitFor(() => {
      expect(ipcMocks.createSshTerminal).toHaveBeenCalled();
    });

    expect(ipcMocks.createSshTerminal).toHaveBeenCalledWith(
      "terminal-session",
      sshInfo.host,
      sshInfo.port,
      sshInfo.username,
      sshInfo.authMethod,
      sshInfo.authData,
      80,
      24,
      expect.any(String),
      expect.any(Function),
      true,
      true,
      "tmux new -A -s main",
      true,
    );
  });

  it("uses the latest measured terminal size when reconnecting SSH", async () => {
    ipcMocks.createTerminalSessionId
      .mockReturnValueOnce("terminal-session")
      .mockReturnValueOnce("terminal-session-reconnect");
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      term.cols = 132;
      term.rows = 37;
      ipcMocks.terminalExitHandlers.get("terminal-session")?.();

      terminalMocks.state.onDataHandler?.("\r");

      await waitFor(() => {
        expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(2);
      });
      expect(ipcMocks.createSshTerminal).toHaveBeenLastCalledWith(
        "terminal-session-reconnect",
        sshInfo.host,
        sshInfo.port,
        sshInfo.username,
        sshInfo.authMethod,
        sshInfo.authData,
        132,
        37,
        expect.any(String),
        expect.any(Function),
        true,
        true,
        null,
        false,
      );
      await waitFor(() => {
        expect(ipcMocks.resizeTerminal).toHaveBeenCalledWith("terminal-session-reconnect", 132, 37);
      });
    } finally {
      clientWidth.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it("shows a retry prompt when SSH reconnect fails and does not write Enter to the old session", async () => {
    ipcMocks.createTerminalSessionId
      .mockReturnValueOnce("terminal-session")
      .mockReturnValueOnce("terminal-session-reconnect");
    ipcMocks.createSshTerminal
      .mockImplementationOnce(async (sessionId: string) => sessionId)
      .mockImplementationOnce(async () => {
        throw new Error("network down");
      });
    const onSessionReady = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      ipcMocks.terminalExitHandlers.get("terminal-session")?.();

      ipcMocks.writeTerminal.mockClear();
      terminalMocks.state.onDataHandler?.("\r");

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith(expect.stringContaining("[Reconnect failed]"));
        expect(term.write).toHaveBeenCalledWith(expect.stringContaining("Press Enter to retry"));
      });
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

      terminalMocks.state.onDataHandler?.("ls\r");
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sends macOS Option printable characters directly to the terminal", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      fireEvent.keyDown(window, { key: "@", code: "Digit2", altKey: true });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith("terminal-session", btoa("@"));
      });
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("accepts OSC 52 clipboard writes from SSH terminals when enabled", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          allowRemoteOsc52Clipboard: true,
        }}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.oscHandlers.get(52)).toBeTruthy();
    });

    terminalMocks.oscHandlers.get(52)?.(encodeOsc52Text("remote copy"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("remote copy");
    });
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

  it("puts terminal zoom actions at the top level and keeps font settings in appearance", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, fontSize: 14 }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));

    expect(await screen.findByText("Zoom in")).toBeInTheDocument();
    expect(screen.getByText("Zoom out")).toBeInTheDocument();
    expect(screen.getByText("Reset zoom")).toBeInTheDocument();
    expect(screen.queryByTestId("context-menu-item-font-size")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-menu-item-font-settings")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Use font/)).not.toBeInTheDocument();
    expect(screen.queryByText("More fonts...")).not.toBeInTheDocument();
    expect(screen.queryByText("Display font ligatures")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Zoom in"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 15,
      theme: DEFAULT_TERMINAL_PROFILE.theme,
    }));
  });

  it("emits a complete terminal profile when a context menu theme is selected", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, theme: "classic", fontSize: 16 }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByText("Termius Dark"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 16,
      theme: "termius-dark",
      fontFamily: DEFAULT_TERMINAL_PROFILE.fontFamily,
    }));
  });

  it("keeps the open terminal appearance menu in sync while changing theme and font size", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, theme: "classic", fontSize: 14 }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));

    const kanagawa = await screen.findByTestId("terminal-context-theme-option-kanagawa-wave");
    fireEvent.click(kanagawa);

    expect(kanagawa).toHaveAttribute("aria-selected", "true");

    const sizeInput = screen.getByTestId("terminal-context-font-size");
    const increase = screen.getByLabelText("Increase terminal font size");
    fireEvent.click(increase);
    expect(sizeInput).toHaveValue("15");
    fireEvent.click(increase);
    expect(sizeInput).toHaveValue("16");

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: "kanagawa-wave",
      fontSize: 16,
    }));
  });

  it("offers code view themes in the terminal appearance context menu", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, theme: "classic" }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByTestId("terminal-context-theme-option-dracula"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dracula" }));
  });

  it("does not render the Git rail button inside the terminal pane", async () => {
    const onOpen = vi.fn();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        gitToggle={{ cwd: "/repo", onOpen }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    expect(screen.queryByTestId("terminal-git-toggle")).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("adds a Git action to the local terminal context menu", async () => {
    const onOpen = vi.fn();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        gitToggle={{ cwd: "/repo", onOpen }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByText("Open Git Panel"));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("saves the current theme as the default for new terminals", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "kanagawa-wave",
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-theme"));

    const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
    expect(stored.theme).toBe("kanagawa-wave");
  });

  it("saves appearance changes made in the open context menu as the terminal default", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "classic",
          fontSize: 14,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByTestId("terminal-context-theme-option-kanagawa-wave"));
    fireEvent.click(screen.getByLabelText("Increase terminal font size"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-theme"));

    const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
    expect(stored.theme).toBe("kanagawa-wave");
    expect(stored.fontSize).toBe(15);
  });

  it("does not auto-save terminal appearance changes for future terminals", async () => {
    window.localStorage.clear();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "classic",
          fontSize: 14,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByTestId("terminal-context-theme-option-kanagawa-wave"));

    fireEvent.change(screen.getByTestId("terminal-context-font-size"), { target: { value: "18" } });

    expect(window.localStorage.getItem("taomni.terminalDefaultProfile.v1")).toBeNull();
  });

  it("keeps follow-system as a savable terminal default theme", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: SYSTEM_TERMINAL_THEME,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-theme"));

    const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
    expect(stored.theme).toBe(SYSTEM_TERMINAL_THEME);
  });

  it("saves all current terminal settings as the terminal default after confirmation", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "dracula",
          readOnly: true,
          showScrollbar: false,
          copyOnSelect: true,
          scrollback: 4321,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-profile"));
    fireEvent.click(await screen.findByRole("button", { name: "Save defaults" }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
      expect(stored).toMatchObject({
        theme: "dracula",
        readOnly: true,
        showScrollbar: false,
        copyOnSelect: true,
        scrollback: 4321,
      });
    });
  });

  it("opens the current terminal settings dialog and applies behavior changes", async () => {
    const onProfileChange = vi.fn();

    render(
      <TerminalPanel
        visible
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          readOnly: false,
          scrollback: 10000,
        }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-change-settings"));

    expect(await screen.findByTestId("terminal-current-settings-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Read-only terminal"));
    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }));

    fireEvent.change(screen.getByLabelText("Scrollback lines"), { target: { value: "2222" } });
    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      readOnly: true,
      scrollback: 2222,
    }));
  });

  it("opens Git from the terminal shortcut", async () => {
    const onOpen = vi.fn();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        gitToggle={{ cwd: "/repo", onOpen }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      expect(terminalMocks.state.customKeyEventHandler).toBeTruthy();
    });

    const handled = terminalMocks.state.customKeyEventHandler?.(
      new KeyboardEvent("keydown", { key: "g", ctrlKey: true, shiftKey: true }),
    );

    expect(handled).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
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

  describe("focus & editable target guard for shortcuts", () => {
    it("does not hijack macOS Cmd+V when focus is inside an editable input (e.g. SFTP address bar)", async () => {
      const originalPlatform = window.navigator.platform;
      const originalClipboard = window.navigator.clipboard;
      const readText = vi.fn(async () => "https://example.com/pasted");
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: "MacIntel",
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: { readText },
      });
      const onSessionReady = vi.fn();

      try {
        render(
          <div>
            <TerminalPanel visible onSessionReady={onSessionReady} />
            <input data-testid="sftp-address-input" defaultValue="/initial/path" />
          </div>,
        );

        await waitFor(() => {
          expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
        });

        const input = screen.getByTestId("sftp-address-input");
        input.focus();
        expect(document.activeElement).toBe(input);

        // Fire Cmd+V while focused on the input
        fireEvent.keyDown(input, { key: "v", metaKey: true });

        // Ensure writeTerminal was NOT called on the terminal session
        expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(window.navigator, "platform", {
          configurable: true,
          value: originalPlatform,
        });
        Object.defineProperty(window.navigator, "clipboard", {
          configurable: true,
          value: originalClipboard,
        });
      }
    });

    it("does not hijack Linux/Windows Ctrl+Shift+V or Shift+Insert when focus is inside an editable input", async () => {
      const onSessionReady = vi.fn();
      const readText = vi.fn(async () => "/pasted/linux/path");
      const originalClipboard = window.navigator.clipboard;
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: { readText },
      });

      try {
        render(
          <div>
            <TerminalPanel visible onSessionReady={onSessionReady} />
            <input data-testid="sftp-local-input" defaultValue="/initial/local" />
          </div>,
        );

        await waitFor(() => {
          expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
        });

        const input = screen.getByTestId("sftp-local-input");
        input.focus();
        expect(document.activeElement).toBe(input);

        // Fire Ctrl+Shift+V on Linux/Win
        fireEvent.keyDown(input, { key: "v", ctrlKey: true, shiftKey: true });
        expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

        // Fire Shift+Insert
        fireEvent.keyDown(input, { key: "Insert", shiftKey: true });
        expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(window.navigator, "clipboard", {
          configurable: true,
          value: originalClipboard,
        });
      }
    });

    it("does not hijack shortcuts when focus is inside an external panel button/list (e.g. SFTP sidebar)", async () => {
      const onSessionReady = vi.fn();
      render(
        <div>
          <TerminalPanel visible onSessionReady={onSessionReady} />
          <div data-testid="sftp-sidebar-mock">
            <button data-testid="sftp-refresh-btn">Refresh</button>
          </div>
        </div>,
      );

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const btn = screen.getByTestId("sftp-refresh-btn");
      btn.focus();
      expect(document.activeElement).toBe(btn);

      // Fire Shift+Insert or Ctrl+Shift+V while button is focused
      fireEvent.keyDown(btn, { key: "Insert", shiftKey: true });
      fireEvent.keyDown(btn, { key: "v", ctrlKey: true, shiftKey: true });
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
    });
  });
});

describe("TerminalPanel local directory confirmed-use reporting (V-03)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    terminalMocks.oscHandlers.clear();
    terminalMocks.state.onDataHandler = null;
    terminalMocks.state.onResizeHandler = null;
    terminalMocks.state.customKeyEventHandler = null;
    ipcMocks.terminalExitHandlers.clear();
    useAppStore.setState({ terminalRuntimeByTab: {}, cwdByTab: {} });
    ipcMocks.createTerminalSessionId.mockImplementation(() => "terminal-session");
    ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
      sessionId,
      shellId: "default",
    }));
    ipcMocks.recordLocalDirectoryUse.mockClear();
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

  it("records confirmed local cwd changes A->B->A through the structured IPC", async () => {
    render(<TerminalPanel tabId="local-cwd" visible />);

    await waitFor(() => {
      expect(ipcMocks.createLocalTerminal).toHaveBeenCalled();
    });
    expect(ipcMocks.recordLocalDirectoryUse).not.toHaveBeenCalled();

    // Initial cwd report for the spawn path, then a change, then back.
    terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
    await waitFor(() => {
      expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledWith({
        backendSessionId: "terminal-session",
        path: "/repo",
      });
    });

    terminalMocks.oscHandlers.get(7)?.("file://localhost/workspace");
    await waitFor(() => {
      expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(2);
    });
    expect((ipcMocks.recordLocalDirectoryUse.mock.calls[1] as unknown[] | undefined)?.[0]).toEqual({
      backendSessionId: "terminal-session",
      path: "/workspace",
    });

    terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
    await waitFor(() => {
      expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(3);
    });
    expect((ipcMocks.recordLocalDirectoryUse.mock.calls[2] as unknown[] | undefined)?.[0]).toEqual({
      backendSessionId: "terminal-session",
      path: "/repo",
    });
  });

  it("does not re-record repeated cwd reports for the same directory", async () => {
    render(<TerminalPanel tabId="local-dedup" visible />);

    await waitFor(() => {
      expect(ipcMocks.createLocalTerminal).toHaveBeenCalled();
    });
    terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
    await waitFor(() => {
      expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(1);
    });
    // Duplicate prompts/probes for the same path never rewrite the record.
    terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
    terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
    expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(1);
  });

  it("never records SSH remote cwd through the local directory channel", async () => {
    render(<TerminalPanel tabId="ssh-cwd" visible ssh={sshInfo} />);

    await waitFor(() => {
      expect(ipcMocks.createSshTerminal).toHaveBeenCalled();
    });
    terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");
    expect(ipcMocks.recordLocalDirectoryUse).not.toHaveBeenCalled();
  });

  it("surfaces a directory-use save warning without failing the launch", async () => {
    ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
      sessionId,
      shellId: "default",
      directoryUseWarning: "Terminal opened; saving the recent-directories record failed",
    }));
    render(<TerminalPanel tabId="local-warn" visible />);

    await waitFor(() => {
      expect(ipcMocks.createLocalTerminal).toHaveBeenCalled();
    });
    // Launch success stands; the warning is only logged.
    expect(
      useAppStore.getState().terminalRuntimeByTab["local-warn"]?.backendSessionId,
    ).toBe("terminal-session");
  });

  it("reports launch failure through onSessionLaunchFailed", async () => {
    const onSessionLaunchFailed = vi.fn();
    ipcMocks.createLocalTerminal.mockImplementation(async () => {
      throw new Error("pty spawn failed");
    });
    render(
      <TerminalPanel tabId="local-fail" visible onSessionLaunchFailed={onSessionLaunchFailed} />,
    );

    await waitFor(() => {
      expect(onSessionLaunchFailed).toHaveBeenCalled();
    });
    expect(String(onSessionLaunchFailed.mock.calls[0]?.[0])).toContain("pty spawn failed");
  });
});
