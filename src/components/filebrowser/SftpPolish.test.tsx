import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { FilePanel } from "./FilePanel";
import { FileBrowser } from "./FileBrowser";
import { PathBreadcrumb } from "./PathBreadcrumb";
import { useSftpStore, type PaneState } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import type { FileEntry } from "../../lib/sftp";

const sftpHomeMock = vi.hoisted(() => vi.fn(async () => ""));
const sftpDownloadMock = vi.hoisted(() => vi.fn(async () => undefined));
const sftpDownloadDirMock = vi.hoisted(() => vi.fn(async () => undefined));
const setStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/sftp", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sftp")>(
    "../../lib/sftp",
  );
  return {
    ...actual,
    sftpListRemote: vi.fn(async () => []),
    sftpListLocal: vi.fn(async () => []),
    sftpLocalHome: sftpHomeMock,
    sftpLocalDrives: vi.fn(async () => []),
    sftpAttach: vi.fn(async () => undefined),
    sftpDetach: vi.fn(async () => undefined),
    sftpRealpath: vi.fn(async (_sid: string, p: string) => p),
    sftpDownload: sftpDownloadMock,
    sftpDownloadDir: sftpDownloadDirMock,
    // Stub event subscriptions — they hit Tauri internals which aren't
    // available in the JSDOM test environment.
    listenSftpProgress: vi.fn(async () => () => undefined),
    listenSftpComplete: vi.fn(async () => () => undefined),
    listenSftpPaused: vi.fn(async () => () => undefined),
    listenSftpAttached: vi.fn(async () => () => undefined),
  };
});

vi.mock("../../stores/transferStore", async () => {
  const actual = await vi.importActual<typeof import("../../stores/transferStore")>(
    "../../stores/transferStore",
  );
  return {
    ...actual,
    newTransferId: () => "test-transfer-id",
  };
});

vi.mock("../../stores/appStore", async () => {
  const actual = await vi.importActual<typeof import("../../stores/appStore")>(
    "../../stores/appStore",
  );
  return {
    ...actual,
    useAppStore: Object.assign(
      (selector: (s: { setStatusMessage: typeof setStatusMock }) => unknown) =>
        selector({ setStatusMessage: setStatusMock }),
      actual.useAppStore,
    ),
  };
});

const SESSION_ID = "polish-session";

function makePane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    path: "/work",
    entries: [],
    selection: [],
    loading: false,
    error: null,
    history: ["/work"],
    historyIndex: 0,
    showHidden: false,
    ...overrides,
  };
}

function seed() {
  useSftpStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [SESSION_ID]: {
        sessionId: SESSION_ID,
        attached: true,
        attaching: false,
        homeDir: "/home/test",
        error: null,
        local: makePane(),
        remote: makePane(),
      },
    },
  }));
}

beforeEach(() => {
  localStorage.clear();
  useSftpStore.setState({ sessions: {} });
  setStatusMock.mockReset();
  sftpHomeMock.mockReset();
  sftpDownloadMock.mockReset();
  sftpDownloadDirMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SFTP file-list column width persistence", () => {
  it("persists per-side widths to localStorage and reloads them", async () => {
    seed();

    // Render the LOCAL pane and shrink the Size column via the resize
    // handle on the Name header (it controls the *next* column).
    const { unmount } = render(
      <FilePanel
        sessionId={SESSION_ID}
        side="local"
        onItemDoubleClick={vi.fn()}
        onEmptyContext={vi.fn(() => [])}
      />,
    );

    const sizeHandle = document.querySelector(
      '[data-testid="col-resize-size"]',
    ) as HTMLElement;
    expect(sizeHandle).toBeTruthy();

    fireEvent.mouseDown(sizeHandle, { clientX: 200 });
    fireEvent(window, new MouseEvent("mousemove", { clientX: 250 }));
    fireEvent(window, new MouseEvent("mouseup"));

    const stored = JSON.parse(
      localStorage.getItem("newmob.sftp.cols.local") ?? "{}",
    );
    expect(stored.size).toBeGreaterThan(80);

    // The remote pane key must remain untouched (per-side independence).
    expect(localStorage.getItem("newmob.sftp.cols.remote")).toBeNull();

    unmount();

    // Re-mount and confirm the previously-stored width is restored.
    render(
      <FilePanel
        sessionId={SESSION_ID}
        side="local"
        onItemDoubleClick={vi.fn()}
        onEmptyContext={vi.fn(() => [])}
      />,
    );
    const reloaded = JSON.parse(
      localStorage.getItem("newmob.sftp.cols.local") ?? "{}",
    );
    expect(reloaded.size).toBe(stored.size);
  });

  it("double-clicking a resize handle restores that column to its default width", () => {
    seed();
    // Pre-seed all four columns with a non-default width.
    localStorage.setItem(
      "newmob.sftp.cols.remote",
      JSON.stringify({ name: 400, size: 240, mtime: 240, type: 240 }),
    );

    render(
      <FilePanel
        sessionId={SESSION_ID}
        side="remote"
        subtitle="u@h"
        onItemDoubleClick={vi.fn()}
        onEmptyContext={vi.fn(() => [])}
      />,
    );

    const sizeHandle = document.querySelector(
      '[data-testid="col-resize-size"]',
    ) as HTMLElement;
    fireEvent.doubleClick(sizeHandle);

    const stored = JSON.parse(
      localStorage.getItem("newmob.sftp.cols.remote") ?? "{}",
    );
    // Each handle resets ITS OWN column. Size default is 80.
    expect(stored.size).toBe(80);
    // Other columns are untouched.
    expect(stored.name).toBe(400);
    expect(stored.mtime).toBe(240);
    expect(stored.type).toBe(240);
  });
});

describe("Local Windows drives navigation", () => {
  it("navigates from a drive root to the virtual drives root via navigateUp", async () => {
    seed();
    // Put the local pane at C:\ so navigateUp should land on the
    // virtual drives root.
    useSftpStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [SESSION_ID]: {
          ...state.sessions[SESSION_ID],
          local: makePane({ path: "C:\\", history: ["C:\\"], historyIndex: 0 }),
        },
      },
    }));

    await act(async () => {
      await useSftpStore.getState().navigateUp(SESSION_ID, "local");
    });

    expect(useSftpStore.getState().sessions[SESSION_ID].local.path).toBe("\\\\");
  });
});

describe("sftpController.download empty-local-dir fallback", () => {
  function entry(): FileEntry {
    return {
      name: "remote.txt",
      path: "/srv/remote.txt",
      size: 10,
      mtime: 0,
      mode: 0o644,
      fileType: "file",
      isHidden: false,
    };
  }

  it("falls back to the local home when no destination directory is provided", async () => {
    sftpHomeMock.mockResolvedValue("/home/me");
    const { result } = renderHook(() => useSftpController(SESSION_ID));

    await act(async () => {
      await result.current.download(entry(), "");
    });

    expect(sftpHomeMock).toHaveBeenCalledTimes(1);
    expect(sftpDownloadMock).toHaveBeenCalledTimes(1);
    const args = sftpDownloadMock.mock.calls[0] as unknown as unknown[];
    expect(args[3]).toBe("/home/me/remote.txt");
    expect(setStatusMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Download failed"),
    );
  });

  it("surfaces a clear status error if neither localDir nor home resolves", async () => {
    sftpHomeMock.mockRejectedValue(new Error("no home"));
    const { result } = renderHook(() => useSftpController(SESSION_ID));

    await act(async () => {
      await result.current.download(entry(), "");
    });

    expect(sftpDownloadMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(
      expect.stringContaining("Download failed"),
    );
  });
});

describe("PathBreadcrumb Windows drives root", () => {
  it("renders the virtual drives root as a single 'Drives' segment", () => {
    const onNavigate = vi.fn();
    const { getByText, queryByTestId } = render(
      <PathBreadcrumb path={"\\\\"} onNavigate={onNavigate} />,
    );
    // The single segment label is "Drives".
    expect(getByText("Drives")).toBeTruthy();
    // The leading "Show all drives" affordance is hidden when we are
    // already at the drives root.
    expect(queryByTestId("breadcrumb-drives-root")).toBeNull();
  });

  it("exposes a 'Show all drives' affordance on Windows paths and navigates to \\\\", () => {
    const onNavigate = vi.fn();
    const { getByTestId } = render(
      <PathBreadcrumb path="C:\\Users\\me" onNavigate={onNavigate} />,
    );
    const drivesBtn = getByTestId("breadcrumb-drives-root");
    fireEvent.click(drivesBtn);
    expect(onNavigate).toHaveBeenCalledWith("\\\\");
  });
});

describe("FileBrowser pane order", () => {
  it("renders the REMOTE pane before the LOCAL pane in the DOM", () => {
    seed();
    const { container } = render(
      <FileBrowser
        sessionId={SESSION_ID}
        host="example.com"
        port={22}
        username="alice"
        authMethod="password"
        authData={null}
      />,
    );
    // Each FilePanel root has data-side="remote"|"local" via its
    // toolbar/data attributes; fall back to subtitle text order.
    const html = container.innerHTML;
    const remoteIdx = html.indexOf("alice@example.com");
    // The local pane omits the user@host subtitle, so look for any
    // "local"-side marker. The DrivesPicker test-id is local-only.
    // If neither is present (different env), at minimum the remote
    // subtitle must appear before the closing of the first Panel.
    expect(remoteIdx).toBeGreaterThan(-1);
    // The remote subtitle must come before the second `data-panel`
    // (i.e. the local pane comes after).
    const panels = Array.from(
      container.querySelectorAll("[data-panel]"),
    ) as HTMLElement[];
    expect(panels.length).toBeGreaterThanOrEqual(2);
    // The first panel's HTML must contain the remote subtitle.
    expect(panels[0].innerHTML).toContain("alice@example.com");
    // The second panel's HTML must NOT contain the remote subtitle.
    expect(panels[1].innerHTML).not.toContain("alice@example.com");
  });
});
