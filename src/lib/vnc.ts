import { invoke } from "@tauri-apps/api/core";
import type { NetworkSettingsPayload } from "./networkSettings";
import type { VncClipboardPolicy, VncOptions } from "../types/vnc";

export interface VncConnectResult {
  session_id: string;
  ws_port: number;
  ws_token: string;
  width: number;
  height: number;
  name: string;
}

export interface VncError {
  code: string;
  stage: string;
  retryable: boolean;
  sanitizedMessage: string;
}

export interface VncDiagnostics {
  correlationId: string;
  state: string;
  protocolVersion: string;
  securityType: string;
  encrypted: boolean;
  identityVerified: boolean;
  width: number;
  height: number;
  framesReceived: number;
  rectanglesReceived: number;
  framesRendered: number;
  framesDropped: number;
  bytesToWebview: number;
  lastError?: VncError | null;
}

export async function vncConnect(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: VncOptions,
  networkSettings: NetworkSettingsPayload | null = null,
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>("vnc_connect", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    optionsJson: JSON.stringify(options),
    networkSettingsJson: networkSettings ? JSON.stringify(networkSettings) : null,
  });
}

export async function vncDisconnect(sessionId: string): Promise<void> {
  return invoke("vnc_disconnect", { sessionId });
}

export async function vncTestConnection(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: VncOptions,
  networkSettings: NetworkSettingsPayload | null = null,
): Promise<string> {
  return invoke("vnc_test_connection", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    optionsJson: JSON.stringify(options),
    networkSettingsJson: networkSettings ? JSON.stringify(networkSettings) : null,
  });
}

export async function vncGetDiagnostics(sessionId: string): Promise<VncDiagnostics> {
  return invoke<VncDiagnostics>("vnc_get_diagnostics", { sessionId });
}

export type WsOutgoing =
  | { type: "ack" }
  | { type: "ping" }
  | { type: "key"; down: boolean; keysym: number }
  | { type: "pointer"; x: number; y: number; buttons: number }
  | { type: "clipboard"; text: string }
  | { type: "ext_clipboard"; text?: string; html?: string; rtf?: string };

export type WsIncoming =
  | {
      type: "connected";
      width: number;
      height: number;
      name: string;
      protocol_version: string;
      security_type: string;
      encrypted: boolean;
      identity_verified: boolean;
      view_only: boolean;
      clipboard_policy: VncClipboardPolicy;
    }
  | {
      type: "disconnected";
      code: string;
      stage: string;
      retryable: boolean;
      sanitizedMessage: string;
      reason?: string;
    }
  | { type: "bell" }
  | { type: "clipboard"; text: string }
  | { type: "ext_clipboard"; text?: string; html?: string; rtf?: string }
  | { type: "ext_clipboard_support"; available: boolean };

export interface VncFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface VncFrameBatch {
  frameId: number;
  width: number;
  height: number;
  rects: VncFrameRect[];
}

const FRAME_HEADER_BYTES = 22;
const RECT_HEADER_BYTES = 12;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_RECTANGLES = 4096;

export function parseWsMessage(data: string): WsIncoming | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      return null;
    }
    return parsed as WsIncoming;
  } catch {
    return null;
  }
}

export function parseFrameBatch(data: ArrayBuffer): VncFrameBatch | null {
  if (data.byteLength < FRAME_HEADER_BYTES || data.byteLength > MAX_FRAME_BYTES) return null;
  const view = new DataView(data);
  if (
    view.getUint8(0) !== 0x54 ||
    view.getUint8(1) !== 0x56 ||
    view.getUint8(2) !== 0x4e ||
    view.getUint8(3) !== 0x43 ||
    view.getUint8(4) !== 1 ||
    view.getUint8(5) !== 1
  ) {
    return null;
  }
  const frameIdBig = view.getBigUint64(8);
  if (frameIdBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const width = view.getUint16(16);
  const height = view.getUint16(18);
  const rectangleCount = view.getUint16(20);
  if (width === 0 || height === 0 || rectangleCount > MAX_RECTANGLES) return null;

  let offset = FRAME_HEADER_BYTES;
  const rects: VncFrameRect[] = [];
  for (let index = 0; index < rectangleCount; index += 1) {
    if (offset + RECT_HEADER_BYTES > data.byteLength) return null;
    const x = view.getUint16(offset);
    const y = view.getUint16(offset + 2);
    const w = view.getUint16(offset + 4);
    const h = view.getUint16(offset + 6);
    const payloadLength = view.getUint32(offset + 8);
    offset += RECT_HEADER_BYTES;
    const expectedLength = w * h * 4;
    if (
      w === 0 ||
      h === 0 ||
      x + w > width ||
      y + h > height ||
      payloadLength !== expectedLength ||
      offset + payloadLength > data.byteLength
    ) {
      return null;
    }
    rects.push({
      x,
      y,
      w,
      h,
      rgba: new Uint8ClampedArray(data, offset, payloadLength),
    });
    offset += payloadLength;
  }
  if (offset !== data.byteLength) return null;
  return { frameId: Number(frameIdBig), width, height, rects };
}

export function encodeWsAck(frameId = 0): ArrayBuffer {
  const bytes = new Uint8Array(9);
  bytes[0] = 0;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(Math.max(0, Math.floor(frameId))));
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

export function keyEventToKeysym(event: KeyboardEvent): number {
  if (event.key.length === 1) {
    return codePointToKeysym(event.key.codePointAt(0) ?? 0);
  }
  if (event.key.startsWith("F") && /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key)) {
    return 0xffbd + Number(event.key.slice(1));
  }
  const right = event.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT;
  const keypad = event.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD;
  switch (event.key) {
    case "Backspace": return 0xff08;
    case "Tab": return 0xff09;
    case "Enter": return keypad ? 0xff8d : 0xff0d;
    case "Escape": return 0xff1b;
    case "Insert": return 0xff63;
    case "Delete": return 0xffff;
    case "Home": return 0xff50;
    case "End": return 0xff57;
    case "PageUp": return 0xff55;
    case "PageDown": return 0xff56;
    case "ArrowLeft": return 0xff51;
    case "ArrowUp": return 0xff52;
    case "ArrowRight": return 0xff53;
    case "ArrowDown": return 0xff54;
    case "Shift": return right ? 0xffe2 : 0xffe1;
    case "Control": return right ? 0xffe4 : 0xffe3;
    case "Alt": return right ? 0xffea : 0xffe9;
    case "Meta": return right ? 0xffec : 0xffeb;
    case "CapsLock": return 0xffe5;
    case "NumLock": return 0xff7f;
    case "ScrollLock": return 0xff14;
    case "Pause": return 0xff13;
    case "PrintScreen": return 0xff61;
    case "Clear": return 0xff0b;
    default: return 0;
  }
}

export function mouseButtonMask(event: MouseEvent | PointerEvent): number {
  let mask = 0;
  if (event.buttons & 1) mask |= 1;
  if (event.buttons & 2) mask |= 4;
  if (event.buttons & 4) mask |= 2;
  return mask;
}

const MODIFIER_KEYSYM_GROUPS = [
  { flag: "shiftKey", left: 0xffe1, right: 0xffe2 },
  { flag: "ctrlKey", left: 0xffe3, right: 0xffe4 },
  { flag: "altKey", left: 0xffe9, right: 0xffea },
  { flag: "metaKey", left: 0xffeb, right: 0xffec },
] as const;

export function pasteModifierKeysyms(
  event: KeyboardEvent,
  pressedKeysyms: ReadonlySet<number>,
): Set<number> {
  const modifiers = new Set<number>();
  for (const group of MODIFIER_KEYSYM_GROUPS) {
    if (!event[group.flag]) continue;
    let foundExactSide = false;
    for (const keysym of [group.left, group.right]) {
      if (pressedKeysyms.has(keysym)) {
        modifiers.add(keysym);
        foundExactSide = true;
      }
    }
    if (!foundExactSide) modifiers.add(group.left);
  }
  return modifiers;
}

export function clientPointToFramebuffer(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  framebufferWidth: number,
  framebufferHeight: number,
  scaleMode: "fit" | "one",
): { x: number; y: number } {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(framebufferWidth) ||
    !Number.isFinite(framebufferHeight) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    framebufferWidth <= 0 ||
    framebufferHeight <= 0
  ) {
    return { x: 0, y: 0 };
  }

  let contentLeft = bounds.left;
  let contentTop = bounds.top;
  let contentWidth = bounds.width;
  let contentHeight = bounds.height;
  if (scaleMode === "fit") {
    const framebufferAspect = framebufferWidth / framebufferHeight;
    const boundsAspect = bounds.width / bounds.height;
    if (boundsAspect > framebufferAspect) {
      contentWidth = bounds.height * framebufferAspect;
      contentLeft += (bounds.width - contentWidth) / 2;
    } else {
      contentHeight = bounds.width / framebufferAspect;
      contentTop += (bounds.height - contentHeight) / 2;
    }
  }

  const x = Math.round((clientX - contentLeft) * (framebufferWidth / contentWidth));
  const y = Math.round((clientY - contentTop) * (framebufferHeight / contentHeight));
  return {
    x: Math.max(0, Math.min(framebufferWidth - 1, x)),
    y: Math.max(0, Math.min(framebufferHeight - 1, y)),
  };
}

export function codePointToKeysym(codePoint: number): number {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return 0;
  if (codePoint <= 0xff) return codePoint;
  return 0x01000000 | codePoint;
}

export function* iterCodePoints(text: string): Generator<number> {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) yield codePoint;
  }
}

export function normalizeVncError(error: unknown): VncError {
  let value = error;
  if (typeof value === "string") {
    const message = value;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return {
        code: "VNC_UNKNOWN",
        stage: "runtime",
        retryable: false,
        sanitizedMessage: message,
      };
    }
  }
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    return {
      code: typeof raw.code === "string" ? raw.code : "VNC_UNKNOWN",
      stage: typeof raw.stage === "string" ? raw.stage : "runtime",
      retryable: raw.retryable === true,
      sanitizedMessage:
        typeof raw.sanitizedMessage === "string"
          ? raw.sanitizedMessage
          : typeof raw.sanitized_message === "string"
            ? raw.sanitized_message
            : typeof raw.reason === "string"
              ? raw.reason
            : "VNC connection failed",
    };
  }
  return {
    code: "VNC_UNKNOWN",
    stage: "runtime",
    retryable: false,
    sanitizedMessage: String(error),
  };
}

export function shouldAutoReconnect(
  error: VncError,
  enabled: boolean,
  attempts: number,
  maxAttempts: number,
): boolean {
  return (
    enabled &&
    error.retryable &&
    Number.isInteger(attempts) &&
    Number.isInteger(maxAttempts) &&
    attempts >= 0 &&
    attempts < Math.max(0, maxAttempts)
  );
}

export function vncReconnectDelayMs(attempt: number, jitterUnit = Math.random()): number {
  const boundedAttempt = Math.max(0, Math.min(30, Math.floor(attempt)));
  const boundedJitter = Math.max(0, Math.min(0.999999, jitterUnit));
  return Math.min(10_000, 500 * 2 ** boundedAttempt) + Math.floor(boundedJitter * 250);
}
