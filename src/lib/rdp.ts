import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "./ipc";
import type { RdpOptions } from "../types/rdp";
import { serializeRdpOptions } from "../types/rdp";

export interface RdpConnectResult {
  session_id: string;
  ws_port: number;
  ws_token: string;
}

export interface RdpCertificateChallenge {
  changed: boolean;
  host: string;
  port: number;
  expected?: string;
  observed: string;
}

/** Begin an RDP session. Returns the loopback WS port the canvas connects to. */
export async function rdpConnect(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: RdpOptions,
  networkSettingsJson: string | null = null,
): Promise<RdpConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<RdpConnectResult>("rdp_connect", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      optionsJson: serializeRdpOptions(options),
      networkSettingsJson,
    }),
  );
}

/** Close a session previously opened with `rdpConnect`. */
export async function rdpDisconnect(sessionId: string): Promise<void> {
  return invoke("rdp_disconnect", { sessionId });
}

export async function rdpTrustCertificate(
  host: string,
  port: number,
  fingerprint: string,
): Promise<string> {
  return invoke<string>("rdp_trust_certificate", { host, port, fingerprint });
}

/** Extract a structured certificate challenge from a rustls handshake error. */
export function extractRdpCertificateChallenge(message: string): RdpCertificateChallenge | null {
  const match = message.match(
    /RDP_CERTIFICATE_(UNTRUSTED|CHANGED)\s+host=([^\s]+)\s+port=(\d+)(?:\s+expected=([0-9a-f]{64}))?\s+observed=([0-9a-f]{64})/i,
  );
  if (!match) return null;
  const port = Number.parseInt(match[3], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    changed: match[1].toUpperCase() === "CHANGED",
    host: match[2],
    port,
    expected: match[4]?.toLowerCase(),
    observed: match[5].toLowerCase(),
  };
}

export function formatRdpCertificateFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,2}/g)?.join(":").toUpperCase() ?? fingerprint.toUpperCase();
}

/** Run the X.224 + Negotiation handshake without spawning the relay. */
export async function rdpTestConnection(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: RdpOptions,
  networkSettingsJson: string | null = null,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("rdp_test_connection", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      optionsJson: serializeRdpOptions(options),
      networkSettingsJson,
    }),
  );
}

/* ── Binary WS framing ──────────────────────────────────────────────── */

/** Outbound channel tags (browser → relay). Mirrors `rdp/ws.rs::channel`. */
export const IN_PING = 0;
export const IN_ACK = 1;
export const IN_KEY = 2;
export const IN_POINTER = 3;
export const IN_RESIZE = 4;
export const IN_WHEEL = 5;
export const IN_REFRESH = 6;

/** Inbound channel tags (relay → browser). */
export const OUT_FRAME = 0;
export const OUT_AUDIO = 1;
export const OUT_CURSOR = 2;
export const OUT_CLIPBOARD_OFFER = 3;
export const OUT_CLIPBOARD_DATA = 4;
export const OUT_STATUS = 5;
export const OUT_FRAME_END = 6;

export const RDP_CURSOR_DEFAULT = 0;
export const RDP_CURSOR_HIDDEN = 1;
export const RDP_CURSOR_BITMAP = 2;
const RDP_CURSOR_BITMAP_HEADER_LENGTH = 10;
const RDP_CURSOR_MAX_DIMENSION = 512;

export type RdpWsText =
  | { type: "connected"; width: number; height: number; protocol: string; server_name: string }
  | { type: "disconnected"; reason: string }
  | { type: "status"; stage: string; detail: string }
  | { type: "clipboard"; text: string }
  | { type: "clipboard_files"; paths: string[]; text?: string }
  | { type: "error"; code: string; message: string; retryable?: boolean };

export function parseRdpWsText(data: string): RdpWsText | null {
  try {
    return JSON.parse(data) as RdpWsText;
  } catch {
    return null;
  }
}

/** Classify failures that occur before the authenticated relay WebSocket exists. */
export function isRetryableRdpConnectError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  if (
    message.includes("certificate") ||
    message.includes("credential") ||
    message.includes("password") ||
    message.includes("not implemented") ||
    message.includes("unsupported")
  ) {
    return false;
  }
  return [
    "timed out",
    "connection refused",
    "connection reset",
    "broken pipe",
    "network is unreachable",
    "no route to host",
    "failed to lookup",
    "dns",
  ].some((needle) => message.includes(needle));
}

export function encodePing(): ArrayBuffer {
  return new Uint8Array([IN_PING]).buffer;
}

export function encodeAck(): ArrayBuffer {
  return new Uint8Array([IN_ACK]).buffer;
}

/** Ask the relay to request a full-desktop redraw from the RDP server. */
export function encodeRefresh(): ArrayBuffer {
  return new Uint8Array([IN_REFRESH]).buffer;
}

export function encodeKey(down: boolean, scancode: number): ArrayBuffer {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  b[0] = IN_KEY;
  b[1] = down ? 1 : 0;
  v.setUint16(2, scancode & 0xffff);
  return b.buffer;
}

export function encodePointer(x: number, y: number, buttons: number): ArrayBuffer {
  const b = new Uint8Array(6);
  const v = new DataView(b.buffer);
  b[0] = IN_POINTER;
  b[1] = buttons & 0xff;
  v.setUint16(2, x & 0xffff);
  v.setUint16(4, y & 0xffff);
  return b.buffer;
}

export function encodeResize(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(5);
  const v = new DataView(b.buffer);
  b[0] = IN_RESIZE;
  v.setUint16(1, width & 0xffff);
  v.setUint16(3, height & 0xffff);
  return b.buffer;
}

export function encodeWheel(
  x: number,
  y: number,
  rotationUnits: number,
  isVertical = true,
): ArrayBuffer {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  b[0] = IN_WHEEL;
  b[1] = isVertical ? 0 : 1;
  v.setUint16(2, x & 0xffff);
  v.setUint16(4, y & 0xffff);
  v.setInt16(6, clampWheelRotationUnits(rotationUnits));
  return b.buffer;
}

export interface RdpResizeSize {
  width: number;
  height: number;
}

export function normalizeRdpResizeSize(width: number, height: number): RdpResizeSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  if (roundedWidth <= 0 || roundedHeight <= 0) return null;

  let normalizedWidth = Math.max(200, Math.min(8192, roundedWidth));
  if (normalizedWidth % 2 !== 0) normalizedWidth -= 1;
  normalizedWidth = Math.max(200, normalizedWidth);

  const normalizedHeight = Math.max(200, Math.min(8192, roundedHeight));
  return { width: normalizedWidth, height: normalizedHeight };
}

/** RDP rotation units per physical wheel notch (Windows `WHEEL_DELTA`). */
const RDP_WHEEL_DELTA = 120;
/** Approx. browser pixel delta produced by one physical wheel notch. */
const PIXELS_PER_NOTCH = 100;
/** Windows default "lines scrolled per wheel notch". */
const LINES_PER_NOTCH = 3;

/**
 * Convert a browser `WheelEvent` delta into RDP rotation units.
 *
 * RDP measures wheel motion in units where one physical notch equals
 * `WHEEL_DELTA` (120) — the value Windows passes to apps via `WM_MOUSEWHEEL`.
 * We therefore first reduce the browser delta to a notch count (which depends
 * on `deltaMode`) and then scale by 120. Sending the raw notch count instead
 * (≈1 per notch) makes the server scroll ~1/120th of a line, which feels like
 * nothing.
 */
export function wheelDeltaToRotationUnits(delta: number, deltaMode: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;

  let notches: number;
  if (deltaMode === 1) {
    notches = delta / LINES_PER_NOTCH; // DOM_DELTA_LINE
  } else if (deltaMode === 2) {
    notches = delta; // DOM_DELTA_PAGE — treat one page as one notch
  } else {
    notches = delta / PIXELS_PER_NOTCH; // DOM_DELTA_PIXEL
  }

  return clampWheelRotationUnits(Math.round(notches * RDP_WHEEL_DELTA));
}

function clampWheelRotationUnits(rotationUnits: number): number {
  if (!Number.isFinite(rotationUnits) || rotationUnits === 0) return 0;
  const rounded = Math.round(rotationUnits);
  return Math.max(-255, Math.min(255, rounded));
}

/**
 * Parse an inbound binary WS frame. The first byte is the channel tag;
 * the meaning of the rest depends on the tag.
 *
 * For FRAME messages, the payload is `[x(2), y(2), w(2), h(2), rgba…]`.
 */
export interface RdpFrameTile {
  tag: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface RdpAudioFrame {
  tag: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestamp: number;
  formatNo: number;
  pcm: Uint8Array<ArrayBuffer>;
}

export type RdpCursorUpdate =
  | { kind: "default" }
  | { kind: "hidden" }
  | {
      kind: "bitmap";
      hotspotX: number;
      hotspotY: number;
      width: number;
      height: number;
      png: Uint8Array<ArrayBuffer>;
    };

export function parseFrameTile(data: ArrayBuffer): RdpFrameTile | null {
  if (data.byteLength < 9) return null;
  const dv = new DataView(data);
  const tag = dv.getUint8(0);
  if (tag !== OUT_FRAME) return null;
  const x = dv.getUint16(1);
  const y = dv.getUint16(3);
  const w = dv.getUint16(5);
  const h = dv.getUint16(7);
  const rgba = new Uint8ClampedArray(data, 9) as Uint8ClampedArray<ArrayBuffer>;
  return { tag, x, y, w, h, rgba };
}

export function parseAudioFrame(data: ArrayBuffer): RdpAudioFrame | null {
  if (data.byteLength < 17) return null;
  const dv = new DataView(data);
  const tag = dv.getUint8(0);
  if (tag !== OUT_AUDIO) return null;
  const sampleRate = dv.getUint32(1);
  const channels = dv.getUint16(5);
  const bitsPerSample = dv.getUint16(7);
  const timestamp = dv.getUint32(9);
  const formatNo = dv.getUint16(13);
  const pcm = new Uint8Array(data, 17) as Uint8Array<ArrayBuffer>;
  return { tag, sampleRate, channels, bitsPerSample, timestamp, formatNo, pcm };
}

export function parseRdpCursorFrame(data: ArrayBuffer): RdpCursorUpdate | null {
  if (data.byteLength < 2) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== OUT_CURSOR) return null;

  const kind = view.getUint8(1);
  if (kind === RDP_CURSOR_DEFAULT) {
    return data.byteLength === 2 ? { kind: "default" } : null;
  }
  if (kind === RDP_CURSOR_HIDDEN) {
    return data.byteLength === 2 ? { kind: "hidden" } : null;
  }
  if (kind !== RDP_CURSOR_BITMAP || data.byteLength <= RDP_CURSOR_BITMAP_HEADER_LENGTH) {
    return null;
  }

  const hotspotX = view.getUint16(2);
  const hotspotY = view.getUint16(4);
  const width = view.getUint16(6);
  const height = view.getUint16(8);
  if (
    width === 0 ||
    height === 0 ||
    width > RDP_CURSOR_MAX_DIMENSION ||
    height > RDP_CURSOR_MAX_DIMENSION ||
    hotspotX >= width ||
    hotspotY >= height
  ) {
    return null;
  }

  const png = new Uint8Array(data, RDP_CURSOR_BITMAP_HEADER_LENGTH) as Uint8Array<ArrayBuffer>;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < pngSignature.length || !pngSignature.every((byte, index) => png[index] === byte)) {
    return null;
  }
  return { kind: "bitmap", hotspotX, hotspotY, width, height, png };
}

export function rdpCursorToCss(update: RdpCursorUpdate): string {
  if (update.kind === "default") return "default";
  if (update.kind === "hidden") return "none";

  let binary = "";
  for (const byte of update.png) binary += String.fromCharCode(byte);
  return `url("data:image/png;base64,${window.btoa(binary)}") ${update.hotspotX} ${update.hotspotY}, default`;
}

/** Map a DOM `KeyboardEvent` to a (scancode, isExtended) pair. */
export function keyEventToScancode(
  e: KeyboardEvent,
): { scancode: number; extended: boolean } | null {
  // Letter keys: KeyA=0x1E … KeyZ=0x2C-ish. Use the DOM `code` map for
  // the common subset; printable characters fall through to charCodeAt
  // mapping as a fallback when `code` is unrecognized.
  const map: Record<string, [number, boolean]> = {
    Escape: [0x01, false],
    Backspace: [0x0e, false],
    Tab: [0x0f, false],
    Enter: [0x1c, false],
    NumpadEnter: [0x1c, true],
    ControlLeft: [0x1d, false],
    ControlRight: [0x1d, true],
    ShiftLeft: [0x2a, false],
    ShiftRight: [0x36, false],
    AltLeft: [0x38, false],
    AltRight: [0x38, true],
    MetaLeft: [0x5b, true],
    MetaRight: [0x5c, true],
    Space: [0x39, false],
    CapsLock: [0x3a, false],
    NumLock: [0x45, false],
    NumpadClear: [0x45, false],
    ScrollLock: [0x46, false],
    PrintScreen: [0x37, true],
    ArrowUp: [0x48, true],
    ArrowDown: [0x50, true],
    ArrowLeft: [0x4b, true],
    ArrowRight: [0x4d, true],
    Home: [0x47, true],
    End: [0x4f, true],
    PageUp: [0x49, true],
    PageDown: [0x51, true],
    Insert: [0x52, true],
    Delete: [0x53, true],
    ContextMenu: [0x5d, true],
    KeyA: [0x1e, false],
    KeyB: [0x30, false],
    KeyC: [0x2e, false],
    KeyD: [0x20, false],
    KeyE: [0x12, false],
    KeyF: [0x21, false],
    KeyG: [0x22, false],
    KeyH: [0x23, false],
    KeyI: [0x17, false],
    KeyJ: [0x24, false],
    KeyK: [0x25, false],
    KeyL: [0x26, false],
    KeyM: [0x32, false],
    KeyN: [0x31, false],
    KeyO: [0x18, false],
    KeyP: [0x19, false],
    KeyQ: [0x10, false],
    KeyR: [0x13, false],
    KeyS: [0x1f, false],
    KeyT: [0x14, false],
    KeyU: [0x16, false],
    KeyV: [0x2f, false],
    KeyW: [0x11, false],
    KeyX: [0x2d, false],
    KeyY: [0x15, false],
    KeyZ: [0x2c, false],
    Digit0: [0x0b, false],
    Digit1: [0x02, false],
    Digit2: [0x03, false],
    Digit3: [0x04, false],
    Digit4: [0x05, false],
    Digit5: [0x06, false],
    Digit6: [0x07, false],
    Digit7: [0x08, false],
    Digit8: [0x09, false],
    Digit9: [0x0a, false],
    Minus: [0x0c, false],
    Equal: [0x0d, false],
    BracketLeft: [0x1a, false],
    BracketRight: [0x1b, false],
    Backslash: [0x2b, false],
    Semicolon: [0x27, false],
    Quote: [0x28, false],
    Backquote: [0x29, false],
    Comma: [0x33, false],
    Period: [0x34, false],
    Slash: [0x35, false],
    IntlBackslash: [0x56, false],
    IntlRo: [0x73, false],
    IntlYen: [0x7d, false],
    Numpad0: [0x52, false],
    Numpad1: [0x4f, false],
    Numpad2: [0x50, false],
    Numpad3: [0x51, false],
    Numpad4: [0x4b, false],
    Numpad5: [0x4c, false],
    Numpad6: [0x4d, false],
    Numpad7: [0x47, false],
    Numpad8: [0x48, false],
    Numpad9: [0x49, false],
    NumpadDecimal: [0x53, false],
    NumpadAdd: [0x4e, false],
    NumpadSubtract: [0x4a, false],
    NumpadMultiply: [0x37, false],
    NumpadDivide: [0x35, true],
    NumpadEqual: [0x59, false],
    F1: [0x3b, false],
    F2: [0x3c, false],
    F3: [0x3d, false],
    F4: [0x3e, false],
    F5: [0x3f, false],
    F6: [0x40, false],
    F7: [0x41, false],
    F8: [0x42, false],
    F9: [0x43, false],
    F10: [0x44, false],
    F11: [0x57, false],
    F12: [0x58, false],
    F13: [0x64, false],
    F14: [0x65, false],
    F15: [0x66, false],
    F16: [0x67, false],
    F17: [0x68, false],
    F18: [0x69, false],
    F19: [0x6a, false],
    F20: [0x6b, false],
    F21: [0x6c, false],
    F22: [0x6d, false],
    F23: [0x6e, false],
    F24: [0x76, false],
  };
  const entry = map[e.code];
  if (entry) return { scancode: entry[0], extended: entry[1] };
  return null;
}

/** Apply the extended-key flag to a scancode for the wire format. */
export function applyExtended(scancode: number, extended: boolean): number {
  return extended ? (scancode | 0x100) : scancode;
}

/** Mouse-button bitmask matching `ws.rs::PointerEvent::buttons`. */
export function mouseButtonMask(e: MouseEvent | PointerEvent): number {
  let m = 0;
  if (e.buttons & 1) m |= 0x01; // left
  if (e.buttons & 2) m |= 0x02; // right
  if (e.buttons & 4) m |= 0x04; // middle
  return m;
}
