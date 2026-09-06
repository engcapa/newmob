import { describe, expect, it } from "vitest";
import {
  failedEntries,
  isRestorableKind,
  sessionFingerprint,
  summarizeBatch,
  type BatchOutcome,
} from "./welcomeRunRestore";
import type { SessionConfig } from "./ipc";

function session(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: "s1",
    name: "Work",
    session_type: "SSH",
    group_path: null,
    host: "example.com",
    port: 22,
    username: "ada",
    auth_method: "Password",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

describe("welcomeRunRestore", () => {
  it("excludes workspace/git/settings/chat-adjacent kinds", () => {
    expect(isRestorableKind("terminal")).toBe(true);
    expect(isRestorableKind("sftp")).toBe(true);
    expect(isRestorableKind("code-workspace")).toBe(false);
    expect(isRestorableKind("git")).toBe(false);
    expect(isRestorableKind("settings")).toBe(false);
    expect(isRestorableKind("welcome")).toBe(false);
    expect(isRestorableKind("browser")).toBe(false);
  });

  it("fingerprints non-sensitive identity without secrets", () => {
    const a = session({ options_json: JSON.stringify({ password: "secret", terminalProfile: { theme: "dark" } }) });
    const b = session({ options_json: JSON.stringify({ password: "other", terminalProfile: { theme: "dark" } }) });
    const c = session({ host: "other.example.com" });
    expect(sessionFingerprint(a)).toBe(sessionFingerprint(b));
    expect(sessionFingerprint(a)).not.toBe(sessionFingerprint(c));
    expect(sessionFingerprint(a)).not.toContain("secret");
  });

  it("summarizes batch counts and isolates the retry set", () => {
    const outcome: BatchOutcome = {
      operationId: "op",
      runId: "run",
      batchRevision: 1,
      results: [
        { entryKey: "a", tabId: "t1", status: "ready", readiness: "client-started", issues: [] },
        { entryKey: "b", tabId: null, status: "failed", readiness: null, issues: [] },
        { entryKey: "c", tabId: null, status: "cancelled", readiness: null, issues: [] },
      ],
    };
    expect(summarizeBatch(outcome)).toEqual({ ok: 1, total: 3 });
    expect(failedEntries(outcome).map((r) => r.entryKey)).toEqual(["b", "c"]);
  });
});
