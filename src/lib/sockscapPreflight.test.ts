import { describe, expect, it } from "vitest";
import {
  collectProbeTargets,
  collectUpstreamConfigIssues,
  upstreamConfigIssue,
} from "./sockscapPreflight";
import type {
  SocksCapConfig,
  SocksCapProfile,
  UpstreamRef,
} from "./sockscap";

function mkProfile(
  id: string,
  upstream: UpstreamRef,
  over: Partial<SocksCapProfile> = {},
): SocksCapProfile {
  return {
    id,
    name: id,
    icon: "🎮",
    color: null,
    enabled: true,
    priority: 0,
    mode: "global",
    apps: [],
    upstream,
    ruleMode: "gfwList",
    userRules: [],
    defaultAction: "direct",
    ...over,
  };
}

function mkCfg(profiles: SocksCapProfile[]): SocksCapConfig {
  return {
    enabled: false,
    activeProfileIds: profiles.map((p) => p.id),
    selectedProfileId: profiles[0]?.id ?? "",
    profiles,
    mode: "global",
    apps: [],
    upstream: profiles[0]?.upstream ?? { kind: "socks5" },
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

describe("upstreamConfigIssue", () => {
  it("passes a fully configured native socks5 upstream", () => {
    expect(
      upstreamConfigIssue({ kind: "socks5", host: "127.0.0.1", port: 1080 }),
    ).toBeNull();
  });

  it("flags an empty host", () => {
    expect(
      upstreamConfigIssue({ kind: "socks5", host: "", port: 1080 }),
    ).toBe("issueHostEmpty");
  });

  it("flags an invalid port", () => {
    expect(
      upstreamConfigIssue({ kind: "http", host: "proxy.local", port: 0 }),
    ).toBe("issuePortInvalid");
  });

  it("treats a session-backed native upstream as configured even without host", () => {
    expect(
      upstreamConfigIssue({ kind: "ssh", sessionId: "sess-1", host: "", port: 0 }),
    ).toBeNull();
  });

  it("flags a shadowsocks upstream with no imported secret", () => {
    expect(
      upstreamConfigIssue({ kind: "shadowsocks", host: "n.example", port: 443 }),
    ).toBe("issueShareLinkMissing");
  });

  it("passes a shadowsocks upstream once its secret is vaulted", () => {
    expect(
      upstreamConfigIssue({
        kind: "shadowsocks",
        host: "n.example",
        port: 443,
        passwordRef: "vault:abc",
      }),
    ).toBeNull();
  });

  it("flags a vmess/vless upstream missing its uuid", () => {
    expect(
      upstreamConfigIssue({ kind: "vless", host: "n.example", port: 443 }),
    ).toBe("issueUuidMissing");
    expect(
      upstreamConfigIssue({
        kind: "vmess",
        host: "n.example",
        port: 443,
        params: { uuidRef: "vault:uuid" },
      }),
    ).toBeNull();
  });

  it("flags wireguard missing key then missing peer", () => {
    expect(
      upstreamConfigIssue({ kind: "wireguard", host: "n.example", port: 51820 }),
    ).toBe("issueWgKeyMissing");
    expect(
      upstreamConfigIssue({
        kind: "wireguard",
        host: "n.example",
        port: 51820,
        params: { privateKeyRef: "vault:wg" },
      }),
    ).toBe("issueWgPeerMissing");
    expect(
      upstreamConfigIssue({
        kind: "wireguard",
        host: "n.example",
        port: 51820,
        params: { privateKeyRef: "vault:wg", peerPublicKey: "PUB" },
      }),
    ).toBeNull();
  });
});

describe("collectUpstreamConfigIssues", () => {
  it("only reports active profiles", () => {
    const cfg = mkCfg([
      mkProfile("a", { kind: "socks5", host: "", port: 0 }),
      mkProfile("b", { kind: "socks5", host: "1.2.3.4", port: 1080 }),
    ]);
    // Deactivate the broken one → no issues.
    cfg.activeProfileIds = ["b"];
    expect(collectUpstreamConfigIssues(cfg)).toEqual([]);

    // Activate both → the broken one is reported.
    cfg.activeProfileIds = ["a", "b"];
    const issues = collectUpstreamConfigIssues(cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0].profileId).toBe("a");
    expect(issues[0].reasonKey).toBe("issueHostEmpty");
  });
});

describe("collectProbeTargets", () => {
  it("skips unconfigured upstreams and de-dupes identical ones", () => {
    const cfg = mkCfg([
      mkProfile("a", { kind: "socks5", host: "1.2.3.4", port: 1080 }),
      mkProfile("b", { kind: "socks5", host: "1.2.3.4", port: 1080 }),
      mkProfile("c", { kind: "socks5", host: "", port: 0 }),
      mkProfile("d", { kind: "http", host: "5.6.7.8", port: 8080 }),
    ]);
    const targets = collectProbeTargets(cfg);
    // a and b collapse to one; c is skipped (empty); d is distinct.
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.profileId).sort()).toEqual(["a", "d"]);
  });
});
