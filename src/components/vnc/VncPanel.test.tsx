import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VncPanel from "./VncPanel";
import { useVncStore } from "../../stores/vncStore";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  readText: vi.fn(),
  readMultiFormat: vi.fn(),
  writeText: vi.fn(),
  writeMultiFormat: vi.fn(),
  setCaptureSource: vi.fn(),
  clearCaptureSource: vi.fn(),
}));

vi.mock("../../lib/vnc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/vnc")>()),
  vncConnect: mocks.connect,
  vncDisconnect: mocks.disconnect,
}));

vi.mock("../../lib/clipboard", () => ({
  readText: mocks.readText,
  readMultiFormat: mocks.readMultiFormat,
  writeText: mocks.writeText,
  writeMultiFormat: mocks.writeMultiFormat,
}));

vi.mock("../../stores/captureStore", () => ({
  useCaptureStore: {
    getState: () => ({
      setSource: mocks.setCaptureSource,
      clearSource: mocks.clearCaptureSource,
    }),
  },
}));

vi.mock("../../stores/appStore", () => ({
  useAppStore: {
    getState: () => ({ setStatusMessage: vi.fn() }),
  },
}));

vi.mock("../tabbar/TabActionSlot", () => ({
  TabActions: ({ active, children }: { active: boolean; children: React.ReactNode }) =>
    active ? children : null,
}));

vi.mock("../capture/CaptureMenuButton", () => ({ CaptureMenuButton: () => null }));

class RelayWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: RelayWebSocket[] = [];

  readyState = RelayWebSocket.OPEN;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = RelayWebSocket.CLOSED;
  });

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    RelayWebSocket.instances.push(this);
  }
}

function keyMessages(socket: RelayWebSocket): Array<{ down: boolean; keysym: number }> {
  const messages: Array<{ down: boolean; keysym: number }> = [];
  for (const [value] of socket.send.mock.calls as Array<[unknown]>) {
    if (!(value instanceof ArrayBuffer) || value.byteLength !== 6) continue;
    const view = new DataView(value);
    if (view.getUint8(0) !== 2) continue;
    messages.push({ down: view.getUint8(1) !== 0, keysym: view.getUint32(2) });
  }
  return messages;
}

async function renderConnected(): Promise<{
  socket: RelayWebSocket;
  unmount: () => void;
}> {
  const view = render(
    <VncPanel tabId="vnc-test" host="mac.example.test" port={5900} visible />,
  );
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  const socket = RelayWebSocket.instances[0];
  expect(socket).toBeDefined();
  act(() => {
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "connected",
          width: 1920,
          height: 1080,
          name: "fixture",
          protocol_version: "RFB 3.8",
          security_type: "VeNCrypt/X509Vnc",
          encrypted: true,
          identity_verified: true,
          view_only: false,
          clipboard_policy: "bidirectional",
        }),
      }),
    );
  });
  await waitFor(() => {
    expect(useVncStore.getState().connections["vnc-test"]?.status).toBe("connected");
  });
  return { socket, unmount: view.unmount };
}

beforeEach(() => {
  RelayWebSocket.instances = [];
  vi.stubGlobal("WebSocket", RelayWebSocket);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  mocks.connect.mockResolvedValue({
    session_id: "session-1",
    ws_port: 41001,
    ws_token: "one-time-token",
    width: 1920,
    height: 1080,
    name: "fixture",
  });
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.readText.mockResolvedValue("");
  mocks.readMultiFormat.mockResolvedValue({ text: "clipboard" });
  mocks.writeText.mockResolvedValue(undefined);
  mocks.writeMultiFormat.mockResolvedValue(undefined);
  useVncStore.setState({ connections: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("VncPanel macOS input lifecycle", () => {
  it("focuses the IME sink and sends committed Unicode as balanced key events", async () => {
    const { socket } = await renderConnected();
    const canvas = screen.getByTestId("vnc-canvas");
    const input = screen.getByLabelText("VNC remote input");

    fireEvent.pointerDown(canvas, { clientX: 200, clientY: 100, pointerId: 1 });
    expect(input).toHaveFocus();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Process", isComposing: true });
    fireEvent.compositionEnd(input, { data: "界" });

    expect(keyMessages(socket)).toEqual([
      { down: true, keysym: 0x0100754c },
      { down: false, keysym: 0x0100754c },
    ]);
  });

  it("preserves right Command and clears its physical state after delayed paste", async () => {
    const { socket } = await renderConnected();
    const input = screen.getByLabelText("VNC remote input");
    input.focus();

    fireEvent.keyDown(input, { key: "Meta", code: "MetaRight", location: 2, metaKey: true });
    fireEvent.keyDown(input, { key: "v", code: "KeyV", metaKey: true });
    fireEvent.keyUp(input, { key: "Meta", code: "MetaRight", location: 2 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });
    fireEvent.keyDown(input, { key: "Meta", code: "MetaRight", location: 2, metaKey: true });

    const messages = keyMessages(socket);
    expect(messages.filter((message) => message.keysym === 0xffec && message.down)).toHaveLength(3);
    expect(messages.some((message) => message.keysym === 0xffeb)).toBe(false);
  });

  it("releases pressed keys before closing the relay on unmount", async () => {
    const { socket, unmount } = await renderConnected();
    const input = screen.getByLabelText("VNC remote input");
    input.focus();
    fireEvent.keyDown(input, { key: "Meta", code: "MetaRight", location: 2, metaKey: true });

    unmount();

    expect(keyMessages(socket).slice(-1)).toEqual([{ down: false, keysym: 0xffec }]);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
