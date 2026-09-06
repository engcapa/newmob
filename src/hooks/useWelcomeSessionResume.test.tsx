import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resumeIpcMocks = vi.hoisted(() => ({
  getWelcomeRunSnapshot: vi.fn(),
  commitWelcomeRunSnapshot: vi.fn(async () => ({ record: null, applied: true })),
  clearWelcomeRunSnapshot: vi.fn(async () => undefined),
}));

vi.mock("../lib/welcomeSessionResume", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWelcomeRunSnapshot: resumeIpcMocks.getWelcomeRunSnapshot,
    commitWelcomeRunSnapshot: resumeIpcMocks.commitWelcomeRunSnapshot,
    clearWelcomeRunSnapshot: resumeIpcMocks.clearWelcomeRunSnapshot,
  };
});

import { useWelcomeSessionResume } from "./useWelcomeSessionResume";
import type { RunSnapshotRecord, SnapshotEntry } from "../types";

const savedEntry = (id: string, type = "SSH"): SnapshotEntry => ({
  kind: "saved-session",
  identity: `saved:${id}`,
  savedSessionId: id,
  savedSessionType: type,
  displayName: `session-${id}`,
});

const record = (
  entries: SnapshotEntry[],
  activeIdentity: string | null = null,
): RunSnapshotRecord => ({
  schemaVersion: 1,
  revision: 3,
  runSequence: 1,
  batchId: "batch-1",
  committedAtMs: 12345,
  entries,
  activeIdentity,
});

const sessionConfig = (id: string, type = "SSH") => ({
  id,
  name: `session-${id}`,
  session_type: type,
  group_path: null,
  host: "example.test",
  port: 22,
  username: "root",
  auth_method: "Password" as const,
  options_json: "{}",
  created_at: 0,
  updated_at: 0,
  last_connected_at: null,
  sort_order: 0,
});

function makeCallbacks() {
  return {
    loadSessionConfig: vi.fn(async (id: string) => sessionConfig(id)),
    findExistingTab: vi.fn(() => null),
    activateTab: vi.fn(),
    openSavedSession: vi.fn(async () => ({
      tabId: "tab-opened",
      status: "ready" as const,
      readiness: "connected" as const,
      issue: null,
    })),
    openLocalTerminal: vi.fn(async () => ({
      tabId: "tab-local",
      status: "ready" as const,
      readiness: "connected" as const,
      issue: null,
    })),
    cancelPendingAuth: vi.fn(),
  };
}

describe("useWelcomeSessionResume (V-07)", () => {
  beforeEach(() => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads a confirmed snapshot into available", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: record([savedEntry("a")]),
      legacyCandidate: null,
      issue: null,
    });
    const { result } = renderHook((props: { active: boolean }) => useWelcomeSessionResume(props.active, makeCallbacks()), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(result.current.view.state).toBe("available"));
    if (result.current.view.state === "available") {
      expect(result.current.view.legacy).toBe(false);
      expect(result.current.view.record.entries).toHaveLength(1);
    }
  });

  it("maps an unknown schema issue to the unavailable/schema state", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: null,
      legacyCandidate: null,
      issue: { code: "unsupported", message: "schema version 99 is not supported" },
    });
    const { result } = renderHook(() => useWelcomeSessionResume(true, makeCallbacks()));
    await waitFor(() => expect(result.current.view.state).toBe("unavailable"));
    if (result.current.view.state === "unavailable") {
      expect(result.current.view.reason).toBe("schema");
    }
  });

  it("shows an empty state with no record and no legacy candidate", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: null,
      legacyCandidate: null,
      issue: null,
    });
    const { result } = renderHook(() => useWelcomeSessionResume(true, makeCallbacks()));
    await waitFor(() => expect(result.current.view.state).toBe("empty"));
  });

  it("restores entries in record order and aggregates success (AC-19)", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: record([savedEntry("ssh-a", "SSH"), savedEntry("db-b", "SSH")]),
      legacyCandidate: null,
      issue: null,
    });
    const callbacks = makeCallbacks();
    const { result } = renderHook(() => useWelcomeSessionResume(true, callbacks));
    await waitFor(() => expect(result.current.view.state).toBe("available"));

    act(() => {
      result.current.startRestore();
    });
    await waitFor(() => expect(result.current.view.state).toBe("succeeded"));
    // Ordered replay: the first entry (SSH) was opened before the DB entry.
    expect(callbacks.openSavedSession).toHaveBeenCalledTimes(2);
    expect((callbacks.openSavedSession.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({ id: "ssh-a" });
    expect((callbacks.openSavedSession.mock.calls[1] as unknown[] | undefined)?.[0]).toMatchObject({ id: "db-b" });
    expect(callbacks.loadSessionConfig).toHaveBeenCalledWith("ssh-a");
    expect(result.current.outcomes.map((o) => o.status)).toEqual(["ready", "ready"]);
    // Suppression cleared on full success.
    expect(result.current.isIdentitySuppressed("saved:ssh-a")).toBe(false);
  });

  it("locates an existing live tab instead of reopening (AC-12)", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: record([savedEntry("a")]),
      legacyCandidate: null,
      issue: null,
    });
    const callbacks = makeCallbacks();
    (callbacks.findExistingTab as unknown as { mockImplementation: (fn: () => string) => void }).mockImplementation(() => "tab-existing");
    const { result } = renderHook(() => useWelcomeSessionResume(true, callbacks));
    await waitFor(() => expect(result.current.view.state).toBe("available"));

    act(() => {
      result.current.startRestore();
    });
    await waitFor(() => expect(result.current.view.state).toBe("succeeded"));
    expect(callbacks.findExistingTab).toHaveBeenCalled();
    expect(callbacks.activateTab).toHaveBeenCalledWith("tab-existing");
    expect(callbacks.openSavedSession).not.toHaveBeenCalled();
    expect(result.current.outcomes[0]).toMatchObject({
      status: "ready",
      readiness: "view-opened",
      tabId: "tab-existing",
    });
  });

  it("reports missing sessions per entry, keeps others, and retries only failures (AC-15/19)", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: record([savedEntry("gone"), savedEntry("ok")]),
      legacyCandidate: null,
      issue: null,
    });
    const callbacks = makeCallbacks();
    callbacks.loadSessionConfig.mockImplementation(async (id: string) => {
      if (id === "gone") {
        throw Object.assign(new Error("no longer exists"), { code: "missing-session" });
      }
      return sessionConfig(id);
    });
    const { result } = renderHook(() => useWelcomeSessionResume(true, callbacks));
    await waitFor(() => expect(result.current.view.state).toBe("available"));

    act(() => {
      result.current.startRestore();
    });
    await waitFor(() => expect(result.current.view.state).toBe("partial"));
    expect(result.current.outcomes).toHaveLength(2);
    expect(result.current.outcomes[0]).toMatchObject({
      identity: "saved:gone",
      status: "failed",
    });
    expect(result.current.outcomes[0].issue?.code).toBe("missing-session");
    expect(result.current.outcomes[1]).toMatchObject({ status: "ready" });
    // The failed identity stays suppressed from the run-snapshot collector.
    expect(result.current.isIdentitySuppressed("saved:gone")).toBe(true);
    expect(result.current.isIdentitySuppressed("saved:ok")).toBe(false);

    // Retry re-runs only the failed entry with the same locked record.
    callbacks.loadSessionConfig.mockImplementation(async (id: string) => sessionConfig(id));
    callbacks.openSavedSession.mockResolvedValueOnce({
      tabId: "tab-recovered",
      status: "ready",
      readiness: "connected",
      issue: null,
    });
    act(() => {
      result.current.retryFailed();
    });
    await waitFor(() => expect(result.current.view.state).toBe("succeeded"));
    expect(callbacks.loadSessionConfig).toHaveBeenCalledTimes(3); // gone + ok + retry(gone)
    expect(callbacks.openSavedSession).toHaveBeenCalledTimes(2); // ok + retry
    expect((callbacks.openSavedSession.mock.calls[1] as unknown[] | undefined)?.[0]).toMatchObject({ id: "gone" });
    expect(result.current.isIdentitySuppressed("saved:gone")).toBe(false);
  });

  it("cancels the pending entry and marks the rest cancelled (AC-13)", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: record([savedEntry("a"), savedEntry("b")]),
      legacyCandidate: null,
      issue: null,
    });
    const callbacks = makeCallbacks();
    let releaseFirst!: (value: unknown) => void;
    (callbacks.openSavedSession as { mockImplementationOnce: (fn: () => Promise<unknown>) => void })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve as (value: unknown) => void;
          }),
      );
    const { result } = renderHook(() => useWelcomeSessionResume(true, callbacks));
    await waitFor(() => expect(result.current.view.state).toBe("available"));

    act(() => {
      result.current.startRestore();
    });
    await waitFor(() => expect(result.current.view.state).toBe("restoring"));

    act(() => {
      result.current.cancelRestore();
    });
    expect(callbacks.cancelPendingAuth).toHaveBeenCalled();

    // The hung open finally rejects (as a cancelled auth would).
    await act(async () => {
      releaseFirst({
        tabId: null,
        status: "cancelled",
        readiness: null,
        issue: { code: "cancelled", message: "Authentication cancelled" },
      });
    });
    await waitFor(() => {
      expect(["partial", "failed", "cancelled", "succeeded"]).toContain(result.current.view.state);
    });
    const statuses = result.current.outcomes.map((o) => o.status);
    expect(statuses[0]).toBe("cancelled");
    // The second entry never dispatched.
    expect(callbacks.openSavedSession).toHaveBeenCalledTimes(1);
  });

  it("promotes a legacy candidate and marks it as legacy source (AC-08)", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: null,
      legacyCandidate: savedEntry("legacy-1"),
      issue: null,
    });
    const callbacks = makeCallbacks();
    const { result } = renderHook(() => useWelcomeSessionResume(true, callbacks));
    await waitFor(() => expect(result.current.view.state).toBe("available"));
    if (result.current.view.state === "available") {
      expect(result.current.view.legacy).toBe(true);
      const entry = result.current.view.record.entries[0];
      expect(entry.kind).toBe("saved-session");
      if (entry.kind === "saved-session") {
        expect(entry.savedSessionId).toBe("legacy-1");
      }
    }

    act(() => {
      result.current.startRestore();
    });
    await waitFor(() => expect(result.current.view.state).toBe("succeeded"));
    // The legacy candidate is promoted to a confirmed batch on full success.
    await waitFor(() => expect(resumeIpcMocks.commitWelcomeRunSnapshot).toHaveBeenCalled());
    expect((resumeIpcMocks.commitWelcomeRunSnapshot.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
      restored: true,
    });
  });

  it("opens whitelist local terminals through the local launcher (AC-10/20)", async () => {
    const localEntry: SnapshotEntry = {
      kind: "local-terminal",
      identity: "local:t1",
      displayName: "bash",
      shellId: "/bin/bash",
      shellArgs: ["-l"],
      confirmedCwd: "/work/repo",
    };
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: record([localEntry]),
      legacyCandidate: null,
      issue: null,
    });
    const callbacks = makeCallbacks();
    const { result } = renderHook(() => useWelcomeSessionResume(true, callbacks));
    await waitFor(() => expect(result.current.view.state).toBe("available"));

    act(() => {
      result.current.startRestore();
    });
    await waitFor(() => expect(result.current.view.state).toBe("succeeded"));
    expect(callbacks.openLocalTerminal).toHaveBeenCalledTimes(1);
    expect((callbacks.openLocalTerminal.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
      identity: "local:t1",
      confirmedCwd: "/work/repo",
    });
    expect(callbacks.openSavedSession).not.toHaveBeenCalled();
  });

  it("keeps a single operation: repeated start requests are ignored (AC-12)", async () => {
    resumeIpcMocks.getWelcomeRunSnapshot.mockResolvedValue({
      record: record([savedEntry("a")]),
      legacyCandidate: null,
      issue: null,
    });
    const callbacks = makeCallbacks();
    let release!: (value: unknown) => void;
    (callbacks.openSavedSession as { mockImplementation: (fn: () => Promise<unknown>) => void })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve as (value: unknown) => void;
          }),
      );
    const { result } = renderHook(() => useWelcomeSessionResume(true, callbacks));
    await waitFor(() => expect(result.current.view.state).toBe("available"));

    act(() => {
      result.current.startRestore();
      result.current.startRestore();
    });
    await waitFor(() => expect(callbacks.openSavedSession).toHaveBeenCalledTimes(1));
    await act(async () => {
      release({ tabId: "t", status: "ready", readiness: "connected", issue: null });
    });
  });
});
