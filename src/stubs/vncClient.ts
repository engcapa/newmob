// @ts-nocheck
/**
 * Browser-preview stub for the VNC WebSocket relay.
 * Returns a mock WS port and starts an inline MockWebSocket that
 * pushes synthetic frames so the VNC canvas renders in dev mode.
 */

let mockInterval: ReturnType<typeof setInterval> | null = null;
let mockWsPort = 0;

function generateSolidFrame(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): ArrayBuffer {
  const frame = new Uint8Array(12 + width * height * 4);
  const dv = new DataView(frame.buffer);
  dv.setUint16(0, 0); // x
  dv.setUint16(2, 0); // y
  dv.setUint16(4, width); // w
  dv.setUint16(6, height); // h
  for (let i = 12; i < frame.length; i += 4) {
    frame[i] = r;
    frame[i + 1] = g;
    frame[i + 2] = b;
    frame[i + 3] = 255;
  }
  return frame.buffer;
}

function sendMockMessage(ws: EventTarget, data: ArrayBuffer | string) {
  ws.dispatchEvent(
    new MessageEvent("message", {
      data,
    }),
  );
}

let wsPatchApplied = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startVncMockWs(_host: string, _port: number): number {
  mockWsPort = 19999;

  if (!wsPatchApplied) {
    wsPatchApplied = true;
    const OriginalWebSocket = window.WebSocket;

    // We intentionally use a loose `any` type for the mock class because
    // perfectly matching the native WebSocket interface in TypeScript
    // triggers strict literal-type mismatches (e.g. CONNECTING = 0 vs
    // number) that do not affect runtime behaviour.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MockWebSocket: any = class VncMockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      url: string;
      protocol = "";
      extensions = "";
      readyState = 0;
      bufferedAmount = 0;
      binaryType: BinaryType = "arraybuffer";
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;

      constructor(url: string | URL, _protocols?: string | string[]) {
        super();
        this.url = url.toString();

        setTimeout(() => {
          if (this.url.includes(`127.0.0.1:${mockWsPort}`)) {
            this.readyState = 1;
            const openEv = new Event("open");
            this.dispatchEvent(openEv);
            if (this.onopen) this.onopen(openEv);

            sendMockMessage(
              this,
              JSON.stringify({
                type: "connected",
                width: 800,
                height: 600,
                name: "VNC Stub",
              }),
            );
            sendMockMessage(
              this,
              JSON.stringify({
                type: "info",
                message: "Server using Raw encoding (stub mode)",
              }),
            );

            let frameCount = 0;
            mockInterval = setInterval(() => {
              frameCount++;
              const r = 30 + (frameCount % 3) * 40;
              const g = 30 + ((frameCount + 1) % 3) * 40;
              const b = 30 + ((frameCount + 2) % 3) * 40;
              const buf = generateSolidFrame(800, 600, r, g, b);
              sendMockMessage(this, buf);
            }, 200);
          } else {
            const realWs = new OriginalWebSocket(this.url);
            realWs.addEventListener("open", (e: Event) => {
              this.dispatchEvent(e);
              if (this.onopen) this.onopen(e);
            });
            realWs.addEventListener("message", (e: MessageEvent) => {
              this.dispatchEvent(e);
              if (this.onmessage) this.onmessage(e);
            });
            realWs.addEventListener("close", (e: CloseEvent) => {
              this.dispatchEvent(e);
              if (this.onclose) this.onclose(e);
            });
            realWs.addEventListener("error", (e: Event) => {
              this.dispatchEvent(e);
              if (this.onerror) this.onerror(e);
            });
            this.readyState = realWs.readyState;
          }
        }, 100);
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      send(_data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        // no-op for stub
      }

      close() {
        this.readyState = 3;
        if (mockInterval) {
          clearInterval(mockInterval);
          mockInterval = null;
        }
        const ev = new CloseEvent("close");
        this.dispatchEvent(ev);
        if (this.onclose) this.onclose(ev);
      }
    };

    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      MockWebSocket;
  }

  return mockWsPort;
}

export function stopVncMockWs() {
  if (mockInterval) {
    clearInterval(mockInterval);
    mockInterval = null;
  }
}
