import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRdpStore, type RdpConnectionState } from "../../stores/rdpStore";
import { DEFAULT_RDP_OPTIONS } from "../../types/rdp";
import RdpPanel from "./RdpPanel";

const CONNECTED: RdpConnectionState = {
  status: "connected",
  sessionId: "rdp-session",
  wsPort: 41000,
  width: 1920,
  height: 1080,
  protocol: "TLS",
  serverName: "windows-host",
  error: null,
  stage: null,
};

describe("RdpPanel pointer rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRdpStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function renderPanel() {
    return render(
      <RdpPanel
        tabId="rdp-tab"
        host="windows.example.test"
        port={3389}
        options={DEFAULT_RDP_OPTIONS}
        visible
      />,
    );
  }

  it("uses a local WebView cursor so pointer movement is not gated by remote frames", () => {
    useRdpStore.setState({ connections: { "rdp-tab": CONNECTED } });

    renderPanel();

    expect(screen.getByTestId("rdp-canvas")).toHaveStyle({ cursor: "default" });
  });

  it("keeps a local cursor while the RDP desktop is disconnected", () => {
    renderPanel();

    expect(screen.getByTestId("rdp-canvas")).toHaveStyle({ cursor: "default" });
  });
});
