import { beforeEach, describe, expect, it, vi } from "vitest";
import { useObjectStorageStore, type ObjStorageSessionState } from "./objectStorageStore";
import { sftpListLocalDetailed, type FileEntry } from "../lib/sftp";

vi.mock("../lib/sftp", () => ({
  sftpListLocal: vi.fn(),
  sftpListLocalDetailed: vi.fn(),
  sftpLocalHome: vi.fn(),
  sftpLocalDrives: vi.fn(),
}));

vi.mock("../lib/objectStorage", () => ({
  storageAttach: vi.fn(),
  storageDetach: vi.fn(),
  storageListBuckets: vi.fn(),
  storageListObjects: vi.fn(),
}));

function entry(name: string, path: string, fileType: FileEntry["fileType"] = "dir"): FileEntry {
  return {
    name,
    path,
    fileType,
    size: 0,
    mtime: 0,
    mode: 0,
    isHidden: false,
  };
}

function session(entries: FileEntry[] = []): ObjStorageSessionState {
  return {
    sessionId: "sid",
    attached: true,
    attaching: false,
    homeDir: "/bucket",
    error: null,
    config: null,
    remote: {
      path: "/bucket",
      entries,
      selection: [],
      loading: false,
      error: null,
      skippedEntryCount: 0,
      entryDiagnostics: [],
      history: ["/bucket"],
      historyIndex: 0,
      showHidden: false,
    },
    local: {
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
    },
  };
}

describe("objectStorageStore remote entry reconciliation", () => {
  beforeEach(() => {
    vi.mocked(sftpListLocalDetailed).mockReset();
    vi.mocked(sftpListLocalDetailed).mockResolvedValue({
      entries: [],
      skippedCount: 0,
      diagnostics: [],
    });
    useObjectStorageStore.setState({ sessions: { sid: session([entry("old", "/bucket/old/")]) } });
  });

  it("upserts a remote entry after a successful create", () => {
    const created = entry("new", "/bucket/new/");

    useObjectStorageStore.getState().upsertRemoteEntry("sid", created);
    useObjectStorageStore.getState().upsertRemoteEntry("sid", { ...created, mtime: 123 });

    const remote = useObjectStorageStore.getState().sessions.sid.remote;
    expect(remote.entries.map((e) => e.path)).toEqual(["/bucket/old/", "/bucket/new/"]);
    expect(remote.entries.find((e) => e.path === "/bucket/new/")?.mtime).toBe(123);
    expect(remote.error).toBeNull();
  });

  it("removes stale remote entries and selection after a successful delete", () => {
    useObjectStorageStore.setState({ sessions: { sid: session([entry("old", "/bucket/old/")]) } });
    useObjectStorageStore.getState().setSelection("sid", "remote", ["/bucket/old/"]);

    useObjectStorageStore.getState().removeRemoteEntries("sid", ["/bucket/old/"]);

    const remote = useObjectStorageStore.getState().sessions.sid.remote;
    expect(remote.entries).toEqual([]);
    expect(remote.selection).toEqual([]);
    expect(remote.error).toBeNull();
  });

  it("keeps readable local entries and partial-listing diagnostics", async () => {
    const readable = entry("readable.txt", "/target/readable.txt", "file");
    vi.mocked(sftpListLocalDetailed).mockResolvedValue({
      entries: [readable],
      skippedCount: 1,
      diagnostics: [{
        name: "private.txt",
        path: "/target/private.txt",
        error: "Permission denied",
      }],
    });

    await useObjectStorageStore.getState().navigate("sid", "local", "/target");

    const local = useObjectStorageStore.getState().sessions.sid.local;
    expect(local.path).toBe("/target");
    expect(local.entries).toEqual([readable]);
    expect(local.skippedEntryCount).toBe(1);
    expect(local.entryDiagnostics).toHaveLength(1);
    expect(local.error).toBeNull();
  });

  it("restores the previous local pane when navigation fails", async () => {
    const previous = entry("keep.txt", "/previous/keep.txt", "file");
    const current = session();
    current.local = {
      ...current.local,
      path: "/previous",
      entries: [previous],
      history: ["/previous"],
      historyIndex: 0,
    };
    useObjectStorageStore.setState({ sessions: { sid: current } });
    vi.mocked(sftpListLocalDetailed).mockRejectedValue(new Error("Permission denied"));

    await useObjectStorageStore.getState().navigate("sid", "local", "/protected");

    const local = useObjectStorageStore.getState().sessions.sid.local;
    expect(local.path).toBe("/previous");
    expect(local.entries).toEqual([previous]);
    expect(local.error).toBe("Permission denied");
  });
});
