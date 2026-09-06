import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  getWelcomeRunSnapshot: vi.fn(),
  commitWelcomeRunSnapshot: vi.fn(),
  clearWelcomeRunSnapshot: vi.fn(),
}));

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWelcomeRunSnapshot: ipcMocks.getWelcomeRunSnapshot,
    commitWelcomeRunSnapshot: ipcMocks.commitWelcomeRunSnapshot,
    clearWelcomeRunSnapshot: ipcMocks.clearWelcomeRunSnapshot,
  };
});

import {
  ELIGIBLE_SAVED_SESSION_TYPES,
  isResumeEligibleSavedSession,
  savedSessionEntry,
  localTerminalEntry,
  snapshotEntriesFingerprint,
  primaryViewTypeForEntry,
  sessionConfigFingerprint,
  getWelcomeRunSnapshot,
  commitWelcomeRunSnapshot,
  clearWelcomeRunSnapshot,
} from "./welcomeSessionResume";
import type { SessionConfig } from "./ipc";

const session = (overrides: Partial<SessionConfig> = {}): SessionConfig => ({
  id: "s1",
  name: "prod",
  session_type: "SSH",
  group_path: null,
  host: "example.test",
  port: 22,
  username: "root",
  auth_method: "Password",
  options_json: "{}",
  created_at: 0,
  updated_at: 0,
  last_connected_at: null,
  sort_order: 0,
  ...overrides,
});

describe("welcomeSessionResume eligible judgment (AC-20)", () => {
  it("accepts the recoverable protocol set and rejects browser/unknown", () => {
    for (const type of ["SSH", "SFTP", "LocalShell", "VNC", "RDP", "Mail", "Redis", "S3"]) {
      expect(isResumeEligibleSavedSession(session({ session_type: type }))).toBe(true);
    }
    expect(isResumeEligibleSavedSession(session({ session_type: "Browser" }))).toBe(false);
    expect(isResumeEligibleSavedSession(session({ session_type: "SomethingNew" }))).toBe(false);
    expect(isResumeEligibleSavedSession(session({ id: "" }))).toBe(false);
    expect(ELIGIBLE_SAVED_SESSION_TYPES.has("Serial")).toBe(true);
  });
});

describe("welcomeSessionResume entry builders (AC-19/20)", () => {
  it("builds saved-session entries with identity and display name", () => {
    const entry = savedSessionEntry(session({ name: "" }));
    expect(entry).toEqual({
      kind: "saved-session",
      identity: "saved:s1",
      savedSessionId: "s1",
      savedSessionType: "SSH",
      displayName: "example.test",
    });
  });

  it("builds whitelist local-terminal entries with confirmed cwd", () => {
    const entry = localTerminalEntry({
      tabId: "local-abc",
      displayName: "bash",
      shellId: "/bin/bash",
      shellArgs: ["-l"],
      confirmedCwd: "/work/repo",
    });
    expect(entry).toMatchObject({
      kind: "local-terminal",
      identity: "local:local-abc",
      shellId: "/bin/bash",
      shellArgs: ["-l"],
      confirmedCwd: "/work/repo",
    });
  });

  it("fingerprints are order- and active-sensitive for change detection", () => {
    const a = [savedSessionEntry(session()), localTerminalEntry({
      tabId: "t1",
      displayName: "bash",
      shellId: "/bin/bash",
      shellArgs: [],
      confirmedCwd: "/w",
    })];
    const b = [...a];
    const reordered = [a[1], a[0]];
    expect(snapshotEntriesFingerprint(a, "saved:s1")).toBe(snapshotEntriesFingerprint(b, "saved:s1"));
    expect(snapshotEntriesFingerprint(a, "saved:s1")).not.toBe(
      snapshotEntriesFingerprint(a, "local:t1"),
    );
    expect(snapshotEntriesFingerprint(a, null)).not.toBe(
      snapshotEntriesFingerprint(a, "saved:s1"),
    );
    expect(snapshotEntriesFingerprint(a, null)).not.toBe(snapshotEntriesFingerprint(reordered, null));
  });
});

describe("welcomeSessionResume view type mapping (AC-12)", () => {
  it("maps saved types to the primary view kinds", () => {
    const kindOf = (type: string) =>
      primaryViewTypeForEntry(savedSessionEntry(session({ session_type: type })));
    expect(kindOf("SSH")).toBe("terminal");
    expect(kindOf("LocalShell")).toBe("terminal");
    expect(kindOf("SFTP")).toBe("sftp");
    expect(kindOf("VNC")).toBe("vnc");
    expect(kindOf("RDP")).toBe("rdp");
    expect(kindOf("Mail")).toBe("mail");
    expect(kindOf("Redis")).toBe("redis");
    expect(kindOf("MySQL")).toBe("database");
    expect(kindOf("S3")).toBe("object-storage");
    expect(kindOf("Proxy")).toBe("proxy-test");
    expect(kindOf("File")).toBe("file-browser");
    expect(kindOf("Browser")).toBe("terminal"); // never collected anyway
  });

  it("fingerprints sessions without secrets", () => {
    const fp = sessionConfigFingerprint(session({ auth_method: "Password" }));
    expect(fp).not.toMatch(/Password/);
    expect(fp).toContain("example.test");
  });
});

describe("welcomeSessionResume IPC wrappers (AC-08/15)", () => {
  beforeEach(() => {
    ipcMocks.getWelcomeRunSnapshot.mockReset();
    ipcMocks.commitWelcomeRunSnapshot.mockReset();
    ipcMocks.clearWelcomeRunSnapshot.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes null (not undefined) revision values to the backend", async () => {
    ipcMocks.getWelcomeRunSnapshot.mockResolvedValue({ record: null, legacyCandidate: null, issue: null });
    ipcMocks.commitWelcomeRunSnapshot.mockResolvedValue({ record: null, applied: false });
    ipcMocks.clearWelcomeRunSnapshot.mockResolvedValue(undefined);

    await getWelcomeRunSnapshot();
    await commitWelcomeRunSnapshot({ batchId: "b", entries: [], activeIdentity: null });
    await clearWelcomeRunSnapshot({});

    expect(ipcMocks.commitWelcomeRunSnapshot).toHaveBeenCalledWith({
      batchId: "b",
      entries: [],
      activeIdentity: null,
      expectedRevision: null,
      restored: false,
    });
    expect(ipcMocks.clearWelcomeRunSnapshot).toHaveBeenCalledWith({ expectedRevision: null });
  });
});
