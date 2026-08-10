import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { useVncStore, type VncConnectionState } from "../../stores/vncStore";
import VncPanel from "./VncPanel";

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor() {
    MockWebSocket.instances.push(this);
  }

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
}

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
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "vnc_connect") {
        return Promise.resolve({
          session_id: "vnc-session",
          ws_port: 41000,
          ws_token: "relay-token",
          width: 1920,
          height: 1080,
          name: "windows-host",
        });
      }
      return Promise.resolve();
    });
    useVncStore.setState({ connections: {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mocks.invoke.mockReset();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("hides the local cursor until the server confirms client-side cursor support", () => {
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

  it("uses a local cursor after PointerPos while preserving a later cursor shape", async () => {
    render(
      <VncPanel
        tabId="vnc-tab"
        host="windows.example.test"
        port={5900}
        visible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket.onmessage?.({
        data: '{"type":"connected","width":1920,"height":1080,"name":"fixture","protocol":"3.8","security":"VNCAuth","encrypted":false}',
      } as MessageEvent);
      socket.onmessage?.({ data: '{"type":"pointer_pos","x":100,"y":200}' } as MessageEvent);
    });
    expect(screen.getByTestId("vnc-canvas")).toHaveStyle({ cursor: "default" });

    act(() => {
      socket.onmessage?.({
        data: '{"type":"cursor","visible":true,"hotspot_x":0,"hotspot_y":0,"width":1,"height":1,"png_base64":"iVBORw0KGgo="}',
      } as MessageEvent);
      socket.onmessage?.({ data: '{"type":"pointer_pos","x":101,"y":201}' } as MessageEvent);
    });
    expect(screen.getByTestId("vnc-canvas").style.cursor).toContain("data:image/png;base64,iVBORw0KGgo=");
  });
});
