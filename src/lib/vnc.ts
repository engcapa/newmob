import { invoke } from "@tauri-apps/api/core";

export interface VncConnectResult {
  session_id: string;
  ws_port: number;
  width: number;
  height: number;
  name: string;
}

export async function vncConnect(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>("vnc_connect", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
  });
}

export async function vncDisconnect(sessionId: string): Promise<void> {
  return invoke("vnc_disconnect", { sessionId });
}

export async function vncTestConnection(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
): Promise<string> {
  return invoke("vnc_test_connection", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
  });
}

/** WebSocket message types sent to the VNC relay. */
export type WsOutgoing =
  | { type: "ack" }
  | { type: "ping" }
  | { type: "key"; down: boolean; keysym: number }
  | { type: "pointer"; x: number; y: number; buttons: number }
  | { type: "clipboard"; text: string }
  | {
      type: "ext_clipboard";
      text?: string;
      html?: string;
      rtf?: string;
    }
  | { type: "resize"; width: number; height: number };

/** WebSocket message types received from the VNC relay. */
export type WsIncoming =
  | { type: "connected"; width: number; height: number; name: string }
  | { type: "disconnected"; reason: string }
  | { type: "bell" }
  | { type: "clipboard"; text: string }
  | {
      type: "ext_clipboard";
      text?: string;
      html?: string;
      rtf?: string;
    };

/** Parse an incoming WS text message. */
export function parseWsMessage(data: string): WsIncoming | null {
  try {
    return JSON.parse(data) as WsIncoming;
  } catch {
    return null;
  }
}

/** Parse a binary frame header: [x(2B), y(2B), w(2B), h(2B)] — all big-endian. */
export function parseFrameHeader(
  data: ArrayBuffer,
): { x: number; y: number; w: number; h: number } | null {
  if (data.byteLength < 12) return null;
  const dv = new DataView(data);
  return {
    x: dv.getUint16(0),
    y: dv.getUint16(2),
    w: dv.getUint16(4),
    h: dv.getUint16(6),
  };
}

/** Map a DOM KeyboardEvent to an RFB keysym. */
export function keyEventToKeysym(e: KeyboardEvent): number {
  // Printable characters
  if (e.key.length === 1) {
    return e.key.charCodeAt(0);
  }
  // Named keys
  switch (e.key) {
    case "Backspace":
      return 0xff08;
    case "Tab":
      return 0xff09;
    case "Enter":
      return 0xff0d;
    case "Escape":
      return 0xff1b;
    case "Insert":
      return 0xff63;
    case "Delete":
      return 0xffff;
    case "Home":
      return 0xff50;
    case "End":
      return 0xff57;
    case "PageUp":
      return 0xff55;
    case "PageDown":
      return 0xff56;
    case "ArrowLeft":
      return 0xff51;
    case "ArrowUp":
      return 0xff52;
    case "ArrowRight":
      return 0xff53;
    case "ArrowDown":
      return 0xff54;
    case "Shift":
      return 0xffe1;
    case "Control":
      return 0xffe3;
    case "Alt":
      return 0xffe9;
    case "Meta":
      return 0xffeb;
    case "CapsLock":
      return 0xffe5;
    case "F1":
      return 0xffbe;
    case "F2":
      return 0xffbf;
    case "F3":
      return 0xffc0;
    case "F4":
      return 0xffc1;
    case "F5":
      return 0xffc2;
    case "F6":
      return 0xffc3;
    case "F7":
      return 0xffc4;
    case "F8":
      return 0xffc5;
    case "F9":
      return 0xffc6;
    case "F10":
      return 0xffc7;
    case "F11":
      return 0xffc8;
    case "F12":
      return 0xffc9;
    default:
      return 0;
  }
}

/** Map mouse buttons to RFB button mask. */
export function mouseButtonMask(e: MouseEvent | PointerEvent): number {
  let mask = 0;
  if (e.buttons & 1) mask |= 1; // left
  if (e.buttons & 2) mask |= 4; // right
  if (e.buttons & 4) mask |= 2; // middle
  return mask;
}
