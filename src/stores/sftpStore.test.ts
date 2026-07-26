import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSftpStore, type PaneState, type SftpSessionState } from "./sftpStore";
import { sftpListRemote, sftpAttach, sftpDetach, type FileEntry } from "../lib/sftp";

vi.mock("../lib/sftp", () => ({
  sftpListRemote: vi.fn(async () => []),
  sftpListLocal: vi.fn(async () => []),
  sftpLocalHome: vi.fn(async () => "/"),
  sftpLocalDrives: vi.fn(async () => []),
  sftpAttach: vi.fn(async () => ({ homeDir: "/" })),
  sftpDetach: vi.fn(async () => {}),
  sftpRealpath: vi.fn(async (_sid: string, p: string) => p),
}));

const charsetSwitchEntry: FileEntry = {
  name: "!now_UTF-8,next_gb18030",
  path: "/!now_UTF-8,next_gb18030",
  fileType: "dir",
  size: 0,
  mtime: 0,
  mode: 0,
  isHidden: false,
};

const hostEntry: FileEntry = {
  name: "ssh_ecs-user@worker",
  path: "/ssh_ecs-user@worker",
  fileType: "dir",
  size: 0,
  mtime: 0,
  mode: 0,
  isHidden: false,
};

function pane(path: string, entries: FileEntry[]): PaneState {
  return {
    path,
    entries,
    selection: [],
    loading: false,
    error: null,
    history: path ? [path] : [],
    historyIndex: path ? 0 : -1,
    showHidden: false,
  };
}

function session(): SftpSessionState {
  return {
    sessionId: "sid",
    attached: true,
    attaching: false,
    homeDir: "/",
    error: null,
    remote: pane("/", [charsetSwitchEntry]),
    local: pane("", []),
  };
}

describe("sftpStore", () => {
  beforeEach(() => {
    vi.mocked(sftpListRemote).mockReset();
    useSftpStore.setState({ sessions: { sid: session() } });
  });

  it("refreshes the current remote directory after a bastion charset switch signal", async () => {
    vi.mocked(sftpListRemote).mockImplementation(async (_sessionId, path) => {
      if (path === charsetSwitchEntry.path) {
        throw new Error(
          "Failed to read /!now_UTF-8,next_gb18030: Failure: character is changed please refresh directory",
        );
      }
      if (path === "/") return [hostEntry];
      return [];
    });

    await useSftpStore.getState().navigate("sid", "remote", charsetSwitchEntry.path);

    const remote = useSftpStore.getState().sessions.sid.remote;
    expect(remote.path).toBe("/");
    expect(remote.error).toBeNull();
    expect(remote.loading).toBe(false);
    expect(remote.entries).toEqual([hostEntry]);
    expect(vi.mocked(sftpListRemote).mock.calls).toEqual([
      ["sid", charsetSwitchEntry.path],
      ["sid", "/"],
    ]);
  });

  it("caches connectionOpts on attach and uses them on reconnect", async () => {
    vi.mocked(sftpAttach).mockResolvedValue({ homeDir: "/home/test" });
    vi.mocked(sftpListRemote).mockResolvedValue([]);

    const opts = {
      sessionId: "new-sid",
      host: "example.com",
      port: 22,
      username: "user",
      authMethod: "Password",
      authData: "pass",
    };

    await useSftpStore.getState().attach(opts);

    const s = useSftpStore.getState().sessions["new-sid"];
    expect(s.connectionOpts).toEqual(opts);
    expect(s.attached).toBe(true);

    // Reset mocks to verify reconnect behavior
    vi.mocked(sftpDetach).mockResolvedValue(undefined);
    vi.mocked(sftpAttach).mockClear();

    await useSftpStore.getState().reconnect("new-sid");
    expect(vi.mocked(sftpDetach)).toHaveBeenCalledWith("new-sid");
    expect(vi.mocked(sftpAttach)).toHaveBeenCalledWith(opts);
  });

  it("escalates connection errors on remote navigation to session level error", async () => {
    vi.mocked(sftpListRemote).mockRejectedValue(new Error("socket closed"));

    await useSftpStore.getState().navigate("sid", "remote", "/some/path");

    const s = useSftpStore.getState().sessions.sid;
    expect(s.attached).toBe(false);
    expect(s.error).toBe("socket closed");
    expect(s.remote.error).toBe("socket closed");
  });

  it("escalates 'session closed' (russh-sftp dropped transport) to session level error", async () => {
    // Regression for #425: a dropped SFTP transport surfaces as
    // "Failed to read <path>: session closed". Previously this did not match
    // isConnectionError, so no reconnect banner appeared and the pane stayed
    // wedged on every click.
    vi.mocked(sftpListRemote).mockRejectedValue(
      new Error("Failed to read /data/users/x/scripts: session closed"),
    );

    await useSftpStore.getState().navigate("sid", "remote", "/some/path");

    const s = useSftpStore.getState().sessions.sid;
    expect(s.attached).toBe(false);
    expect(s.error).toContain("session closed");
    expect(s.remote.error).toContain("session closed");
  });

  it("does not escalate non-connection errors on remote navigation", async () => {
    vi.mocked(sftpListRemote).mockRejectedValue(new Error("Permission denied"));

    await useSftpStore.getState().navigate("sid", "remote", "/some/path");

    const s = useSftpStore.getState().sessions.sid;
    expect(s.attached).toBe(true);
    expect(s.error).toBeNull();
    expect(s.remote.error).toBe("Permission denied");
  });
});
