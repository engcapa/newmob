import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVncStore, type VncConnectionState } from "../../stores/vncStore";
import VncPanel from "./VncPanel";

const CONNECTED: VncConnectionState = {
  status: "connected",
  sessionId: "vnc-session",
  wsPort: 41000,
  width: 1920,
  height: 1080,
  name: "windows-host",
  protocol: "RFB 3.8",
  security: "VNC Authentication",
  encrypted: false,
  error: null,
};

describe("VncPanel pointer rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useVncStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("hides the local WebView cursor over a connected remote desktop", () => {
    useVncStore.setState({ connections: { "vnc-tab": CONNECTED } });

    render(
      <VncPanel
        tabId="vnc-tab"
        host="windows.example.test"
        port={5900}
        visible
      />,
    );

    expect(screen.getByTestId("vnc-canvas")).toHaveStyle({ cursor: "none" });
  });
});
