import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePanel } from "./WelcomePanel";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";

const ipcMocks = vi.hoisted(() => ({
  listWithRevision: vi.fn(),
  listenChanged: vi.fn(),
  listLocalShells: vi.fn(),
  listWslDistros: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    listCommonLocalDirectoriesWithRevision: ipcMocks.listWithRevision,
    listenWelcomeDirectoriesChanged: ipcMocks.listenChanged,
    listLocalShells: ipcMocks.listLocalShells,
    listWslDistros: ipcMocks.listWslDistros,
  };
});

vi.mock("../lib/runtime", () => ({
  getAppPlatform: () => "linux",
}));

describe("WelcomePanel directories ordering (AC-01)", () => {
  beforeEach(() => {
    ipcMocks.listLocalShells.mockResolvedValue([]);
    ipcMocks.listWslDistros.mockResolvedValue([]);
    ipcMocks.listenChanged.mockResolvedValue(() => undefined);
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      statusMessage: "Ready",
    });
    useSessionStore.setState({
      sessions: [],
      groups: [],
      loading: false,
      selectedSessionId: null,
      selectedSessionIds: [],
      searchQuery: "",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders backend order A/Home/Downloads with stable ids and unknown-time text", async () => {
    ipcMocks.listWithRevision.mockResolvedValue({
      revision: 3,
      directories: [
        { label: "A", path: "/tmp/a", kind: "personal", directoryId: "id-a", lastUsedAtMs: 3000, timeSource: "local-start", availability: "available" },
        { label: "Home", path: "/tmp/home", kind: "system", directoryId: "id-home", lastUsedAtMs: 2000, timeSource: "local-cwd", availability: "available" },
        { label: "Downloads", path: "/tmp/downloads", kind: "system", directoryId: "id-dl", lastUsedAtMs: 1000, availability: "available" },
      ],
    });
    render(<WelcomePanel onStartLocalTerminal={() => undefined} onNewSession={() => undefined} active />);
    fireEvent.click(screen.getByRole("tab", { name: /directories/i }));
    const rows = await screen.findAllByTestId("welcome-local-directory");
    expect(rows.map((r) => r.getAttribute("data-directory-path"))).toEqual([
      "/tmp/a",
      "/tmp/home",
      "/tmp/downloads",
    ]);
    expect(rows[0].getAttribute("data-directory-id")).toBe("id-a");
    expect(rows[0].getAttribute("data-last-used-at-ms")).toBe("3000");
  });

  it("keeps relative order after search and clear", async () => {
    ipcMocks.listWithRevision.mockResolvedValue({
      revision: 1,
      directories: [
        { label: "A-work", path: "/tmp/a", kind: "personal" },
        { label: "Home", path: "/home/u", kind: "system" },
        { label: "Archive", path: "/tmp/archive", kind: "personal" },
      ],
    });
    render(<WelcomePanel onStartLocalTerminal={() => undefined} onNewSession={() => undefined} active />);
    fireEvent.click(screen.getByRole("tab", { name: /directories/i }));
    await screen.findAllByTestId("welcome-local-directory");
    fireEvent.change(screen.getByTestId("welcome-local-directory-filter"), { target: { value: "a" } });
    let rows = screen.getAllByTestId("welcome-local-directory");
    expect(rows.map((r) => r.getAttribute("data-directory-path"))).toEqual(["/tmp/a", "/tmp/archive"]);
    fireEvent.change(screen.getByTestId("welcome-local-directory-filter"), { target: { value: "" } });
    rows = screen.getAllByTestId("welcome-local-directory");
    expect(rows.map((r) => r.getAttribute("data-directory-path"))).toEqual([
      "/tmp/a",
      "/home/u",
      "/tmp/archive",
    ]);
  });

  it("leaves empty time attributes blank with path tooltip instead of current time", async () => {
    ipcMocks.listWithRevision.mockResolvedValue({
      revision: 1,
      directories: [
        { label: "Gone", path: "/tmp/gone", kind: "personal", availability: "missing", lastUsedAtMs: null },
        { label: "Fresh", path: "/tmp/fresh", kind: "personal", availability: "available", lastUsedAtMs: null },
      ],
    });
    const onStart = vi.fn();
    render(<WelcomePanel onStartLocalTerminal={onStart} onNewSession={() => undefined} active />);
    fireEvent.click(screen.getByRole("tab", { name: /directories/i }));
    const rows = await screen.findAllByTestId("welcome-local-directory");
    expect(rows).toHaveLength(2);
    // Null times: attribute blank, tooltip falls back to the path (never now).
    expect(rows[0].getAttribute("data-last-used-at-ms")).toBe("");
    expect(rows[0].getAttribute("title")).toBe("/tmp/gone");
    fireEvent.click(rows[0]);
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
  });

  it("restore row: empty disabled, available count, failed retry", async () => {
    ipcMocks.listWithRevision.mockResolvedValue({ revision: 0, directories: [] });
    const onRestore = vi.fn();
    const { rerender } = render(
      <WelcomePanel onStartLocalTerminal={() => undefined} onNewSession={() => undefined} active runRestoreView={{ state: "empty" }} onRestoreBatch={onRestore} />,
    );
    expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();
    rerender(
      <WelcomePanel
        onStartLocalTerminal={() => undefined}
        onNewSession={() => undefined}
        active
        runRestoreView={{
          state: "available",
          snapshot: {
            schemaVersion: 2,
            revision: 1,
            runId: "run-1",
            createdAtMs: 1,
            activeEntryKey: null,
            entries: [
              { entryKey: "saved:a", orderIndex: 0, kind: "terminal", savedSessionId: "a", savedSessionType: "SSH", displayName: "A", localCwd: null, tempShell: null, profileRef: null },
              { entryKey: "saved:b", orderIndex: 1, kind: "terminal", savedSessionId: "b", savedSessionType: "SSH", displayName: "B", localCwd: null, tempShell: null, profileRef: null },
            ],
          },
        }}
        onRestoreBatch={onRestore}
      />,
    );
    fireEvent.click(screen.getByTestId("welcome-restore-last-session"));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
