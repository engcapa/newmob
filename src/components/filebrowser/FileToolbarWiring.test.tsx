import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePanel } from "./FilePanel";
import { FileBrowser } from "./FileBrowser";
import { useSftpStore, type PaneState } from "../../stores/sftpStore";
import type { FileEntry } from "../../lib/sftp";

const controllerMocks = vi.hoisted(() => ({
  upload: vi.fn(async () => undefined),
  uploadBlob: vi.fn(async () => undefined),
  download: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  chmodRecursive: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  createFile: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  pause: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  retry: vi.fn(async () => undefined),
}));

vi.mock("../../lib/sftpController", () => ({
  useSftpController: () => controllerMocks,
}));

vi.mock("../../lib/sftp", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sftp")>("../../lib/sftp");
  return {
    ...actual,
    sftpListRemote: vi.fn(async () => []),
    sftpListLocal: vi.fn(async () => []),
    sftpLocalHome: vi.fn(async () => "/home/test"),
    sftpAttach: vi.fn(async () => undefined),
    sftpDetach: vi.fn(async () => undefined),
    sftpRealpath: vi.fn(async (_sid: string, p: string) => p),
  };
});

const SESSION_ID = "test-session";

function file(name: string, opts: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: opts.path ?? `/work/${name}`,
    size: 100,
    mtime: 1_700_000_000,
    mode: 0o644,
    fileType: "file",
    isHidden: name.startsWith("."),
    ...opts,
  };
}

function dir(name: string, opts: Partial<FileEntry> = {}): FileEntry {
  return file(name, { ...opts, fileType: "dir", size: 0 });
}

function makePane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    path: "/work",
    entries: [
      dir("subdir"),
      file("notes.txt"),
      file("image.png"),
      file(".hidden"),
    ],
    selection: [],
    loading: false,
    error: null,
    history: ["/work"],
    historyIndex: 0,
    showHidden: false,
    ...overrides,
  };
}

function seedSession(extra: Partial<PaneState> = {}) {
  useSftpStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [SESSION_ID]: {
        sessionId: SESSION_ID,
        attached: true,
        attaching: false,
        homeDir: "/home/test",
        error: null,
        local: makePane(extra),
        remote: makePane(extra),
      },
    },
  }));
}

function setSelection(side: "local" | "remote", paths: string[]) {
  act(() => {
    useSftpStore.getState().setSelection(SESSION_ID, side, paths);
  });
}

const noopHandlers = {
  onItemDoubleClick: vi.fn(),
  onEmptyContext: vi.fn(() => []),
};

beforeEach(() => {
  useSftpStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  useSftpStore.setState({ sessions: {} });
  vi.clearAllMocks();
});

function renderRemote(extra: Record<string, unknown> = {}) {
  return render(
    <FilePanel
      sessionId={SESSION_ID}
      side="remote"
      subtitle="user@example.com"
      onDownloadSelected={vi.fn()}
      onUploadFromDisk={vi.fn()}
      onDeleteSelected={vi.fn()}
      onChmodSelected={vi.fn()}
      onPreviewSelected={vi.fn()}
      onOpenTerminalHere={vi.fn()}
      {...noopHandlers}
      {...extra}
    />,
  );
}

function renderLocal(extra: Record<string, unknown> = {}) {
  return render(
    <FilePanel
      sessionId={SESSION_ID}
      side="local"
      onUploadSelected={vi.fn()}
      onDeleteSelected={vi.fn()}
      onChmodSelected={vi.fn()}
      onPreviewSelected={vi.fn()}
      {...noopHandlers}
      {...extra}
    />,
  );
}

describe("FileToolbar wiring through FilePanel", () => {
  it("renders the REMOTE badge and remote-only buttons on the remote pane", () => {
    seedSession();
    renderRemote();

    expect(screen.getByText("REMOTE")).toBeInTheDocument();
    expect(screen.queryByText("LOCAL")).not.toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();

    expect(screen.getByTitle(/Download selected to local/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Upload files from this computer/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Open terminal at this path/i)).toBeInTheDocument();

    expect(screen.queryByTitle(/Upload .* selected to remote/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Upload selected to remote$/i)).not.toBeInTheDocument();
  });

  it("renders the LOCAL badge and local-only Upload button on the local pane", () => {
    seedSession();
    renderLocal();

    expect(screen.getByText("LOCAL")).toBeInTheDocument();
    expect(screen.queryByText("REMOTE")).not.toBeInTheDocument();

    expect(screen.getByTitle(/Upload selected to remote/i)).toBeInTheDocument();

    expect(screen.queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Upload files from this computer/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();
  });

  it("disables/hides selection-dependent buttons when nothing is selected", () => {
    seedSession();
    renderRemote();

    // Buttons whose enabled state depends only on selection count: rendered
    // but disabled.
    expect(screen.getByTitle(/Download selected to local/i)).toBeDisabled();
    expect(screen.getByTitle(/^Delete selected$/i)).toBeDisabled();
    // Chmod / Preview are wired through `firstSelected` in FilePanel, so the
    // handlers are undefined when nothing is selected and the buttons are not
    // rendered at all.
    expect(screen.queryByTitle(/Permissions \(chmod\)/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/View \/ preview text file/i)).not.toBeInTheDocument();

    expect(screen.getByTitle("Refresh")).toBeEnabled();
    expect(screen.getByTitle("New folder")).toBeEnabled();
  });

  it("enables download/delete/chmod/preview when one previewable file is selected (remote)", () => {
    seedSession();
    renderRemote();

    setSelection("remote", ["/work/notes.txt"]);

    expect(screen.getByTitle(/Download 1 selected to local/i)).toBeEnabled();
    expect(screen.getByTitle(/Delete 1 selected/i)).toBeEnabled();
    expect(screen.getByTitle(/Permissions \(chmod\)/i)).toBeEnabled();
    expect(screen.getByTitle(/View \/ preview text file/i)).toBeEnabled();
  });

  it("enables chmod for multi-select and disables preview when no previewable file selected", () => {
    seedSession();
    renderRemote();

    setSelection("remote", ["/work/notes.txt", "/work/image.png"]);

    expect(screen.getByTitle(/Download 2 selected to local/i)).toBeEnabled();
    expect(screen.getByTitle(/Delete 2 selected/i)).toBeEnabled();
    // chmod now supports multi-select and applies the same mode to all.
    expect(screen.getByTitle(/Permissions \(chmod\) for 2 selected/i)).toBeEnabled();
    // image.png is not a previewable text type.
    expect(screen.getByTitle(/View \/ preview text file/i)).toBeDisabled();
  });

  it("enables Upload-to-remote on the local pane when files are selected", () => {
    seedSession();
    renderLocal();

    const upload = screen.getByTitle(/Upload selected to remote/i);
    expect(upload).toBeDisabled();

    setSelection("local", ["/work/notes.txt"]);

    expect(screen.getByTitle(/Upload 1 selected to remote/i)).toBeEnabled();
  });

  it("toggles Show hidden files and reveals dotfiles", async () => {
    const user = userEvent.setup();
    seedSession();
    renderRemote();

    // Hidden file initially filtered out.
    expect(screen.queryByText(".hidden")).not.toBeInTheDocument();

    const toggle = screen.getByTitle(/Show hidden files/i);
    await user.click(toggle);

    // Now visible, and the toggle's title flips to the inverse action.
    expect(screen.getByText(".hidden")).toBeInTheDocument();
    expect(screen.getByTitle(/Hide hidden files/i)).toBeInTheDocument();
    expect(useSftpStore.getState().sessions[SESSION_ID].remote.showHidden).toBe(true);
  });

  it("renders the LOCAL/REMOTE badges with side-specific styling", () => {
    seedSession();
    const { unmount } = renderRemote();
    const remoteBadge = screen.getByText("REMOTE");
    expect(remoteBadge).toHaveStyle({ background: "var(--moba-accent)" });
    unmount();

    renderLocal();
    const localBadge = screen.getByText("LOCAL");
    expect(localBadge).toHaveStyle({ background: "var(--moba-text-muted)" });
  });

  it("hides side-only buttons when their callbacks are not provided", () => {
    seedSession();
    // Remote pane without download/upload-from-disk/terminal handlers.
    render(
      <FilePanel
        sessionId={SESSION_ID}
        side="remote"
        onDeleteSelected={vi.fn()}
        {...noopHandlers}
      />,
    );

    expect(screen.queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Upload files from this computer/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();
    // Delete handler IS provided, so the delete button is rendered (disabled).
    expect(screen.getByTitle(/^Delete selected$/i)).toBeInTheDocument();
  });

  it("invokes the side-specific handlers when toolbar buttons are clicked", async () => {
    const user = userEvent.setup();
    seedSession();

    const onDownload = vi.fn();
    const onTerminal = vi.fn();
    render(
      <FilePanel
        sessionId={SESSION_ID}
        side="remote"
        onDownloadSelected={onDownload}
        onOpenTerminalHere={onTerminal}
        {...noopHandlers}
      />,
    );

    setSelection("remote", ["/work/notes.txt"]);

    await user.click(screen.getByTitle(/Download 1 selected to local/i));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload.mock.calls[0][0]).toHaveLength(1);
    expect(onDownload.mock.calls[0][0][0]).toMatchObject({ path: "/work/notes.txt" });

    await user.click(screen.getByTitle(/Open terminal at this path/i));
    expect(onTerminal).toHaveBeenCalledWith("/work");
  });

  it("updates selection from a row click and enables Delete (no store mutation)", async () => {
    const user = userEvent.setup();
    seedSession();
    const onDelete = vi.fn();
    render(
      <FilePanel
        sessionId={SESSION_ID}
        side="remote"
        onDeleteSelected={onDelete}
        {...noopHandlers}
      />,
    );

    expect(screen.getByTitle(/^Delete selected$/i)).toBeDisabled();

    // Click the row for notes.txt (rendered by FilePanel) to drive selection
    // through the real onClick handler instead of mutating the store.
    await user.click(screen.getByText("notes.txt"));

    expect(screen.getByTitle(/Delete 1 selected/i)).toBeEnabled();
    expect(useSftpStore.getState().sessions[SESSION_ID].remote.selection).toEqual([
      "/work/notes.txt",
    ]);

    await user.click(screen.getByTitle(/Delete 1 selected/i));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0][0]).toMatchObject({ path: "/work/notes.txt" });
  });

  it("scopes the toolbar to the LOCAL pane: no Download / no Open-terminal", () => {
    seedSession();
    // Even when (mistakenly) given the remote-only handlers, the local pane
    // must NOT render the remote-only buttons.
    render(
      <FilePanel
        sessionId={SESSION_ID}
        side="local"
        onDownloadSelected={vi.fn()}
        onOpenTerminalHere={vi.fn()}
        onUploadFromDisk={vi.fn()}
        onUploadSelected={vi.fn()}
        {...noopHandlers}
      />,
    );

    const toolbar = screen.getByText("LOCAL").closest("div")!.parentElement!;
    const utils = within(toolbar);
    expect(utils.queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
    expect(utils.queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();
    expect(utils.queryByTitle(/Upload files from this computer/i)).not.toBeInTheDocument();
    // Upload-to-remote IS the local-pane analog and must be present.
    expect(utils.getByTitle(/Upload selected to remote/i)).toBeInTheDocument();
  });
});

describe("FileBrowser → FilePanel toolbar wiring", () => {
  function renderBrowser() {
    return render(
      <FileBrowser
        sessionId={SESSION_ID}
        host="example.com"
        port={22}
        username="user"
        authMethod="password"
        authData={null}
      />,
    );
  }

  it("wires the remote-pane Download toolbar button to controller.download", async () => {
    const user = userEvent.setup();
    seedSession();
    renderBrowser();

    // Both panes render the same fixture; pick the REMOTE pane's row.
    // FilePanel renders one row per entry per pane, so notes.txt appears
    // twice. Scope to the remote pane via its REMOTE badge container.
    const remoteBadge = screen.getByText("REMOTE");
    const remotePanel = remoteBadge.closest("div.h-full") as HTMLElement;
    expect(remotePanel).toBeTruthy();

    const remoteRow = within(remotePanel).getByText("notes.txt");
    await user.click(remoteRow);

    const downloadBtn = within(remotePanel).getByTitle(/Download 1 selected to local/i);
    expect(downloadBtn).toBeEnabled();
    await user.click(downloadBtn);

    expect(controllerMocks.download).toHaveBeenCalledTimes(1);
    const downloadArgs = controllerMocks.download.mock.calls[0] as unknown as unknown[];
    expect(downloadArgs[0]).toMatchObject({
      path: "/work/notes.txt",
    });
  });

  it("wires the remote-pane context Download action to the full multi-selection", async () => {
    const user = userEvent.setup();
    seedSession();
    renderBrowser();

    const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
    setSelection("remote", ["/work/subdir", "/work/notes.txt"]);

    fireEvent.contextMenu(within(remotePanel).getByText("notes.txt"), {
      clientX: 20,
      clientY: 20,
    });
    await user.click(await screen.findByTestId("context-menu-item-download-2-selected-to-local"));

    expect(controllerMocks.download).toHaveBeenCalledTimes(2);
    const downloadCalls = controllerMocks.download.mock.calls as unknown as Array<[FileEntry]>;
    expect(downloadCalls.map(([entry]) => entry.path)).toEqual([
      "/work/subdir",
      "/work/notes.txt",
    ]);
  });

  it("wires the remote-pane Open-terminal-here toolbar button to the FileBrowser onOpenTerminalHere prop", async () => {
    const user = userEvent.setup();
    seedSession();
    const onOpenTerminalHere = vi.fn();
    render(
      <FileBrowser
        sessionId={SESSION_ID}
        host="example.com"
        port={22}
        username="user"
        authMethod="password"
        authData={null}
        onOpenTerminalHere={onOpenTerminalHere}
      />,
    );

    const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
    const terminalBtn = within(remotePanel).getByTitle(/Open terminal at this path/i);
    await user.click(terminalBtn);

    expect(onOpenTerminalHere).toHaveBeenCalledWith("/work");
  });

  it("does not auto-sync the remote pane from a terminal cwd hint on open", () => {
    seedSession();
    render(
      <FileBrowser
        sessionId={SESSION_ID}
        host="example.com"
        port={22}
        username="user"
        authMethod="password"
        authData={null}
        cwdHint="/terminal"
        cwdHintVersion={1}
      />,
    );

    expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/work");
  });

  it("requests terminal cwd and syncs only after a fresh cwd response", async () => {
    const user = userEvent.setup();
    seedSession();
    const onRequestTerminalCwd = vi.fn(() => true);
    const { rerender } = render(
      <FileBrowser
        sessionId={SESSION_ID}
        host="example.com"
        port={22}
        username="user"
        authMethod="password"
        authData={null}
        cwdHint={null}
        cwdHintVersion={0}
        onRequestTerminalCwd={onRequestTerminalCwd}
      />,
    );

    await user.click(screen.getByTitle(/Query the terminal cwd/i));
    expect(onRequestTerminalCwd).toHaveBeenCalledTimes(1);
    expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/work");

    rerender(
      <FileBrowser
        sessionId={SESSION_ID}
        host="example.com"
        port={22}
        username="user"
        authMethod="password"
        authData={null}
        cwdHint="/terminal"
        cwdHintVersion={1}
        onRequestTerminalCwd={onRequestTerminalCwd}
      />,
    );

    await waitFor(() => {
      expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/terminal");
    });
  });

  it("wires the local-pane Upload toolbar button to controller.upload", async () => {
    const user = userEvent.setup();
    seedSession();
    renderBrowser();

    const localBadge = screen.getByText("LOCAL");
    const localPanel = localBadge.closest("div.h-full") as HTMLElement;
    expect(localPanel).toBeTruthy();

    // Sanity: local pane never gets the remote-only buttons even when wired
    // through the real FileBrowser.
    expect(within(localPanel).queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
    expect(within(localPanel).queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();

    await user.click(within(localPanel).getByText("notes.txt"));

    const uploadBtn = within(localPanel).getByTitle(/Upload 1 selected to remote/i);
    expect(uploadBtn).toBeEnabled();
    await user.click(uploadBtn);

    expect(controllerMocks.upload).toHaveBeenCalledTimes(1);
    const uploadArgs = controllerMocks.upload.mock.calls[0] as unknown as unknown[];
    expect(uploadArgs[0]).toMatchObject({
      path: "/work/notes.txt",
    });
  });

  it("wires the local-pane context Upload action to the full multi-selection", async () => {
    const user = userEvent.setup();
    seedSession();
    renderBrowser();

    const localPanel = screen.getByText("LOCAL").closest("div.h-full") as HTMLElement;
    setSelection("local", ["/work/subdir", "/work/notes.txt"]);

    fireEvent.contextMenu(within(localPanel).getByText("subdir"), {
      clientX: 20,
      clientY: 20,
    });
    await user.click(await screen.findByTestId("context-menu-item-upload-2-selected-to-remote"));

    expect(controllerMocks.upload).toHaveBeenCalledTimes(2);
    const uploadCalls = controllerMocks.upload.mock.calls as unknown as Array<[FileEntry]>;
    expect(uploadCalls.map(([entry]) => entry.path)).toEqual([
      "/work/subdir",
      "/work/notes.txt",
    ]);
  });
});
