import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOCKSCAP_MACOS_SETUP_STORAGE_KEY,
  SocksCapPanel,
} from "./SocksCapPanel";
import {
  sockscapCapabilities,
  sockscapInstallRedirector,
  sockscapRecover,
  sockscapRedirectorInstallStatus,
  sockscapLaunchApp,
  sockscapLaunchedApps,
  sockscapStopLaunchedApp,
  sockscapStop,
  sockscapStart,
  sockscapStatus,
  sockscapParseShareLink,
  sockscapImportSubscription,
  sockscapDetectTunConflicts,
  sockscapTestUpstream,
  type SocksCapConfig,
} from "../../lib/sockscap";
import { vaultStatus, vaultPut, listSessions, type SessionConfig } from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";

const { dialogOpenMock } = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
}));

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
  blockQuic: true,
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
    sockscapCapabilities: vi.fn(async () =>
      currentPlatform === "linux"
        ? {
            platform: "linux",
            globalTcp: false,
            appFilter: true,
            captureBackend: "linux-app-launch",
            notes: ["Launch configured applications from SocksCap."],
            privilegedRequired: false,
            linux: {
              transparentAvailable: false,
              launchedApplicationAvailable: true,
              launchOnly: true,
              containerized: false,
              transparentUnavailableReason: "Operation not permitted",
            },
          }
        : {
            platform: currentPlatform,
            globalTcp: true,
            appFilter: true,
            captureBackend: "WinDivert",
            notes: [],
            privilegedRequired: true,
          },
    ),
    sockscapStart: vi.fn(async () => ({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    })),
    sockscapLaunchApp: vi.fn(async (profileId: string, path: string, args: string[], launchPreparation = {}) => ({
      pid: 4242,
      profileId,
      path,
      args: args ?? [],
      launchPreparation,
      running: true,
    })),
    sockscapLaunchedApps: vi.fn(async () => []),
    sockscapStopLaunchedApp: vi.fn(async () => undefined),
    sockscapStop: vi.fn(async () => ({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    })),
    sockscapRecover: vi.fn(async () => undefined),
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
    sockscapTestUpstream: vi.fn(async () => "SOCKS5 ok"),
    sockscapTestCoreUpstream: vi.fn(async () => "ok"),
    sockscapDetectLocalProxies: vi.fn(async () => []),
    sockscapDetectTunConflicts: vi.fn(async () => []),
    sockscapImportSubscription: vi.fn(),
    sockscapInstallRedirector: vi.fn(async () => ({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "installed",
    })),
    sockscapRedirectorInstallStatus: vi.fn(async () => ({
      state: "ready",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "enabled",
      message: "ready",
    })),
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
    window.localStorage.removeItem(SOCKSCAP_MACOS_SETUP_STORAGE_KEY);
    currentCfg = JSON.parse(JSON.stringify(defaultTestCfg));
    currentPlatform = "windows";
    vi.mocked(sockscapStart).mockReset();
    vi.mocked(sockscapStart).mockResolvedValue({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    });
    vi.mocked(sockscapLaunchApp).mockReset();
    vi.mocked(sockscapLaunchApp).mockImplementation(async (profileId, path, args, launchPreparation) => ({
      pid: 4242,
      profileId,
      path,
      args: args ?? [],
      launchPreparation,
      running: true,
    }));
    vi.mocked(sockscapLaunchedApps).mockReset();
    vi.mocked(sockscapLaunchedApps).mockResolvedValue([]);
    vi.mocked(sockscapStopLaunchedApp).mockReset();
    vi.mocked(sockscapStopLaunchedApp).mockResolvedValue(undefined);
    vi.mocked(sockscapStop).mockReset();
    vi.mocked(sockscapStop).mockResolvedValue({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    });
    vi.mocked(sockscapRecover).mockReset();
    vi.mocked(sockscapRecover).mockResolvedValue(undefined);
    // Default to idle so the panel is unlocked; the lock test overrides this.
    vi.mocked(sockscapStatus).mockReset();
    vi.mocked(sockscapStatus).mockResolvedValue({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    });
    // Default: the pre-flight upstream probe passes.
    vi.mocked(sockscapTestUpstream).mockReset();
    vi.mocked(sockscapTestUpstream).mockResolvedValue("SOCKS5 ok");
    vi.mocked(sockscapDetectTunConflicts).mockReset();
    vi.mocked(sockscapDetectTunConflicts).mockResolvedValue([]);
    vi.mocked(sockscapInstallRedirector).mockReset();
    vi.mocked(sockscapInstallRedirector).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "installed",
    });
    vi.mocked(sockscapRedirectorInstallStatus).mockReset();
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "ready",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "enabled",
      message: "ready",
    });
    dialogOpenMock.mockReset();
    dialogOpenMock.mockResolvedValue(null);
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
    expect(screen.getByTestId("sockscap-header-summary")).toHaveTextContent(
      "1 active · 默认方案",
    );
    expect(screen.getByTestId("sockscap-header-summary")).toHaveTextContent(
      "0 flows · 0 proxy · 0 direct",
    );
    expect(screen.getByTestId("sockscap-capability-notes")).toHaveTextContent(
      "Backend · WinDivert",
    );
  });

  it("renders detail sections collapsed by default and expands them on demand", async () => {
    render(<SocksCapPanel />);

    const upstreamToggle = await screen.findByTestId("sockscap-section-upstream-toggle");
    expect(upstreamToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("sockscap-upstream-kind")).not.toBeVisible();

    fireEvent.click(upstreamToggle);

    expect(upstreamToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("sockscap-upstream-kind")).toBeVisible();
    expect(screen.getByTestId("sockscap-domains-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a header warning icon for TUN conflicts and opens its detail dialog", async () => {
    vi.mocked(sockscapDetectTunConflicts).mockResolvedValueOnce(["OpenVPN Wintun"]);
    render(<SocksCapPanel />);

    const warning = await screen.findByTestId("sockscap-tun-warning");
    expect(within(screen.getByTestId("sockscap-header")).getByTestId("sockscap-tun-warning")).toBe(warning);
    expect(warning.getAttribute("title")).toContain("OpenVPN Wintun");

    fireEvent.click(warning);

    expect(await screen.findByTestId("sockscap-tun-warning-dialog")).toHaveTextContent("OpenVPN Wintun");
    fireEvent.click(screen.getByTestId("sockscap-tun-warning-close"));
    expect(screen.queryByTestId("sockscap-tun-warning-dialog")).not.toBeInTheDocument();
  });

  it("treats an unavailable browser TUN probe as no conflict", async () => {
    vi.mocked(sockscapDetectTunConflicts).mockResolvedValueOnce(undefined as unknown as string[]);
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-panel")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("sockscap-tun-warning")).not.toBeInTheDocument());
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

  it("sorts profiles by priority and lets the user raise, lower, or edit it", async () => {
    const base = defaultTestCfg.profiles[0];
    currentCfg = {
      ...defaultTestCfg,
      activeProfileIds: ["default", "middle", "highest"],
      profiles: [
        { ...base, id: "default", name: "Default", priority: 10 },
        { ...base, id: "middle", name: "Middle", priority: 20 },
        { ...base, id: "highest", name: "Highest", priority: 0 },
      ],
    };
    render(<SocksCapPanel />);

    await screen.findByTestId("sockscap-profile-priority-input-default");
    const listedIds = () =>
      Array.from(
        screen
          .getByTestId("sockscap-profile-list")
          .querySelectorAll<HTMLElement>("[data-testid^='sockscap-profile-item-']"),
      ).map((element) => element.dataset.testid);

    expect(listedIds()).toEqual([
      "sockscap-profile-item-highest",
      "sockscap-profile-item-default",
      "sockscap-profile-item-middle",
    ]);
    expect(screen.getByTestId("sockscap-profile-priority-input-default")).toHaveAttribute(
      "title",
      expect.stringContaining("Smaller values have higher priority"),
    );

    const raiseDefault = screen.getByTestId("sockscap-profile-priority-up-default");
    expect(raiseDefault).not.toBeDisabled();
    fireEvent.click(raiseDefault);
    await waitFor(() => {
      expect(currentCfg.profiles.find((p) => p.id === "default")?.priority).toBe(0);
      expect(listedIds().slice(0, 2)).toEqual([
        "sockscap-profile-item-default",
        "sockscap-profile-item-highest",
      ]);
    });

    fireEvent.change(screen.getByTestId("sockscap-profile-priority-input-middle"), {
      target: { value: "-5" },
    });
    await waitFor(() => {
      expect(currentCfg.profiles.find((p) => p.id === "middle")?.priority).toBe(-5);
      expect(listedIds()[0]).toBe("sockscap-profile-item-middle");
    });

    fireEvent.click(screen.getByTestId("sockscap-profile-priority-down-middle"));
    await waitFor(() => {
      expect(listedIds().slice(0, 2)).toEqual([
        "sockscap-profile-item-default",
        "sockscap-profile-item-middle",
      ]);
    });
  });

  it("offers only SSH and Proxy sessions as upstream sources", async () => {
    const mkSession = (
      id: string,
      name: string,
      session_type: string,
    ): SessionConfig => ({
      id,
      name,
      session_type,
      group_path: null,
      host: `${id}.example.com`,
      port: 1080,
      username: null,
      auth_method: "Password" as SessionConfig["auth_method"],
      options_json: "",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    });
    vi.mocked(listSessions).mockResolvedValueOnce([
      mkSession("s1", "Bastion SSH", "SSH"),
      mkSession("p1", "Office Proxy", "Proxy"),
      mkSession("l1", "Local Shell", "LocalShell"),
      mkSession("f1", "Local Folder", "File"),
      mkSession("d1", "Prod DB", "MySQL"),
      mkSession("r1", "Desktop", "RDP"),
    ]);

    render(<SocksCapPanel />);
    const trigger = await screen.findByTestId("sockscap-upstream-source");
    fireEvent.click(trigger);

    const menu = await screen.findByTestId("sockscap-upstream-source-menu");
    // The default upstream kind is socks5 → proxy mode, so proxy sessions show.
    expect(within(menu).getByText("Office Proxy")).toBeInTheDocument();
    // Non-proxy / non-SSH sessions must never appear.
    expect(within(menu).queryByText("Local Shell")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Local Folder")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Prod DB")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Desktop")).not.toBeInTheDocument();
    // SSH sessions are excluded from proxy mode too (only surface in ssh mode).
    expect(within(menu).queryByText("Bastion SSH")).not.toBeInTheDocument();
  });

  it("reveals core-upstream fields (share link + cipher) when selecting Shadowsocks", async () => {
    render(<SocksCapPanel />);
    fireEvent.click(await screen.findByTestId("sockscap-section-upstream-toggle"));
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

  it("imports a subscription into one profile per node, vaulting secrets", async () => {
    vi.mocked(sockscapImportSubscription).mockResolvedValue([
      {
        kindTag: "trojan",
        name: "Node A",
        host: "a.example.com",
        port: 443,
        params: { tls: "tls" },
        secret: "pwA",
        uuid: "",
      },
      {
        kindTag: "vless",
        name: "Node B",
        host: "b.example.com",
        port: 443,
        params: { flow: "xtls-rprx-vision" },
        secret: "",
        uuid: "uuid-b",
      },
    ]);

    render(<SocksCapPanel />);
    await waitFor(() => expect(screen.getByTestId("sockscap-panel")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("sockscap-sub-import-toggle"));
    const input = await screen.findByTestId("sockscap-sub-input");
    fireEvent.change(input, { target: { value: "https://sub.example.com/link" } });
    fireEvent.click(screen.getByTestId("sockscap-sub-import"));

    await waitFor(() => {
      // Two profiles added beyond the default.
      const names = currentCfg.profiles.map((p) => p.name);
      expect(names).toContain("Node A");
      expect(names).toContain("Node B");
    });
    const a = currentCfg.profiles.find((p) => p.name === "Node A")!;
    const b = currentCfg.profiles.find((p) => p.name === "Node B")!;
    expect(a.upstream.kind).toBe("trojan");
    expect(a.upstream.host).toBe("a.example.com");
    expect(a.upstream.passwordRef).toBe("vault:test-ref"); // secret vaulted
    expect(b.upstream.kind).toBe("vless");
    expect(b.upstream.params?.uuidRef).toBe("vault:test-ref"); // uuid vaulted
    expect(b.upstream.params?.flow).toBe("xtls-rprx-vision");
    // Imported profiles are not auto-activated.
    expect(currentCfg.activeProfileIds).not.toContain(a.id);
  });

  it("locks every profile and routing-rule mutation while running", async () => {
    // Report the engine as Active so the panel enters the locked state.
    vi.mocked(sockscapStatus).mockResolvedValue({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    });
    render(<SocksCapPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("sockscap-locked-banner")).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId("sockscap-header")).getByTestId("sockscap-locked-banner")).toBeInTheDocument();
    // Capture topology and profile controls are disabled.
    expect(screen.getByTestId("sockscap-upstream-kind")).toBeDisabled();
    expect(screen.getByTestId("sockscap-mode-global")).toBeDisabled();
    expect(screen.getByTestId("sockscap-upstream-source")).toBeDisabled();
    expect(screen.getByTestId("sockscap-profile-checkbox-default")).toBeDisabled();
    expect(screen.getByTestId("sockscap-profile-priority-input-default")).toBeDisabled();
    expect(screen.getByTestId("sockscap-add-profile")).toBeDisabled();

    // Policy and shared routing-rule mutations are disabled as well.
    fireEvent.click(screen.getByTestId("sockscap-section-rules-toggle"));
    expect(await screen.findByTestId("sockscap-rules-editor")).toBeDisabled();
    fireEvent.click(screen.getByTestId("sockscap-section-gfwlist-toggle"));
    expect(await screen.findByTestId("sockscap-refresh-gfw")).toBeDisabled();
    expect(screen.getByTestId("sockscap-import-gfw")).toBeDisabled();
    expect(screen.getByTestId("sockscap-block-quic")).toBeDisabled();
  });

  it("shows a copyable detail modal after testing the upstream", async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeMock } });
    render(<SocksCapPanel />);

    // Shadowsocks routes the test through the mocked core-upstream tester.
    const kindSelect = await screen.findByTestId("sockscap-upstream-kind");
    fireEvent.change(kindSelect, { target: { value: "shadowsocks" } });

    fireEvent.click(await screen.findByTestId("sockscap-test-upstream"));

    const body = await screen.findByTestId("sockscap-test-detail-body");
    expect(body).toHaveTextContent("ok");

    fireEvent.click(screen.getByTestId("sockscap-test-detail-copy"));
    await waitFor(() => expect(writeMock).toHaveBeenCalledWith("ok"));
  });

  it("shows the no-proxy help block when no local proxy is detected", async () => {
    render(<SocksCapPanel />);
    // Default upstream is socks5 with no detected proxies and no session.
    expect(await screen.findByTestId("sockscap-noproxy-help")).toBeInTheDocument();
  });

  it("uses launch-only mode without asking for sudo when transparent Linux capture is unavailable", async () => {
    currentPlatform = "linux";
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-rootless-mode")).toHaveTextContent(
      "Application capture without administrator access",
    );
    expect(screen.getByTestId("sockscap-launch-only-banner")).toHaveTextContent(
      "No-permission application capture",
    );
    expect(screen.queryByTestId("sockscap-start")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-profile-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("sockscap-pick-linux-application")).toHaveTextContent("Browse");
    expect(screen.getByTestId("sockscap-rootless-command")).toBeVisible();
    expect(screen.getByTestId("sockscap-rootless-arguments")).toBeVisible();
    expect(screen.getByTestId("sockscap-rootless-launch-mode")).toHaveValue("desktop");
    expect(screen.queryByTestId("sockscap-rootless-profile-current")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-rootless-profile")).not.toBeInTheDocument();
    expect(screen.getByTestId("sockscap-section-upstream-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("sockscap-section-rules-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("sockscap-section-gfwlist-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("sockscap-upstream-kind")).toBeVisible();
    expect(screen.getByTestId("sockscap-rules-editor")).toBeVisible();
    expect(screen.getByTestId("sockscap-refresh-gfw")).toBeVisible();

    fireEvent.change(screen.getByTestId("sockscap-upstream-kind"), {
      target: { value: "http" },
    });
    await waitFor(() => expect(currentCfg.profiles[0].upstream.kind).toBe("http"));
    fireEvent.change(
      within(screen.getByTestId("sockscap-rules-editor")).getByDisplayValue("GFWList"),
      { target: { value: "proxyAll" } },
    );
    await waitFor(() => expect(currentCfg.profiles[0].ruleMode).toBe("proxyAll"));

    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sockscap-root-prompt-dialog")).not.toBeInTheDocument();
  });

  it("launches and stops a configured Linux application from the launch-only UI", async () => {
    currentPlatform = "linux";
    currentCfg.profiles[0].apps = [
      { path: "/usr/bin/example-app", name: "Example App" },
    ];
    currentCfg.apps = currentCfg.profiles[0].apps;
    render(<SocksCapPanel />);

    const launch = await screen.findByTestId("sockscap-launch-app-0");
    expect(launch).toBeEnabled();
    expect(launch).toHaveTextContent("Start and capture");
    fireEvent.click(launch);

    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalledWith(undefined));
    await waitFor(() =>
      expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledWith(
        "default",
        "/usr/bin/example-app",
        [],
        {},
      ),
    );
    expect(await screen.findByText("Running · PID 4242")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sockscap-stop-launched-app-4242"));
    await waitFor(() =>
      expect(vi.mocked(sockscapStopLaunchedApp)).toHaveBeenCalledWith(4242),
    );
    expect(vi.mocked(sockscapStop)).toHaveBeenCalledTimes(1);
  });

  it("keeps profiles implicit in rootless mode even when legacy config contains several", async () => {
    currentPlatform = "linux";
    currentCfg.profiles.push({
      ...JSON.parse(JSON.stringify(currentCfg.profiles[0])),
      id: "alternate",
      name: "备用方案",
      priority: 1,
    });
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-rootless-mode")).toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-rootless-profile")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-rootless-profile-current")).not.toBeInTheDocument();
    expect(currentCfg.selectedProfileId).toBe("default");
  });

  it("uses the file picker to fill a rootless command without launching it", async () => {
    currentPlatform = "linux";
    dialogOpenMock.mockResolvedValue("/usr/bin/example-app");
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-pick-linux-application"));

    await waitFor(() =>
      expect(screen.getByTestId("sockscap-rootless-command")).toHaveValue(
        "/usr/bin/example-app",
      ),
    );
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
    expect(vi.mocked(sockscapLaunchApp)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));
    await waitFor(() => expect(currentCfg.profiles[0].apps).toHaveLength(1));
    expect(currentCfg.profiles[0].apps).toEqual([
      {
        path: "/usr/bin/example-app",
        args: [],
        launchMode: "desktop",
        name: "example-app",
      },
    ]);
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
  });

  it("adds a PATH command with parsed arguments before launching", async () => {
    currentPlatform = "linux";
    render(<SocksCapPanel />);

    fireEvent.change(await screen.findByTestId("sockscap-rootless-command"), {
      target: { value: "google-chrome-stable" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-arguments"), {
      target: { value: '--incognito "--user-data-dir=/tmp/chrome profile"' },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));

    await waitFor(() =>
      expect(currentCfg.profiles[0].apps).toEqual([
        {
          path: "google-chrome-stable",
          args: ["--incognito", "--user-data-dir=/tmp/chrome profile"],
          launchMode: "desktop",
          name: "google-chrome-stable",
        },
      ]),
    );
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));
    await waitFor(() =>
      expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledWith(
        "default",
        "google-chrome-stable",
        ["--incognito", "--user-data-dir=/tmp/chrome profile"],
        {},
      ),
    );
  });

  it("adds, edits, and launches a desktop application with launch preparation", async () => {
    currentPlatform = "linux";
    render(<SocksCapPanel />);

    fireEvent.change(await screen.findByTestId("sockscap-rootless-command"), {
      target: { value: "./bin/example-app" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-arguments"), {
      target: { value: '"argument with spaces"' },
    });
    fireEvent.click(screen.getByTestId("sockscap-rootless-preparation-toggle"));
    fireEvent.change(screen.getByTestId("sockscap-rootless-working-directory"), {
      target: { value: "/workspace/example" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-shell"), {
      target: { value: "bash" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-pre-command"), {
      target: { value: "export PREPARED=yes" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-environment"));
    fireEvent.change(screen.getByTestId("sockscap-rootless-environment-name-0"), {
      target: { value: "APP_ENV" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-environment-value-0"), {
      target: { value: "development" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));

    await waitFor(() =>
      expect(currentCfg.profiles[0].apps).toEqual([
        {
          path: "./bin/example-app",
          args: ["argument with spaces"],
          launchMode: "desktop",
          launchPreparation: {
            workingDirectory: "/workspace/example",
            environment: { APP_ENV: "development" },
            preCommand: "export PREPARED=yes",
            shell: "bash",
          },
          name: "example-app",
        },
      ]),
    );

    fireEvent.click(screen.getByTestId("sockscap-edit-app-0"));
    expect(screen.getByTestId("sockscap-rootless-working-directory")).toHaveValue(
      "/workspace/example",
    );
    fireEvent.change(screen.getByTestId("sockscap-rootless-working-directory"), {
      target: { value: "/workspace/updated" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));
    await waitFor(() =>
      expect(currentCfg.profiles[0].apps[0].launchPreparation?.workingDirectory).toBe(
        "/workspace/updated",
      ),
    );

    fireEvent.click(screen.getByTestId("sockscap-launch-app-0"));
    await waitFor(() =>
      expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledWith(
        "default",
        "./bin/example-app",
        ["argument with spaces"],
        {
          workingDirectory: "/workspace/updated",
          environment: { APP_ENV: "development" },
          preCommand: "export PREPARED=yes",
          shell: "bash",
        },
      ),
    );
  });

  it("opens a terminal tab for a TUI command instead of launching it without a TTY", async () => {
    currentPlatform = "linux";
    render(<SocksCapPanel />);

    fireEvent.change(await screen.findByTestId("sockscap-rootless-command"), {
      target: { value: "agy" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-launch-mode"), {
      target: { value: "terminal" },
    });
    fireEvent.click(screen.getByTestId("sockscap-rootless-preparation-toggle"));
    fireEvent.change(screen.getByTestId("sockscap-rootless-working-directory"), {
      target: { value: "/workspace/agy" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-pre-command"), {
      target: { value: "export AGL_RUN_MODE=prepared" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));

    await waitFor(() =>
      expect(currentCfg.profiles[0].apps).toEqual([
        {
          path: "agy",
          args: [],
          launchMode: "terminal",
          launchPreparation: {
            workingDirectory: "/workspace/agy",
            preCommand: "export AGL_RUN_MODE=prepared",
          },
          name: "agy",
        },
      ]),
    );
    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));

    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalledWith(undefined));
    expect(vi.mocked(sockscapLaunchApp)).not.toHaveBeenCalled();
    const terminalTab = useAppStore
      .getState()
      .tabs.find((tab) => tab.sockscapTerminal?.path === "agy");
    expect(terminalTab).toMatchObject({
      type: "terminal",
      title: "agy",
      sockscapTerminal: {
        profileId: "default",
        path: "agy",
        args: [],
        launchPreparation: {
          workingDirectory: "/workspace/agy",
          preCommand: "export AGL_RUN_MODE=prepared",
        },
      },
    });
    if (terminalTab) useAppStore.getState().removeTab(terminalTab.id);
  });

  it("starts multiple configured rootless applications independently", async () => {
    currentPlatform = "linux";
    currentCfg.profiles[0].apps = [
      { path: "first-app", args: ["--one"], name: "First" },
      { path: "second-app", args: ["--two"], name: "Second" },
    ];
    currentCfg.apps = currentCfg.profiles[0].apps;
    let pid = 5000;
    vi.mocked(sockscapLaunchApp).mockImplementation(async (profileId, path, args, launchPreparation) => ({
      pid: pid++,
      profileId,
      path,
      args: args ?? [],
      launchPreparation,
      running: true,
    }));
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));
    await waitFor(() => expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("sockscap-launch-app-1"));
    await waitFor(() => expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledTimes(2));

    expect(vi.mocked(sockscapStart)).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Running · PID 5000")).toBeInTheDocument();
    expect(screen.getByText("Running · PID 5001")).toBeInTheDocument();
  });

  it("shows a structured error when launch preparation fails", async () => {
    currentPlatform = "linux";
    currentCfg.profiles[0].apps = [
      {
        path: "example-app",
        args: [],
        launchPreparation: { preCommand: "false" },
        name: "Example",
      },
    ];
    currentCfg.apps = currentCfg.profiles[0].apps;
    vi.mocked(sockscapLaunchApp).mockResolvedValueOnce({
      pid: 5002,
      profileId: "default",
      path: "example-app",
      args: [],
      launchPreparation: { preCommand: "false" },
      phase: "failed",
      launchError: "application PID 5002 exited with status 1 before the target started",
      running: false,
    });
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));

    expect(
      await screen.findByText(/Launch failed: application PID 5002 exited with status 1/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Running · PID 5002")).not.toBeInTheDocument();
  });

  it("retries Recover with sudo without accidentally starting capture", async () => {
    currentPlatform = "linux";
    vi.mocked(sockscapRecover).mockRejectedValueOnce(
      "query nftables table failed: Operation not permitted. Linux capture requires CAP_NET_ADMIN",
    );
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-recover"));
    expect(await screen.findByTestId("sockscap-root-prompt-dialog")).toHaveTextContent(
      "Removing residual Linux nftables and cgroup state requires Root privileges",
    );

    fireEvent.change(screen.getByTestId("sockscap-root-password-input"), {
      target: { value: "sudo-secret" },
    });
    fireEvent.click(screen.getByTestId("sockscap-root-prompt-submit"));

    await waitFor(() => {
      expect(vi.mocked(sockscapRecover)).toHaveBeenNthCalledWith(1, undefined);
      expect(vi.mocked(sockscapRecover)).toHaveBeenNthCalledWith(2, "sudo-secret");
    });
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("sockscap-root-prompt-dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps the Recover sudo prompt open after authentication fails", async () => {
    currentPlatform = "linux";
    vi.mocked(sockscapRecover)
      .mockRejectedValueOnce(
        "query nftables table failed: Operation not permitted. Linux capture requires CAP_NET_ADMIN",
      )
      .mockRejectedValueOnce("sudo authentication failed: Sorry, try again");
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-recover"));
    fireEvent.change(await screen.findByTestId("sockscap-root-password-input"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByTestId("sockscap-root-prompt-submit"));

    expect(await screen.findByTestId("sockscap-root-prompt-error")).toHaveTextContent(
      "Sudo password incorrect or authentication failed",
    );
    expect(screen.getByTestId("sockscap-root-prompt-dialog")).toBeInTheDocument();
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
  });

  it("blocks start and warns when the active upstream is unconfigured", async () => {
    // Empty host → nothing to dial.
    currentCfg.profiles[0].upstream = { kind: "socks5", sessionId: "", host: "", port: 0 };

    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    expect(
      await screen.findByTestId("sockscap-config-issue-dialog"),
    ).toBeInTheDocument();
    // Never probes or starts an unconfigured upstream.
    expect(vi.mocked(sockscapTestUpstream)).not.toHaveBeenCalled();
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sockscap-config-issue-ok"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("sockscap-config-issue-dialog"),
      ).not.toBeInTheDocument(),
    );
  });

  it("probes the upstream and starts directly when it is reachable", async () => {
    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    await waitFor(() => expect(vi.mocked(sockscapTestUpstream)).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalled());
    // No prompt appears on a clean probe.
    expect(
      screen.queryByTestId("sockscap-probe-fail-dialog"),
    ).not.toBeInTheDocument();
  });

  it("offers force/cancel when the upstream probe fails", async () => {
    vi.mocked(sockscapTestUpstream).mockRejectedValue("connection refused");

    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    expect(
      await screen.findByTestId("sockscap-probe-fail-dialog"),
    ).toBeInTheDocument();
    // Probe ran, but start was withheld pending the user's decision.
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();

    // Cancel leaves capture stopped.
    fireEvent.click(screen.getByTestId("sockscap-probe-fail-cancel"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("sockscap-probe-fail-dialog"),
      ).not.toBeInTheDocument(),
    );
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
  });

  it("force-starts after a failed probe when the user confirms", async () => {
    vi.mocked(sockscapTestUpstream).mockRejectedValue("connection refused");

    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    fireEvent.click(await screen.findByTestId("sockscap-probe-fail-force"));
    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalled());
  });

  it("opens the ordered macOS setup guide when Redirector is missing", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "missing",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "Mitmproxy Redirector is not installed.",
    });

    render(<SocksCapPanel />);

    const guide = await screen.findByTestId("sockscap-macos-setup-dialog");
    expect(within(guide).getByTestId("sockscap-macos-setup-step-1")).toHaveTextContent(
      "Install Mitmproxy Redirector",
    );
    expect(within(guide).getByTestId("sockscap-macos-setup-step-2")).toHaveTextContent(
      "Start once to request system approval",
    );
    expect(within(guide).getByTestId("sockscap-macos-setup-step-3")).toHaveTextContent(
      "Privacy & Security",
    );
    expect(within(guide).getByTestId("sockscap-macos-setup-step-4")).toHaveTextContent(
      "Refresh, then start again",
    );

    fireEvent.click(within(guide).getByTestId("sockscap-macos-setup-install"));
    await waitFor(() => expect(vi.mocked(sockscapInstallRedirector)).toHaveBeenCalledOnce());
  });

  it("shows macOS approval location and refreshes a waiting Redirector", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "waitingForUser",
      message: "Mitmproxy Redirector is waiting for approval in System Settings.",
    });

    render(<SocksCapPanel />);

    const guide = await screen.findByTestId("sockscap-macos-setup-dialog");
    expect(guide).toHaveTextContent(
      "System Settings → Privacy & Security → Security → Allow",
    );
    fireEvent.click(within(guide).getByTestId("sockscap-macos-setup-refresh"));
    await waitFor(() =>
      expect(vi.mocked(sockscapRedirectorInstallStatus)).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps macOS setup help beside Start after Redirector is ready", async () => {
    currentPlatform = "macos";

    render(<SocksCapPanel />);

    await screen.findByTestId("sockscap-start");
    expect(screen.queryByTestId("sockscap-macos-setup-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sockscap-macos-setup-help"));

    const guide = await screen.findByTestId("sockscap-macos-setup-dialog");
    expect(guide).toHaveTextContent("macOS capture setup help");
    expect(guide).toHaveTextContent("System Settings → Network → VPN & Filters");
  });

  it("remembers a completed macOS setup after capture starts", async () => {
    currentPlatform = "macos";

    render(<SocksCapPanel />);
    fireEvent.click(await screen.findByTestId("sockscap-start"));

    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalled());
    expect(window.localStorage.getItem(SOCKSCAP_MACOS_SETUP_STORAGE_KEY)).toBe("complete");
  });

  it("does not request a sudo password for macOS Redirector errors", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapCapabilities).mockResolvedValueOnce({
      platform: "macos",
      globalTcp: true,
      appFilter: false,
      captureBackend: "mitmproxy-redirector",
      notes: ["Global capture is available through Mitmproxy Redirector."],
      privilegedRequired: false,
    });
    vi.mocked(sockscapStart).mockRejectedValueOnce(
      "approve the Mitmproxy Redirector System Extension and network configuration",
    );
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-start"));

    expect(
      await screen.findByText(/approve the Mitmproxy Redirector System Extension/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-root-prompt-dialog")).not.toBeInTheDocument();
    expect(vi.mocked(sockscapStart)).toHaveBeenCalledWith(undefined);
  });

  it("blocks repeated Start attempts while macOS System Extension approval is waiting", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "waitingForUser",
      message: "Mitmproxy Redirector is waiting for approval in System Settings.",
    });
    render(<SocksCapPanel />);

    const start = await screen.findByTestId("sockscap-start");
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute(
      "title",
      expect.stringContaining("Approve the Mitmproxy Redirector System Extension"),
    );
    expect(await screen.findByTestId("sockscap-redirector-action")).toHaveTextContent(
      "Refresh approval",
    );
  });

  it("keeps first Start available before Redirector has registered its approval request", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "Start SocksCap once, then approve its System Extension.",
    });
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-start")).not.toBeDisabled();
  });

  it("disables app scope and shows the backend notes when app filtering is unavailable", async () => {
    currentPlatform = "macos";
    vi.mocked(sockscapCapabilities).mockResolvedValueOnce({
      platform: "macos",
      globalTcp: true,
      appFilter: false,
      captureBackend: "mitmproxy-redirector",
      notes: ["Global capture is available. Application scope remains disabled."],
      privilegedRequired: false,
    });
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-mode-apps")).toBeDisabled();
    const capabilityNotes = await screen.findByTestId("sockscap-capability-notes");
    expect(capabilityNotes.getAttribute("title")).toContain("Application scope remains disabled");
  });

  it("keeps app scope selectable where the backend can identify applications", async () => {
    currentPlatform = "windows";
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-mode-apps")).not.toBeDisabled();
  });
});
