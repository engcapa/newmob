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

export type VncDisconnectSource = "backend" | "relay" | "frontend";
export type VncDisconnectCode =
  | "requested"
  | "auth_failed"
  | "network_error"
  | "protocol_error"
  | "websocket_closed"
  | "internal_error";

export interface VncDisconnectInfo {
  source: VncDisconnectSource;
  code: VncDisconnectCode;
  reason: string;
  retryable: boolean;
}

/** WebSocket message types sent to the VNC relay. */
export type WsOutgoing =
  | { type: "ack" }
  | { type: "key"; down: boolean; keysym: number }
  | { type: "pointer"; x: number; y: number; buttons: number }
  | { type: "clipboard"; text: string }
  | { type: "resize"; width: number; height: number };

/** WebSocket message types received from the VNC relay. */
export type WsIncoming =
  | { type: "connected"; width: number; height: number; name: string }
  | {
      type: "disconnected";
      reason: string;
      source?: VncDisconnectSource;
      code?: VncDisconnectCode;
      retryable?: boolean;
    }
  | { type: "bell" }
  | { type: "clipboard"; text: string };

/** Parse an incoming WS text message. */
export function parseWsMessage(data: string): WsIncoming | null {
  try {
    return JSON.parse(data) as WsIncoming;
  } catch {
    return null;
  }
}

export function classifyVncConnectError(error: unknown): VncDisconnectInfo {
  const reason = extractErrorMessage(error);
  return classifyVncDisconnect(
    "backend",
    reason,
    "network_error",
    true,
  );
}

export function normalizeVncDisconnectInfo(
  msg: {
    reason: string;
    source?: VncDisconnectSource;
    code?: VncDisconnectCode;
    retryable?: boolean;
  },
  fallbackSource: VncDisconnectSource = "relay",
): VncDisconnectInfo {
  const source = msg.source ?? fallbackSource;
  const classified = classifyVncDisconnect(
    source,
    msg.reason,
    msg.code ?? "internal_error",
    msg.retryable ?? true,
  );

  return {
    source,
    code: msg.code ?? classified.code,
    reason: msg.reason,
    retryable: msg.retryable ?? classified.retryable,
  };
}

export function formatVncDisconnect(info: VncDisconnectInfo): string {
  const source =
    info.source === "backend"
      ? "Backend"
      : info.source === "relay"
        ? "Relay"
        : "Frontend";
  return `${source} (${info.code}): ${info.reason}`;
}

function classifyVncDisconnect(
  source: VncDisconnectSource,
  reason: string,
  fallbackCode: VncDisconnectCode,
  fallbackRetryable: boolean,
): VncDisconnectInfo {
  const lower = reason.toLowerCase();

  if (
    lower.includes("authentication failed") ||
    lower.includes("auth failure") ||
    lower.includes("no vnc username")
  ) {
    return { source, code: "auth_failed", reason, retryable: false };
  }

  if (
    lower.includes("protocol") ||
    lower.includes("invalid rfb") ||
    lower.includes("unknown server message")
  ) {
    return { source, code: "protocol_error", reason, retryable: false };
  }

  if (
    lower.includes("websocket") ||
    lower.includes("connection closed") ||
    lower.includes("socket")
  ) {
    return { source, code: "websocket_closed", reason, retryable: true };
  }

  if (
    lower.includes("connection reset") ||
    lower.includes("broken pipe") ||
    lower.includes("timed out") ||
    lower.includes("failed to fill whole buffer") ||
    lower.includes("tcp connect") ||
    lower.includes("network")
  ) {
    return { source, code: "network_error", reason, retryable: true };
  }

  return {
    source,
    code: fallbackCode,
    reason,
    retryable: fallbackRetryable,
  };
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const maybeError = error as { message?: unknown };
    if (typeof maybeError.message === "string") {
      return maybeError.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
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
