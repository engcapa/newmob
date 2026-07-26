import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocksCapPanel } from "./SocksCapPanel";
import {
  sockscapStart,
  sockscapParseShareLink,
  type SocksCapConfig,
} from "../../lib/sockscap";
import { vaultStatus, vaultPut } from "../../lib/ipc";

const defaultTestCfg: SocksCapConfig = {
  enabled: false,
  activeProfileIds: ["default"],
  selectedProfileId: "default",
  profiles: [
    {
      id: "default",
      name: "默认方案",
      icon: "🎮",
      color: null,
      enabled: true,
      priority: 0,
      mode: "global",
      apps: [],
      upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
      ruleMode: "gfwList",
      userRules: [],
      defaultAction: "direct",
    },
  ],
  mode: "global",
  apps: [],
  upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
  ruleMode: "gfwList",
  gfwlist: { enabled: true, url: "https://example.com/gfw.txt", autoRefreshHours: 24 },
  userRules: [],
  bypassCidrs: ["127.0.0.0/8"],
  defaultAction: "direct",
  restoreOnLogin: false,
};

let currentCfg = { ...defaultTestCfg };
let currentPlatform = "windows";

vi.mock("../../lib/sockscap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sockscap")>();
  return {
    ...actual,
    sockscapGetConfig: vi.fn(async () => JSON.parse(JSON.stringify(currentCfg))),
    sockscapSetConfig: vi.fn(async (cfg) => {
      currentCfg = JSON.parse(JSON.stringify(cfg));
    }),
    sockscapCapabilities: vi.fn(async () => ({
      platform: currentPlatform,
      globalTcp: true,
      appFilter: true,
      captureBackend: "WinDivert",
      notes: [],
      privilegedRequired: true,
    })),
    sockscapStart: vi.fn(async () => ({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    })),
    sockscapStatus: vi.fn(async () => ({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    })),
    sockscapGfwlistStatus: vi.fn(async () => ({
      loaded: false,
      ruleCount: 0,
      skipped: 0,
      lastRefresh: null,
      source: "",
      error: null,
    })),
    sockscapStatsSnapshot: vi.fn(async () => ({
      flowsTotal: 0,
      flowsProxy: 0,
      flowsDirect: 0,
      flowsBlock: 0,
      bytesUp: 0,
      bytesDown: 0,
    })),
    sockscapHelperStatus: vi.fn(async () => ({
      running: true,
      elevated: true,
      endpoint: "127.0.0.1:1080",
      message: "ok",
      windivert: null,
      pid: 1234,
    })),
    sockscapGetDomainRecords: vi.fn(async () => []),
    sockscapParseShareLink: vi.fn(),
    sockscapTestCoreUpstream: vi.fn(async () => "ok"),
    sockscapDetectLocalProxies: vi.fn(async () => []),
    sockscapDetectTunConflicts: vi.fn(async () => []),
  };
});

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listSessions: vi.fn(async () => []),
    vaultStatus: vi.fn(async () => ({ state: "unlocked" })),
    vaultPut: vi.fn(async () => ({ reference: "vault:test-ref" })),
  };
});

describe("SocksCapPanel Multi-Profile UI", () => {
  beforeEach(() => {
    currentCfg = JSON.parse(JSON.stringify(defaultTestCfg));
    currentPlatform = "windows";
    vi.mocked(sockscapStart).mockReset();
    vi.mocked(sockscapStart).mockResolvedValue({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders profile manager sidebar and default profile", async () => {
    render(<SocksCapPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("sockscap-panel")).toBeInTheDocument();
      expect(screen.getByTestId("sockscap-profile-list")).toBeInTheDocument();
      expect(screen.getByTestId("sockscap-add-profile")).toBeInTheDocument();
    });
  });

  it("allows adding a new profile", async () => {
    render(<SocksCapPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("sockscap-add-profile")).toBeInTheDocument();
    });

    const addBtn = screen.getByTestId("sockscap-add-profile");
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(currentCfg.profiles.length).toBe(2);
      expect(currentCfg.profiles[1].name).toBe("方案 2");
    });
  });

  it("reveals core-upstream fields (share link + cipher) when selecting Shadowsocks", async () => {
    render(<SocksCapPanel />);
    const kindSelect = await screen.findByTestId("sockscap-upstream-kind");

    fireEvent.change(kindSelect, { target: { value: "shadowsocks" } });

    await waitFor(() => {
      expect(currentCfg.profiles[0].upstream.kind).toBe("shadowsocks");
    });
    // Share-link import field + the SS cipher select are now shown.
    expect(await screen.findByTestId("sockscap-sharelink-input")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "chacha20-ietf-poly1305" }),
      ).toBeInTheDocument();
    });
  });

  it("imports a VLESS share link, vaulting uuid and populating params", async () => {
    vi.mocked(sockscapParseShareLink).mockResolvedValue({
      kindTag: "vless",
      name: "My VLESS",
      host: "node.example.com",
      port: 443,
      params: {
        flow: "xtls-rprx-vision",
        tls: "reality",
        realityPublicKey: "PUBKEY",
        network: "tcp",
        encryption: "none",
      },
      secret: "",
      uuid: "11111111-2222-3333-4444-555555555555",
    });

    render(<SocksCapPanel />);
    const kindSelect = await screen.findByTestId("sockscap-upstream-kind");
    fireEvent.change(kindSelect, { target: { value: "vless" } });

    const input = await screen.findByTestId("sockscap-sharelink-input");
    fireEvent.change(input, {
      target: { value: "vless://uuid@node.example.com:443?security=reality#My VLESS" },
    });
    fireEvent.click(screen.getByTestId("sockscap-sharelink-import"));

    await waitFor(() => {
      const up = currentCfg.profiles[0].upstream;
      expect(up.kind).toBe("vless");
      expect(up.host).toBe("node.example.com");
      expect(up.port).toBe(443);
      // uuid was vaulted into params.uuidRef (never stored plaintext).
      expect(up.params?.uuidRef).toBe("vault:test-ref");
      expect(up.params?.flow).toBe("xtls-rprx-vision");
      expect(up.params?.realityPublicKey).toBe("PUBKEY");
    });
    // The uuid was sent to the vault, not written to config plaintext.
    expect(vi.mocked(vaultPut)).toHaveBeenCalled();
    expect(vi.mocked(vaultStatus)).toHaveBeenCalled();
  });

  it("prompts for sudo when Linux nftables reports missing CAP_NET_ADMIN", async () => {
    currentPlatform = "linux";
    vi.mocked(sockscapStart).mockRejectedValueOnce(
      "nftables is present but unavailable: Operation not permitted "
        + "(you must be root). Linux capture requires CAP_NET_ADMIN",
    );
    render(<SocksCapPanel />);

    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    expect(await screen.findByTestId("sockscap-root-prompt-dialog")).toBeInTheDocument();
  });
});
