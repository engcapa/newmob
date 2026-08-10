import { invoke } from "@tauri-apps/api/core";

export interface VncStructuredError {
  code: string;
  stage: "dns" | "tcp" | "proxy" | "rfb" | "security" | "authentication" | "initialization" | "runtime" | "relay";
  retryable: boolean;
  message: string;
}

const VNC_STAGES = new Set<VncStructuredError["stage"]>([
  "dns",
  "tcp",
  "proxy",
  "rfb",
  "security",
  "authentication",
  "initialization",
  "runtime",
  "relay",
]);
const MAX_FRAMEBUFFER_DIMENSION = 16_384;
const MAX_FRAMEBUFFER_BYTES = 256 * 1024 * 1024;
const MAX_RELAY_TEXT_CHARS = 64 * 1024 * 1024;
const MAX_CLIPBOARD_FORMAT_CHARS = 16 * 1024 * 1024;
const MAX_CLIPBOARD_TOTAL_CHARS = 32 * 1024 * 1024;
const MAX_CURSOR_DIMENSION = 512;
const MAX_CURSOR_BASE64_CHARS = 2 * 1024 * 1024;

function isVncStage(value: unknown): value is VncStructuredError["stage"] {
  return typeof value === "string" && VNC_STAGES.has(value as VncStructuredError["stage"]);
}

function validFramebufferSize(width: unknown, height: unknown): width is number {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  const w = width as number;
  const h = height as number;
  return w > 0
    && h > 0
    && w <= MAX_FRAMEBUFFER_DIMENSION
    && h <= MAX_FRAMEBUFFER_DIMENSION
    && w * h * 4 <= MAX_FRAMEBUFFER_BYTES;
}

function validClipboardFormats(...formats: unknown[]): boolean {
  let total = 0;
  for (const format of formats) {
    if (format === undefined) continue;
    if (typeof format !== "string" || format.length > MAX_CLIPBOARD_FORMAT_CHARS) return false;
    total += format.length;
    if (total > MAX_CLIPBOARD_TOTAL_CHARS) return false;
  }
  return true;
}

export function parseVncError(value: unknown): VncStructuredError {
  const text = value instanceof Error ? value.message : String(value);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const error = parsed as Record<string, unknown>;
      if (typeof error.code === "string" && error.code.length <= 128
        && isVncStage(error.stage)
        && typeof error.retryable === "boolean"
        && typeof error.message === "string" && error.message.length <= 2048) {
        return error as unknown as VncStructuredError;
      }
    }
  } catch {
    // Legacy backend error; retain a sanitized generic shape.
  }
  return { code: "vnc-error", stage: "runtime", retryable: false, message: text.slice(0, 2048) };
}

export type VncSecurityPolicy =
  | "require-encryption"
  | "prefer-encryption"
  | "legacy-compatible"
  | "allow-none";

export type VncClipboardPolicy =
  | "disabled"
  | "client-to-server"
  | "server-to-client"
  | "bidirectional";

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
  securityPolicy: VncSecurityPolicy = "prefer-encryption",
  viewOnly = false,
  clipboardPolicy: VncClipboardPolicy = "bidirectional",
): Promise<VncConnectResult> {
  return invoke<VncConnectResult>("vnc_connect", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    networkSettingsJson: networkSettingsJson ?? null,
    securityPolicy,
    viewOnly,
    clipboardPolicy,
  });
}

export interface VncDetachClaim {
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  network_settings_json?: string | null;
  security_policy: VncSecurityPolicy;
  view_only: boolean;
  clipboard_policy: VncClipboardPolicy;
}

export async function vncCreateDetachClaim(claim: VncDetachClaim): Promise<string> {
  const result = await invoke<{ claim_id: string }>("vnc_create_detach_claim", { claim });
  return result.claim_id;
}

export async function vncConsumeDetachClaim(claimId: string): Promise<VncDetachClaim> {
  return invoke<VncDetachClaim>("vnc_consume_detach_claim", { claimId });
}

export function redactVncHandoff<
  T extends {
    host: string;
    port: number;
    username?: string | null;
    password?: string;
    networkSettingsJson?: string | null;
    claimId?: string;
  },
>(params: T, claimId?: string): T {
  return {
    ...params,
    host: claimId ? "" : params.host,
    port: claimId ? 0 : params.port,
    username: claimId ? null : params.username,
    password: undefined,
    networkSettingsJson: null,
    claimId,
  };
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
  securityPolicy: VncSecurityPolicy = "prefer-encryption",
): Promise<string> {
  return invoke("vnc_test_connection", {
    host,
    port,
    username: username?.trim() || null,
    password: password ?? null,
    networkSettingsJson: networkSettingsJson ?? null,
    securityPolicy,
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
  | { type: "refresh" };

/** WebSocket message types received from the VNC relay. */
export type WsIncoming =
  | { type: "connected"; width: number; height: number; name: string; protocol: string; security: string; encrypted: boolean }
  | {
      type: "disconnected";
      code: string;
      stage: VncStructuredError["stage"];
      retryable: boolean;
      reason: string;
    }
  | { type: "bell" }
  | { type: "desktop_size"; width: number; height: number; generation: number }
  | { type: "pointer_pos"; x: number; y: number }
  | { type: "clipboard"; text: string }
  | {
      type: "ext_clipboard";
      text?: string;
      html?: string;
      rtf?: string;
    }
  | { type: "ext_clipboard_support"; available: boolean }
  | {
      type: "cursor";
      visible: boolean;
      hotspot_x: number;
      hotspot_y: number;
      width: number;
      height: number;
      png_base64: string;
    };

/** Parse and minimally validate an incoming WS text message. */
export function parseWsMessage(data: string): WsIncoming | null {
  if (data.length > MAX_RELAY_TEXT_CHARS) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const msg = value as Record<string, unknown>;
    if (typeof msg.type !== "string") return null;
    switch (msg.type) {
      case "connected":
        return validFramebufferSize(msg.width, msg.height)
          && typeof msg.name === "string" && msg.name.length <= 64 * 1024
          && typeof msg.protocol === "string" && msg.protocol.length <= 128
          && typeof msg.security === "string" && msg.security.length <= 128
          && typeof msg.encrypted === "boolean"
          ? value as WsIncoming
          : null;
      case "desktop_size":
        return validFramebufferSize(msg.width, msg.height)
          && Number.isSafeInteger(msg.generation)
          && (msg.generation as number) > 0
          ? value as WsIncoming
          : null;
      case "pointer_pos":
        return Number.isInteger(msg.x)
          && Number.isInteger(msg.y)
          && (msg.x as number) >= 0
          && (msg.y as number) >= 0
          && (msg.x as number) <= 0xffff
          && (msg.y as number) <= 0xffff
          ? value as WsIncoming
          : null;
      case "disconnected":
        return typeof msg.code === "string" && msg.code.length <= 128
          && isVncStage(msg.stage)
          && typeof msg.retryable === "boolean"
          && typeof msg.reason === "string" && msg.reason.length <= 2048
          ? value as WsIncoming
          : null;
      case "bell":
        return value as WsIncoming;
      case "clipboard":
        return typeof msg.text === "string" && validClipboardFormats(msg.text)
          ? value as WsIncoming
          : null;
      case "ext_clipboard":
        return validClipboardFormats(msg.text, msg.html, msg.rtf)
          ? value as WsIncoming
          : null;
      case "ext_clipboard_support":
        return typeof msg.available === "boolean" ? value as WsIncoming : null;
      case "cursor": {
        if (typeof msg.visible !== "boolean") return null;
        if (msg.visible === false) {
          return msg.hotspot_x === 0 && msg.hotspot_y === 0
            && msg.width === 0 && msg.height === 0 && msg.png_base64 === ""
            ? value as WsIncoming
            : null;
        }
        const validGeometry = Number.isInteger(msg.hotspot_x)
          && Number.isInteger(msg.hotspot_y)
          && Number.isInteger(msg.width)
          && Number.isInteger(msg.height)
          && (msg.width as number) > 0
          && (msg.height as number) > 0
          && (msg.width as number) <= MAX_CURSOR_DIMENSION
          && (msg.height as number) <= MAX_CURSOR_DIMENSION
          && (msg.hotspot_x as number) >= 0
          && (msg.hotspot_y as number) >= 0
          && (msg.hotspot_x as number) < (msg.width as number)
          && (msg.hotspot_y as number) < (msg.height as number);
        const validPng = typeof msg.png_base64 === "string"
          && msg.png_base64.length > 0
          && msg.png_base64.length <= MAX_CURSOR_BASE64_CHARS
          && msg.png_base64.startsWith("iVBORw0KGgo")
          && /^[A-Za-z0-9+/]*={0,2}$/.test(msg.png_base64);
        return validGeometry && validPng ? value as WsIncoming : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function vncCursorToCss(cursor: Extract<WsIncoming, { type: "cursor" }>): string {
  if (!cursor.visible) return "none";
  return `url("data:image/png;base64,${cursor.png_base64}") ${cursor.hotspot_x} ${cursor.hotspot_y}, default`;
}

export function encodeWsAck(): ArrayBuffer {
  return new Uint8Array([0]).buffer;
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

export function encodeWsRefresh(): ArrayBuffer {
  return new Uint8Array([4]).buffer;
}

/** Parse a binary frame header: [x(2B), y(2B), w(2B), h(2B)] — all big-endian. */
export function parseFrameHeader(
  data: ArrayBuffer,
): { x: number; y: number; w: number; h: number } | null {
  if (data.byteLength < 12) return null;
  const dv = new DataView(data);
  const x = dv.getUint16(0);
  const y = dv.getUint16(2);
  const w = dv.getUint16(4);
  const h = dv.getUint16(6);
  if (w === 0 || h === 0 || dv.getUint32(8) !== 0) return null;
  const expected = w * h * 4;
  if (!Number.isSafeInteger(expected) || data.byteLength !== 12 + expected) return null;
  return { x, y, w, h };
}

/** Map a DOM KeyboardEvent to an RFB keysym. */
export function keyEventToKeysym(e: KeyboardEvent): number {
  if (e.code.startsWith("Numpad")) {
    const keypad: Record<string, number> = {
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
      NumpadComma: 0xffac,
    };
    const keysym = keypad[e.code];
    if (keysym !== undefined) return keysym;
  }
  // Printable characters
  const printable = [...e.key];
  if (printable.length === 1) {
    return codePointToKeysym(printable[0].codePointAt(0) ?? 0);
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
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffe2 : 0xffe1;
    case "Control":
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffe4 : 0xffe3;
    case "Alt":
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffea : 0xffe9;
    case "Meta":
      return e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT ? 0xffec : 0xffeb;
    case "AltGraph":
      return 0xfe03;
    case "CapsLock":
      return 0xffe5;
    case "NumLock":
      return 0xff7f;
    case "ScrollLock":
      return 0xff14;
    case "PrintScreen":
      return 0xff61;
    case "Pause":
      return 0xff13;
    case "ContextMenu":
      return 0xff67;
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
    default: {
      const functionMatch = /^F(1[3-9]|2[0-4])$/.exec(e.key);
      if (functionMatch) return 0xffbd + Number(functionMatch[1]);
      return 0;
    }
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

export interface VncViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VncFramebufferPoint {
  x: number;
  y: number;
  /** False when the pointer is in fit-mode letterboxing or outside the canvas. */
  inside: boolean;
}

/**
 * Convert CSS-pixel pointer coordinates to remote framebuffer coordinates.
 * Device pixel ratio deliberately does not participate: RFB input follows the
 * remote logical framebuffer while the DOM event and canvas bounds are both in
 * CSS pixels.
 */
export function mapClientToFramebuffer(
  clientX: number,
  clientY: number,
  viewport: VncViewportRect,
  framebufferWidth: number,
  framebufferHeight: number,
  scaleMode: "fit" | "one",
): VncFramebufferPoint | null {
  if (![clientX, clientY, viewport.left, viewport.top, viewport.width, viewport.height]
    .every(Number.isFinite)
    || !Number.isInteger(framebufferWidth)
    || !Number.isInteger(framebufferHeight)
    || viewport.width <= 0
    || viewport.height <= 0
    || framebufferWidth <= 0
    || framebufferHeight <= 0) {
    return null;
  }

  let contentLeft = viewport.left;
  let contentTop = viewport.top;
  let contentWidth = viewport.width;
  let contentHeight = viewport.height;

  if (scaleMode === "fit") {
    const framebufferAspect = framebufferWidth / framebufferHeight;
    const viewportAspect = viewport.width / viewport.height;
    if (viewportAspect > framebufferAspect) {
      contentWidth = viewport.height * framebufferAspect;
      contentLeft += (viewport.width - contentWidth) / 2;
    } else {
      contentHeight = viewport.width / framebufferAspect;
      contentTop += (viewport.height - contentHeight) / 2;
    }
  }

  const inside = clientX >= contentLeft
    && clientX < contentLeft + contentWidth
    && clientY >= contentTop
    && clientY < contentTop + contentHeight;
  const x = Math.round((clientX - contentLeft) * framebufferWidth / contentWidth);
  const y = Math.round((clientY - contentTop) * framebufferHeight / contentHeight);
  return {
    x: Math.max(0, Math.min(framebufferWidth - 1, x)),
    y: Math.max(0, Math.min(framebufferHeight - 1, y)),
    inside,
  };
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
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return 0;
  }
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
