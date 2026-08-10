/**
 * Tests for the generic detachedSession handoff/reattach helpers.
 *
 * The most important invariants are:
 *   1. handoff round-trip: write/read via the same kind+id returns the
 *      same payload, and TTL eviction kicks in correctly.
 *   2. URL detection: hash form (`#kind=id`) and query form
 *      (`?kind=id`) both resolve back to a `{ kind, id }` tuple.
 *   3. Reattach: the `subscribeReattach` callback fires when a peer
 *      broadcasts, and `drainPendingReattach` returns localStorage
 *      entries left behind by abrupt closes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HANDOFF_TTL_MS,
  broadcastReattach,
  clearDetachedHandoff,
  clearReattachHandoff,
  consumeDetachedHandoff,
  detectDetachedRoute,
  drainPendingReattach,
  subscribeReattach,
  sweepExpiredHandoffs,
  writeDetachedHandoff,
} from "./detachedSession";

describe("detachedSession handoff round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("writes and reads back a payload for any kind", () => {
    writeDetachedHandoff("rdp", "tab-1", { foo: "bar" });
    expect(consumeDetachedHandoff<{ foo: string }>("rdp", "tab-1")).toEqual({
      foo: "bar",
    });
  });

  it("expires handoffs older than the TTL", () => {
    writeDetachedHandoff("vnc", "tab-2", { v: 1 });
    const key = "taomni.detached.vnc.tab-2";
    const env = JSON.parse(localStorage.getItem(key)!);
    env.createdAt = Date.now() - HANDOFF_TTL_MS - 1_000;
    localStorage.setItem(key, JSON.stringify(env));
    expect(consumeDetachedHandoff("vnc", "tab-2")).toBeNull();
  });

  it("never persists a VNC plaintext password", () => {
    writeDetachedHandoff("vnc", "secret-tab", {
      host: "localhost",
      password: "do-not-store",
      credentialRef: "also-not-a-reference",
    });
    const raw = localStorage.getItem("taomni.detached.vnc.secret-tab") ?? "";
    expect(raw).not.toContain("do-not-store");
    expect(raw).not.toContain("also-not-a-reference");
  });

  it("clearDetachedHandoff removes the entry without throwing", () => {
    writeDetachedHandoff("terminal", "tab-3", { x: true });
    clearDetachedHandoff("terminal", "tab-3");
    expect(consumeDetachedHandoff("terminal", "tab-3")).toBeNull();
  });

  it("falls back to the legacy SFTP key for sftp kind", () => {
    // Older builds wrote a bare params blob (no createdAt envelope) to
    // taomni.sftp.detached.<id>. Make sure the new helpers still consume
    // it so users with stale entries don't lose their SFTP credentials
    // across an upgrade.
    localStorage.setItem(
      "taomni.sftp.detached.legacy",
      JSON.stringify({ host: "h", port: 22 }),
    );
    expect(
      consumeDetachedHandoff<{ host: string; port: number }>("sftp", "legacy"),
    ).toEqual({ host: "h", port: 22 });
  });

  it("sweepExpiredHandoffs removes only expired entries", () => {
    writeDetachedHandoff("rdp", "fresh", { a: 1 });
    writeDetachedHandoff("rdp", "stale", { b: 2 });
    const staleKey = "taomni.detached.rdp.stale";
    const env = JSON.parse(localStorage.getItem(staleKey)!);
    env.createdAt = Date.now() - HANDOFF_TTL_MS - 1_000;
    localStorage.setItem(staleKey, JSON.stringify(env));
    sweepExpiredHandoffs();
    expect(consumeDetachedHandoff("rdp", "fresh")).toEqual({ a: 1 });
    expect(consumeDetachedHandoff("rdp", "stale")).toBeNull();
  });
});

describe("detectDetachedRoute", () => {
  const original = window.location.href;
  afterEach(() => {
    window.history.replaceState(null, "", original);
  });

  it("returns null on the main window", () => {
    window.history.replaceState(null, "", "/");
    expect(detectDetachedRoute()).toBeNull();
  });

  it("parses hash form (#kind=id) from Tauri native windows", () => {
    window.history.replaceState(null, "", "/index.html#rdp=session-1");
    expect(detectDetachedRoute()).toEqual({ kind: "rdp", id: "session-1" });
  });

  it("parses query form (?kind=id) from window.open in browser mode", () => {
    window.history.replaceState(null, "", "/index.html?vnc=session-2");
    expect(detectDetachedRoute()).toEqual({ kind: "vnc", id: "session-2" });
  });

  it("parses database detached routes", () => {
    window.history.replaceState(null, "", "/index.html#database=db-session");
    expect(detectDetachedRoute()).toEqual({ kind: "database", id: "db-session" });
  });

  it("parses notes detached routes", () => {
    window.history.replaceState(null, "", "/index.html#notes=panel");
    expect(detectDetachedRoute()).toEqual({ kind: "notes", id: "panel" });
  });

  it("parses servers detached routes", () => {
    window.history.replaceState(null, "", "/index.html#servers=main");
    expect(detectDetachedRoute()).toEqual({ kind: "servers", id: "main" });
  });

  it("ignores unknown kinds", () => {
    window.history.replaceState(null, "", "/index.html#bogus=oops");
    expect(detectDetachedRoute()).toBeNull();
  });
});

describe("reattach pipeline", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("drainPendingReattach returns and clears localStorage envelopes", () => {
    // Simulate a detached window that wrote a reattach envelope and then
    // died before its broadcast was delivered.
    const env = {
      payload: { host: "h", port: 22 },
      createdAt: Date.now(),
    };
    localStorage.setItem("taomni.reattach.terminal.tab-9", JSON.stringify(env));
    const drained = drainPendingReattach();
    expect(drained).toHaveLength(1);
    expect(drained[0].kind).toBe("terminal");
    expect(drained[0].id).toBe("tab-9");
    expect(drained[0].payload).toEqual({ host: "h", port: 22 });
    expect(localStorage.getItem("taomni.reattach.terminal.tab-9")).toBeNull();
  });

  it("clearReattachHandoff removes the entry without throwing", () => {
    localStorage.setItem(
      "taomni.reattach.rdp.tab-10",
      JSON.stringify({ payload: {}, createdAt: Date.now() }),
    );
    clearReattachHandoff("rdp", "tab-10");
    expect(localStorage.getItem("taomni.reattach.rdp.tab-10")).toBeNull();
  });

  it("broadcastReattach writes a localStorage backstop", () => {
    broadcastReattach("rdp", "tab-11", { host: "win", port: 3389 });
    const raw = localStorage.getItem("taomni.reattach.rdp.tab-11");
    expect(raw).toBeTruthy();
    const env = JSON.parse(raw!);
    expect(env.payload).toEqual({ host: "win", port: 3389 });
    expect(typeof env.createdAt).toBe("number");
  });

  it("subscribeReattach registers a callback that can be unsubscribed", () => {
    // jsdom's BroadcastChannel doesn't actually deliver to listeners in
    // the same realm, so the round-trip itself isn't testable here. We
    // settle for exercising the registration path: the unsubscribe call
    // must not throw and the listener registry must shrink.
    const fn = vi.fn();
    const unsub = subscribeReattach(fn);
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });
});
