import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocksCapPanel } from "./SocksCapPanel";
import {
  sockscapCapabilities,
  sockscapStart,
  type SocksCapConfig,
} from "../../lib/sockscap";

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

  it("prompts for a password when macOS needs admin rights for the system proxy", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapCapabilities).mockResolvedValueOnce({
      platform: "macos",
      globalTcp: true,
      appFilter: false,
      captureBackend: "system-proxy",
      notes: ["macOS: system SOCKS proxy points applications at the loopback listener."],
      privilegedRequired: true,
    });
    vi.mocked(sockscapStart).mockRejectedValueOnce(
      "macOS capture requires administrator rights to change the system proxy",
    );
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-start"));

    expect(await screen.findByTestId("sockscap-root-prompt-dialog")).toBeInTheDocument();
  });

  it("disables app scope and shows the backend notes when app filtering is unavailable", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapCapabilities).mockResolvedValueOnce({
      platform: "macos",
      globalTcp: true,
      appFilter: false,
      captureBackend: "system-proxy",
      notes: ["Not transparent capture: scope is Global only."],
      privilegedRequired: true,
    });
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-mode-apps")).toBeDisabled();
    expect(await screen.findByTestId("sockscap-capability-notes")).toHaveTextContent(
      "Global only",
    );
  });

  it("keeps app scope selectable where the backend can identify applications", async () => {
    currentPlatform = "windows";
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-mode-apps")).not.toBeDisabled();
  });
});
