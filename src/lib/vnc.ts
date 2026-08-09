import { invoke } from "@tauri-apps/api/core";
import type { VncClientOptions, VncClipboardPolicy } from "../types/vnc";

export interface VncConnectResult {
  session_id: string;
  ws_port: number;
  ws_token: string;
  width: number;
  height: number;
  name: string;
}

export async function vncConnect(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
  networkSettingsJson?: string | null,
  clientOptions?: VncClientOptions,
  credentialCapability?: string | null,
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>("vnc_connect", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    networkSettingsJson: networkSettingsJson ?? null,
    clientOptionsJson: clientOptions ? JSON.stringify(clientOptions) : null,
    credentialCapability: credentialCapability ?? null,
  });
}

export async function vncCreateCredentialCapability(
  credential?: string,
): Promise<string | null> {
  return invoke<string | null>("vnc_create_credential_capability", {
    credential: credential ?? null,
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
  networkSettingsJson?: string | null,
  clientOptions?: VncClientOptions,
): Promise<string> {
  return invoke("vnc_test_connection", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    networkSettingsJson: networkSettingsJson ?? null,
    clientOptionsJson: clientOptions ? JSON.stringify(clientOptions) : null,
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
  | {
      type: "connected";
      width: number;
      height: number;
      name: string;
      security?: string;
      protocol?: string;
      encrypted?: boolean;
      view_only?: boolean;
      clipboard_policy?: VncClipboardPolicy;
    }
  | { type: "resize"; width: number; height: number; frame_id?: number }
  | { type: "disconnected"; reason: string; code?: string; retryable?: boolean }
  | { type: "bell" }
  | { type: "clipboard"; text: string }
  | {
      type: "ext_clipboard";
      text?: string;
      html?: string;
      rtf?: string;
    }
  | { type: "ext_clipboard_support"; available: boolean };

/** Parse an incoming WS text message. */
export function parseWsMessage(data: string): WsIncoming | null {
  try {
    return JSON.parse(data) as WsIncoming;
  } catch {
    return null;
  }
}

export function encodeWsAck(frameId = 0): ArrayBuffer {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0;
  view.setUint32(1, frameId >>> 0);
  return bytes.buffer;
}

export function encodeWsPing(): ArrayBuffer {
  return new Uint8Array([1]).buffer;
}

export function encodeWsKey(down: boolean, keysym: number): ArrayBuffer {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  bytes[0] = 2;
  bytes[1] = down ? 1 : 0;
  view.setUint32(2, keysym >>> 0);
  return bytes.buffer;
}

export function encodeWsPointer(x: number, y: number, buttons: number): ArrayBuffer {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  bytes[0] = 3;
  bytes[1] = buttons & 0xff;
  view.setUint16(2, x & 0xffff);
  view.setUint16(4, y & 0xffff);
  return bytes.buffer;
}

export function encodeWsResize(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  bytes[0] = 4;
  view.setUint16(1, width & 0xffff);
  view.setUint16(3, height & 0xffff);
  return bytes.buffer;
}

/** Parse a binary frame header: [x(2B), y(2B), w(2B), h(2B)] — all big-endian. */
export function parseFrameHeader(
  data: ArrayBuffer,
): { x: number; y: number; w: number; h: number; frameId: number } | null {
  if (data.byteLength < 12) return null;
  const dv = new DataView(data);
  return {
    x: dv.getUint16(0),
    y: dv.getUint16(2),
    w: dv.getUint16(4),
    h: dv.getUint16(6),
    frameId: dv.getUint32(8),
  };
}

/** Map a DOM KeyboardEvent to an RFB keysym. */
export function keyEventToKeysym(e: KeyboardEvent): number {
  const codeMap: Record<string, number> = {
    ShiftLeft: 0xffe1,
    ShiftRight: 0xffe2,
    ControlLeft: 0xffe3,
    ControlRight: 0xffe4,
    MetaLeft: 0xffeb,
    MetaRight: 0xffec,
    Numpad0: 0xffb0,
    Numpad1: 0xffb1,
    Numpad2: 0xffb2,
    Numpad3: 0xffb3,
    Numpad4: 0xffb4,
    Numpad5: 0xffb5,
    Numpad6: 0xffb6,
    Numpad7: 0xffb7,
    Numpad8: 0xffb8,
    Numpad9: 0xffb9,
    NumpadDecimal: 0xffae,
    NumpadDivide: 0xffaf,
    NumpadMultiply: 0xffaa,
    NumpadSubtract: 0xffad,
    NumpadAdd: 0xffab,
    NumpadEnter: 0xff8d,
    NumpadEqual: 0xffbd,
  };
  if (e.key === "AltGraph") return 0xfe03;
  if (e.code === "AltRight") return e.ctrlKey ? 0xfe03 : 0xffea;
  if (e.code === "AltLeft") return 0xffe9;
  if (codeMap[e.code] !== undefined) return codeMap[e.code];
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(e.key);
  if (functionKey) return 0xffbd + Number.parseInt(functionKey[1], 10);
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
    case "NumLock":
      return 0xff7f;
    case "ScrollLock":
      return 0xff14;
    case "Pause":
      return 0xff13;
    case "PrintScreen":
      return 0xff61;
    case "ContextMenu":
      return 0xff67;
    case "Clear":
      return 0xff0b;
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

/**
 * Map a Unicode code point to an RFB keysym.
 *
 * Latin-1 (≤ U+00FF) maps directly — that's also the X11 keysym range. Code
 * points above 0xFF use the X.org "Unicode keysym" extension: 0x01000000 |
 * codepoint. GNOME (vino), KDE, TigerVNC, RealVNC, and X.Org all accept it,
 * which is the only way to deliver CJK/Emoji to a server that doesn't speak
 * ExtendedClipboard (the legacy ClientCutText channel is Latin-1 and
 * physically can't carry those characters).
 */
export function codePointToKeysym(cp: number): number {
  if (cp <= 0xff) return cp;
  return 0x01000000 | cp;
}

/** Iterate Unicode code points in a string (handles surrogate pairs). */
export function* iterCodePoints(text: string): Generator<number> {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) yield cp;
  }
}
