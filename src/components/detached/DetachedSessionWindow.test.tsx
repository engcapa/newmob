import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeDetachedHandoff } from "../../lib/detachedSession";
import type { VncDetachClaim } from "../../lib/vnc";
import DetachedSessionWindow, { type DetachedVncParams } from "./DetachedSessionWindow";

const vncMocks = vi.hoisted(() => ({
  consumeDetachClaim: vi.fn(),
  createDetachClaim: vi.fn(),
}));

vi.mock("../../lib/vnc", () => ({
  vncConsumeDetachClaim: vncMocks.consumeDetachClaim,
  vncCreateDetachClaim: vncMocks.createDetachClaim,
  redactVncHandoff: (params: unknown) => params,
}));

vi.mock("../../lib/i18n", () => ({
  useT: () => (key: string) => key,
  t: (key: string) => key,
}));

vi.mock("../../lib/appTheme", () => ({
  useAppTheme: () => ({ mode: "dark", resolvedTheme: "dark" }),
}));

vi.mock("../../lib/runtime", () => ({
  isTauriRuntime: () => false,
}));

const appState = {
  uiFontFamily: "Inter",
  uiFontSize: 13,
  addTab: vi.fn(),
  setActiveTab: vi.fn(),
  tabs: [],
};

vi.mock("../../stores/appStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof appState) => unknown) => selector(appState),
    { getState: () => appState },
  ),
}));

vi.mock("../../stores/aiStore", () => ({
  useAiStore: (selector: (state: { config: { fully_disabled: boolean } }) => unknown) =>
    selector({ config: { fully_disabled: true } }),
}));

const chatState = {
  drawerOpen: false,
  drawerPosition: "right",
  drawerPinned: false,
};

vi.mock("../../stores/chatStore", () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock("../terminal/TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("../chat/ChatDrawer", () => ({ ChatDrawer: () => null }));
vi.mock("../tao/TaoRibbon", () => ({ TaoRibbon: () => null }));
vi.mock("../agent/CcAgentBridge", () => ({ CcAgentBridge: () => null }));
vi.mock("../vnc/VncPanel", () => ({
  default: ({ host, port }: { host: string; port: number }) => (
    <div data-vnc-panel-stub data-host={host} data-port={port} />
  ),
}));

const DETACHED_ID = "vnc-tab__detached";

function seedVncHandoff(): void {
  writeDetachedHandoff<DetachedVncParams>("vnc", DETACHED_ID, {
    tabId: "vnc-tab",
    sessionId: "saved-session",
    host: "",
    port: 0,
    claimId: "claim-1",
    title: "VNC fixture",
  });
}

beforeEach(() => {
  localStorage.clear();
  vncMocks.consumeDetachClaim.mockReset();
  vncMocks.createDetachClaim.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("DetachedSessionWindow VNC handoff", () => {
  it("reuses the one-time claim request when StrictMode replays effects", async () => {
    let resolveClaim: ((claim: VncDetachClaim) => void) | undefined;
    vncMocks.consumeDetachClaim.mockImplementation(
      () => new Promise<VncDetachClaim>((resolve) => {
        resolveClaim = resolve;
      }),
    );
    seedVncHandoff();

    render(
      <StrictMode>
        <DetachedSessionWindow kind="vnc" id={DETACHED_ID} />
      </StrictMode>,
    );

    await waitFor(() => expect(vncMocks.consumeDetachClaim).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveClaim?.({
        host: "vnc.internal",
        port: 5900,
        username: "alice",
        password: "secret",
        network_settings_json: null,
        security_policy: "prefer-encryption",
        view_only: false,
        clipboard_policy: "bidirectional",
      });
    });

    await waitFor(() => {
      expect(document.querySelector("[data-vnc-panel-stub]")).toHaveAttribute(
        "data-host",
        "vnc.internal",
      );
    });
    const panel = document.querySelector("[data-vnc-panel-stub]");
    expect(panel).toHaveAttribute("data-port", "5900");
  });

  it("shows a handoff error instead of loading forever when claim consumption fails", async () => {
    vncMocks.consumeDetachClaim.mockRejectedValue(new Error("claim expired"));
    seedVncHandoff();

    render(<DetachedSessionWindow kind="vnc" id={DETACHED_ID} />);

    expect(await screen.findByText("fileBrowser.detachedTimedOutTitle")).toBeInTheDocument();
    expect(screen.queryByText("vnc.loading")).not.toBeInTheDocument();
  });
});
