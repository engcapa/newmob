import { describe, expect, it } from "vitest";
import { captureScopeSignature, requiresRestart } from "./sockscapRestart";
import type { SocksCapConfig, SocksCapProfile } from "./sockscap";

function profile(over: Partial<SocksCapProfile> = {}): SocksCapProfile {
  return {
    id: "default",
    name: "Default",
    icon: null,
    color: null,
    enabled: true,
    priority: 0,
    mode: "global",
    apps: [],
    upstream: {
      kind: "socks5",
      sessionId: "",
      host: "127.0.0.1",
      port: 1080,
      username: "",
      passwordRef: "",
    },
    ruleMode: "gfwList",
    userRules: [],
    defaultAction: "direct",
    ...over,
  };
}

function cfg(profiles: SocksCapProfile[], activeIds?: string[]): SocksCapConfig {
  return {
    enabled: true,
    activeProfileIds: activeIds ?? profiles.map((p) => p.id),
    selectedProfileId: profiles[0]?.id ?? "",
    profiles,
    mode: profiles[0]?.mode ?? "global",
    apps: profiles[0]?.apps ?? [],
    upstream: profiles[0]?.upstream ?? {
      kind: "socks5",
      host: "127.0.0.1",
      port: 1080,
    },
    ruleMode: "gfwList",
    gfwlist: { enabled: true, url: "", autoRefreshHours: 24 },
    userRules: [],
    bypassCidrs: [],
    defaultAction: "direct",
    restoreOnLogin: false,
    blockQuic: true,
    captureMode: "auto",
    localProxyPort: 7890,
  };
}

describe("requiresRestart", () => {
  it("is false when nothing changed", () => {
    const a = cfg([profile()]);
    const b = cfg([profile()]);
    expect(requiresRestart(a, b)).toBe(false);
  });

  it("keeps routing-policy changes outside the topology-only signature", () => {
    const a = cfg([profile()]);
    const b = cfg([
      profile({
        ruleMode: "proxyAll",
        defaultAction: "proxy",
        userRules: [{ pattern: "example.com", action: "block" }],
      }),
    ]);
    expect(requiresRestart(a, b)).toBe(false);
  });

  it("is true when scope mode changes", () => {
    const a = cfg([profile({ mode: "global" })]);
    const b = cfg([profile({ mode: "apps", apps: [{ path: "C:/a.exe" }] })]);
    expect(requiresRestart(a, b)).toBe(true);
  });

  it("is true when the app list changes", () => {
    const a = cfg([profile({ mode: "apps", apps: [{ path: "C:/a.exe" }] })]);
    const b = cfg([
      profile({ mode: "apps", apps: [{ path: "C:/a.exe" }, { path: "C:/b.exe" }] }),
    ]);
    expect(requiresRestart(a, b)).toBe(true);
  });

  it("ignores app-path case and slash direction", () => {
    const a = cfg([profile({ mode: "apps", apps: [{ path: "C:/App/Game.exe" }] })]);
    const b = cfg([profile({ mode: "apps", apps: [{ path: "c:\\app\\game.exe" }] })]);
    expect(requiresRestart(a, b)).toBe(false);
  });

  it("is true when the upstream changes", () => {
    const a = cfg([profile()]);
    const b = cfg([
      profile({
        upstream: { kind: "http", sessionId: "", host: "10.0.0.1", port: 8080, username: "", passwordRef: "" },
      }),
    ]);
    expect(requiresRestart(a, b)).toBe(true);
  });

  it("is true when a session-bound upstream target changes", () => {
    const a = cfg([profile({ upstream: { kind: "ssh", sessionId: "s1", host: "", port: 0, username: "", passwordRef: "" } })]);
    const b = cfg([profile({ upstream: { kind: "ssh", sessionId: "s2", host: "", port: 0, username: "", passwordRef: "" } })]);
    expect(requiresRestart(a, b)).toBe(true);
  });

  it("is true when the active profile set changes", () => {
    const p1 = profile({ id: "a" });
    const p2 = profile({ id: "b" });
    const a = cfg([p1, p2], ["a"]);
    const b = cfg([p1, p2], ["a", "b"]);
    expect(requiresRestart(a, b)).toBe(true);
  });

  it("is order-independent over active profiles", () => {
    const p1 = profile({ id: "a" });
    const p2 = profile({ id: "b" });
    expect(captureScopeSignature(cfg([p1, p2], ["a", "b"]))).toBe(
      captureScopeSignature(cfg([p2, p1], ["b", "a"])),
    );
  });

  it("disabling a profile changes the active scope", () => {
    const p1 = profile({ id: "a" });
    const p2 = profile({ id: "b" });
    const a = cfg([p1, p2], ["a", "b"]);
    const b = cfg([p1, { ...p2, enabled: false }], ["a", "b"]);
    expect(requiresRestart(a, b)).toBe(true);
  });
});
